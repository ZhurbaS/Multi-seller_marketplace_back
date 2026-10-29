const { Schema, model } = require("mongoose");

// Скільки разів конкретний покупець використав купон. Унікальний індекс (купон + покупець)
// разом із умовним оновленням робить перевірку ліміту «на одного покупця» атомарною:
// два одночасні замовлення не зможуть обидва пройти.
const couponUsageSchema = new Schema(
  {
    couponId: { type: Schema.ObjectId, required: true },
    customerId: { type: Schema.ObjectId, required: true },
    count: { type: Number, default: 0 },
  },
  { timestamps: true }
);

couponUsageSchema.index({ couponId: 1, customerId: 1 }, { unique: true });

module.exports = model("couponUsages", couponUsageSchema);
