// Банери сайту за плейсментами (BANNERS_SPEC.md). Чиста логіка — utiles/siteBanner.js.
const fs = require("fs");
const mongoose = require("mongoose");
const { IncomingForm } = require("formidable");
const cloudinary = require("cloudinary").v2;

const siteBannerModel = require("../models/siteBannerModel");
const bannerModel = require("../models/bannerModel");
const productModel = require("../models/productModel");
const categoryModel = require("../models/categoryModel");
const storeSettingsModel = require("../models/storeSettingsModel");
const { PLACEMENTS, getPlacement, LIMITS } = require("../utiles/bannerPlacements");
const lib = require("../utiles/siteBanner");
const handleError = require("../utiles/handleError");
const { responseReturn } = require("../utiles/response");

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
  secure: true,
});

const FOLDER = "site-banners";
const validId = (id) => mongoose.Types.ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(String(id));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const one = (v) => (Array.isArray(v) ? v[0] : v);
const allowEvent = lib.createThrottle({ windowMs: 1000 });

// ---------- форми / файли ----------
function parseForm(req) {
  const form = new IncomingForm({
    multiples: false,
    keepExtensions: true,
    allowEmptyFiles: false,
    maxFiles: 2,
    maxFileSize: lib.MAX_IMAGE_BYTES,
    maxTotalFileSize: lib.MAX_IMAGE_BYTES * 2,
    maxFields: 60,
    maxFieldsSize: 64 * 1024,
  });
  return new Promise((resolve) => {
    form.parse(req, (err, fields, files) => resolve({ err, fields: fields || {}, files: files || {} }));
  });
}

function cleanupFiles(files) {
  for (const v of Object.values(files || {})) {
    for (const f of Array.isArray(v) ? v : [v]) {
      if (f && f.filepath) fs.promises.unlink(f.filepath).catch(() => {});
    }
  }
}

const formError = (err) =>
  err && (err.httpCode === 413 || /maxFileSize|maxTotalFileSize/i.test(err.message || ""))
    ? `Розмір зображення — до ${LIMITS.maxImageMB} МБ`
    : "Помилка обробки форми";

async function upload(file) {
  const r = await cloudinary.uploader.upload(file.filepath, { folder: FOLDER });
  if (!r || !(r.secure_url || r.url)) throw new Error("Cloudinary: порожня відповідь");
  return {
    url: r.secure_url || r.url,
    publicId: r.public_id || "",
    width: Number(r.width) || 0,
    height: Number(r.height) || 0,
  };
}

async function destroy(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (e) {
    console.warn("⚠️ siteBanner: не вдалося видалити файл Cloudinary", publicId, e.message);
  }
}

// Видаляємо файл, лише якщо ним не користується інший банер (копії мають спільні URL)
async function releaseImage(img, exceptId) {
  if (!img || !img.publicId) return;
  try {
    const shared = await siteBannerModel.countDocuments({
      _id: { $ne: exceptId },
      $or: [{ "imageDesktop.url": img.url }, { "imageMobile.url": img.url }],
    });
    if (shared > 0) return;
  } catch {
    return;
  }
  await destroy(img.publicId);
}

// Завантажує desktop/mobile; при замалій ширині — прибирає вже завантажене й повертає помилку
async function uploadImages({ fd, fm }) {
  const out = {};
  try {
    if (fd) out.imageDesktop = await upload(fd);
    if (fm) out.imageMobile = await upload(fm);
  } catch (e) {
    await Promise.all(Object.values(out).map((i) => destroy(i.publicId)));
    throw e;
  }
  for (const [k, img] of Object.entries(out)) {
    if (lib.tooNarrow(img.width)) {
      await Promise.all(Object.values(out).map((i) => destroy(i.publicId)));
      return {
        error: `Зображення ${k === "imageDesktop" ? "для ПК" : "для мобільного"} замале: мін. ширина ${LIMITS.minImageWidth}px`,
      };
    }
  }
  return { value: out };
}

// Посилання на товар/категорію: перевірка існування; slug товару — з БД
async function resolveLinkRefs(v) {
  if (v.linkType === "product") {
    const p = await productModel.findById(v.productId).select("slug name").lean();
    if (!p) return { error: "Товар для посилання не знайдено" };
    v.productSlug = p.slug;
  }
  if (v.linkType === "category") {
    const c = await categoryModel
      .findOne({ name: new RegExp(`^${escapeRe(v.categoryName)}$`, "i") })
      .select("name")
      .lean();
    if (!c) return { error: "Категорію для посилання не знайдено" };
    v.categoryName = c.name;
  }
  return { value: v };
}

async function nextSort(placement) {
  const last = await siteBannerModel.findOne({ placement }).sort({ sort: -1 }).select("sort").lean();
  return last ? (Number(last.sort) || 0) + 1 : 0;
}

async function loadSettings() {
  const s = (await storeSettingsModel.findOne({ key: "main" }).select("bannerSettings").lean()) || {};
  return lib.normalizeSettings(s.bannerSettings);
}

function pickFiles(files, placement) {
  const pl = getPlacement(placement);
  if (pl && pl.kind === "text") return { fd: null, fm: null };
  return { fd: one(files.imageDesktop) || null, fm: one(files.imageMobile) || null };
}

function fileErrors({ fd, fm }) {
  for (const f of [fd, fm]) {
    if (!f) continue;
    const e = lib.validateImageFile(f);
    if (e) return e;
  }
  return null;
}

// ---------- Публічно ----------
exports.public_list = async (req, res) => {
  try {
    const { placement } = req.params;
    const pl = getPlacement(placement);
    if (!pl) return responseReturn(res, 404, { error: "Невідоме місце показу" });
    const audience = req.query.audience === "customer" ? "customer" : "guest";
    const category = typeof req.query.category === "string" ? req.query.category.slice(0, 80) : "";

    const [list, settings] = await Promise.all([
      siteBannerModel.find({ placement, active: true }).lean(),
      loadSettings(),
    ]);
    let banners = lib.pickForPlacement(list, { placement, category, audience, now: new Date() }).map(lib.toPublic);
    if (placement === "home_hero" && banners.length === 0) {
      const legacy = await bannerModel.find({}).sort({ createdAt: -1 }).limit(pl.max).lean();
      banners = legacy.map(lib.legacyToPublic);
    }
    res.set("Cache-Control", "public, max-age=60");
    responseReturn(res, 200, { banners, settings: lib.publicSettings(settings, placement) });
  } catch (e) {
    return handleError(res, e, "siteBanner → public_list");
  }
};

exports.public_event = async (req, res) => {
  try {
    const { id } = req.params;
    const type = (req.body && req.body.type) || req.query.type;
    if (!validId(id) || !["view", "click"].includes(type)) {
      return responseReturn(res, 400, { error: "Некоректна подія" });
    }
    if (!allowEvent(`${req.ip}|${id}|${type}`)) return responseReturn(res, 200, { ok: true });
    await siteBannerModel.updateOne(
      { _id: id },
      { $inc: type === "view" ? { impressions: 1 } : { clicks: 1 } }
    );
    responseReturn(res, 200, { ok: true });
  } catch (e) {
    return handleError(res, e, "siteBanner → public_event");
  }
};

// ---------- Адмін ----------
exports.admin_meta = (req, res) => {
  responseReturn(res, 200, { placements: PLACEMENTS, limits: { maxImageMB: LIMITS.maxImageMB } });
};

exports.admin_list = async (req, res) => {
  try {
    const placement = typeof req.query.placement === "string" ? req.query.placement : "";
    if (placement && !getPlacement(placement)) {
      return responseReturn(res, 400, { error: "Невідоме місце показу" });
    }
    const [list, settings] = await Promise.all([
      siteBannerModel
        .find(placement ? { placement } : {})
        .sort({ placement: 1, sort: 1, createdAt: -1 })
        .lean(),
      loadSettings(),
    ]);
    const now = new Date();
    responseReturn(res, 200, { banners: list.map((b) => lib.toAdmin(b, now)), settings });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_list");
  }
};

exports.admin_create = async (req, res) => {
  const { err, fields, files } = await parseForm(req);
  try {
    if (err) return responseReturn(res, 400, { error: formError(err) });
    const raw = lib.flattenFields(fields);
    const picked = pickFiles(files, raw.placement);
    const fe = fileErrors(picked);
    if (fe) return responseReturn(res, 400, { error: fe });

    const r = lib.validateInput(raw, { hasDesktopImage: !!picked.fd });
    if (r.error) return responseReturn(res, 400, { error: r.error });
    const refs = await resolveLinkRefs(r.value);
    if (refs.error) return responseReturn(res, 400, { error: refs.error });
    const v = refs.value;
    if (raw.sort === undefined || raw.sort === "") v.sort = await nextSort(v.placement);

    let images = {};
    if (v.kind === "image") {
      const up = await uploadImages(picked);
      if (up.error) return responseReturn(res, 400, { error: up.error });
      images = up.value;
    }
    const banner = await siteBannerModel.create({
      ...v,
      imageDesktop: images.imageDesktop || null,
      imageMobile: images.imageMobile || null,
    });
    responseReturn(res, 201, { banner: lib.toAdmin(banner), message: "Банер створено" });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_create");
  } finally {
    cleanupFiles(files);
  }
};

exports.admin_update = async (req, res) => {
  const { err, fields, files } = await parseForm(req);
  try {
    if (err) return responseReturn(res, 400, { error: formError(err) });
    const { id } = req.params;
    if (!validId(id)) return responseReturn(res, 400, { error: "Некоректний ідентифікатор" });
    const existing = await siteBannerModel.findById(id);
    if (!existing) return responseReturn(res, 404, { error: "Банер не знайдено" });

    const raw = lib.flattenFields(fields);
    const removeMobile = lib.parseBool(raw.removeImageMobile) === true;
    const placement = raw.placement !== undefined ? raw.placement : existing.placement;
    const picked = pickFiles(files, placement);
    const fe = fileErrors(picked);
    if (fe) return responseReturn(res, 400, { error: fe });

    const hasDesktopImage = !!picked.fd || !!(existing.imageDesktop && existing.imageDesktop.url);
    const r = lib.validateInput(raw, { existing, hasDesktopImage });
    if (r.error) return responseReturn(res, 400, { error: r.error });
    const v = r.value;
    const productChanged =
      v.linkType === "product" && (!v.productSlug || String(existing.productId) !== String(v.productId));
    const categoryChanged = v.linkType === "category" && v.categoryName !== existing.categoryName;
    if (productChanged || categoryChanged) {
      const refs = await resolveLinkRefs(v);
      if (refs.error) return responseReturn(res, 400, { error: refs.error });
    }

    const toRelease = [];
    const update = { ...v };
    if (v.kind === "image") {
      const up = await uploadImages(picked);
      if (up.error) return responseReturn(res, 400, { error: up.error });
      if (up.value.imageDesktop) {
        update.imageDesktop = up.value.imageDesktop;
        toRelease.push(existing.imageDesktop);
      }
      if (up.value.imageMobile) {
        update.imageMobile = up.value.imageMobile;
        toRelease.push(existing.imageMobile);
      } else if (removeMobile) {
        update.imageMobile = null;
        toRelease.push(existing.imageMobile);
      }
    }
    const banner = await siteBannerModel.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true });
    for (const img of toRelease) await releaseImage(img && (img.toObject ? img.toObject() : img), id);
    responseReturn(res, 200, { banner: lib.toAdmin(banner), message: "Банер оновлено" });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_update");
  } finally {
    cleanupFiles(files);
  }
};

exports.admin_delete = async (req, res) => {
  try {
    const { id } = req.params;
    if (!validId(id)) return responseReturn(res, 400, { error: "Некоректний ідентифікатор" });
    const b = await siteBannerModel.findByIdAndDelete(id).lean();
    if (!b) return responseReturn(res, 404, { error: "Банер не знайдено" });
    await releaseImage(b.imageDesktop, id);
    await releaseImage(b.imageMobile, id);
    responseReturn(res, 200, { message: "Банер видалено", id });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_delete");
  }
};

exports.admin_set_active = async (req, res) => {
  try {
    const { id } = req.params;
    if (!validId(id)) return responseReturn(res, 400, { error: "Некоректний ідентифікатор" });
    const active = lib.parseBool(req.body && req.body.active);
    if (active === undefined) return responseReturn(res, 400, { error: "Поле active: так/ні" });
    const banner = await siteBannerModel.findByIdAndUpdate(id, { $set: { active } }, { new: true });
    if (!banner) return responseReturn(res, 404, { error: "Банер не знайдено" });
    responseReturn(res, 200, {
      banner: lib.toAdmin(banner),
      message: active ? "Банер увімкнено" : "Банер вимкнено",
    });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_set_active");
  }
};

exports.admin_duplicate = async (req, res) => {
  try {
    const { id } = req.params;
    if (!validId(id)) return responseReturn(res, 400, { error: "Некоректний ідентифікатор" });
    const b = await siteBannerModel.findById(id).lean();
    if (!b) return responseReturn(res, 404, { error: "Банер не знайдено" });
    const { _id, createdAt, updatedAt, __v, impressions, clicks, ...rest } = b;
    const copyImg = (img) => (img && img.url ? { ...img, publicId: "" } : null);
    const suffix = " (копія)";
    const banner = await siteBannerModel.create({
      ...rest,
      name: (b.name || "").slice(0, 80 - suffix.length) + suffix,
      active: false,
      impressions: 0,
      clicks: 0,
      sort: await nextSort(b.placement),
      imageDesktop: copyImg(b.imageDesktop),
      imageMobile: copyImg(b.imageMobile),
    });
    responseReturn(res, 201, { banner: lib.toAdmin(banner), message: "Копію створено" });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_duplicate");
  }
};

exports.admin_reorder = async (req, res) => {
  try {
    const { placement, ids } = req.body || {};
    if (!getPlacement(placement)) return responseReturn(res, 400, { error: "Невідоме місце показу" });
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every(validId)) {
      return responseReturn(res, 400, { error: "Некоректний список банерів" });
    }
    if (ids.length) {
      await siteBannerModel.bulkWrite(
        ids.map((id, i) => ({ updateOne: { filter: { _id: id, placement }, update: { $set: { sort: i } } } }))
      );
    }
    const list = await siteBannerModel.find({ placement }).sort({ sort: 1, createdAt: -1 }).lean();
    const now = new Date();
    responseReturn(res, 200, { banners: list.map((b) => lib.toAdmin(b, now)), message: "Порядок збережено" });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_reorder");
  }
};

exports.admin_reset_stats = async (req, res) => {
  try {
    const { id } = req.params;
    if (!validId(id)) return responseReturn(res, 400, { error: "Некоректний ідентифікатор" });
    const banner = await siteBannerModel.findByIdAndUpdate(
      id,
      { $set: { impressions: 0, clicks: 0 } },
      { new: true }
    );
    if (!banner) return responseReturn(res, 404, { error: "Банер не знайдено" });
    responseReturn(res, 200, { banner: lib.toAdmin(banner), message: "Статистику скинуто" });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_reset_stats");
  }
};

// ---------- Старі seller-банери ----------
exports.admin_legacy_list = async (req, res) => {
  try {
    const legacy = await bannerModel.find({}).sort({ createdAt: -1 }).lean();
    const pids = [...new Set(legacy.map((l) => String(l.productId)).filter(validId))];
    const products = pids.length
      ? await productModel.find({ _id: { $in: pids } }).select("name slug").lean()
      : [];
    const byId = new Map(products.map((p) => [String(p._id), p]));
    const banners = legacy.map((l) => {
      const p = byId.get(String(l.productId));
      return {
        _id: l._id,
        productId: l.productId,
        banner: l.banner,
        link: l.link,
        productName: p ? p.name : "",
        slug: p ? p.slug : l.link,
        createdAt: l.createdAt,
      };
    });
    responseReturn(res, 200, { banners });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_legacy_list");
  }
};

exports.admin_legacy_import = async (req, res) => {
  try {
    const { id } = req.params;
    if (!validId(id)) return responseReturn(res, 400, { error: "Некоректний ідентифікатор" });
    const l = await bannerModel.findById(id).lean();
    if (!l) return responseReturn(res, 404, { error: "Старий банер не знайдено" });
    const p = validId(l.productId)
      ? await productModel.findById(l.productId).select("name slug").lean()
      : null;
    const title = (p && p.name) || "Банер товару";
    const banner = await siteBannerModel.create({
      name: title.slice(0, 80),
      placement: "home_hero",
      kind: "image",
      imageDesktop: { url: l.banner, publicId: "", width: 0, height: 0 },
      imageMobile: null,
      alt: title.slice(0, 160),
      linkType: p || l.link ? "product" : "none",
      productId: p ? p._id : l.productId || null,
      productSlug: (p && p.slug) || l.link || "",
      active: false,
      sort: await nextSort("home_hero"),
    });
    responseReturn(res, 201, { banner: lib.toAdmin(banner), message: "Банер імпортовано" });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_legacy_import");
  }
};

// ---------- Пошук товарів для посилання ----------
exports.admin_product_search = async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 60) : "";
    const filter = q ? { name: new RegExp(escapeRe(q), "i") } : {};
    const list = await productModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(10)
      .select("name slug images")
      .lean();
    responseReturn(res, 200, {
      products: list.map((p) => ({
        _id: p._id,
        name: p.name,
        slug: p.slug,
        image: Array.isArray(p.images) && p.images.length ? p.images[0] : "",
      })),
    });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_product_search");
  }
};

// ---------- Налаштування ----------
exports.admin_get_settings = async (req, res) => {
  try {
    responseReturn(res, 200, { settings: await loadSettings() });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_get_settings");
  }
};

exports.admin_save_settings = async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const src = body.settings && typeof body.settings === "object" ? body.settings : body;
    const settings = lib.normalizeSettings(src);
    await storeSettingsModel.updateOne(
      { key: "main" },
      { $set: { bannerSettings: settings } },
      { upsert: true }
    );
    responseReturn(res, 200, { settings, message: "Налаштування банерів збережено" });
  } catch (e) {
    return handleError(res, e, "siteBanner → admin_save_settings");
  }
};
