const { Schema, model } = require("mongoose");

// Журнал згод — append-only (лише вставка). Див. MARKETING_SPEC.md §0.3, §1
const ACTIONS = [
  "opt_in_request",
  "opt_in_confirm",
  "opt_in_explicit",
  "opt_out",
  "topic_change",
  "import",
  "admin_set",
  "bounce",
  "complaint",
  "telegram_start",
  "telegram_stop",
  "erasure_request",
  "erasure",
  "merge",
];

const consentLogSchema = new Schema(
  {
    contactId: { type: Schema.Types.ObjectId, ref: "contacts", required: true },
    channel: { type: String, enum: ["email", "telegram"], default: "email" },
    topic: { type: String, enum: ["all", "promo", "news", "restock", "tips"], default: "all" },
    action: { type: String, enum: ACTIONS, required: true },
    source: { type: String, default: "" },
    at: { type: Date, default: Date.now },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    text: { type: String, default: "" },
    textVersion: { type: String, default: "" },
    meta: { type: Object, default: undefined },
  },
  { versionKey: false }
);

consentLogSchema.index({ contactId: 1, at: -1 });
consentLogSchema.index({ action: 1, at: -1 });

// Append-only: оновлення заборонені
const deny = function () {
  throw new Error("ConsentLog — лише додавання записів");
};
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"]) {
  consentLogSchema.pre(op, deny);
}

const ConsentLog = model("consentlogs", consentLogSchema);
ConsentLog.ACTIONS = ACTIONS;
module.exports = ConsentLog;
