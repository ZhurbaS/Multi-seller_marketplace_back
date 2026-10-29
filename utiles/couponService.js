// Купони: правила, перевірка, атомарне резервування і журнал використань.
//
// Принципи:
//  - сума знижки рахується ТІЛЬКИ на сервері від суми товарів у БД;
//  - ліміти (загальний і на одного покупця) перевіряються атомарно (умовні $inc),
//    тому два одночасні замовлення не «перепригнуть» ліміт;
//  - купон фінансує магазин: продавцям нараховується повна сума їхніх товарів;
//  - купон не складається з автоматичною знижкою за сумою замовлення — діє більша з двох;
//  - повідомлення покупцю про невідомий/прострочений/вичерпаний купон однакове,
//    щоб не можна було перебором дізнатися, які коди існують.

const couponModel = require("../models/couponModel");
const couponUsageModel = require("../models/couponUsageModel");
const couponRedemptionModel = require("../models/couponRedemptionModel");
const customerOrderModel = require("../models/customerOrderModel");

const CODE_RE = /^[A-Z0-9_-]{3,32}$/;
const GENERIC = "Купон недійсний або не діє";
const ALREADY_USED = "Ви вже використали цей купон";

const normalizeCode = (c) => String(c || "").trim().toUpperCase().replace(/\s+/g, "");

// Без символів, які легко сплутати (0/O, 1/I/L).
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateCode(length = 8, random = Math.random) {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return out;
}

// Знижка в цілих гривнях. Платіж завжди лишається > 0 (мінімум ₴1).
function computeDiscount(coupon, subtotal) {
  const base = Number(subtotal) || 0;
  if (base <= 1) return 0;
  let d =
    coupon.type === "percent"
      ? Math.floor((base * Number(coupon.value)) / 100)
      : Math.floor(Number(coupon.value));
  if (coupon.type === "percent" && coupon.maxDiscount > 0) {
    d = Math.min(d, coupon.maxDiscount);
  }
  d = Math.min(d, base - 1);
  return Math.max(0, d);
}

// Правила, що не потребують запитів до БД (крім лічильника usedCount, який вже в документі).
function checkStatic(coupon, { subtotal }, now = new Date()) {
  if (!coupon || !coupon.active) return { ok: false, message: GENERIC };
  if (coupon.startsAt && new Date(coupon.startsAt) > now) return { ok: false, message: GENERIC };
  if (coupon.endsAt && new Date(coupon.endsAt) < now) return { ok: false, message: GENERIC };
  if (coupon.totalLimit != null && coupon.usedCount >= coupon.totalLimit) {
    return { ok: false, message: GENERIC };
  }
  if (coupon.minSubtotal > 0 && subtotal < coupon.minSubtotal) {
    return { ok: false, message: `Купон діє для замовлень від ₴${coupon.minSubtotal}` };
  }
  return { ok: true };
}

// Перевірка без резервування (для кошика й підтвердження на оформленні).
// autoDiscount — знижка за сумою замовлення; купон застосовується, лише якщо вона більша.
async function evaluate({ code, customerId, subtotal, autoDiscount = 0, now = new Date() }) {
  const norm = normalizeCode(code);
  if (!CODE_RE.test(norm)) return { ok: false, message: GENERIC };
  const coupon = await couponModel.findOne({ code: norm }).lean();
  const st = checkStatic(coupon, { subtotal }, now);
  if (!st.ok) return st;

  if (coupon.perCustomerLimit != null) {
    const usage = await couponUsageModel.findOne({ couponId: coupon._id, customerId }).lean();
    if (usage && usage.count >= coupon.perCustomerLimit) {
      return { ok: false, message: ALREADY_USED };
    }
  }
  if (coupon.firstOrderOnly) {
    const previous = await customerOrderModel.countDocuments({
      customerId,
      delivery_status: { $ne: "cancelled" },
    });
    if (previous > 0) {
      return { ok: false, message: "Купон діє лише для першого замовлення" };
    }
  }
  const discount = computeDiscount(coupon, subtotal);
  if (discount <= 0) return { ok: false, message: GENERIC };
  return { ok: true, coupon, discount, beatsAuto: discount > autoDiscount };
}

// Атомарно займає одне використання. Повертає { ok } або { ok:false, message }.
async function reserve(coupon, customerId) {
  const filter = { _id: coupon._id, active: true };
  if (coupon.totalLimit != null) filter.usedCount = { $lt: coupon.totalLimit };
  const updated = await couponModel.findOneAndUpdate(
    filter,
    { $inc: { usedCount: 1 } },
    { new: true }
  );
  if (!updated) return { ok: false, message: GENERIC };

  const usageFilter = { couponId: coupon._id, customerId };
  if (coupon.perCustomerLimit != null) usageFilter.count = { $lt: coupon.perCustomerLimit };
  // Два одночасні upsert-и першого використання можуть дати «дублікат ключа» навіть коли
  // ліміт не вичерпано — тому одну повторну спробу робимо; друга відмова = ліміт досягнуто.
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await couponUsageModel.findOneAndUpdate(
        usageFilter,
        { $inc: { count: 1 } },
        { upsert: true, new: true }
      );
      return { ok: true };
    } catch (error) {
      lastError = error;
      if (!(error && error.code === 11000)) break;
    }
  }
  await couponModel.updateOne({ _id: coupon._id, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
  if (lastError && lastError.code === 11000) return { ok: false, message: ALREADY_USED };
  throw lastError;
}

// Повертає використання (замовлення не створилось або скасоване).
async function giveBack(couponId, customerId) {
  await couponModel.updateOne({ _id: couponId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
  await couponUsageModel.updateOne({ couponId, customerId, count: { $gt: 0 } }, { $inc: { count: -1 } });
}

async function recordRedemption({ coupon, customerId, orderId, amount, orderTotal }) {
  return couponRedemptionModel.create({
    couponId: coupon._id,
    code: coupon.code,
    campaign: coupon.campaign || "",
    customerId,
    orderId,
    amount,
    orderTotal,
    status: "reserved",
    rules: {
      type: coupon.type,
      value: coupon.value,
      maxDiscount: coupon.maxDiscount,
      minSubtotal: coupon.minSubtotal,
    },
  });
}

// Оплата отримана (або «оплата при отриманні» завершена) — купон використано.
async function markRedeemed(orderId) {
  await couponRedemptionModel.updateMany(
    { orderId, status: "reserved" },
    { $set: { status: "redeemed", redeemedAt: new Date() } }
  );
}

// Замовлення скасоване — купон знову доступний (ідемпотентно).
async function releaseForOrder(orderId) {
  const r = await couponRedemptionModel.findOneAndUpdate(
    { orderId, status: { $in: ["reserved", "redeemed"] } },
    { $set: { status: "released", releasedAt: new Date() } }
  );
  if (!r) return false;
  await giveBack(r.couponId, r.customerId);
  return true;
}

// Скасоване замовлення відновлено (напр. гроші прийшли після автоскасування) —
// знову займаємо використання без перевірки лімітів (рішення вже прийняте).
async function reacquireForOrder(orderId) {
  const r = await couponRedemptionModel.findOneAndUpdate(
    { orderId, status: "released" },
    { $set: { status: "reserved", releasedAt: null } }
  );
  if (!r) return false;
  await couponModel.updateOne({ _id: r.couponId }, { $inc: { usedCount: 1 } });
  await couponUsageModel.findOneAndUpdate(
    { couponId: r.couponId, customerId: r.customerId },
    { $inc: { count: 1 } },
    { upsert: true }
  );
  return true;
}

// ---------- Валідація даних від адміна ----------

const toDateOrNull = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "__invalid__" : d;
};
const toIntOrNull = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

// → { value } | { error }
function sanitizeCoupon(body = {}, { requireCode = true } = {}) {
  const out = {};
  const code = normalizeCode(body.code);
  if (requireCode || code) {
    if (!CODE_RE.test(code)) {
      return { error: "Код: 3–32 символи — латинські літери, цифри, «-» або «_»" };
    }
    out.code = code;
  }
  out.title = String(body.title || "").trim().slice(0, 100);
  out.campaign = String(body.campaign || "").trim().slice(0, 50);

  if (!["percent", "fixed"].includes(body.type)) return { error: "Оберіть тип знижки" };
  out.type = body.type;
  const value = Number(body.value);
  if (!Number.isFinite(value) || value <= 0) return { error: "Розмір знижки має бути більшим за 0" };
  if (out.type === "percent") {
    if (value > 90) return { error: "Відсоткова знижка: від 1 до 90%" };
    out.value = value;
  } else {
    if (!Number.isInteger(value)) return { error: "Фіксована знижка — ціле число гривень" };
    out.value = value;
  }

  const maxDiscount = toIntOrNull(body.maxDiscount);
  if (maxDiscount !== null) {
    if (!Number.isInteger(maxDiscount) || maxDiscount < 1) {
      return { error: "Стеля знижки — ціле число гривень від 1" };
    }
  }
  out.maxDiscount = out.type === "percent" ? maxDiscount : null;

  const minSubtotal = toIntOrNull(body.minSubtotal) ?? 0;
  if (!Number.isInteger(minSubtotal) || minSubtotal < 0) {
    return { error: "Мінімальна сума замовлення — ціле число від 0" };
  }
  out.minSubtotal = minSubtotal;
  if (out.type === "fixed" && minSubtotal > 0 && out.value >= minSubtotal) {
    return { error: "Фіксована знижка має бути меншою за мінімальну суму замовлення" };
  }

  const startsAt = toDateOrNull(body.startsAt);
  const endsAt = toDateOrNull(body.endsAt);
  if (startsAt === "__invalid__" || endsAt === "__invalid__") return { error: "Некоректна дата" };
  if (startsAt && endsAt && endsAt <= startsAt) {
    return { error: "Дата завершення має бути пізнішою за дату початку" };
  }
  out.startsAt = startsAt;
  out.endsAt = endsAt;

  const totalLimit = toIntOrNull(body.totalLimit);
  if (totalLimit !== null && (!Number.isInteger(totalLimit) || totalLimit < 1)) {
    return { error: "Загальний ліміт — ціле число від 1 (або порожньо)" };
  }
  out.totalLimit = totalLimit;

  const firstOrderOnly = body.firstOrderOnly === true || body.firstOrderOnly === "true";
  out.firstOrderOnly = firstOrderOnly;
  let perCustomer = body.perCustomerLimit === undefined ? 1 : toIntOrNull(body.perCustomerLimit);
  if (firstOrderOnly) perCustomer = 1;
  if (perCustomer !== null && (!Number.isInteger(perCustomer) || perCustomer < 1)) {
    return { error: "Ліміт на покупця — ціле число від 1 (або порожньо)" };
  }
  out.perCustomerLimit = perCustomer;

  if (body.active !== undefined) out.active = body.active === true || body.active === "true";
  return { value: out };
}

module.exports = {
  GENERIC,
  ALREADY_USED,
  normalizeCode,
  generateCode,
  computeDiscount,
  checkStatic,
  evaluate,
  reserve,
  giveBack,
  recordRedemption,
  markRedeemed,
  releaseForOrder,
  reacquireForOrder,
  sanitizeCoupon,
};
