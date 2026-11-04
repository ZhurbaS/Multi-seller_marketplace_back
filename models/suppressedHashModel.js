const { Schema, model } = require("mongoose");

// SHA-256 від нормалізованого e-mail анонімізованих контактів — щоб не імпортувати їх знову
const suppressedHashSchema = new Schema(
  {
    hash: { type: String, required: true, unique: true },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = model("suppressedhashes", suppressedHashSchema);
