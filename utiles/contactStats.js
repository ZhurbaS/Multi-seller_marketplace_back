// Синхронізація CRM-контакту з даними покупця: статистика замовлень (MARKETING_SPEC.md §1 stats, §6)
// і зміна e-mail. Чисті функції — вгорі (покриті тестами), робота з БД — нижче.
// Викликати у try/catch / через *Safe-варіанти: помилка CRM не повинна ламати оплату чи зміну пошти.

const MAX_CATEGORIES = 10;

// ======================= чисті функції =======================

const isCancelled = (o) => o?.delivery_status === "cancelled";
// Оплачене й не скасоване (скасоване оплачене = повернення коштів, у LTV не враховуємо)
const isPaid = (o) => o?.payment_status === "paid" && !isCancelled(o);

function orderDate(o) {
  const cand = [o?.createdAt, o?.payment?.paidAt, o?.date];
  for (const v of cand) {
    if (!v) continue;
    const d = new Date(v);
    if (Number.isFinite(d.getTime())) return d;
  }
  return null;
}

// Сума замовлення для LTV: price мінус повернене
function orderValue(o) {
  const price = Number(o?.price) || 0;
  const refunded = Number(o?.refunded_total) || 0;
  return Math.max(0, price - refunded);
}

const round2 = (n) => Math.round(n * 100) / 100;

// Ключ категорії позиції замовлення: ObjectId/рядок-id або назва
function categoryKey(item) {
  const c = item?.category;
  if (!c) return "";
  if (typeof c === "object" && c._id) return String(c._id);
  return String(c);
}

// items → [{key, count}] (count — кількість одиниць), відсортовано за спаданням
function countCategories(orders) {
  const m = new Map();
  for (const o of orders || []) {
    for (const it of Array.isArray(o?.products) ? o.products : []) {
      const k = categoryKey(it);
      if (!k) continue;
      const q = Math.max(1, Math.round(Number(it.quantity) || 1));
      m.set(k, (m.get(k) || 0) + q);
    }
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

// orders → stats-об'єкт контакту. names: Map|об'єкт id→назва категорії (якщо ключ — id)
function computeStats(orders, { names } = {}) {
  const list = Array.isArray(orders) ? orders : [];
  const live = list.filter((o) => !isCancelled(o));
  const paid = list.filter(isPaid);
  const ltv = round2(paid.reduce((s, o) => s + orderValue(o), 0));
  const dates = paid.map(orderDate).filter(Boolean).sort((a, b) => a - b);
  const nameOf = (k) => (names instanceof Map ? names.get(k) : names?.[k]) || (/^[a-f\d]{24}$/i.test(k) ? "" : k);
  const categories = countCategories(paid)
    .map(({ key, count }) => ({ name: nameOf(key), count }))
    .filter((c) => c.name)
    .slice(0, MAX_CATEGORIES);
  return {
    orders: live.length,
    paidOrders: paid.length,
    ltv,
    avgOrder: paid.length ? round2(ltv / paid.length) : 0,
    firstOrderAt: dates[0] || undefined,
    lastOrderAt: dates.at(-1) || undefined,
    categories,
  };
}

// ======================= БД =======================

const Contact = () => require("../models/contactModel");

async function categoryNames(orders) {
  const ids = [...new Set(countCategories(orders).map((c) => c.key))].filter((k) => /^[a-f\d]{24}$/i.test(k));
  if (!ids.length) return new Map();
  const rows = await require("../models/categoryModel").find({ _id: { $in: ids } }).select("name").lean();
  return new Map(rows.map((r) => [String(r._id), r.name]));
}

// Перерахунок stats для контакту покупця (rfm не чіпаємо — його рахує utiles/rfm.js).
// Немає контакту → створюємо CRM-запис зі статусом 'none' (якщо в покупця є e-mail/телефон).
async function refreshStats(customerId) {
  if (!customerId) return null;
  const orders = await require("../models/customerOrderModel")
    .find({ customerId })
    .select("price refunded_total payment_status delivery_status createdAt date payment.paidAt products.category products.quantity")
    .lean();
  const stats = computeStats(orders, { names: await categoryNames(orders.filter(isPaid)) });

  let doc = await Contact().findOne({ customerId });
  if (!doc) {
    const customer = await require("../models/customerModel").findById(customerId).select("name email phone isGuest savedCompanies").lean();
    if (!customer || (!customer.email && !customer.phone)) return null;
    doc = await require("./contactService").upsertFromCustomer({ customer, source: "customer", explicit: false });
    if (!doc) return null;
  }
  const rfm = doc.stats?.rfm && typeof doc.stats.rfm.toObject === "function" ? doc.stats.rfm.toObject() : doc.stats?.rfm;
  doc.stats = { ...stats, ...(rfm ? { rfm } : {}) };
  if (stats.lastOrderAt && (!doc.lastActivityAt || new Date(doc.lastActivityAt) < stats.lastOrderAt)) doc.lastActivityAt = stats.lastOrderAt;
  await doc.save();
  return doc;
}

// Неблокуючий виклик для інтеграцій (оплата, статуси замовлень)
function refreshStatsSafe(customerId) {
  return refreshStats(customerId).catch((e) => {
    console.error("⚠️ contactStats.refreshStats:", e.message);
    return null;
  });
}

// Покупець змінив e-mail → оновлюємо Contact.email. Якщо нова адреса вже в іншого контакту — зливаємо
// (строгіші статуси перемагають, див. contactService.mergeContacts).
async function syncCustomerEmail(customerId, newEmail, { oldEmail } = {}) {
  const cs = require("./contactService");
  const e = cs.normalizeEmail(newEmail || "");
  if (!customerId || !e) return null;
  const M = Contact();
  let doc = await M.findOne({ customerId });
  if (!doc && oldEmail) {
    const o = cs.normalizeEmail(oldEmail);
    if (o) doc = await M.findOne({ email: o });
  }
  const other = await M.findOne({ email: e, ...(doc ? { _id: { $ne: doc._id } } : {}) });
  if (!doc) {
    if (other) {
      if (!other.customerId) {
        other.customerId = customerId;
        await other.save();
      }
      return other;
    }
    const customer = await require("../models/customerModel").findById(customerId).select("name email phone savedCompanies").lean();
    return cs.upsertFromCustomer({ customer: { ...(customer || {}), _id: customerId, email: e }, source: "customer" });
  }
  if (other) doc = await cs.mergeContacts(doc, other);
  doc.email = e;
  doc.lastActivityAt = new Date();
  await doc.save();
  return doc;
}

// Реєстрація / гостьове оформлення / Google (§6): CRM-контакт; marketing===true → явна згода (subscribed).
// Ніколи не кидає — помилка маркетингу не повинна ламати реєстрацію чи вхід.
async function syncCustomerSafe({ customer, source, marketing, req } = {}) {
  try {
    if (!customer) return null;
    const s = await require("./marketingSettings")
      .load()
      .catch(() => require("./marketingSettings").DEFAULTS);
    return await require("./contactService").upsertFromCustomer({
      customer,
      source,
      explicit: marketing === true,
      text: s.consentText.checkout,
      textVersion: s.consentText.version,
      ip: req?.ip || "",
      userAgent: String(req?.get?.("user-agent") || "").slice(0, 500),
    });
  } catch (e) {
    console.error("⚠️ CRM-контакт для покупця:", e.message);
    return null;
  }
}

function syncCustomerEmailSafe(customerId, newEmail, opts) {
  return syncCustomerEmail(customerId, newEmail, opts).catch((e) => {
    console.error("⚠️ contactStats.syncCustomerEmail:", e.message);
    return null;
  });
}

module.exports = {
  syncCustomerSafe,
  syncCustomerEmailSafe,
  isPaid,
  orderDate,
  orderValue,
  countCategories,
  computeStats,
  refreshStats,
  refreshStatsSafe,
  syncCustomerEmail,
};
