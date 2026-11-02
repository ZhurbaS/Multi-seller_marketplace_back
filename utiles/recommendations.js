// «Рекомендовано для вас» у кошику.
// Гібрид: «часто купують разом» (co-purchase з реальних замовлень) + той самий розділ + популярність/рейтинг
// + відповідність ціні кошика. Лише товари в наявності; кількість залишків назовні не віддаємо.
// Нерелевантні картки не додаємо (щоб не «забивати» кошик): кількість не фіксована, до MAX.

const mongoose = require("mongoose");

const MAX = 12;
const MAX_PER_BRAND = 4;
const MIN_SCORE = 0.18;
const ORDERS_WINDOW = 1000;
const POPULARITY_DAYS = 90;

const effectivePrice = (p) => {
  const d = Number(p.discount) || 0;
  return d > 0 ? Math.round(Number(p.price) * (1 - d / 100) * 100) / 100 : Number(p.price);
};

// Чиста функція оцінювання (тестується без БД).
// cart: [{_id, category, price, discount}], candidates: [{_id, category, brand, rating, price, discount}],
// co: Map(id → к-сть спільних замовлень), pop: Map(id → к-сть замовлень за період)
function rankCandidates({ cart, candidates, co = new Map(), pop = new Map() }) {
  const cartIds = new Set(cart.map((c) => String(c._id)));
  const cartCats = new Set(cart.map((c) => String(c.category)));
  const prices = cart.map(effectivePrice).filter((n) => n > 0);
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const maxCo = Math.max(1, ...[...co.values()]);
  const maxPop = Math.max(1, ...[...pop.values()]);

  const scored = [];
  for (const p of candidates) {
    const id = String(p._id);
    if (cartIds.has(id)) continue;
    const coN = (co.get(id) || 0) / maxCo;
    const sameCat = cartCats.has(String(p.category)) ? 1 : 0;
    const popN = (pop.get(id) || 0) / maxPop;
    const rate = Math.min(Math.max(Number(p.rating) || 0, 0), 5) / 5;
    const price = effectivePrice(p);
    // Ціна в «розумному» діапазоні від середньої по кошику; аксесуари (дешевші) не штрафуємо
    let fit = 1;
    if (avg > 0 && price > avg * 1.5) fit = price > avg * 3 ? 0 : 0.5;
    if (fit === 0) continue;
    const score = 0.45 * coN + 0.25 * sameCat + 0.15 * popN + 0.1 * rate + 0.05 * fit;
    // Без жодного поведінкового чи категорійного сигналу — не рекомендуємо
    if (coN === 0 && !sameCat && popN === 0) continue;
    if (score < MIN_SCORE) continue;
    scored.push({ p, score, reason: coN > 0 ? "together" : sameCat ? "category" : "popular" });
  }
  scored.sort((a, b) => b.score - a.score || String(a.p._id).localeCompare(String(b.p._id)));

  const perBrand = new Map();
  const out = [];
  for (const s of scored) {
    const b = String(s.p.brand || "").toLowerCase();
    if ((perBrand.get(b) || 0) >= MAX_PER_BRAND) continue;
    perBrand.set(b, (perBrand.get(b) || 0) + 1);
    out.push(s);
    if (out.length >= MAX) break;
  }
  return out;
}

const REASONS = { together: "Часто купують разом", category: "З вашої категорії", popular: "Популярне" };

async function recommendForCart(ids) {
  const productModel = require("../models/productModel");
  const customerOrderModel = require("../models/customerOrderModel");

  const cartIds = [...new Set((ids || []).map(String))]
    .filter((i) => mongoose.Types.ObjectId.isValid(i))
    .slice(0, 30);
  if (!cartIds.length) return [];

  const cart = await productModel
    .find({ _id: { $in: cartIds } })
    .select("category price discount")
    .lean();
  if (!cart.length) return [];
  const cats = [...new Set(cart.map((c) => String(c.category)))];

  // «Часто купують разом»: інші товари з тих самих замовлень (без скасованих)
  const co = new Map();
  const orders = await customerOrderModel
    .find({ "products._id": { $in: cart.map((c) => c._id) }, delivery_status: { $ne: "cancelled" } })
    .select("products._id")
    .sort({ createdAt: -1 })
    .limit(ORDERS_WINDOW)
    .lean();
  for (const o of orders) {
    for (const op of o.products || []) {
      const id = String(op._id);
      if (cartIds.includes(id)) continue;
      co.set(id, (co.get(id) || 0) + 1);
    }
  }

  // Популярність за період
  const pop = new Map();
  const since = new Date(Date.now() - POPULARITY_DAYS * 24 * 3600 * 1000);
  const agg = await customerOrderModel.aggregate([
    { $match: { createdAt: { $gte: since }, delivery_status: { $ne: "cancelled" } } },
    { $unwind: "$products" },
    { $group: { _id: "$products._id", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 200 },
  ]);
  for (const a of agg) pop.set(String(a._id), a.n);

  const wantIds = [...new Set([...co.keys(), ...pop.keys()])]
    .filter((i) => mongoose.Types.ObjectId.isValid(i))
    .slice(0, 300);
  const candidates = await productModel
    .find({
      stock: { $gt: 0 },
      _id: { $nin: cartIds },
      $or: [{ _id: { $in: wantIds } }, { category: { $in: cats.filter((c) => mongoose.Types.ObjectId.isValid(c)) } }],
    })
    .sort({ rating: -1 })
    .limit(150)
    .select("name slug price discount images rating brand category minOrderQty orderStep packLabel shopName")
    .lean();

  return rankCandidates({ cart, candidates, co, pop }).map(({ p, reason }) => ({
    _id: p._id,
    name: p.name,
    slug: p.slug,
    price: p.price,
    discount: p.discount || 0,
    image: (p.images && p.images[0]) || "",
    rating: p.rating || 0,
    brand: p.brand,
    packLabel: p.packLabel || "",
    reason: REASONS[reason],
  }));
}

module.exports = { rankCandidates, recommendForCart, effectivePrice };
