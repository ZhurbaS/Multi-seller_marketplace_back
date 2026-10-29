const { Schema, model } = require("mongoose");

const sellerWalletSchema = new Schema(
  {
    sellerId: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    month: {
      type: Number,
      required: true,
    },
    year: {
      type: Number,
      required: true,
    },
    // --- Журнал: нові записи мають ці поля, старі (до комісії) — ні ---
    // sale | reversal | return (повернення частини замовлення) | return_shipping (списання за зворотну доставку)
    type: { type: String, default: "sale" },
    orderId: { type: Schema.ObjectId },
    authOrderId: { type: Schema.ObjectId },
    returnId: { type: Schema.ObjectId }, // заявка на повернення, що створила запис
    gross: { type: Number }, // сума товарів продавця до комісії
    commission: { type: Number }, // комісія магазину
    // null — чекаємо доставку; дата — гроші стають доступними для виплати з цієї дати;
    // відсутнє поле (старі записи) — доступно одразу.
    availableAt: { type: Date },
    reversed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = model("sellerWallets", sellerWalletSchema);
