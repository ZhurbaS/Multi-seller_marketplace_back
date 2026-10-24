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
