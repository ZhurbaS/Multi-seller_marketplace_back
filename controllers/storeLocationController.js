const mongoose = require("mongoose");
const storeLocationModel = require("../models/storeLocationModel");
const storeSettingsModel = require("../models/storeSettingsModel");
const productModel = require("../models/productModel");
const lib = require("../utiles/storeLocation");
const storefront = require("../utiles/storefront");
const { responseReturn } = require("../utiles/response");

const ORDER = { sort: 1, createdAt: 1 };
const fail = (res, where, e) => {
  console.error(`💥 storeLocation.${where}:`, e.message);
  responseReturn(res, 500, { error: "Щось пішло не так" });
};
const validId = (id) => mongoose.Types.ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(String(id));

// Кількість товарів, які бачить покупець. Публічний get-products/query-products віддає
// всі товари без фільтра видимості, тож рахуємо так само — усі документи.
const countVisibleProducts = () => productModel.countDocuments({});
const countActiveStores = () => storeLocationModel.countDocuments({ active: true });

// Публічна вітрина: лічильники кешуються в пам'яті на 60 с (адмінка завжди рахує наживо)
let countsCache = { at: 0, value: null };
async function cachedCounts() {
  if (countsCache.value && Date.now() - countsCache.at < 60000) return countsCache.value;
  const [productCount, storesCount] = await Promise.all([countVisibleProducts(), countActiveStores()]);
  countsCache = { at: Date.now(), value: { productCount, storesCount } };
  return countsCache.value;
}
const resetCountsCache = () => (countsCache = { at: 0, value: null });

async function loadStorefront() {
  const s = (await storeSettingsModel.findOne({ key: "main" }).select("storefront").lean()) || {};
  return storefront.normalize(s.storefront);
}

// ---------- Публічно ----------
exports.public_list = async (req, res) => {
  try {
    const list = await storeLocationModel.find({ active: true }).sort(ORDER).lean();
    res.set("Cache-Control", "public, max-age=60");
    responseReturn(res, 200, { stores: list.map(lib.publicStore) });
  } catch (e) {
    fail(res, "public_list", e);
  }
};

exports.public_storefront = async (req, res) => {
  try {
    const [sf, { productCount, storesCount }] = await Promise.all([loadStorefront(), cachedCounts()]);
    const r = storefront.resolve(sf, { productCount, storesCount });
    res.set("Cache-Control", "public, max-age=60");
    responseReturn(res, 200, {
      compact: r.compact,
      mode: sf.mode,
      productCount,
      catalogBgUrl: sf.catalogBgUrl,
      storesCount,
      showStoresLink: r.showStoresLink,
    });
  } catch (e) {
    fail(res, "public_storefront", e);
  }
};

// ---------- Адмін: магазини ----------
exports.admin_list = async (req, res) => {
  try {
    const stores = await storeLocationModel.find({}).sort(ORDER).lean();
    responseReturn(res, 200, { stores });
  } catch (e) {
    fail(res, "admin_list", e);
  }
};

exports.admin_create = async (req, res) => {
  try {
    const r = lib.sanitizeStore(req.body);
    if (r.error) return responseReturn(res, 400, { error: r.error });
    if (r.value.sort === undefined) {
      const last = await storeLocationModel.findOne({}).sort({ sort: -1 }).select("sort").lean();
      r.value.sort = last ? (last.sort || 0) + 1 : 0;
    }
    const store = await storeLocationModel.create(r.value);
    resetCountsCache();
    responseReturn(res, 201, { store, message: "Магазин додано" });
  } catch (e) {
    fail(res, "admin_create", e);
  }
};

exports.admin_update = async (req, res) => {
  try {
    const { id } = req.params;
    if (!validId(id)) return responseReturn(res, 400, { error: "Некоректний магазин" });
    const r = lib.sanitizeStore(req.body);
    if (r.error) return responseReturn(res, 400, { error: r.error });
    const store = await storeLocationModel.findByIdAndUpdate(id, { $set: r.value }, { new: true, runValidators: true });
    if (!store) return responseReturn(res, 404, { error: "Магазин не знайдено" });
    resetCountsCache();
    responseReturn(res, 200, { store, message: "Зміни збережено" });
  } catch (e) {
    fail(res, "admin_update", e);
  }
};

exports.admin_delete = async (req, res) => {
  try {
    const { id } = req.params;
    if (!validId(id)) return responseReturn(res, 400, { error: "Некоректний магазин" });
    const store = await storeLocationModel.findByIdAndDelete(id);
    if (!store) return responseReturn(res, 404, { error: "Магазин не знайдено" });
    resetCountsCache();
    responseReturn(res, 200, { id, message: "Магазин видалено" });
  } catch (e) {
    fail(res, "admin_delete", e);
  }
};

exports.admin_set_active = async (req, res) => {
  try {
    const { id } = req.params;
    if (!validId(id)) return responseReturn(res, 400, { error: "Некоректний магазин" });
    if (typeof req.body?.active !== "boolean") {
      return responseReturn(res, 400, { error: "Поле active має бути true або false" });
    }
    const store = await storeLocationModel.findByIdAndUpdate(id, { $set: { active: req.body.active } }, { new: true });
    if (!store) return responseReturn(res, 404, { error: "Магазин не знайдено" });
    resetCountsCache();
    responseReturn(res, 200, {
      store,
      message: store.active ? "Магазин показано на сайті" : "Магазин приховано з сайту",
    });
  } catch (e) {
    fail(res, "admin_set_active", e);
  }
};

exports.admin_reorder = async (req, res) => {
  try {
    const r = lib.sanitizeIds(req.body?.ids);
    if (r.error) return responseReturn(res, 400, { error: r.error });
    const found = await storeLocationModel.countDocuments({ _id: { $in: r.value } });
    if (found !== r.value.length) return responseReturn(res, 400, { error: "Деяких магазинів не знайдено" });
    await storeLocationModel.bulkWrite(
      r.value.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { sort: i } } } }))
    );
    const stores = await storeLocationModel.find({}).sort(ORDER).lean();
    responseReturn(res, 200, { stores, message: "Порядок збережено" });
  } catch (e) {
    fail(res, "admin_reorder", e);
  }
};

// ---------- Адмін: вітрина ----------
async function adminStorefrontPayload(sf) {
  const [productCount, storesCount] = await Promise.all([countVisibleProducts(), countActiveStores()]);
  return { storefront: sf, productCount, storesCount, resolved: storefront.resolve(sf, { productCount, storesCount }) };
}

exports.admin_get_storefront = async (req, res) => {
  try {
    responseReturn(res, 200, await adminStorefrontPayload(await loadStorefront()));
  } catch (e) {
    fail(res, "admin_get_storefront", e);
  }
};

exports.admin_save_storefront = async (req, res) => {
  try {
    const r = storefront.sanitize(req.body);
    if (r.error) return responseReturn(res, 400, { error: r.error });
    await storeSettingsModel.findOneAndUpdate(
      { key: "main" },
      { $set: { storefront: r.value } },
      { upsert: true }
    );
    responseReturn(res, 200, { ...(await adminStorefrontPayload(r.value)), message: "Налаштування вітрини збережено" });
  } catch (e) {
    fail(res, "admin_save_storefront", e);
  }
};
