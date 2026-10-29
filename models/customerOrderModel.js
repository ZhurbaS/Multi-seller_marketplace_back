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
    // Сума товарів до знижки за сумою замовлення, і сама знижка. price = goods_total − order_discount.amount.
    // Доставку в ціну не включаємо: її оплачує покупець перевізнику при отриманні.
    goods_total: { type: Number, default: null },
    order_discount: {
      percent: { type: Number, default: 0 },
      amount: { type: Number, default: 0 },
    },
    has_preorder: { type: Boolean, default: false },
    // Купон (знижка фінансується магазином). Діє замість знижки за сумою, не разом із нею:
    // тоді order_discount = {0, 0}. price = goods_total − order_discount.amount − coupon.amount.
    coupon: {
      couponId: { type: Schema.ObjectId, default: undefined },
      code: { type: String, default: undefined },
      discountType: { type: String, default: undefined }, // percent | fixed
      value: { type: Number, default: undefined },
      amount: { type: Number, default: 0 },
    },
    // Покупець: фізособа чи юрособа (для юрособи — реквізити). Від цього залежать умови повернення.
    buyer: {
      kind: { type: String, enum: ["individual", "company"], default: "individual" },
      companyName: { type: String, default: "" },
      edrpou: { type: String, default: "" },
      ipn: { type: String, default: "" },
    },
    // Коли замовлення доставлено — від цієї дати рахується строк повернення.
    deliveredAt: { type: Date, default: null },
    // Повернення коштів: скільки вже повернуто покупцю і стан
    refunded_total: { type: Number, default: 0 },
    refund_inflight: { type: Number, default: 0 }, // сума повернень, що зараз обробляються банком
    refund_status: { type: String, enum: ["none", "partial", "full"], default: "none" },
    // Адмін може дозволити (allow) або заборонити (deny) повернення саме для цього замовлення
    returnOverride: { type: String, enum: ["default", "allow", "deny"], default: "default" },
    // Рахунок на оплату (для юросіб, оплата «за рахунком»). status:
    //   awaiting — рахунок сформовано, але лист ще не надіслано (немає пошти/помилка) → адмін надсилає повторно;
    //   sent     — рахунок надіслано покупцю, очікуємо оплату;
    //   paid     — оплачено; expired — строк минув, замовлення скасовано; cancelled — покупець обрав інший спосіб.
    invoice: {
      number: { type: String, default: null },
      status: { type: String, default: null },
      issuingAt: { type: Date, default: null }, // замок виставлення (застарілий через 1 хв)
      sendingAt: { type: Date, default: null }, // замок надсилання листа (застарілий через 1 хв)
      issuedAt: { type: Date, default: null },
      dueAt: { type: Date, default: null },
      sentAt: { type: Date, default: null },
      sentTo: { type: String, default: null },
      sendError: { type: String, default: null },
      company: { type: Object, default: undefined }, // знімок реквізитів магазину на момент виставлення
    },
    // Спосіб оплати: cod | monobank | liqpay | mock | invoice (порожньо — ще не обрано / старі замовлення)
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
