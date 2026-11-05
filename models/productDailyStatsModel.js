const { Schema, model } = require("mongoose");

// Добова статистика товару (DASHBOARD_SPEC.md §4): перегляди, унікальні перегляди, додавання в кошик,
// джерела трафіку. Жодних персональних даних (IP/UA/хешів) тут немає.
// sources: { <ключ джерела, '.' закодовано як '_'>: кількість }
const productDailyStatsSchema = new Schema(
  {
    date: { type: String, required: true }, // 'YYYY-MM-DD' за Києвом
    productId: { type: Schema.ObjectId, required: true },
    sellerId: { type: Schema.ObjectId, required: true },
    views: { type: Number, default: 0 },
    uniqueViews: { type: Number, default: 0 },
    carts: { type: Number, default: 0 },
    sources: { type: Object, default: {} },
  },
  { timestamps: false, minimize: false, versionKey: false }
);

productDailyStatsSchema.index({ date: 1, productId: 1 }, { unique: true });
productDailyStatsSchema.index({ sellerId: 1, date: 1 });

module.exports = model("productdailystats", productDailyStatsSchema, "productdailystats");
