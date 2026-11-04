const { Schema, model } = require("mongoose");

// Сегмент контактів: filter — DSL { match, rules:[{field, op, value}] } (utiles/segmentEngine.js)
const segmentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 500 },
    filter: { type: Object, default: () => ({ match: "all", rules: [] }) },
    system: { type: Boolean, default: false }, // вбудований шаблон, лише читання
    systemKey: { type: String, default: undefined },
    createdBy: { type: Schema.Types.ObjectId, default: null },
    cachedCount: { type: Number, default: 0 },
    cachedAt: { type: Date, default: undefined },
  },
  { timestamps: true }
);

segmentSchema.index({ systemKey: 1 }, { unique: true, sparse: true });
segmentSchema.index({ createdAt: -1 });

module.exports = model("segments", segmentSchema);
