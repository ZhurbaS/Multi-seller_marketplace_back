const { Schema, model } = require("mongoose");

// Окреме повідомлення розсилки/автоматизації одному контакту. Див. MARKETING_SPEC.md §1, §8
const SKIP_REASONS = [
  "not_subscribed",
  "topic_off",
  "suppressed",
  "frequency_cap",
  "no_address",
  "outside_window",
  "daily_limit",
];

const campaignMessageSchema = new Schema(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: "campaigns", default: null },
    automation: { type: String, default: null },
    step: { type: Number, default: undefined },
    contactId: { type: Schema.Types.ObjectId, ref: "contacts", required: true },
    channel: { type: String, enum: ["email", "telegram"], default: "email" },
    // sending — захоплено воркером (атомарно queued→sending), щоб повторний/паралельний tick не надіслав двічі
    status: { type: String, enum: ["queued", "sending", "sent", "failed", "skipped"], default: "queued" },
    skipReason: { type: String, enum: [...SKIP_REASONS, null], default: null },
    providerId: { type: String, default: "" },
    error: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    queuedAt: { type: Date, default: Date.now },
    sentAt: Date,
    clicks: { type: Number, default: 0 },
    links: { type: Object, default: undefined }, // { url: count } — для топу посилань
    lockId: { type: String, default: undefined }, // хто захопив (status 'sending')
    claimedAt: Date,
    sendStartedAt: Date, // запит до провайдера вже почався — після збою не повторюємо (могло бути надіслано)
    // Разовий облік у Campaign.stats (відписка/скарга/bounce рахуються один раз на повідомлення)
    unsubscribedAt: Date,
    complainedAt: Date,
    bouncedAt: Date,
  },
  { versionKey: false }
);

campaignMessageSchema.index({ campaignId: 1, status: 1 });
campaignMessageSchema.index({ contactId: 1, sentAt: -1 });
campaignMessageSchema.index({ status: 1, queuedAt: 1 });
campaignMessageSchema.index({ automation: 1, contactId: 1, sentAt: -1 });
campaignMessageSchema.index({ providerId: 1 }, { sparse: true });
campaignMessageSchema.index({ status: 1, channel: 1, sentAt: -1 }); // денний ліміт / health (marketingWorker)
campaignMessageSchema.index({ lockId: 1 }, { sparse: true });
campaignMessageSchema.index({ status: 1, claimedAt: 1 });
// Одне повідомлення кампанії на контакт і канал (захист від подвійного резолву кількома інстансами)
campaignMessageSchema.index(
  { campaignId: 1, contactId: 1, channel: 1 },
  { unique: true, partialFilterExpression: { campaignId: { $type: "objectId" } } }
);
// Кожен крок welcome — один раз на контакт
campaignMessageSchema.index(
  { automation: 1, contactId: 1, step: 1 },
  { unique: true, partialFilterExpression: { automation: "welcome" } }
);

const CampaignMessage = model("campaignmessages", campaignMessageSchema);
CampaignMessage.SKIP_REASONS = SKIP_REASONS;
module.exports = CampaignMessage;
