const { Schema, model } = require("mongoose");

const myShopWalletSchema = new Schema(
  {
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
    // --- Журнал: чистий дохід магазину ---
    // type: commission (комісія з підзамовлення) | discount (знижка за сумою, від'ємна) |
    //       coupon (знижка за купоном, від'ємна) | reversal | discount_back (частка знижки повернулась
    //       магазину при скасуванні підзамовлення) | return | return_shipping
    type: { type: String, default: "legacy" },
    orderId: { type: Schema.ObjectId },
    authOrderId: { type: Schema.ObjectId },
    returnId: { type: Schema.ObjectId },
    reversed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = model("myShopWallets", myShopWalletSchema);
