// Листи покупцю про хід замовлення: оформлено → оплачено → в обробці → відправлено → доставлено / скасовано.
// Кожна подія надсилається не більше одного разу (атомарна позначка в order.notifiedEvents).
// Помилки пошти не впливають на замовлення.

const customerOrderModel = require("../models/customerOrderModel");
const customerModel = require("../models/customerModel");
const mailer = require("./mailer");
const { orderLabel } = require("./orderNumber");

const front = () => (process.env.PUBLIC_FRONT_URL || "").replace(/\/+$/, "");

const PAY_METHOD = {
  monobank: "картка (monobank)",
  liqpay: "картка (LiqPay)",
  mock: "тестова оплата",
  cod: "оплата при отриманні",
  invoice: "за рахунком (безготівковий розрахунок)",
};

const DELIVERY = {
  nova_poshta_warehouse: "Нова пошта, відділення",
  nova_poshta_postomat: "Нова пошта, поштомат",
  nova_poshta_courier: "Нова пошта, курєр",
  ukrposhta: "Укрпошта",
  pickup: "Самовивіз",
};

function lines(order) {
  return (order.products || [])
    .map((p) => `• ${p.name} — ${p.quantity} шт × ₴${p.unitPrice ?? p.price}`)
    .join("\n");
}

function where(order) {
  const si = order.shippingInfo || {};
  const parts = [si.city, si.warehouse, si.address].filter(Boolean).join(", ");
  return `${DELIVERY[si.deliveryType] || "Доставка"}${parts ? `: ${parts}` : ""}`;
}

const link = (order) => (front() ? `\nСтатус замовлення: ${front()}/dashboard/order/details/${order._id}\n` : "");

const TEXTS = {
  placed: (o) => ({
    subject: `Замовлення ${orderLabel(o)} оформлено`,
    text:
      `Дякуємо за замовлення!\n\nНомер: ${orderLabel(o)}\n${lines(o)}\n\nСума: ₴${o.price}\n` +
      `${o.payment_method ? `Оплата: ${PAY_METHOD[o.payment_method] || o.payment_method}\n` : ""}${where(o)}\n` +
      `Вартість доставки — за тарифами перевізника, оплачується при отриманні.\n${link(o)}` +
      (o.legalAcceptance && front()
        ? `\nУмови договору: публічна оферта (редакція №${o.legalAcceptance.version}) — ${front()}/oferta\n`
        : "") +
      `\nЦей лист підтверджує замовлення та його умови.`,
  }),
  paid: (o) => ({
    subject: `Замовлення ${orderLabel(o)} оплачено`,
    text: `Оплату замовлення ${orderLabel(o)} на ₴${o.price} отримано. Ми передаємо його в обробку.\n${link(o)}`,
  }),
  processing: (o) => ({
    subject: `Замовлення ${orderLabel(o)} прийнято в обробку`,
    text: `Замовлення ${orderLabel(o)} опрацьовується, ми його комплектуємо.\n${link(o)}`,
  }),
  shipped: (o) => ({
    subject: `Замовлення ${orderLabel(o)} відправлено`,
    text:
      `Замовлення ${orderLabel(o)} відправлено.\n${where(o)}\n` +
      (o.trackingNumber ? `Номер накладної (ТТН): ${o.trackingNumber}\n` : "") +
      `${link(o)}`,
  }),
  delivered: (o) => ({
    subject: `Замовлення ${orderLabel(o)} доставлено`,
    text: `Замовлення ${orderLabel(o)} доставлено. Дякуємо, що обрали нас! Якщо щось не так — подайте заявку на повернення в особистому кабінеті.\n${link(o)}`,
  }),
  cancelled: (o) => ({
    subject: `Замовлення ${orderLabel(o)} скасовано`,
    text:
      `Замовлення ${orderLabel(o)} скасовано.` +
      (o.payment_status === "paid" ? " Кошти буде повернено тим самим способом, яким здійснювалась оплата." : "") +
      `\n${link(o)}`,
  }),
};

async function notify(orderId, event) {
  try {
    if (!TEXTS[event]) return false;
    // Атомарно «забираємо» подію: повторний виклик нічого не надішле
    const order = await customerOrderModel.findOneAndUpdate(
      { _id: orderId, notifiedEvents: { $ne: event } },
      { $addToSet: { notifiedEvents: event } },
      { new: true }
    );
    if (!order) return false;
    const c = await customerModel.findById(order.customerId).select("email").lean();
    if (!c?.email) return false;
    const { subject, text } = TEXTS[event](order);
    const ok = await mailer.sendMail({ to: c.email, subject, text });
    if (!ok) {
      // лист не пішов — дозволяємо повторити подію пізніше
      await customerOrderModel.updateOne({ _id: orderId }, { $pull: { notifiedEvents: event } });
    }
    return ok;
  } catch (e) {
    console.error("📧 orderNotify:", e.message);
    return false;
  }
}

// Статус, змінений адміном/продавцем → відповідна подія (лише ті, що цікаві покупцю)
const STATUS_EVENTS = ["processing", "shipped", "delivered", "cancelled"];
const notifyStatus = (orderId, status) => (STATUS_EVENTS.includes(status) ? notify(orderId, status) : false);

module.exports = { notify, notifyStatus, TEXTS };
