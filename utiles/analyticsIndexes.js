// Індекси для аналітики (DASHBOARD_SPEC.md §3: $match по sellerId + даті першим).
// Створюються один раз ліниво при першому запиті аналітики (createIndex ідемпотентний),
// щоб не чіпати схеми існуючих моделей. Помилки лише в лог — аналітика працює й без індексів.
// productdailystats має власні індекси у схемі (models/productDailyStatsModel.js).

let started = null;

const SPECS = [
  ["authorOrderModel", { sellerId: 1, createdAt: -1 }],
  ["authorOrderModel", { orderId: 1 }],
  ["authorOrderModel", { createdAt: -1 }],
  ["returnRequestModel", { "items.sellerId": 1, createdAt: -1 }],
  ["reviewModel", { productId: 1, status: 1, createdAt: -1 }],
  ["reviewModel", { status: 1 }],
  ["productModel", { sellerId: 1 }],
  ["customerModel", { createdAt: -1 }],
];

function ensureAnalyticsIndexes() {
  if (started) return started;
  started = (async () => {
    for (const [model, keys] of SPECS) {
      try {
        const M = require(`../models/${model}`);
        await M.collection.createIndex(keys, { background: true });
      } catch (e) {
        console.error(`analytics index ${model} ${JSON.stringify(keys)}:`, e?.message);
      }
    }
  })();
  return started;
}

module.exports = { ensureAnalyticsIndexes, SPECS };
