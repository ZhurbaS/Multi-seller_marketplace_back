const { Schema, model } = require("mongoose");

const customerOrderSchema = new Schema(
  {
    customerId: {
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
      type: Object,
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
    // Спосіб оплати: cod | monobank | liqpay | mock (порожньо — ще не обрано / старі замовлення)
    payment_method: {
      type: String,
      default: null,
    },
    // Дані платежу у платіжній системі
    payment: {
      provider: { type: String, default: null },
      invoiceId: { type: String, default: null }, // monobank invoiceId
      status: { type: String, default: null }, // pending | paid | failed
      providerStatus: { type: String, default: null }, // «сирий» статус провайдера
      modifiedDate: { type: String, default: null }, // для відсікання застарілих вебхуків
      paidAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

module.exports = model("customerOrders", customerOrderSchema);
