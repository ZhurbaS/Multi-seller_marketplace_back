const { Schema, model } = require("mongoose");
const { PLACEMENT_IDS } = require("../utiles/bannerPlacements");

// Банери сайту за плейсментами (див. BANNERS_SPEC.md, utiles/siteBanner.js).
// Старі seller-банери лишаються в models/bannerModel.js (колекція banners).
const imageSchema = new Schema(
  {
    url: { type: String, default: "" },
    publicId: { type: String, default: "" },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
  },
  { _id: false }
);

const siteBannerSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 80, trim: true },
    placement: { type: String, required: true, enum: PLACEMENT_IDS, index: true },
    kind: { type: String, enum: ["image", "text"], default: "image" },
    imageDesktop: { type: imageSchema, default: null },
    imageMobile: { type: imageSchema, default: null },
    alt: { type: String, default: "", maxlength: 160 },
    headline: { type: String, default: "", maxlength: 80 },
    subline: { type: String, default: "", maxlength: 160 },
    ctaLabel: { type: String, default: "", maxlength: 30 },
    bgColor: { type: String, default: "" },
    textColor: { type: String, default: "" },
    linkType: {
      type: String,
      enum: ["none", "product", "category", "page", "url"],
      default: "none",
    },
    productId: { type: Schema.Types.ObjectId, default: null },
    productSlug: { type: String, default: "" },
    categoryName: { type: String, default: "" },
    pagePath: { type: String, default: "" },
    url: { type: String, default: "" },
    newTab: { type: Boolean, default: false },
    active: { type: Boolean, default: false },
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    sort: { type: Number, default: 0 },
    device: { type: String, enum: ["all", "desktop", "mobile"], default: "all" },
    audience: { type: String, enum: ["all", "guest", "customer"], default: "all" },
    categories: { type: [String], default: [] },
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
  },
  { timestamps: true }
);

siteBannerSchema.index({ placement: 1, active: 1, sort: 1 });

module.exports = model("sitebanners", siteBannerSchema);
