// Зміна отримувача й доставки покупцем, поки замовлення не відправлене.
// Чисті функції без БД — маршрут у controllers/order/shippingEditController.js.

// Статуси, у яких зміну ще можна прийняти (замовлення не передано перевізнику)
const EDITABLE = ["pending", "placed", "processing", "packing"];

// Чому змінити не можна ("" — можна). subs — підзамовлення продавців.
function editBlocker(order, subs = []) {
  if (!order) return "Замовлення не знайдено";
  if (order.delivery_status === "cancelled") return "Замовлення скасовано";
  if (!EDITABLE.includes(order.delivery_status)) {
    return "Замовлення вже відправлено або доставлено — змінити отримувача й доставку не можна";
  }
  if (order.trackingNumber) return "Для замовлення вже створено накладну — змінити доставку не можна. Зв'яжіться з магазином";
  if (subs.some((s) => ["shipped", "delivered"].includes(s.delivery_status))) {
    return "Частину замовлення вже відправлено — змінити доставку не можна. Зв'яжіться з магазином";
  }
  return "";
}

const TYPE = {
  nova_poshta_warehouse: "Нова пошта, відділення",
  nova_poshta_postomat: "Нова пошта, поштомат",
  nova_poshta_courier: "Нова пошта, курєр",
  ukrposhta: "Укрпошта",
  pickup: "Самовивіз",
};

// Коротко для листів і історії змін
function describe(si = {}) {
  const r = si.recipient?.other ? `${si.recipient.lastName} ${si.recipient.firstName}, ${si.recipient.phone}` : `${si.name}, ${si.phone}`;
  const place = [si.city, si.warehouse, si.address].filter(Boolean).join(", ");
  return `Отримувач: ${r}\nДоставка: ${TYPE[si.deliveryType] || "—"}${place ? `: ${place}` : ""}`;
}

// Чи змінилось щось суттєве
const changed = (a, b) => JSON.stringify(a || {}) !== JSON.stringify(b || {});

module.exports = { EDITABLE, editBlocker, describe, changed };
