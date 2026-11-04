const { Schema, model } = require("mongoose");

// Фізичні магазини (точки продажу/самовивозу). Санітизація — utiles/storeLocation.js
const storeLocationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    hours: { type: String, default: "" }, // багаторядковий графік
    description: { type: String, default: "" },
    mapUrl: {
      type: String,
      default: "",
      validate: { validator: (v) => !v || /^https?:\/\//i.test(v), message: "mapUrl: http(s)" },
    },
    lat: { type: Number, default: null, min: -90, max: 90 },
    lng: { type: Number, default: null, min: -180, max: 180 },
    pickup: { type: Boolean, default: false },
    photo: { type: String, default: "" },
    active: { type: Boolean, default: false },
    sort: { type: Number, default: 0 },
  },
  { timestamps: true }
);

storeLocationSchema.index({ active: 1, sort: 1, createdAt: 1 });

module.exports = model("storeLocations", storeLocationSchema);
