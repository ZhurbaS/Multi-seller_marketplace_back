// Аналітика продавця — /api/seller/analytics/* (DASHBOARD_SPEC.md §3).
//
// Семантика (перевірено за моделями/контролерами проєкту):
//  - Одиниця продажу продавця — підзамовлення authOrders (authorOrderModel): sellerId, price (сума товарів
//    продавця ДО знижки за сумою/купона — знижки фінансує магазин), payout (price − commission; у старих
//    замовлень поля немає → price), products[] (знімок: _id, quantity, unitPrice|price+discount, category).
//  - «Оплачено/зараховано у виручку» — та сама логіка, що rfm.ORDER_MATCH / ledger: delivery_status ≠ 'cancelled'
//    І (payment_status = 'paid' АБО delivery_status = 'delivered'). markOrderPaid проставляє payment_status 'paid'
//    і в підзамовлення; COD стає 'paid' після доставки. «Виконано» — delivery_status = 'delivered' (deliveredAt).
//  - Дата замовлення — createdAt (timestamps). Поле `date` — рядок moment("LLL") для показу, для фільтрів НЕ годиться.
//    Групування за днями/тижнями/місяцями — $dateTrunc з timezone Europe/Kyiv (потрібен MongoDB ≥ 5.0).
//  - authOrders.orderId → customerOrders._id: звідти customerId (покупець), shippingInfo.district (область),
//    payment_method, coupon{code,amount}, goods_total. Гості теж мають customerId (м'який гостьовий акаунт
//    customers.isGuest), тож новий/повторний визначаємо за customerId; контакт-хеш не потрібен.
//    Новий — перше зараховане замовлення в цього продавця припадає на період; повторний — перше було раніше.
//  - Повернення — returnRequests (kind 'return', статус ≠ rejected/cancelled), позиції items[].sellerId/authOrderId.
//    Скасування — authOrders.delivery_status = 'cancelled' (частка від усіх створених у періоді підзамовлень).
//  - Рейтинг/відгуки — лише reviews.status = 'approved' (як у публічному рейтингу).
//  - SLA відправлення: у підзамовленні немає shippedAt. Час відправки = shippedAt (якщо колись з'явиться)
//    або updatedAt для підзамовлень у статусі 'shipped' (наближення: остання зміна = відправка). Прострочені —
//    не відправлені > SLA_HOURS «робочі» замовлення (оплачені або COD). Доставлені без shippedAt у медіану не входять.
//  - Перегляди/кошики — колекція productdailystats (utiles/tracking.js), дані є лише з моменту ввімкнення трекінгу.
//  - sellerId ЗАВЖДИ з токена (req.id) і стоїть у першому $match. Відповіді кешуються на 60 с (sellerId + URL).
//  - Приватність: /customers і експорт customers — лише агрегати, групи < 5 покупців приховано; імена — ніколи
//    (у /reviews лише «Ім'я І.», як на вітрині).

const mongoose = require("mongoose");
const authorOrderModel = require("../../models/authorOrderModel");
const customerOrderModel = require("../../models/customerOrderModel");
const productModel = require("../../models/productModel");
const reviewModel = require("../../models/reviewModel");
const returnRequestModel = require("../../models/returnRequestModel");
const sellerModel = require("../../models/sellerModel");
const couponModel = require("../../models/couponModel");
const Stats = require("../../models/productDailyStatsModel");
const A = require("../../utiles/sellerAnalytics");
const { buildInsights, THRESHOLDS } = require("../../utiles/sellerInsights");
const { decodeSourceKey } = require("../../utiles/tracking");
const rfm = require("../../utiles/rfm");
const handleError = require("../../utiles/handleError");
const { ensureAnalyticsIndexes } = require("../../utiles/analyticsIndexes");

const { ObjectId } = mongoose.Types;
const TZ = A.TZ;
const SLA_HOURS = 48;
const HOUR = 60 * 60 * 1000;

const cache = A.createCache({ ttlMs: 60 * 1000, max: 500 });

// Зараховані у виручку підзамовлення (див. шапку)
const QUALIFY = {
  delivery_status: { $ne: "cancelled" },
  $or: [{ payment_status: "paid" }, { delivery_status: "delivered" }],
};
const RETURN_LIVE = { kind: "return", status: { $nin: ["rejected", "cancelled"] } };

const range = (start, end) => ({ $gte: start, $lt: end });
const CO = () => customerOrderModel.collection.name;

const UNITS_EXPR = {
  $reduce: {
    input: { $ifNull: ["$products", []] },
    initialValue: 0,
    in: { $add: ["$$value", { $ifNull: ["$$this.quantity", 0] }] },
  },
};
// Виручка рядка (після $unwind products) — як A.lineRevenue
const LINE_REV = {
  $cond: [
    { $isNumber: "$products.unitPrice" },
    { $multiply: ["$products.unitPrice", { $ifNull: ["$products.quantity", 0] }] },
    {
      $multiply: [
        {
          $subtract: [
            { $ifNull: ["$products.price", 0] },
            { $floor: { $divide: [{ $multiply: [{ $ifNull: ["$products.price", 0] }, { $ifNull: ["$products.discount", 0] }] }, 100] } },
          ],
        },
        { $ifNull: ["$products.quantity", 0] },
      ],
    },
  ],
};

const bucketExpr = (g, field = "$createdAt") => ({
  $dateToString: {
    format: "%Y-%m-%d",
    timezone: TZ,
    date: { $dateTrunc: { date: field, unit: g, timezone: TZ, ...(g === "week" ? { startOfWeek: "monday" } : {}) } },
  },
});

// Підтягнути з замовлення покупця лише потрібні поля
const lookupCustomerOrder = (fields) => [
  { $lookup: { from: CO(), localField: "orderId", foreignField: "_id", pipeline: [{ $project: fields }], as: "co" } },
  { $set: { co: { $first: "$co" } } },
];

// ======================= інфраструктура =======================

function sellerIdOf(req) {
  const id = String(req.id || "");
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

// Обгортка: sellerId з токена, кеш 60 с, помилки → handleError
function endpoint(name, fn) {
  return async (req, res) => {
    const sellerId = sellerIdOf(req);
    if (!sellerId) return res.status(403).json({ error: "Доступ заборонено" });
    ensureAnalyticsIndexes();
    const key = `${sellerId}:${req.originalUrl}`;
    try {
      let data = cache.get(key);
      if (data === undefined) {
        data = await fn(sellerId, A.parseRange(req.query), req);
        cache.set(key, data);
      }
      if (data && data.__csv !== undefined) {
        res.set("Content-Type", "text/csv; charset=utf-8");
        res.set("Content-Disposition", `attachment; filename="${data.filename}"`);
        res.set("Cache-Control", "no-store");
        return res.status(200).send(data.__csv);
      }
      res.set("Cache-Control", "private, max-age=60");
      return res.status(200).json(data);
    } catch (error) {
      return handleError(res, error, `sellerAnalytics → ${name}`);
    }
  };
}

// ======================= запити =======================

async function orderTotals(sellerId, start, end) {
  if (!start) return null;
  const [r] = await authorOrderModel.aggregate([
    { $match: { sellerId, createdAt: range(start, end), ...QUALIFY } },
    {
      $group: {
        _id: null,
        revenue: { $sum: "$price" },
        orders: { $sum: 1 },
        payout: { $sum: { $ifNull: ["$payout", "$price"] } },
        units: { $sum: UNITS_EXPR },
      },
    },
  ]);
  return r || { revenue: 0, orders: 0, payout: 0, units: 0 };
}

async function cancelStats(sellerId, start, end) {
  if (!start) return null;
  const [r] = await authorOrderModel.aggregate([
    { $match: { sellerId, createdAt: range(start, end) } },
    { $group: { _id: null, all: { $sum: 1 }, cancelled: { $sum: { $cond: [{ $eq: ["$delivery_status", "cancelled"] }, 1, 0] } } } },
  ]);
  return r || { all: 0, cancelled: 0 };
}

async function returnStats(sellerId, start, end) {
  if (!start) return null;
  const rows = await returnRequestModel.aggregate([
    { $match: { "items.sellerId": sellerId, createdAt: range(start, end), ...RETURN_LIVE } },
    { $unwind: "$items" },
    { $match: { "items.sellerId": sellerId } },
    {
      $group: {
        _id: "$_id",
        reason: { $first: "$reason" },
        auth: { $addToSet: "$items.authOrderId" },
        units: { $sum: { $ifNull: ["$items.quantity", 0] } },
        value: { $sum: { $ifNull: ["$items.value", 0] } },
      },
    },
  ]);
  const auth = new Set();
  const byReason = new Map();
  let units = 0;
  let value = 0;
  for (const r of rows) {
    for (const a of r.auth || []) if (a) auth.add(String(a));
    byReason.set(r.reason || "other", (byReason.get(r.reason || "other") || 0) + 1);
    units += r.units;
    value += r.value;
  }
  return {
    count: rows.length,
    authOrders: auth.size,
    units,
    value,
    byReason: [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

// Покупці продавця з історією до end: [{_id, firstAt, lastAt, count, sum, inPeriod}]
async function buyerStats(sellerId, start, end) {
  if (!start) return null;
  return authorOrderModel.aggregate([
    { $match: { sellerId, createdAt: { $lt: end }, ...QUALIFY } },
    ...lookupCustomerOrder({ customerId: 1 }),
    { $match: { "co.customerId": { $ne: null } } },
    {
      $group: {
        _id: "$co.customerId",
        firstAt: { $min: "$createdAt" },
        lastAt: { $max: "$createdAt" },
        count: { $sum: 1 },
        sum: { $sum: "$price" },
        inPeriod: { $sum: { $cond: [{ $gte: ["$createdAt", start] }, 1, 0] } },
      },
    },
  ]);
}

const sellerProductIds = (sellerId) => productModel.find({ sellerId }).distinct("_id");

async function ratingStats(productIds, start, end) {
  if (!start || !productIds.length) return { avg: null, count: 0 };
  const [r] = await reviewModel.aggregate([
    { $match: { productId: { $in: productIds }, status: "approved", createdAt: range(start, end) } },
    { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);
  return r ? { avg: A.round(r.avg, 2), count: r.count } : { avg: null, count: 0 };
}

async function seriesBy(sellerId, start, end, g) {
  if (!start) return [];
  return authorOrderModel.aggregate([
    { $match: { sellerId, createdAt: range(start, end), ...QUALIFY } },
    { $group: { _id: bucketExpr(g), revenue: { $sum: "$price" }, orders: { $sum: 1 }, units: { $sum: UNITS_EXPR } } },
    { $project: { _id: 0, date: "$_id", revenue: 1, orders: 1, units: 1 } },
  ]);
}

// Продажі по товарах за період: Map productId → {units, orders, revenue}
async function lineStats(sellerId, start, end) {
  const m = new Map();
  if (!start) return m;
  const rows = await authorOrderModel.aggregate([
    { $match: { sellerId, createdAt: range(start, end), ...QUALIFY } },
    { $unwind: "$products" },
    {
      $group: {
        _id: "$products._id",
        units: { $sum: { $ifNull: ["$products.quantity", 0] } },
        orders: { $sum: 1 },
        revenue: { $sum: LINE_REV },
      },
    },
  ]);
  for (const r of rows) if (r._id) m.set(String(r._id), r);
  return m;
}

// Прострочені «робочі» замовлення (оплачені або COD), що не відправлені довше за hours
async function overdueOrders(sellerId, { hours = SLA_HOURS, statuses = ["pending", "placed", "processing", "packing"], start, end, now = new Date() } = {}) {
  const created = { $lt: new Date(now.getTime() - hours * HOUR) };
  if (start) created.$gte = start;
  if (end && end < created.$lt) created.$lt = end;
  const [r] = await authorOrderModel.aggregate([
    { $match: { sellerId, delivery_status: { $in: statuses }, createdAt: created } },
    ...lookupCustomerOrder({ payment_method: 1 }),
    { $match: { $or: [{ payment_status: "paid" }, { "co.payment_method": "cod" }] } },
    { $count: "n" },
  ]);
  return r ? r.n : 0;
}

// Повний набір метрик по товарах продавця за період (для products / inventory / quality / funnel / insights)
async function productMetrics(sellerId, rg, now = new Date()) {
  const products = await productModel
    .find({ sellerId })
    .select("name slug images price discount stock brand description specifications rating createdAt")
    .lean();
  if (!products.length) return { products: [], rows: [], abc: A.abcClassify([]).summary };
  const ids = products.map((p) => p._id);
  const d28 = new Date(now.getTime() - 28 * A.DAY_MS);
  const d90 = new Date(now.getTime() - 90 * A.DAY_MS);
  const weeks = 12;
  const dWeeks = new Date(now.getTime() - weeks * 7 * A.DAY_MS);

  const [period, recent, weekly, returns, reviews, traffic] = await Promise.all([
    lineStats(sellerId, rg.start, rg.end),
    authorOrderModel.aggregate([
      { $match: { sellerId, ...QUALIFY } },
      { $unwind: "$products" },
      {
        $group: {
          _id: "$products._id",
          lastSaleAt: { $max: "$createdAt" },
          units28: { $sum: { $cond: [{ $gte: ["$createdAt", d28] }, { $ifNull: ["$products.quantity", 0] }, 0] } },
          units90: { $sum: { $cond: [{ $gte: ["$createdAt", d90] }, { $ifNull: ["$products.quantity", 0] }, 0] } },
        },
      },
    ]),
    authorOrderModel.aggregate([
      { $match: { sellerId, createdAt: { $gte: dWeeks }, ...QUALIFY } },
      { $unwind: "$products" },
      {
        $group: {
          _id: { p: "$products._id", w: { $floor: { $divide: [{ $subtract: [now, "$createdAt"] }, 7 * A.DAY_MS] } } },
          units: { $sum: { $ifNull: ["$products.quantity", 0] } },
        },
      },
    ]),
    returnRequestModel.aggregate([
      { $match: { "items.sellerId": sellerId, createdAt: range(rg.start, rg.end), ...RETURN_LIVE } },
      { $unwind: "$items" },
      { $match: { "items.sellerId": sellerId } },
      { $group: { _id: "$items.productId", units: { $sum: { $ifNull: ["$items.quantity", 0] } } } },
    ]),
    reviewModel.aggregate([
      { $match: { productId: { $in: ids }, status: "approved" } },
      { $group: { _id: "$productId", count: { $sum: 1 }, avg: { $avg: "$rating" } } },
    ]),
    Stats.aggregate([
      { $match: { sellerId, date: { $gte: rg.from, $lte: rg.to } } },
      { $group: { _id: "$productId", views: { $sum: "$views" }, uniqueViews: { $sum: "$uniqueViews" }, carts: { $sum: "$carts" } } },
    ]),
  ]);

  const byId = (rows) => new Map(rows.filter((r) => r._id).map((r) => [String(r._id), r]));
  const recentM = byId(recent);
  const returnsM = byId(returns);
  const reviewsM = byId(reviews);
  const trafficM = byId(traffic);
  const weeklyM = new Map();
  for (const r of weekly) {
    if (!r._id?.p) continue;
    const k = String(r._id.p);
    const w = Math.min(weeks - 1, Math.max(0, r._id.w));
    if (!weeklyM.has(k)) weeklyM.set(k, Array(weeks).fill(0));
    weeklyM.get(k)[w] += r.units;
  }
  const { classes, summary } = A.abcClassify(products.map((p) => ({ id: p._id, revenue: period.get(String(p._id))?.revenue || 0 })));

  const rows = products.map((p) => {
    const id = String(p._id);
    const s = period.get(id) || {};
    const rc = recentM.get(id) || {};
    const tr = trafficM.get(id) || {};
    const rv = reviewsM.get(id) || {};
    const units = s.units || 0;
    const orders = s.orders || 0;
    const views = tr.views || 0;
    const carts = tr.carts || 0;
    const avgDaily28 = A.round((rc.units28 || 0) / 28, 3);
    const ageDays = p.createdAt ? Math.floor((now - new Date(p.createdAt)) / A.DAY_MS) : null;
    const status = A.inventoryStatus({ stock: p.stock, avgDaily28, units90: rc.units90 || 0, ageDays });
    const q = A.qualityScore(p, { reviews: rv.count || 0 });
    const returnsUnits = returnsM.get(id)?.units || 0;
    return {
      productId: id,
      name: p.name,
      slug: p.slug,
      image: Array.isArray(p.images) ? p.images[0] || null : null,
      price: p.price,
      discount: p.discount,
      stock: p.stock,
      units,
      orders,
      revenue: A.round(s.revenue || 0),
      returnsUnits,
      returnRate: units > 0 ? A.round(returnsUnits / units, 4) : null,
      rating: rv.count ? A.round(rv.avg, 2) : null,
      reviews: rv.count || 0,
      views,
      uniqueViews: tr.uniqueViews || 0,
      carts,
      viewToCart: A.safeRate(carts, views),
      cartToOrder: A.safeRate(orders, carts),
      cr: A.safeRate(orders, views),
      avgDaily28,
      units90: rc.units90 || 0,
      lastSaleAt: rc.lastSaleAt || null,
      daysOfCover: A.daysOfCover(p.stock, avgDaily28),
      status,
      abc: classes.get(id) || "-",
      xyz: A.xyzClass(weeklyM.get(id) || Array(weeks).fill(0)),
      deadStock: status === "dead",
      qualityScore: q.score,
      qualityIssues: q.issues,
    };
  });
  return { products, rows, abc: summary };
}

// SLA і статуси за період
async function fulfillmentStats(sellerId, rg, now = new Date()) {
  const orders = await authorOrderModel
    .find({ sellerId, createdAt: range(rg.start, rg.end) })
    .select("delivery_status payment_status createdAt updatedAt shippedAt deliveredAt")
    .lean();
  const hours = [];
  let shippedCount = 0;
  const statusCount = new Map();
  for (const o of orders) {
    statusCount.set(o.delivery_status, (statusCount.get(o.delivery_status) || 0) + 1);
    if (o.delivery_status === "shipped" || o.delivery_status === "delivered") shippedCount++;
    const shipAt = o.shippedAt || (o.delivery_status === "shipped" ? o.updatedAt : null);
    if (shipAt && o.createdAt) hours.push(Math.max(0, (new Date(shipAt) - new Date(o.createdAt)) / HOUR));
  }
  const overdueCount = await overdueOrders(sellerId, { start: rg.start, end: rg.end, now });
  const lateShipped = hours.filter((h) => h > SLA_HOURS).length;
  const base = hours.length + overdueCount;
  const med = A.median(hours);
  const p90 = A.percentile(hours, 0.9);
  return {
    orders,
    statusCount,
    sla: {
      slaHours: SLA_HOURS,
      medianHours: med === null ? null : A.round(med, 1),
      p90Hours: p90 === null ? null : A.round(p90, 1),
      lateRate: base > 0 ? A.round((lateShipped + overdueCount) / base, 4) : null,
      shippedCount,
      measuredCount: hours.length,
      overdueCount,
    },
  };
}

// Негативні відгуки (≤2★) за останні 14 днів по товарах
async function negativeReviews(products, now = new Date()) {
  if (!products.length) return [];
  const since = new Date(now.getTime() - THRESHOLDS.NEG_WINDOW_DAYS * A.DAY_MS);
  const rows = await reviewModel.aggregate([
    { $match: { productId: { $in: products.map((p) => p._id) }, status: "approved", rating: { $lte: THRESHOLDS.NEG_RATING_MAX }, createdAt: { $gte: since } } },
    { $group: { _id: "$productId", count: { $sum: 1 } } },
  ]);
  const names = new Map(products.map((p) => [String(p._id), p.name]));
  return rows.map((r) => ({ productId: String(r._id), name: names.get(String(r._id)) || "", count: r.count }));
}

// ======================= ендпойнти =======================

async function overview(sellerId, rg) {
  const now = new Date();
  const productIds = await sellerProductIds(sellerId);
  const [cur, prev, cc, cp, rc, rp, bc, bp, rtc, rtp, series, prevSeries, hasOrderDoc] = await Promise.all([
    orderTotals(sellerId, rg.start, rg.end),
    orderTotals(sellerId, rg.prevStart, rg.prevEnd),
    cancelStats(sellerId, rg.start, rg.end),
    cancelStats(sellerId, rg.prevStart, rg.prevEnd),
    returnStats(sellerId, rg.start, rg.end),
    returnStats(sellerId, rg.prevStart, rg.prevEnd),
    buyerStats(sellerId, rg.start, rg.end),
    buyerStats(sellerId, rg.prevStart, rg.prevEnd),
    ratingStats(productIds, rg.start, rg.end),
    rg.prevStart ? ratingStats(productIds, rg.prevStart, rg.prevEnd) : null,
    seriesBy(sellerId, rg.start, rg.end, rg.granularity),
    seriesBy(sellerId, rg.prevStart, rg.prevEnd, rg.granularity),
    authorOrderModel.exists({ sellerId }),
  ]);
  const P = (v) => (prev ? v : null);
  const nvr = A.newVsRepeat((bc || []).filter((b) => b.inPeriod > 0), rg.start);
  const nvrPrev = bp ? A.newVsRepeat(bp.filter((b) => b.inPeriod > 0), rg.prevStart) : null;
  const rate = (a, b) => (b > 0 ? A.round(a / b, 4) : null);

  const kpi = {
    revenue: A.kpi(cur.revenue, P(prev?.revenue)),
    orders: A.kpi(cur.orders, P(prev?.orders)),
    aov: A.kpi(cur.orders ? cur.revenue / cur.orders : 0, prev ? (prev.orders ? prev.revenue / prev.orders : 0) : null),
    units: A.kpi(cur.units, P(prev?.units)),
    payout: A.kpi(cur.payout, P(prev?.payout)),
    returnsRate: A.kpi(rate(rc.authOrders, cur.orders), prev ? rate(rp.authOrders, prev.orders) : null),
    cancelRate: A.kpi(rate(cc.cancelled, cc.all), cp ? rate(cp.cancelled, cp.all) : null),
    newBuyers: A.kpi(nvr.new, nvrPrev ? nvrPrev.new : null),
    repeatBuyers: A.kpi(nvr.repeat, nvrPrev ? nvrPrev.repeat : null),
    avgRating: A.kpi(rtc.avg, rtp ? rtp.avg : null),
  };

  const hasProducts = productIds.length > 0;
  const hasOrders = !!hasOrderDoc;
  let insights = [];
  let onboarding = null;
  if (!hasProducts) {
    insights = buildInsights({ hasProducts: false });
  } else {
    const [pm, ful, pendingOld] = await Promise.all([
      productMetrics(sellerId, rg, now),
      fulfillmentStats(sellerId, rg, now),
      overdueOrders(sellerId, { statuses: ["pending"], now }),
    ]);
    const neg = await negativeReviews(pm.products, now);
    insights = buildInsights({
      hasProducts,
      hasOrders,
      products: pm.rows,
      negativeReviews: neg,
      kpi: { revenue: kpi.revenue, orders: kpi.orders },
      fulfillment: ful.sla,
      pendingOld,
    });
  }
  if (!hasProducts || !hasOrders) {
    const seller = await sellerModel.findById(sellerId).select("shopInfo").lean();
    const prods = hasProducts ? await productModel.find({ sellerId }).select("images stock").limit(200).lean() : [];
    onboarding = {
      hasProducts,
      hasOrders,
      steps: [
        { id: "profile", title: "Заповніть дані магазину", done: !!(seller?.shopInfo && Object.keys(seller.shopInfo).length), link: "/seller/dashboard/profile" },
        { id: "first_product", title: "Додайте перший товар", done: hasProducts, link: "/seller/dashboard/add-product" },
        { id: "photos", title: "Додайте ≥5 фото до товару", done: prods.some((p) => (p.images || []).length >= 5), link: "/seller/dashboard/products" },
        { id: "stock", title: "Вкажіть залишок на складі", done: prods.some((p) => Number(p.stock) > 0), link: "/seller/dashboard/products" },
        { id: "first_order", title: "Отримайте перше замовлення", done: hasOrders, link: "/seller/dashboard/orders" },
      ],
    };
  }

  return {
    period: { from: rg.from, to: rg.to, prevFrom: rg.prevFrom, prevTo: rg.prevTo, compare: rg.compare, granularity: rg.granularity },
    kpi,
    series: A.fillSeries(series, A.bucketKeys(rg.from, rg.to, rg.granularity), ["revenue", "orders"]),
    prevSeries: rg.prevFrom ? A.fillSeries(prevSeries, A.bucketKeys(rg.prevFrom, rg.prevTo, rg.granularity), ["revenue", "orders"]) : [],
    insights,
    onboarding,
  };
}

async function sales(sellerId, rg) {
  const match = { sellerId, createdAt: range(rg.start, rg.end), ...QUALIFY };
  const [byPeriod, byWeekday, heat, checks, methods, status] = await Promise.all([
    seriesBy(sellerId, rg.start, rg.end, rg.granularity),
    authorOrderModel.aggregate([
      { $match: match },
      { $group: { _id: { $isoDayOfWeek: { date: "$createdAt", timezone: TZ } }, revenue: { $sum: "$price" }, orders: { $sum: 1 } } },
      { $project: { _id: 0, dow: "$_id", revenue: 1, orders: 1 } },
    ]),
    authorOrderModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: { dow: { $isoDayOfWeek: { date: "$createdAt", timezone: TZ } }, hour: { $hour: { date: "$createdAt", timezone: TZ } } },
          orders: { $sum: 1 },
        },
      },
      { $project: { _id: 0, dow: "$_id.dow", hour: "$_id.hour", orders: 1 } },
    ]),
    authorOrderModel.find(match).select("price").lean(),
    authorOrderModel.aggregate([
      { $match: match },
      ...lookupCustomerOrder({ payment_method: 1 }),
      { $group: { _id: { $ifNull: ["$co.payment_method", "unknown"] }, count: { $sum: 1 }, revenue: { $sum: "$price" } } },
      { $project: { _id: 0, method: "$_id", count: 1, revenue: 1 } },
      { $sort: { revenue: -1 } },
    ]),
    authorOrderModel.aggregate([
      { $match: { sellerId, createdAt: range(rg.start, rg.end) } },
      { $group: { _id: "$delivery_status", count: { $sum: 1 } } },
      { $project: { _id: 0, status: "$_id", count: 1 } },
    ]),
  ]);
  const filled = A.fillSeries(byPeriod, A.bucketKeys(rg.from, rg.to, rg.granularity), ["revenue", "orders", "units"]).map((r) => ({
    ...r,
    aov: r.orders ? A.round(r.revenue / r.orders) : 0,
  }));
  return {
    period: { from: rg.from, to: rg.to, granularity: rg.granularity },
    byPeriod: filled,
    byWeekday: A.fillWeekdays(byWeekday),
    heatmap: A.fillHeatmap(heat),
    checkBuckets: A.checkBuckets(checks.map((o) => o.price)),
    paymentMethods: methods.map((m) => ({ ...m, revenue: A.round(m.revenue) })),
    status: A.sortStatuses(status),
  };
}

const PRODUCT_SORT = new Set([
  "name", "price", "discount", "stock", "units", "orders", "revenue", "returnsUnits", "returnRate", "rating", "reviews",
  "views", "carts", "viewToCart", "cartToOrder", "cr", "daysOfCover", "abc", "xyz", "qualityScore",
]);

function sortRows(rows, sort, order) {
  const key = PRODUCT_SORT.has(sort) ? sort : "revenue";
  const dir = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    // null/undefined — завжди в кінці
    if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
    if (y === null || y === undefined) return -1;
    if (typeof x === "string") return dir * x.localeCompare(y, "uk");
    return dir * (x - y) || a.name.localeCompare(b.name, "uk");
  });
}

const lite = (r) => ({ productId: r.productId, name: r.name, image: r.image, revenue: r.revenue, units: r.units, stock: r.stock });

async function products(sellerId, rg, req) {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const pm = await productMetrics(sellerId, rg);
  const all = pm.rows.map(({ qualityIssues, avgDaily28, units90, lastSaleAt, status, uniqueViews, ...r }) => r);
  let rows = all;
  if (q) {
    const re = new RegExp(A.escapeRegex(q), "i");
    rows = rows.filter((r) => re.test(r.name));
  }
  rows = sortRows(rows, req.query.sort, req.query.order);
  const byRevenue = sortRows(all, "revenue", "desc");
  const worst = sortRows(
    all.filter((r) => r.stock > 0),
    "revenue",
    "asc"
  );
  return {
    rows: rows.slice((page - 1) * limit, page * limit),
    total: rows.length,
    page,
    limit,
    abc: pm.abc,
    topN: byRevenue.filter((r) => r.revenue > 0).slice(0, 5).map(lite),
    worstN: worst.slice(0, 5).map(lite),
  };
}

async function inventory(sellerId, rg) {
  const pm = await productMetrics(sellerId, rg);
  const rows = pm.rows
    .map((r) => ({
      productId: r.productId,
      name: r.name,
      image: r.image,
      stock: r.stock,
      avgDaily28: r.avgDaily28,
      daysOfCover: r.daysOfCover,
      status: r.status,
      lastSaleAt: r.lastSaleAt,
      abc: r.abc,
    }))
    .sort((a, b) => {
      const rank = { out: 0, low: 1, dead: 2, ok: 3 };
      return rank[a.status] - rank[b.status] || (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) || a.name.localeCompare(b.name, "uk");
    });
  const summary = { active: 0, outOfStock: 0, low: 0, dead: 0 };
  for (const r of rows) {
    if (r.stock > 0) summary.active++;
    if (r.status === "out") summary.outOfStock++;
    if (r.status === "low") summary.low++;
    if (r.status === "dead") summary.dead++;
  }
  return { rows, summary };
}

async function fulfillment(sellerId, rg) {
  const [ful, ret, totals] = await Promise.all([
    fulfillmentStats(sellerId, rg),
    returnStats(sellerId, rg.start, rg.end),
    orderTotals(sellerId, rg.start, rg.end),
  ]);
  const all = ful.orders.length;
  const cancelled = ful.statusCount.get("cancelled") || 0;
  return {
    sla: ful.sla,
    cancelRate: all > 0 ? A.round(cancelled / all, 4) : null,
    returns: {
      rate: totals.orders > 0 ? A.round(ret.authOrders / totals.orders, 4) : null,
      count: ret.count,
      units: ret.units,
      byReason: ret.byReason,
    },
    statusFunnel: A.sortStatuses([...ful.statusCount.entries()].map(([status, count]) => ({ status, count }))),
  };
}

async function reviews(sellerId, rg) {
  const prods = await productModel.find({ sellerId }).select("name").lean();
  const ids = prods.map((p) => p._id);
  const empty = { rating: { avg: null, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }, trend: [], negativeShare: null, recent: [] };
  if (!ids.length) return empty;
  const match = { productId: { $in: ids }, status: "approved", createdAt: range(rg.start, rg.end) };
  const [dist, trend, recent] = await Promise.all([
    reviewModel.aggregate([{ $match: match }, { $group: { _id: { $round: ["$rating", 0] }, count: { $sum: 1 } } }]),
    reviewModel.aggregate([
      { $match: match },
      { $group: { _id: bucketExpr(rg.granularity), avg: { $avg: "$rating" }, count: { $sum: 1 } } },
      { $project: { _id: 0, date: "$_id", avg: 1, count: 1 } },
    ]),
    reviewModel.find(match).sort({ createdAt: -1 }).limit(10).select("productId name rating review createdAt").lean(),
  ]);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let sum = 0;
  for (const d of dist) {
    const k = Math.min(5, Math.max(1, Number(d._id) || 1));
    distribution[k] += d.count;
    count += d.count;
    sum += k * d.count;
  }
  const names = new Map(prods.map((p) => [String(p._id), p.name]));
  const trendBy = new Map(trend.map((t) => [t.date, t]));
  return {
    rating: { avg: count ? A.round(sum / count, 2) : null, count, distribution },
    trend: A.bucketKeys(rg.from, rg.to, rg.granularity).map((date) => {
      const t = trendBy.get(date);
      return { date, avg: t ? A.round(t.avg, 2) : null, count: t ? t.count : 0 };
    }),
    negativeShare: count ? A.round((distribution[1] + distribution[2]) / count, 4) : null,
    recent: recent.map((r) => ({
      productId: String(r.productId),
      productName: names.get(String(r.productId)) || "",
      rating: r.rating,
      text: String(r.review || "").slice(0, 500),
      createdAt: r.createdAt,
      customerName: A.shortName(r.name),
    })),
  };
}

async function customers(sellerId, rg) {
  const match = { sellerId, createdAt: range(rg.start, rg.end), ...QUALIFY };
  const [buyers, regions, checks] = await Promise.all([
    buyerStats(sellerId, rg.start, rg.end),
    authorOrderModel.aggregate([
      { $match: match },
      ...lookupCustomerOrder({ customerId: 1, "shippingInfo.district": 1 }),
      {
        $group: {
          _id: { $ifNull: ["$co.shippingInfo.district", ""] },
          orders: { $sum: 1 },
          revenue: { $sum: "$price" },
          buyers: { $addToSet: "$co.customerId" },
        },
      },
      { $project: { _id: 0, region: "$_id", orders: 1, revenue: 1, buyers: { $size: "$buyers" } } },
      { $sort: { revenue: -1 } },
    ]),
    authorOrderModel.aggregate([
      { $match: match },
      ...lookupCustomerOrder({ customerId: 1 }),
      { $project: { price: 1, customerId: "$co.customerId" } },
    ]),
  ]);
  const periodBuyers = buyers.filter((b) => b.inPeriod > 0);
  const nvr = A.newVsRepeat(periodBuyers, rg.start);

  // Регіони: порожні назви → «Не вказано», групи < 5 покупців → «Інші»/hidden
  const regionRows = new Map();
  for (const r of regions) {
    const name = String(r.region || "").trim() || "Не вказано";
    const e = regionRows.get(name) || { region: name, orders: 0, revenue: 0, buyers: 0 };
    e.orders += r.orders;
    e.revenue += r.revenue;
    e.buyers += r.buyers;
    regionRows.set(name, e);
  }
  const byRegion = A.suppressSmallGroups([...regionRows.values()], { labelKey: "region", fields: ["orders", "revenue"] });

  // Сегменти за чеком: кількість замовлень у бакеті, ховаємо бакети з < 5 різними покупцями
  const bucketBuyers = A.CHECK_BUCKETS.map(() => new Set());
  const bucketCount = A.CHECK_BUCKETS.map(() => 0);
  for (const o of checks) {
    const i = A.checkBucketIndex(o.price);
    bucketCount[i]++;
    if (o.customerId) bucketBuyers[i].add(String(o.customerId));
  }
  const checkSegments = A.CHECK_BUCKETS.map((b, i) =>
    bucketBuyers[i].size >= A.MIN_GROUP || bucketCount[i] === 0
      ? { label: b.label, count: bucketCount[i] }
      : { label: b.label, count: null, hidden: true }
  );

  // RFM серед покупців цього продавця (історія до кінця періоду)
  const { items } = rfm.computeScores(
    buyers.map((b) => ({ id: String(b._id), lastOrderAt: b.lastAt, count: b.count, sum: b.sum })),
    { now: rg.end.getTime() < Date.now() ? rg.end : new Date() }
  );
  const segCount = new Map();
  for (const x of items) segCount.set(x.segment, (segCount.get(x.segment) || 0) + 1);
  const rfmRows = rfm.SEGMENTS.filter((s) => segCount.has(s)).map((s) => {
    const n = segCount.get(s);
    return n >= A.MIN_GROUP
      ? { segment: s, label: rfm.SEGMENT_LABELS[s], count: n }
      : { segment: s, label: rfm.SEGMENT_LABELS[s], count: null, hidden: true };
  });

  return {
    newVsRepeat: nvr,
    buyers: periodBuyers.length >= A.MIN_GROUP ? periodBuyers.length : null,
    byRegion,
    checkSegments,
    rfm: rfmRows,
    minGroup: A.MIN_GROUP,
  };
}

async function funnel(sellerId, rg) {
  const [pm, totalsRow, srcRows, first, ordersAll, paid] = await Promise.all([
    productMetrics(sellerId, rg),
    Stats.aggregate([
      { $match: { sellerId, date: { $gte: rg.from, $lte: rg.to } } },
      { $group: { _id: null, views: { $sum: "$views" }, uniqueViews: { $sum: "$uniqueViews" }, carts: { $sum: "$carts" } } },
    ]),
    Stats.aggregate([
      { $match: { sellerId, date: { $gte: rg.from, $lte: rg.to } } },
      { $project: { s: { $objectToArray: { $ifNull: ["$sources", {}] } } } },
      { $unwind: "$s" },
      { $group: { _id: "$s.k", views: { $sum: "$s.v" } } },
      { $sort: { views: -1 } },
    ]),
    Stats.findOne({ sellerId }).sort({ date: 1 }).select("date").lean(),
    authorOrderModel.countDocuments({ sellerId, createdAt: range(rg.start, rg.end) }),
    authorOrderModel.countDocuments({ sellerId, createdAt: range(rg.start, rg.end), ...QUALIFY }),
  ]);
  const t = totalsRow[0] || { views: 0, uniqueViews: 0, carts: 0 };
  const sources = srcRows.slice(0, 20).map((s) => ({ source: decodeSourceKey(s._id), views: s.views, orders: null }));
  const rest = srcRows.slice(20).reduce((s, r) => s + r.views, 0);
  if (rest > 0) sources.push({ source: "other", views: rest, orders: null });
  return {
    totals: { views: t.views, uniqueViews: t.uniqueViews, carts: t.carts, orders: ordersAll, paid },
    rates: {
      viewToCart: A.safeRate(t.carts, t.views),
      cartToOrder: A.safeRate(ordersAll, t.carts),
      cr: A.safeRate(paid, t.views),
    },
    byProduct: pm.rows
      .filter((r) => r.views > 0 || r.carts > 0 || r.orders > 0)
      .sort((a, b) => b.views - a.views)
      .map((r) => ({
        productId: r.productId,
        name: r.name,
        views: r.views,
        uniqueViews: r.uniqueViews,
        carts: r.carts,
        orders: r.orders,
        viewToCart: r.viewToCart,
        cartToOrder: r.cartToOrder,
        cr: r.cr,
      })),
    sources,
    dataSince: first?.date || null,
    lowSample: t.views < A.MIN_DENOM,
  };
}

async function marketing(sellerId, rg) {
  const match = { sellerId, createdAt: range(rg.start, rg.end), ...QUALIFY };
  const [withCoupon, totals, pm, prevLines] = await Promise.all([
    authorOrderModel.aggregate([
      { $match: match },
      ...lookupCustomerOrder({ coupon: 1, goods_total: 1, price: 1 }),
      { $match: { "co.coupon.code": { $nin: [null, ""] } } },
      {
        $project: {
          price: 1,
          code: "$co.coupon.code",
          // частка купона, що припадає на товари цього продавця
          cost: {
            $cond: [
              { $gt: [{ $ifNull: ["$co.goods_total", 0] }, 0] },
              { $multiply: [{ $ifNull: ["$co.coupon.amount", 0] }, { $divide: ["$price", "$co.goods_total"] }] },
              0,
            ],
          },
        },
      },
      { $group: { _id: "$code", uses: { $sum: 1 }, revenue: { $sum: "$price" }, discountCost: { $sum: "$cost" } } },
      { $sort: { uses: -1 } },
    ]),
    orderTotals(sellerId, rg.start, rg.end),
    productMetrics(sellerId, rg),
    lineStats(sellerId, rg.prevStart, rg.prevEnd),
  ]);
  const titles = new Map(
    (await couponModel.find({ code: { $in: withCoupon.map((c) => c._id) } }).select("code title").lean()).map((c) => [c.code, c.title || ""])
  );
  const coupons = withCoupon.map((c) => ({
    code: c._id,
    title: titles.get(c._id) || "",
    uses: c.uses,
    revenue: A.round(c.revenue),
    discountCost: A.round(c.discountCost),
    aov: c.uses ? A.round(c.revenue / c.uses) : 0,
    share: totals.orders ? A.round(c.uses / totals.orders, 4) : null,
  }));
  const discountedProducts = pm.rows
    .filter((r) => Number(r.discount) > 0)
    .map((r) => ({
      productId: r.productId,
      name: r.name,
      discount: r.discount,
      units: r.units,
      revenue: r.revenue,
      liftVsPrev: rg.prevStart ? A.deltaPct(r.units, prevLines.get(r.productId)?.units || 0) : null,
    }))
    .sort((a, b) => b.revenue - a.revenue);
  return {
    coupons,
    discountedProducts,
    summary: {
      ordersWithCoupon: coupons.reduce((s, c) => s + c.uses, 0),
      couponCost: A.round(coupons.reduce((s, c) => s + c.discountCost, 0)),
      revenueWithCoupon: A.round(coupons.reduce((s, c) => s + c.revenue, 0)),
    },
  };
}

async function quality(sellerId, rg) {
  const pm = await productMetrics(sellerId, rg);
  const rows = pm.rows
    .map((r) => ({ productId: r.productId, name: r.name, image: r.image, score: r.qualityScore, issues: r.qualityIssues }))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, "uk"));
  return { rows, avg: rows.length ? A.round(rows.reduce((s, r) => s + r.score, 0) / rows.length, 1) : null };
}

// ======================= CSV =======================

const EXPORTS = {
  async sales(sellerId, rg) {
    const d = await sales(sellerId, rg);
    return A.toCsv(
      ["Період", "Виручка, грн", "Замовлення", "Одиниць", "Середній чек, грн"],
      d.byPeriod.map((r) => [r.date, r.revenue, r.orders, r.units, r.aov])
    );
  },
  async products(sellerId, rg) {
    const pm = await productMetrics(sellerId, rg);
    return A.toCsv(
      ["Товар", "Ціна", "Знижка, %", "Залишок", "Продано, шт", "Замовлень", "Виручка, грн", "Повернено, шт", "Рейтинг", "Відгуків", "Перегляди", "У кошик", "Конверсія", "Днів запасу", "ABC", "XYZ", "Якість картки"],
      sortRows(pm.rows, "revenue", "desc").map((r) => [
        r.name, r.price, r.discount, r.stock, r.units, r.orders, r.revenue, r.returnsUnits, r.rating ?? "", r.reviews, r.views, r.carts, r.cr ?? "", r.daysOfCover ?? "", r.abc, r.xyz, r.qualityScore,
      ])
    );
  },
  async inventory(sellerId, rg) {
    const d = await inventory(sellerId, rg);
    const label = { ok: "OK", low: "Мало", out: "Немає", dead: "Не продається 90 дн." };
    return A.toCsv(
      ["Товар", "Залишок", "Продажі/день (28 дн.)", "Днів запасу", "Статус", "Останній продаж"],
      d.rows.map((r) => [r.name, r.stock, r.avgDaily28, r.daysOfCover ?? "", label[r.status] || r.status, r.lastSaleAt ? A.kyivDateKey(r.lastSaleAt) : ""])
    );
  },
  async customers(sellerId, rg) {
    // Лише агрегати, без персональних даних; приховані групи — порожні клітинки
    const d = await customers(sellerId, rg);
    const rows = [
      ["Нові/повторні", "Нові", d.newVsRepeat.new, ""],
      ["Нові/повторні", "Повторні", d.newVsRepeat.repeat, ""],
      ...d.byRegion.map((r) => ["Регіон", r.region, r.orders ?? "", r.revenue ?? ""]),
      ...d.checkSegments.map((s) => ["Чек", s.label, s.count ?? "", ""]),
      ...d.rfm.map((s) => ["RFM", s.label, s.count ?? "", ""]),
    ];
    return A.toCsv(["Розріз", "Група", "Кількість / замовлень", "Виручка, грн"], rows);
  },
};

async function exportCsv(sellerId, rg, req) {
  const report = String(req.params.report || "");
  const fn = Object.prototype.hasOwnProperty.call(EXPORTS, report) ? EXPORTS[report] : null;
  if (!fn) {
    const e = new Error("unknown report");
    e.status = 404;
    throw e;
  }
  return { __csv: await fn(sellerId, rg), filename: `${report}_${rg.from}_${rg.to}.csv` };
}

const exportHandler = endpoint("export", exportCsv);

module.exports = {
  overview: endpoint("overview", overview),
  sales: endpoint("sales", sales),
  products: endpoint("products", products),
  inventory: endpoint("inventory", inventory),
  fulfillment: endpoint("fulfillment", fulfillment),
  reviews: endpoint("reviews", reviews),
  customers: endpoint("customers", customers),
  funnel: endpoint("funnel", funnel),
  marketing: endpoint("marketing", marketing),
  quality: endpoint("quality", quality),
  export: (req, res) => {
    if (!Object.prototype.hasOwnProperty.call(EXPORTS, String(req.params.report || ""))) {
      return res.status(404).json({ error: "Невідомий звіт" });
    }
    return exportHandler(req, res);
  },
  // для тестів
  _internal: { QUALIFY, sortRows, cache, SLA_HOURS },
};
