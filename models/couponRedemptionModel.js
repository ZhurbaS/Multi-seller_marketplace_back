const { Schema, model } = require("mongoose");

// Журнал використання купонів: одне замовлення — один запис.
// reserved (замовлення створено) → redeemed (оплачено / отримано) → released (замовлення скасовано).
const couponRedemptionSchema = new Schema(
  {
    couponId: { type: Schema.ObjectId, required: true, index: true },
    code: { type: String, required: true },
    campaign: { type: String, default: "" },
    customerId: { type: Schema.ObjectId, required: true },
    orderId: { type: Schema.ObjectId, required: true, unique: true },
    amount: { type: Number, required: true }, // знижка в ₴
    orderTotal: { type: Number, default: 0 }, // сума товарів до знижки
    status: {
      type: String,
      enum: ["reserved", "redeemed", "released"],
      default: "reserved",
    },
    // Знімок правил на момент застосування (для аудиту, якщо купон потім змінять).
    rules: { type: Object, default: {} },
    redeemedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = model("couponRedemptions", couponRedemptionSchema);
