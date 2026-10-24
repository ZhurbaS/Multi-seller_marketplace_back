const { Schema, model } = require("mongoose");

const reviewSchema = new Schema(
  {
    productId: {
      type: Schema.ObjectId,
      required: true,
    },
    customerId: {
      type: Schema.ObjectId,
      required: true,
    },
    orderId: {
      type: Schema.ObjectId,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    rating: {
      type: Number,
      default: 0,
    },
    review: {
      type: String,
      required: true,
    },
    date: {
      type: String,
      required: true,
    },
    // Moderation: every review starts as "pending" and is only shown
    // publicly / counted in the product's average rating once an admin
    // approves it. "rejected" reviews are kept (not deleted) for audit
    // purposes but never shown or counted.
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    adminNote: {
      type: String,
      default: "",
    },
    moderatedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// One review per customer per product — resubmitting updates the existing
// review (and sends it back to "pending") instead of creating duplicates.
reviewSchema.index({ productId: 1, customerId: 1 }, { unique: true });

module.exports = model("reviews", reviewSchema);
