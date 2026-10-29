const { Schema, model } = require("mongoose");

const cardSchema = new Schema(
  {
    userId: {
      type: Schema.ObjectId,
      required: true,
    },
    productId: {
      type: Schema.ObjectId,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true }
);

// Кошик зберігається в БД (переживає вихід з акаунта й перезапуск браузера).
// Позиція автоматично видаляється через 30 днів після останньої зміни.
// Те саме значення — CART_TTL_DAYS у cardController.
cardSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = model("cardProducts", cardSchema);
