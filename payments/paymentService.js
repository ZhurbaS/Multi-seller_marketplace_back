// Центральна логіка оплат. Усе, що змінює гроші/статуси, проходить через цей файл.
//
// Принципи:
//  - сума береться ТІЛЬКИ з замовлення в БД (order.price), ніколи з клієнта;
//  - джерело істини — підписаний вебхук (+ перевірка статусу через API провайдера);
//  - markOrderPaid ідемпотентний: повторний вебхук/клік не нарахує гроші вдруге.

const customerOrderModel = require("../models/customerOrderModel");
const authorOrderModel = require("../models/authorOrderModel");
const ledger = require("../utiles/ledger");
const stockService = require("../utiles/stockService");
const couponService = require("../utiles/couponService");
const config = require("./config");
const monobank = require("./providers/monobank");
const liqpay = require("./providers/liqpay");

const METHODS = ["monobank", "liqpay", "mock", "cod"];
// Оплата за рахунком (invoice) — лише для юросіб, див. utiles/invoiceService.js; доступність залежить від
// реквізитів магазину в БД, тому перевіряється окремо (асинхронно).

function availableMethods() {
  const list = [];
  if (config.monobankEnabled())
    list.push({ id: "monobank", title: "Картка / Apple Pay / Google Pay (monobank)" });
  if (config.liqpayEnabled())
    list.push({ id: "liqpay", title: "Картка (LiqPay)" });
  if (config.mockEnabled())
    list.push({ id: "mock", title: "Тестова оплата (без реальних грошей)", test: true });
  if (config.codEnabled())
    list.push({ id: "cod", title: "Оплата при отриманні" });
  return list;
}

function isMethodAvailable(method) {
  return availableMethods().some((m) => m.id === method);
}

// ---------------------------------------------------------------------------
// Підтвердження оплати (ідемпотентне)
// ---------------------------------------------------------------------------
async function markOrderPaid(orderId, { provider, providerStatus, modifiedDate } = {}) {
  // Атомарний перехід unpaid → paid: лише один виклик отримає документ назад.
  const order = await customerOrderModel.findOneAndUpdate(
    { _id: orderId, payment_status: { $ne: "paid" } },
    {
      $set: {
        payment_status: "paid",
        "payment.status": "paid",
        "payment.paidAt": new Date(),
        ...(provider ? { "payment.provider": provider } : {}),
        ...(providerStatus ? { "payment.providerStatus": providerStatus } : {}),
        ...(modifiedDate ? { "payment.modifiedDate": modifiedDate } : {}),
      },
    },
    { new: true }
  );
  if (!order) return { changed: false };
  if (order.invoice?.number && order.payment_method === "invoice") {
    await customerOrderModel.updateOne({ _id: order._id }, { $set: { "invoice.status": "paid" } });
  }

  // Якщо замовлення встигли автоскасувати за таймером, а гроші прийшли — відновлюємо.
  const restore = order.delivery_status === "cancelled";
  if (restore) {
    await customerOrderModel.findByIdAndUpdate(order._id, {
      delivery_status: "pending",
    });
    // Товари при скасуванні повернулись на склад — резервуємо знову. Гроші вже отримано,
    // тому навіть якщо товару не вистачає, замовлення лишається оплаченим (розбереться адмін).
    const r = await stockService.reserveForOrder(order._id);
    if (!r.ok) {
      console.error(
        `⚠️ Оплачене замовлення ${order._id} відновлено, але на складі бракує "${r.name}" — потрібне ручне втручання/повернення коштів`
      );
    }
    // Купон, який «відпустили» під час автоскасування, знову займаємо
    await couponService.reacquireForOrder(order._id);
  }
  // delivery_status підзамовлень чіпаємо лише при відновленні скасованого,
  // щоб не відкотити вже просунутий статус (напр. COD, оплачений при доставці).
  await authorOrderModel.updateMany(
    { orderId: order._id },
    { payment_status: "paid", ...(restore ? { delivery_status: "pending" } : {}) }
  );

  const authOrders = await authorOrderModel.find({ orderId: order._id });
  // Нарахування: частка продавця (з утриманням до закінчення терміну повернення),
  // комісія магазину, знижка за сумою замовлення — див. utiles/ledger.js
  await ledger.recordPaidOrder(order, authOrders);
  await couponService.markRedeemed(order._id);
  return { changed: true, order };
}

// ---------------------------------------------------------------------------
// Старт оплати
// ---------------------------------------------------------------------------
class PaymentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function startPayment(order, method) {
  if (method !== "invoice" && (!METHODS.includes(method) || !isMethodAvailable(method))) {
    throw new PaymentError("Цей спосіб оплати недоступний");
  }
  if (order.payment_status === "paid") {
    throw new PaymentError("Замовлення вже оплачене");
  }
  if (order.delivery_status === "cancelled") {
    throw new PaymentError("Замовлення скасовано");
  }
  if (method === "invoice" && order.buyer?.kind !== "company") {
    throw new PaymentError("Оплата за рахунком доступна лише юридичним особам та ФОП");
  }
  // Покупець передумав і обрав інший спосіб — раніше виставлений рахунок більше не діє
  // (скасовуємо рахунок лише після того, як новий спосіб успішно стартував).
  const dropInvoice = async () => {
    if (method !== "invoice" && order.invoice?.number) {
      await require("../utiles/invoiceService").cancelIfInvoice(order._id);
    }
  };
  const amountUah = Number(order.price);
  if (!Number.isFinite(amountUah) || amountUah <= 0) {
    throw new PaymentError("Некоректна сума замовлення", 500);
  }

  if (method === "invoice") {
    const invoiceService = require("../utiles/invoiceService");
    try {
      const r = await invoiceService.issueAndSend(order);
      return {
        type: "invoice",
        number: r.order?.invoice?.number || null,
        status: r.order?.invoice?.status || null,
        dueAt: r.order?.invoice?.dueAt || null,
        emailed: !!r.sent,
        to: r.to || null,
      };
    } catch (e) {
      if (e instanceof invoiceService.InvoiceError) throw new PaymentError(e.message, e.status);
      throw e;
    }
  }

  if (method === "cod") {
    await customerOrderModel.findByIdAndUpdate(order._id, {
      payment_method: "cod",
      "payment.provider": "cod",
      "payment.status": "pending",
    });
    await dropInvoice();
    return { type: "cod" };
  }

  if (method === "monobank") {
    const { invoiceId, pageUrl } = await monobank.createInvoice({ order, amountUah });
    await customerOrderModel.findByIdAndUpdate(order._id, {
      payment_method: "monobank",
      "payment.provider": "monobank",
      "payment.invoiceId": invoiceId,
      "payment.status": "pending",
      "payment.providerStatus": "created",
      "payment.modifiedDate": null,
    });
    await dropInvoice();
    return { type: "redirect", url: pageUrl };
  }

  if (method === "liqpay") {
    const form = liqpay.createCheckout({ order, amountUah });
    await customerOrderModel.findByIdAndUpdate(order._id, {
      payment_method: "liqpay",
      "payment.provider": "liqpay",
      // invoiceId monobank не стираємо: якщо покупець встиг оплатити старий рахунок — вебхук його визнає.
      "payment.status": "pending",
      "payment.providerStatus": null,
    });
    await dropInvoice();
    return { type: "form", url: form.url, fields: form.fields };
  }

  // mock
  await customerOrderModel.findByIdAndUpdate(order._id, {
    payment_method: "mock",
    "payment.provider": "mock",
    "payment.status": "pending",
  });
  await dropInvoice();
  return {
    type: "redirect",
    url: `${config.publicFrontUrl()}/pay/mock?orderId=${order._id}`,
    internal: true,
  };
}

// ---------------------------------------------------------------------------
// Застосування результату від провайдера (вебхук або verify-on-return)
// ---------------------------------------------------------------------------
async function applyResult(order, { provider, normalized, providerStatus, modifiedDate }) {
  if (normalized === "paid") {
    return markOrderPaid(order._id, { provider, providerStatus, modifiedDate });
  }
  // Не затираємо «paid» невдалою спробою, що прийшла пізніше.
  if (order.payment_status === "paid") return { changed: false };
  await customerOrderModel.updateOne(
    { _id: order._id, payment_status: { $ne: "paid" } },
    {
      $set: {
        "payment.status": normalized,
        "payment.providerStatus": providerStatus,
        ...(modifiedDate ? { "payment.modifiedDate": modifiedDate } : {}),
      },
    }
  );
  return { changed: false };
}

// ---------------------------------------------------------------------------
// Вебхук monobank
// ---------------------------------------------------------------------------
async function handleMonobankWebhook(rawBody, signature) {
  if (!(await monobank.verifyWebhook(rawBody, signature))) {
    throw new PaymentError("Невалідний підпис", 401);
  }
  const body = JSON.parse(rawBody.toString("utf8"));
  const { invoiceId, reference } = body;
  if (!invoiceId || !reference) return { ignored: true };

  const order = await customerOrderModel.findById(reference).catch(() => null);
  if (!order || order.payment?.invoiceId !== invoiceId) return { ignored: true };

  // Порядок доставки вебхуків не гарантований — відкидаємо застарілі за modifiedDate.
  const prev = order.payment?.modifiedDate;
  if (prev && body.modifiedDate && body.modifiedDate < prev) return { ignored: true };

  let status = body;
  if (body.status === "success") {
    // Перепідтверджуємо статус напряму в monobank (захист від повторів/підробок).
    status = await monobank.getInvoiceStatus(invoiceId);
  }
  if (status.status === "success") {
    if (
      Number(status.amount) !== Math.round(order.price * 100) ||
      Number(status.ccy) !== 980
    ) {
      console.error(
        `monobank: сума/валюта не збігається для замовлення ${order._id}: ${status.amount} ${status.ccy}`
      );
      throw new PaymentError("Сума платежу не збігається", 409);
    }
  }
  await applyResult(order, {
    provider: "monobank",
    normalized: monobank.normalizeStatus(status.status),
    providerStatus: status.status,
    modifiedDate: status.modifiedDate || body.modifiedDate,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Callback LiqPay (form-urlencoded: data, signature)
// ---------------------------------------------------------------------------
async function handleLiqpayCallback(data, signature) {
  if (!liqpay.verifyCallback(data, signature)) {
    throw new PaymentError("Невалідний підпис", 401);
  }
  const info = liqpay.decodeData(data);
  const order = await customerOrderModel.findById(info.order_id).catch(() => null);
  if (!order) return { ignored: true };

  if (info.status === "success" || info.status === "sandbox") {
    if (info.status === "sandbox" && config.isProduction()) {
      throw new PaymentError("Sandbox-платіж у production", 409);
    }
    if (
      Number(info.amount) !== Number(order.price) ||
      info.currency !== "UAH"
    ) {
      console.error(
        `LiqPay: сума/валюта не збігається для замовлення ${order._id}: ${info.amount} ${info.currency}`
      );
      throw new PaymentError("Сума платежу не збігається", 409);
    }
  }
  await applyResult(order, {
    provider: "liqpay",
    normalized: liqpay.normalizeStatus(info.status),
    providerStatus: info.status,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// verify-on-return: покупець повернувся на сайт, а вебхук ще не дійшов
// ---------------------------------------------------------------------------
async function verifyOrderPayment(order) {
  if (order.payment_status === "paid") return order;

  try {
    if (order.payment?.provider === "monobank" && order.payment.invoiceId) {
      const s = await monobank.getInvoiceStatus(order.payment.invoiceId);
      if (
        s.status !== "success" ||
        (Number(s.amount) === Math.round(order.price * 100) && Number(s.ccy) === 980)
      ) {
        await applyResult(order, {
          provider: "monobank",
          normalized: monobank.normalizeStatus(s.status),
          providerStatus: s.status,
          modifiedDate: s.modifiedDate,
        });
      }
    } else if (order.payment?.provider === "liqpay" && config.liqpayEnabled()) {
      const s = await liqpay.getStatus(order._id.toString());
      const okAmount =
        Number(s.amount) === Number(order.price) && s.currency === "UAH";
      if (s.status && (liqpay.normalizeStatus(s.status) !== "paid" || okAmount)) {
        if (!(s.status === "sandbox" && config.isProduction())) {
          await applyResult(order, {
            provider: "liqpay",
            normalized: liqpay.normalizeStatus(s.status),
            providerStatus: s.status,
          });
        }
      }
    }
  } catch (e) {
    // Тимчасова помилка API провайдера — просто повертаємо поточний стан.
    console.error("verifyOrderPayment:", e.message);
  }
  return customerOrderModel.findById(order._id);
}

// Тестова оплата (лише поза production)
async function completeMockPayment(order, success) {
  if (!config.mockEnabled() || order.payment?.provider !== "mock") {
    throw new PaymentError("Тестова оплата недоступна", 403);
  }
  return applyResult(order, {
    provider: "mock",
    normalized: success ? "paid" : "failed",
    providerStatus: success ? "success" : "failure",
  });
}

// ---------------------------------------------------------------------------
// Повернення коштів покупцю
// ---------------------------------------------------------------------------
// Повертає { state: "success" | "processing" | "failed" | "manual", provider, error? }.
//  - "manual": автоматичне повернення неможливе (оплата при отриманні) — адмін переказує вручну;
//  - "processing": банк прийняв запит, результат буде пізніше (перевіряється через syncRefund);
//  - "failed": банк відхилив запит (текст помилки — в error), можна повторити або провести вручну.
// extRef — стабільний номер повернення: повторний виклик не створює друге повернення
// (для monobank спершу перевіряємо, чи цей extRef уже є в cancelList).
const MONO_REFUND_STATE = { success: "success", processing: "processing", failure: "failed" };

// Операції повернення за одним rr-номером (спроби мають суфікс -2, -3…): якщо будь-яка з них
// успішна або ще в обробці, нову не створюємо — щоб не повернути кошти двічі.
function monoRefundsFor(status, extRef) {
  const base = String(extRef).replace(/-\d+$/, "");
  return (status.cancelList || []).filter((c) => c.extRef === base || String(c.extRef).startsWith(`${base}-`));
}
function monoRefundState(list) {
  if (list.some((c) => c.status === "success")) return "success";
  if (list.some((c) => c.status === "processing")) return "processing";
  return list.length ? "failed" : null;
}

async function refundPayment(order, amountUah, extRef) {
  const provider = order.payment?.provider;
  try {
    if (provider === "mock") {
      return { state: "success", provider };
    }
    if (provider === "monobank" && order.payment?.invoiceId) {
      const status = await monobank.getInvoiceStatus(order.payment.invoiceId);
      const prior = monoRefundState(monoRefundsFor(status, extRef));
      if (prior === "success" || prior === "processing") return { state: prior, provider };
      const r = await monobank.cancelInvoice({
        invoiceId: order.payment.invoiceId,
        amountUah,
        extRef,
      });
      return { state: MONO_REFUND_STATE[r?.status] || "processing", provider };
    }
    if (provider === "liqpay" && config.liqpayEnabled()) {
      const r = await liqpay.refund({ orderId: order._id.toString(), amountUah });
      if (r?.result === "ok" && r.status === "reversed") {
        const waiting = r.wait_amount === true || r.wait_amount === "true";
        return { state: waiting ? "processing" : "success", provider };
      }
      return {
        state: "failed",
        provider,
        error: `LiqPay: ${r?.err_description || r?.err_code || r?.status || "відмова"}`,
      };
    }
  } catch (error) {
    // LiqPay: після збою мережі невідомо, чи пройшло повернення, і перевірити за власним номером
    // неможливо — повторювати наосліп не можна. Лишаємо «в обробці»: адмін звіряє з кабінетом
    // LiqPay і підтверджує вручну (кнопка стає доступною через 2 хв).
    if (provider === "liqpay") {
      return {
        state: "processing",
        provider,
        error: `Невідомий результат (${error.message}). Перевірте повернення в кабінеті LiqPay і підтвердіть вручну`,
      };
    }
    return { state: "failed", provider, error: error.message };
  }
  return { state: "manual", provider: provider || null };
}

// Уточнення статусу повернення, яке банк обробляє асинхронно.
async function syncRefund(order, extRef) {
  const provider = order.payment?.provider;
  try {
    if (provider === "monobank" && order.payment?.invoiceId) {
      const status = await monobank.getInvoiceStatus(order.payment.invoiceId);
      const state = monoRefundState(monoRefundsFor(status, extRef));
      if (!state) return { state: "failed", provider, error: "Операцію повернення в monobank не знайдено" };
      return { state, provider };
    }
  } catch (error) {
    return { state: "processing", provider, error: error.message };
  }
  return { state: "processing", provider };
}

module.exports = {
  refundPayment,
  syncRefund,
  PaymentError,
  availableMethods,
  isMethodAvailable,
  markOrderPaid,
  startPayment,
  applyResult,
  handleMonobankWebhook,
  handleLiqpayCallback,
  verifyOrderPayment,
  completeMockPayment,
};
