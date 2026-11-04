const { Schema, model } = require("mongoose");

// Маркетингова розсилка. Див. MARKETING_SPEC.md §1, §2
const STATUSES = ["draft", "scheduled", "sending", "sent", "cancelled", "failed"];

const campaignSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    subject: { type: String, default: "", maxlength: 200 },
    preheader: { type: String, default: "", maxlength: 250 },
    blocks: { type: [Object], default: [] },
    topic: { type: String, enum: ["promo", "news", "tips"], default: "promo" },
    channels: {
      type: [{ type: String, enum: ["email", "telegram"] }],
      default: ["email"],
    },
    segmentId: { type: Schema.Types.ObjectId, ref: "segments", default: null },
    filter: { type: Object, default: null },
    status: { type: String, enum: STATUSES, default: "draft" },
    scheduledAt: Date,
    startedAt: Date,
    finishedAt: Date,
    utm: {
      campaign: { type: String, default: "" },
      source: { type: String, default: "email" },
      medium: { type: String, default: "newsletter" },
    },
    stats: {
      recipients: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      unsubscribed: { type: Number, default: 0 },
      complained: { type: Number, default: 0 },
      bounced: { type: Number, default: 0 },
    },
    telegramText: { type: String, default: "", maxlength: 4000 },
    lastError: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

campaignSchema.index({ status: 1, scheduledAt: 1 });
campaignSchema.index({ createdAt: -1 });

const Campaign = model("campaigns", campaignSchema);
Campaign.STATUSES = STATUSES;
module.exports = Campaign;
