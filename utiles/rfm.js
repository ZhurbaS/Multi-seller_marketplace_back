// RFM-аналіз (MARKETING_SPEC.md §4). R — днів від останнього замовлення (менше — краще),
// F — кількість замовлень, M — сума (₴). Бали 1–5: квінтилі поточної бази; якщо контактів із
// замовленнями < 10 — фіксовані пороги. Верхня частина — чисті функції, recomputeAll() — БД.

const DAY = 24 * 60 * 60 * 1000;
const MIN_FOR_QUINTILES = 10;

// Межі між балами (4 межі → 5 кошиків)
const FIXED = {
  r: [30, 60, 120, 240], // днів: ≤30 → 5 … >240 → 1
  f: [1, 2, 3, 5], // ≤1 → 1, 2 → 2, 3 → 3, 4–5 → 4, >5 → 5
  m: [2000, 5000, 15000, 40000], // ₴: ≤2000 → 1 … >40000 → 5
};

const SEGMENTS = ["champions", "loyal", "new", "promising", "at_risk", "hibernating", "lost"];
const SEGMENT_LABELS = {
  champions: "Чемпіони",
  loyal: "Лояльні",
  new: "Нові",
  promising: "Перспективні",
  at_risk: "Під ризиком",
  hibernating: "Сплячі",
  lost: "Втрачені",
};

// Квантиль (лінійна інтерполяція) відсортованого масиву
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// 4 межі квінтилів (20/40/60/80%)
function quintiles(values) {
  const s = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return [0.2, 0.4, 0.6, 0.8].map((q) => quantile(s, q));
}

// Бал 1–5 за межами. higherIsBetter=true: значення > межі піднімає бал; false (R): менше — краще
function score(value, cuts, higherIsBetter = true) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 1;
  const above = cuts.filter((c) => v > c).length; // 0..4
  return higherIsBetter ? 1 + above : 5 - above;
}

function segmentName(r, f) {
  if (r >= 4 && f >= 4) return "champions";
  if (f >= 3 && r >= 3) return "loyal";
  if (f === 1 && r >= 4) return "new";
  if (r >= 3 && f <= 2) return "promising";
  if (r <= 2 && f >= 3) return "at_risk";
  if (r === 1 && f === 1) return "lost";
  return "hibernating"; // r ≤ 2, f ≤ 2
}

const daysSince = (date, now) => Math.max(0, Math.floor((now - new Date(date).getTime()) / DAY));

// rows: [{ id, lastOrderAt, count, sum }] → [{ id, r, f, m, segment, recencyDays }], method
function computeScores(rows, { now = Date.now() } = {}) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const list = (rows || []).filter((x) => x && Number(x.count) > 0 && x.lastOrderAt);
  const recency = list.map((x) => daysSince(x.lastOrderAt, t));
  const useQ = list.length >= MIN_FOR_QUINTILES;
  const cuts = useQ
    ? { r: quintiles(recency), f: quintiles(list.map((x) => Number(x.count))), m: quintiles(list.map((x) => Number(x.sum) || 0)) }
    : FIXED;
  const items = list.map((x, i) => {
    const r = score(recency[i], cuts.r, false);
    const f = score(Number(x.count), cuts.f, true);
    const m = score(Number(x.sum) || 0, cuts.m, true);
    return { id: x.id, r, f, m, segment: segmentName(r, f), recencyDays: recency[i] };
  });
  return { method: useQ ? "quintiles" : "fixed", cuts, items };
}

// ======================= БД =======================

// Оплачені або виконані (не скасовані) замовлення
const ORDER_MATCH = {
  delivery_status: { $ne: "cancelled" },
  $or: [{ payment_status: "paid" }, { delivery_status: "delivered" }],
};

let running = null;

async function doRecompute({ now = Date.now() } = {}) {
  const Contact = require("../models/contactModel");
  const customerOrderModel = require("../models/customerOrderModel");

  const agg = await customerOrderModel.aggregate([
    { $match: ORDER_MATCH },
    { $group: { _id: "$customerId", lastOrderAt: { $max: "$createdAt" }, count: { $sum: 1 }, sum: { $sum: "$price" } } },
  ]);
  const byCustomer = new Map(agg.map((a) => [String(a._id), a]));

  const contacts = await Contact.find({ customerId: { $ne: null }, anonymized: { $ne: true } })
    .select("_id customerId")
    .lean();
  const rows = [];
  for (const c of contacts) {
    const a = byCustomer.get(String(c.customerId));
    if (a) rows.push({ id: c._id, lastOrderAt: a.lastOrderAt, count: a.count, sum: a.sum });
  }
  const { method, items } = computeScores(rows, { now });
  const at = new Date(now);
  const ops = items.map((x) => ({
    updateOne: {
      filter: { _id: x.id },
      update: { $set: { "stats.rfm": { r: x.r, f: x.f, m: x.m, segment: x.segment, computedAt: at } } },
    },
  }));
  for (let i = 0; i < ops.length; i += 500) await Contact.bulkWrite(ops.slice(i, i + 500), { ordered: false });

  // У кого більше немає оплачених замовлень — прибираємо сегмент
  const scored = new Set(items.map((x) => String(x.id)));
  const stale = await Contact.find({ "stats.rfm.segment": { $exists: true, $ne: null } })
    .select("_id")
    .lean();
  const staleIds = stale.map((c) => c._id).filter((id) => !scored.has(String(id)));
  if (staleIds.length) await Contact.updateMany({ _id: { $in: staleIds } }, { $unset: { "stats.rfm": "" } });

  const bySegment = {};
  for (const x of items) bySegment[x.segment] = (bySegment[x.segment] || 0) + 1;
  return { updated: items.length, cleared: staleIds.length, method, bySegment, computedAt: at };
}

// Гард від паралельного запуску (кнопка в адмінці + нічна задача)
function recomputeAll(opts) {
  if (!running) running = doRecompute(opts).finally(() => (running = null));
  return running;
}

module.exports = {
  FIXED,
  SEGMENTS,
  SEGMENT_LABELS,
  MIN_FOR_QUINTILES,
  ORDER_MATCH,
  quantile,
  quintiles,
  score,
  segmentName,
  computeScores,
  recomputeAll,
};
