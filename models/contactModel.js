const { Schema, model } = require("mongoose");

// CRM-контакт (підписник / клієнт). Див. MARKETING_SPEC.md §1. Логіка — utiles/contactService.js
const EMAIL_STATUSES = ["none", "pending", "subscribed", "unsubscribed", "bounced", "complained", "cleaned"];
const TELEGRAM_STATUSES = ["none", "subscribed", "unsubscribed", "blocked"];
const KINDS = ["person", "company", "unknown"];
const FREQUENCIES = ["normal", "weekly", "monthly"];

const topicsDef = {
  promo: { type: Boolean, default: false },
  news: { type: Boolean, default: false },
  restock: { type: Boolean, default: false },
  tips: { type: Boolean, default: false },
};

const contactSchema = new Schema(
  {
    email: { type: String, lowercase: true, trim: true, default: undefined },
    phone: { type: String, trim: true, default: undefined },
    name: { type: String, trim: true, default: "" },
    kind: { type: String, enum: KINDS, default: "unknown" },
    city: { type: String, trim: true, default: "" },
    customerId: { type: Schema.Types.ObjectId, ref: "customers", default: null },
    tags: {
      type: [{ type: String, lowercase: true, trim: true }],
      default: [],
      validate: { validator: (v) => !v || v.length <= 30, message: "Не більше 30 тегів" },
    },
    source: { type: String, default: "" },
    notes: { type: String, maxlength: 1000, default: "" },
    lastActivityAt: { type: Date, default: undefined },
    erasureRequested: { type: Boolean, default: false },
    erasureRequestedAt: { type: Date, default: undefined },
    anonymized: { type: Boolean, default: false },
    channels: {
      email: {
        status: { type: String, enum: EMAIL_STATUSES, default: "none" },
        topics: topicsDef,
        frequency: { type: String, enum: FREQUENCIES, default: "normal" },
        confirmedAt: Date,
        subscribedAt: Date,
        unsubscribedAt: Date,
        pendingSince: Date,
      },
      telegram: {
        status: { type: String, enum: TELEGRAM_STATUSES, default: "none" },
        chatId: { type: String, default: undefined },
        username: { type: String, default: "" },
        topics: topicsDef,
        subscribedAt: Date,
        unsubscribedAt: Date,
      },
    },
    stats: {
      orders: { type: Number, default: 0 },
      paidOrders: { type: Number, default: 0 },
      ltv: { type: Number, default: 0 },
      avgOrder: { type: Number, default: 0 },
      firstOrderAt: Date,
      lastOrderAt: Date,
      categories: { type: [{ _id: false, name: String, count: Number }], default: [] },
      rfm: {
        r: Number,
        f: Number,
        m: Number,
        segment: String,
        computedAt: Date,
      },
    },
    // Для frequency cap; зберігаємо останні 30 записів
    marketingSentLog: {
      type: [
        {
          _id: false,
          at: Date,
          channel: String,
          campaignId: { type: Schema.Types.ObjectId, default: null },
          automation: { type: String, default: null },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

contactSchema.index({ email: 1 }, { unique: true, sparse: true });
contactSchema.index({ phone: 1 }, { sparse: true });
contactSchema.index({ customerId: 1 }, { sparse: true });
contactSchema.index({ "channels.telegram.chatId": 1 }, { sparse: true });
contactSchema.index({ "channels.email.status": 1 });
contactSchema.index({ "channels.telegram.status": 1 });
contactSchema.index({ tags: 1 });
contactSchema.index({ kind: 1 });
contactSchema.index({ city: 1 });
contactSchema.index({ source: 1 });
contactSchema.index({ "stats.rfm.segment": 1 });
contactSchema.index({ "stats.lastOrderAt": -1 });
contactSchema.index({ createdAt: -1 });
contactSchema.index({ name: "text", email: "text", phone: "text" });

const Contact = model("contacts", contactSchema);
Contact.EMAIL_STATUSES = EMAIL_STATUSES;
Contact.TELEGRAM_STATUSES = TELEGRAM_STATUSES;
Contact.KINDS = KINDS;
Contact.FREQUENCIES = FREQUENCIES;
module.exports = Contact;
