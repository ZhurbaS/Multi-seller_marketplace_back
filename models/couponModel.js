const { Schema, model } = require("mongoose");

// Купон / промокод. Створює адмін; знижку фінансує магазин (продавцям нараховується
// повна сума їхніх товарів, комісія рахується з повної суми).
const couponSchema = new Schema(
  {
    // Унікальний код у верхньому регістрі, напр. WELCOME10
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    title: { type: String, default: "" }, // внутрішня назва для адміна
    campaign: { type: String, default: "" }, // мітка кампанії для аналітики (email, instagram…)
    type: { type: String, enum: ["percent", "fixed"], required: true },
    value: { type: Number, required: true }, // % або ₴
    maxDiscount: { type: Number, default: null }, // стеля знижки в ₴ (для відсоткових)
    minSubtotal: { type: Number, default: 0 }, // мінімальна сума товарів у замовленні
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    active: { type: Boolean, default: true },
    totalLimit: { type: Number, default: null }, // скільки разів можна використати всього
    perCustomerLimit: { type: Number, default: 1 }, // скільки разів — одному покупцю (null — без обмеження)
    firstOrderOnly: { type: Boolean, default: false },
    // Лічильник використань (резерв + використано; зменшується, коли замовлення скасовано).
    usedCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = model("coupons", couponSchema);
