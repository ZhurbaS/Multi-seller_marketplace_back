const { Schema, model } = require("mongoose");

// Підписка покупця «повідомити, коли товар з'явиться в наявності».
const stockSubscriptionSchema = new Schema(
  {
    userId: { type: Schema.ObjectId, required: true },
    productId: { type: Schema.ObjectId, required: true },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Одна підписка на пару покупець + товар
stockSubscriptionSchema.index({ userId: 1, productId: 1 }, { unique: true });

module.exports = model("stockSubscriptions", stockSubscriptionSchema);
