const { Schema, model } = require("mongoose");

const productSchema = new Schema(
  {
    sellerId: {
      type: Schema.ObjectId,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    slugBase: {
      type: String,
      required: true,
    },
    slug: {
      type: String,
      required: true,
    },
    category: {
      type: Schema.Types.ObjectId,
      ref: "categories",
      required: true,
    },
    brand: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
    },
    stock: {
      type: Number,
      required: true,
    },
    discount: {
      type: Number,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    shopName: {
      type: String,
      required: true,
    },
    images: {
      type: Array,
      required: true,
    },
    rating: {
      type: Number,
      default: 0,
    },
    // --- Умови продажу ---
    // Ціна й склад рахуються в штуках. Мінімальне замовлення і крок кратності
    // дозволяють продавати комплекти/упаковки (мін. 100, крок 100 → лише по 100 шт).
    minOrderQty: { type: Number, default: 1, min: 1 },
    orderStep: { type: Number, default: 1, min: 1 },
    // Необов'язковий підпис для покупця, напр. "Упаковка по 100 шт"
    packLabel: { type: String, default: "", trim: true },
    // Знижки за кількість: від minQty шт — знижка percent % (до ціни зі знижкою товару)
    priceTiers: {
      type: [
        {
          minQty: { type: Number, required: true, min: 2 },
          percent: { type: Number, required: true, min: 1, max: 90 },
        },
      ],
      default: [],
    },
    // Коли товару немає в наявності: очікуваний термін поставки (днів) і чи можна передзамовити
    restockDaysMin: { type: Number, default: null },
    restockDaysMax: { type: Number, default: null },
    allowPreorder: { type: Boolean, default: false },
    // Вільні пари ключ-значення ("Екран" → "15.6″"), а не жорстка схема під
    // кожну категорію — різні товари (ноутбук, годинник, колонки) мають
    // абсолютно різний набір характеристик, і продавцю потрібна гнучкість.
    specifications: {
      type: [
        {
          key: { type: String, required: true, trim: true },
          value: { type: String, required: true, trim: true },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

productSchema.index(
  {
    name: "text",
    category: "text",
    brand: "text",
    description: "text",
  },
  {
    weights: {
      name: 5,
      category: 4,
      brand: 3,
      description: 2,
    },
  }
);

module.exports = model("products", productSchema);
