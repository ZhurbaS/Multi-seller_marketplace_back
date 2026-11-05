// GET /api/admin/analytics/overview (DASHBOARD_SPEC.md §6) — реальні дані для AdminDashboard.
// Семантика та сама, що в controllers/seller/analyticsController.js: GMV і замовлення — зараховані
// підзамовлення (не скасовані І (оплачені АБО доставлені)), дата — createdAt, групування за Києвом.
//  - gmv — сума authOrders.price (товари до знижок магазину), orders — кількість замовлень покупців (orderId),
//    commission — сума authOrders.commission (знімок на момент замовлення; у старих — 0).
//  - payoutsPending — сума заявок продавців на виплату зі статусом pending (поточний стан, не за період).
//  - activeSellers — продавці з ≥1 зарахованим замовленням у періоді; newCustomers — нові не-гостьові акаунти.
//  - returns.rate — заявки на повернення (kind 'return', не rejected/cancelled) / зараховані замовлення.
//  - pendingActions — поточні черги: продавці на модерації, заявки на виплату, повернення 'requested', відгуки 'pending'.
// kpi — числа (як у специфікації); порівняння з попереднім періодом — у compare.{key}: {prev, deltaPct}.

const authorOrderModel = require("../../models/authorOrderModel");
const customerModel = require("../../models/customerModel");
const sellerModel = require("../../models/sellerModel");
const withdrawalRequest = require("../../models/withdrawalRequest");
const returnRequestModel = require("../../models/returnRequestModel");
const reviewModel = require("../../models/reviewModel");
const A = require("../../utiles/sellerAnalytics");
const handleError = require("../../utiles/handleError");
const { ensureAnalyticsIndexes } = require("../../utiles/analyticsIndexes");

const QUALIFY = {
  delivery_status: { $ne: "cancelled" },
  $or: [{ payment_status: "paid" }, { delivery_status: "delivered" }],
};
const range = (start, end) => ({ $gte: start, $lt: end });
const cache = A.createCache({ ttlMs: 60 * 1000, max: 100 });

const bucketExpr = (g) => ({
  $dateToString: {
    format: "%Y-%m-%d",
    timezone: A.TZ,
    date: { $dateTrunc: { date: "$createdAt", unit: g, timezone: A.TZ, ...(g === "week" ? { startOfWeek: "monday" } : {}) } },
  },
});

async function totals(start, end) {
  if (!start) return null;
  const [r] = await authorOrderModel.aggregate([
    { $match: { createdAt: range(start, end), ...QUALIFY } },
    {
      $group: {
        _id: null,
        gmv: { $sum: "$price" },
        commission: { $sum: { $ifNull: ["$commission", 0] } },
        orders: { $addToSet: "$orderId" },
        sellers: { $addToSet: "$sellerId" },
      },
    },
    { $project: { _id: 0, gmv: 1, commission: 1, orders: { $size: "$orders" }, activeSellers: { $size: "$sellers" } } },
  ]);
  const newCustomers = await customerModel.countDocuments({ createdAt: range(start, end), isGuest: { $ne: true } });
  return { gmv: 0, commission: 0, orders: 0, activeSellers: 0, ...(r || {}), newCustomers };
}

async function buildOverview(rg) {
  const [cur, prev, series, topSellers, topCategories, returnsCount, payouts, sellerRequests, paymentRequests, returnsPending, reviewsPending] =
    await Promise.all([
      totals(rg.start, rg.end),
      totals(rg.prevStart, rg.prevEnd),
      authorOrderModel.aggregate([
        { $match: { createdAt: range(rg.start, rg.end), ...QUALIFY } },
        {
          $group: {
            _id: bucketExpr(rg.granularity),
            gmv: { $sum: "$price" },
            commission: { $sum: { $ifNull: ["$commission", 0] } },
            orders: { $addToSet: "$orderId" },
          },
        },
        { $project: { _id: 0, date: "$_id", gmv: 1, commission: 1, orders: { $size: "$orders" } } },
      ]),
      authorOrderModel.aggregate([
        { $match: { createdAt: range(rg.start, rg.end), ...QUALIFY } },
        { $group: { _id: "$sellerId", revenue: { $sum: "$price" }, orders: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
        { $limit: 5 },
        { $lookup: { from: sellerModel.collection.name, localField: "_id", foreignField: "_id", pipeline: [{ $project: { shopInfo: 1, name: 1 } }], as: "s" } },
        { $set: { s: { $first: "$s" } } },
        { $project: { _id: 0, sellerId: "$_id", revenue: 1, orders: 1, shopName: { $ifNull: ["$s.shopInfo.shopName", "$s.name"] } } },
      ]),
      authorOrderModel.aggregate([
        { $match: { createdAt: range(rg.start, rg.end), ...QUALIFY } },
        { $unwind: "$products" },
        {
          $group: {
            _id: { $ifNull: ["$products.category", "—"] },
            revenue: {
              $sum: {
                $cond: [
                  { $isNumber: "$products.unitPrice" },
                  { $multiply: ["$products.unitPrice", { $ifNull: ["$products.quantity", 0] }] },
                  { $multiply: [{ $ifNull: ["$products.price", 0] }, { $ifNull: ["$products.quantity", 0] }] },
                ],
              },
            },
            units: { $sum: { $ifNull: ["$products.quantity", 0] } },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 5 },
        { $project: { _id: 0, category: { $toString: "$_id" }, revenue: 1, units: 1 } },
      ]),
      returnRequestModel.countDocuments({ createdAt: range(rg.start, rg.end), kind: "return", status: { $nin: ["rejected", "cancelled"] } }),
      withdrawalRequest.aggregate([{ $match: { status: "pending" } }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      sellerModel.countDocuments({ status: "pending" }),
      withdrawalRequest.countDocuments({ status: "pending" }),
      returnRequestModel.countDocuments({ status: "requested" }),
      reviewModel.countDocuments({ status: "pending" }),
    ]);

  const payoutsPending = A.round(payouts[0]?.amount || 0);
  const kpi = {
    gmv: A.round(cur.gmv),
    orders: cur.orders,
    commission: A.round(cur.commission),
    payoutsPending,
    activeSellers: cur.activeSellers,
    newCustomers: cur.newCustomers,
  };
  const compare = {};
  for (const k of ["gmv", "orders", "commission", "activeSellers", "newCustomers"]) {
    const p = prev ? prev[k] : null;
    compare[k] = { prev: p === null ? null : A.round(p), deltaPct: A.deltaPct(kpi[k], p) };
  }
  return {
    period: { from: rg.from, to: rg.to, prevFrom: rg.prevFrom, prevTo: rg.prevTo, granularity: rg.granularity },
    kpi,
    compare,
    series: A.fillSeries(series, A.bucketKeys(rg.from, rg.to, rg.granularity), ["gmv", "orders", "commission"]),
    topSellers: topSellers.map((s) => ({ ...s, sellerId: String(s.sellerId), revenue: A.round(s.revenue), shopName: s.shopName || "" })),
    topCategories: topCategories.map((c) => ({ ...c, revenue: A.round(c.revenue) })),
    returns: { rate: cur.orders > 0 ? A.round(returnsCount / cur.orders, 4) : null, count: returnsCount },
    pendingActions: { sellerRequests, paymentRequests, returns: returnsPending, reviews: reviewsPending },
  };
}

async function overview(req, res) {
  ensureAnalyticsIndexes();
  const key = `admin:${req.originalUrl}`;
  try {
    let data = cache.get(key);
    if (data === undefined) {
      data = await buildOverview(A.parseRange(req.query));
      cache.set(key, data);
    }
    res.set("Cache-Control", "private, max-age=60");
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "adminAnalytics → overview");
  }
}

module.exports = { overview };
