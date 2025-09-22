const { Schema, model } = require("mongoose");

const withdrawalSchema = new Schema(
  {
    sellerId: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      default: "pending",
    },
  },
  { timestamps: true }
);

module.exports = model("withdrawalRequests", withdrawalSchema);
