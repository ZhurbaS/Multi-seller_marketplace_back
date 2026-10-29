// Рахунки на оплату для юросіб: виставлення, надсилання листом, повторне надсилання, PDF.
//
// Життєвий цикл (order.invoice.status):
//   awaiting → sent → paid            (awaiting: рахунок сформовано, лист не надіслано — адмін надсилає повторно)
//                    ↘ expired        (строк дії минув — замовлення скасовується автоматично)
//   cancelled — покупець обрав інший спосіб оплати.
// Оплату адмін підтверджує вручну після надходження коштів на рахунок («Підтвердити оплату» в замовленні).

const customerOrderModel = require("../models/customerOrderModel");
const storeSettingsModel = require("../models/storeSettingsModel");
const customerModel = require("../models/customerModel");
const invoiceLib = require("./invoice");
const mailer = require("./mailer");
const { publicFrontUrl } = require("../payments/config");

class InvoiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const DAY = 24 * 60 * 60 * 1000;

async function loadCompany() {
  // require тут, щоб уникнути циклічної залежності
  const { loadSettings } = require("../controllers/settingsController");
  const { company } = await loadSettings();
  return company;
}

async function isAvailable() {
  return invoiceLib.isCompanyConfigured(await loadCompany());
}

const orderLabel = (order) => `№${String(order._id).slice(-8).toUpperCase()}`;

async function customerEmail(customerId) {
  const c = await customerModel.findById(customerId).select("email name").lean();
  return c?.email || null;
}

const LOCK_MS = 60 * 1000;
const lockFree = (field) => [{ [field]: null }, { [field]: { $lt: new Date(Date.now() - LOCK_MS) } }];

// Знову робить рахунок чинним (покупець повернувся до оплати за рахунком / замовлення відновили):
// новий строк дії, статус «sent» або «awaiting».
async function revive(orderId) {
  const o = await customerOrderModel.findById(orderId);
  if (!o?.invoice?.number || o.payment_status === "paid") return null;
  const days = o.invoice.company?.invoiceValidDays || 5;
  return customerOrderModel.findByIdAndUpdate(
    orderId,
    {
      $set: {
        payment_method: "invoice",
        "payment.provider": "invoice",
        "payment.status": "pending",
        "invoice.status": o.invoice.sentAt ? "sent" : "awaiting",
        "invoice.dueAt": new Date(Date.now() + days * DAY),
      },
    },
    { new: true }
  );
}

// Якщо замовлення «за рахунком» відновлюють (було скасоване за строком) — продовжуємо рахунок,
// інакше фонова перевірка скасує його знову.
async function reviveIfInvoice(orderId) {
  const o = await customerOrderModel.findById(orderId);
  if (o?.payment_method === "invoice" && o.invoice?.number && o.payment_status !== "paid") {
    await revive(orderId);
  }
}

// Покупець обрав інший спосіб оплати / замовлення скасовано — рахунок більше не діє
async function cancelIfInvoice(orderId) {
  await customerOrderModel.updateOne(
    { _id: orderId, "invoice.number": { $ne: null }, "invoice.status": { $in: ["awaiting", "sent"] } },
    { $set: { "invoice.status": "cancelled" } }
  );
}

// Виставляє рахунок (ідемпотентно: повторний виклик повертає вже виставлений).
// Повертає актуальний документ замовлення.
async function issue(order) {
  if (order.buyer?.kind !== "company") {
    throw new InvoiceError("Рахунок виставляється лише юридичним особам та ФОП");
  }
  if (order.invoice?.number) {
    // Покупець повернувся до оплати за рахунком після скасованого/простроченого — оживляємо
    if (["cancelled", "expired"].includes(order.invoice.status)) {
      const revived = await revive(order._id);
      if (revived) return revived;
    }
    return customerOrderModel.findById(order._id);
  }

  const company = await loadCompany();
  const checked = invoiceLib.sanitizeCompany(company);
  if (checked.error) {
    throw new InvoiceError("Оплата за рахунком тимчасово недоступна: магазин не заповнив реквізити", 503);
  }

  // Атомарне «захоплення»: лише один паралельний виклик виставляє рахунок і бере номер
  const claimed = await customerOrderModel.findOneAndUpdate(
    { _id: order._id, "invoice.number": null, $or: lockFree("invoice.issuingAt") },
    { $set: { "invoice.issuingAt": new Date() } },
    { new: true }
  );
  if (!claimed) {
    const cur = await customerOrderModel.findById(order._id);
    if (cur?.invoice?.number) return cur;
    throw new InvoiceError("Рахунок уже формується — спробуйте ще раз за мить", 409);
  }

  try {
    const st = await storeSettingsModel.findOneAndUpdate(
      { key: "main" },
      { $inc: { invoiceSeq: 1 } },
      { upsert: true, new: true }
    );
    const c = checked.value;
    const now = new Date();
    return await customerOrderModel.findByIdAndUpdate(
      order._id,
      {
        $set: {
          payment_method: "invoice",
          "payment.provider": "invoice",
          "payment.status": "pending",
          "invoice.number": invoiceLib.formatNumber(c.invoicePrefix, st.invoiceSeq),
          "invoice.status": "awaiting",
          "invoice.issuingAt": null,
          "invoice.issuedAt": now,
          "invoice.dueAt": new Date(now.getTime() + c.invoiceValidDays * DAY),
          "invoice.company": c,
        },
      },
      { new: true }
    );
  } catch (e) {
    await customerOrderModel.updateOne({ _id: order._id }, { $set: { "invoice.issuingAt": null } });
    throw e;
  }
}

// PDF рахунку (за знімком реквізитів на момент виставлення)
async function pdfFor(order) {
  if (!order.invoice?.number) throw new InvoiceError("Рахунок ще не виставлено", 404);
  const company = order.invoice.company || (await loadCompany());
  return invoiceLib.renderPdf({
    order,
    company,
    number: order.invoice.number,
    issuedAt: order.invoice.issuedAt,
    dueAt: order.invoice.dueAt,
  });
}

// Надсилає рахунок покупцю на email. Результат записується в order.invoice.
// Повертає { sent, to, error, busy? }. Паралельні виклики не надсилають лист двічі.
async function send(order) {
  const claimed = await customerOrderModel.findOneAndUpdate(
    { _id: order._id, $or: lockFree("invoice.sendingAt") },
    { $set: { "invoice.sendingAt": new Date() } },
    { new: true }
  );
  if (!claimed) return { sent: false, to: null, error: "Надсилання вже виконується", busy: true };
  try {
    const to = await customerEmail(order.customerId);
    if (!to) {
      await customerOrderModel.updateOne(
        { _id: order._id },
        { $set: { "invoice.sendError": "У покупця немає email" } }
      );
      return { sent: false, to: null, error: "У покупця немає email" };
    }
    const pdf = await pdfFor(order);
    const inv = order.invoice;
    const dueText = new Date(inv.dueAt).toLocaleDateString("uk-UA");
    const ok = await mailer.sendMail({
      to,
      subject: `Рахунок на оплату ${inv.number} (замовлення ${orderLabel(order)})`,
      text:
        `Доброго дня!\n\nДякуємо за замовлення ${orderLabel(order)}. У вкладенні — рахунок на оплату ${inv.number} ` +
        `на суму ₴${order.price}.\n\n` +
        `Рахунок дійсний до ${dueText}. Якщо оплата не надійде до цієї дати, замовлення буде автоматично скасоване.\n` +
        `У призначенні платежу вкажіть номер рахунку ${inv.number}.\n\n` +
        `Рахунок також доступний у вашому особистому кабінеті: ${publicFrontUrl()}/dashboard/order/details/${order._id}\n` +
        `Після надходження коштів ми підтвердимо оплату й передамо замовлення в обробку.`,
      attachments: [{ filename: `rahunok-${inv.number}.pdf`, content: pdf }],
    });
    await customerOrderModel.updateOne(
      { _id: order._id, "invoice.status": { $in: ["awaiting", "sent"] } },
      ok
        ? { $set: { "invoice.status": "sent", "invoice.sentAt": new Date(), "invoice.sentTo": to, "invoice.sendError": null } }
        : { $set: { "invoice.sendError": "Лист не надіслано (перевірте налаштування пошти) — надішліть повторно", "invoice.sentTo": to } }
    );
    return { sent: ok, to, error: ok ? null : "Лист не надіслано" };
  } finally {
    await customerOrderModel.updateOne({ _id: order._id }, { $set: { "invoice.sendingAt": null } });
  }
}

// Виставити + надіслати (виклик із startPayment). Збій листа не скасовує рахунок.
async function issueAndSend(order) {
  const issued = await issue(order);
  if (issued.invoice?.status === "awaiting" || issued.invoice?.status === "sent") {
    // Не надсилаємо вдруге, якщо вже надіслано
    if (issued.invoice.status === "sent") return { order: issued, sent: true, to: issued.invoice.sentTo };
    const r = await send(issued);
    const fresh = await customerOrderModel.findById(order._id);
    // Лист уже надсилає паралельний запит — вважаємо успішним, якщо статус «sent»
    if (r.busy) return { order: fresh, sent: fresh.invoice?.status === "sent", to: fresh.invoice?.sentTo };
    return { order: fresh, ...r };
  }
  return { order: issued, sent: false };
}

// Адмін: надіслати повторно; extend — продовжити строк дії на стільки ж днів від сьогодні
async function resend(orderId, { extend = false } = {}) {
  let order = await customerOrderModel.findById(orderId);
  if (!order) throw new InvoiceError("Замовлення не знайдено", 404);
  if (!order.invoice?.number) throw new InvoiceError("Для цього замовлення рахунок не виставлявся", 404);
  if (order.payment_status === "paid") throw new InvoiceError("Замовлення вже оплачене", 409);
  if (order.delivery_status === "cancelled") throw new InvoiceError("Замовлення скасовано", 409);
  if (order.invoice.status === "cancelled" || order.payment_method !== "invoice") {
    throw new InvoiceError("Покупець обрав інший спосіб оплати — рахунок більше не діє", 409);
  }
  if (extend) {
    const days = order.invoice.company?.invoiceValidDays || 5;
    order = await customerOrderModel.findByIdAndUpdate(
      orderId,
      { $set: { "invoice.dueAt": new Date(Date.now() + days * DAY), "invoice.status": order.invoice.sentAt ? "sent" : "awaiting" } },
      { new: true }
    );
  }
  const r = await send(order);
  return { order: await customerOrderModel.findById(orderId), ...r };
}

module.exports = {
  InvoiceError,
  isAvailable,
  issue,
  issueAndSend,
  send,
  resend,
  pdfFor,
  loadCompany,
  revive,
  reviveIfInvoice,
  cancelIfInvoice,
};
