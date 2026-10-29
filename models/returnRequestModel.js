const { Schema, model } = require("mongoose");

// Заявка на повернення / скасування.
//  kind "cancellation" — замовлення скасовується ДО відправки (товар не повертається);
//  kind "return"       — товар повертається на склад (відмова від договору, брак, не той товар,
//                        відмова від отримання на пошті).
//
// Статуси:
//  requested → approved → shipped → received → refund_pending → refunded
//  requested | approved | shipped | received → rejected | cancelled(покупець відкликав)
//  received → exchanged (обмін на інший товар, без повернення коштів)
const returnRequestSchema = new Schema(
  {
    orderId: { type: Schema.ObjectId, required: true, index: true },
    customerId: { type: Schema.ObjectId, required: true, index: true },
    number: { type: String, index: true }, // зручний номер для листування, напр. R-3F9A2C
    kind: { type: String, enum: ["return", "cancellation"], required: true },
    reason: {
      type: String,
      enum: [
        "withdrawal", // відмова від договору (14 днів) / передумав
        "defect", // брак
        "wrong_item", // не той товар / некомплект
        "refused", // відмова від отримання на пошті
        "cancel_unshipped", // скасування до відправки (за ініціативою покупця)
        "cancel_by_store", // скасування магазином / продавцем
        "other",
      ],
      required: true,
    },
    resolution: { type: String, enum: ["refund", "exchange"], default: "refund" },
    comment: { type: String, default: "" },
    createdBy: { type: String, enum: ["customer", "admin", "seller", "system"], default: "customer" },
    buyerKind: { type: String, enum: ["individual", "company"], default: "individual" },

    items: [
      {
        _id: false,
        productId: { type: Schema.ObjectId },
        name: String,
        image: String,
        quantity: Number, // скільки повертається
        orderedQuantity: Number,
        unitPrice: Number,
        value: Number, // unitPrice × quantity
        sellerId: { type: Schema.ObjectId },
        authOrderId: { type: Schema.ObjectId },
        commissionPercent: { type: Number, default: null },
        commission: { type: Number, default: 0 }, // комісія магазину з цієї частини
      },
    ],
    itemsValue: { type: Number, default: 0 },

    status: {
      type: String,
      enum: [
        "requested",
        "approved",
        "shipped",
        "received",
        "refund_pending",
        "refunded",
        "exchanged",
        "rejected",
        "cancelled",
      ],
      default: "requested",
      index: true,
    },
    // Адмін може сховати заявку від покупця (внутрішні/спірні випадки)
    visibleToCustomer: { type: Boolean, default: true },

    shipment: {
      carrier: { type: String, default: "" },
      ttn: { type: String, default: "" },
      shippedAt: { type: Date, default: null },
      receivedAt: { type: Date, default: null },
    },
    inspection: {
      result: { type: String, enum: ["", "ok", "damaged", "mismatch"], default: "" },
      note: { type: String, default: "" },
      at: { type: Date, default: null },
      restocked: { type: Boolean, default: false }, // товар повернено на склад при огляді
    },
    decision: {
      note: { type: String, default: "" }, // коментар адміна покупцю
      rejectReason: { type: String, default: "" },
      at: { type: Date, default: null },
    },

    refund: {
      // none → pending (рішення прийнято) → processing (запит у банк) → success | failed
      status: {
        type: String,
        enum: ["none", "pending", "processing", "success", "failed"],
        default: "none",
      },
      amount: { type: Number, default: 0 }, // скільки отримає покупець
      goodsAmount: { type: Number, default: 0 }, // вартість товарів (після частки знижки)
      discountShare: { type: Number, default: 0 }, // частка знижки/купона, що припала на ці товари
      deduction: { type: Number, default: 0 }, // утримання (пошкодження тощо) — залишається продавцю
      deductionReason: { type: String, default: "" },
      shippingCost: { type: Number, default: 0 }, // вартість зворотної доставки
      shippingPayer: { type: String, enum: ["seller", "store", "customer"], default: "seller" },
      provider: { type: String, default: null }, // monobank | liqpay | mock | manual
      extRef: { type: String, default: null },
      error: { type: String, default: "" },
      attempts: { type: Number, default: 0 },
      manualNote: { type: String, default: "" },
      ledgerDone: { type: Boolean, default: false },
      ledgerLockAt: { type: Date, default: null },
      requestedAt: { type: Date, default: null },
      refundedAt: { type: Date, default: null },
    },
    refundDueAt: { type: Date, default: null }, // крайній строк повернення коштів (за законом — до 30 днів)

    timeline: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        by: { type: String }, // customer | admin | seller | system
        action: { type: String },
        note: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true }
);

module.exports = model("returnRequests", returnRequestSchema);
