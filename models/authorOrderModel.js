const { Schema, model } = require("mongoose");

const authorOrderSchema = new Schema(
  {
    orderId: {
      type: Schema.ObjectId,
      required: true,
    },
    sellerId: {
      type: Schema.ObjectId,
      required: true,
    },
    products: {
      type: Array,
      required: true,
    },
    price: {
      type: Number,
      required: true,
    },
    payment_status: {
      type: String,
      required: true,
    },
    shippingInfo: {
      type: String,
      required: true,
    },
    delivery_status: {
      type: String,
      required: true,
    },
    date: {
      type: String,
      required: true,
    },
    deliveredAt: { type: Date, default: null },
    // Знімок комісії на момент замовлення (зміна ставки пізніше історію не чіпає).
    // Старі замовлення цих полів не мають.
    commission: { type: Number },
    payout: { type: Number }, // price − commission: що належить продавцю
    // true — товари цього підзамовлення зараз «зарезервовані» (віднято зі складу).
    // Гарантує, що повернення на склад відбувається рівно один раз.
    stock_reserved: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = model("authOrders", authorOrderSchema);
