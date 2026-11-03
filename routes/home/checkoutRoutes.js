const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const { customerAuthMiddleware } = require("../../middleware/authMiddleware");
const customerModel = require("../../models/customerModel");
const np = require("../../utiles/novaPoshta");

// Підказки під час набору — частіші запити, ніж звичайні
const npLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Забагато запитів. Зачекайте хвилину" },
});

// Збережені отримувачі й організації покупця
router.get("/home/customer/checkout-data", customerAuthMiddleware, async (req, res) => {
  try {
    const c = await customerModel.findById(req.id).select("name phone savedRecipients savedCompanies savedAddresses").lean();
    res.json({
      profile: { name: c?.name || "", phone: c?.phone || "" },
      addresses: c?.savedAddresses || [],
      recipients: c?.savedRecipients || [],
      companies: c?.savedCompanies || [],
      novaPoshta: np.isEnabled(),
    });
  } catch (e) {
    console.error("💥 checkout-data:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
});

const removeSaved = (field) => async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Некоректний запис" });
    await customerModel.updateOne({ _id: req.id }, { $pull: { [field]: { _id: req.params.id } } });
    res.json({ ok: true });
  } catch (e) {
    console.error("💥 saved remove:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
};
router.delete("/home/customer/saved-address/:id", customerAuthMiddleware, removeSaved("savedAddresses"));

// Додати адресу вручну (з «Налаштувань»)
router.post("/home/customer/saved-address", customerAuthMiddleware, async (req, res) => {
  try {
    const { sanitizeAddress } = require("../../utiles/shipping");
    const { upsertAddress } = require("../../utiles/savedContacts");
    const a = sanitizeAddress(req.body);
    if (a.error) return res.status(400).json({ error: a.error });
    const c = await customerModel.findById(req.id).select("savedAddresses");
    c.savedAddresses = upsertAddress(c.savedAddresses.map((x) => x.toObject()), a.value);
    await c.save();
    res.json({ addresses: c.savedAddresses });
  } catch (e) {
    console.error("💥 saved-address:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
});

// Контактні дані профілю (ім'я, телефон)
router.put("/home/customer/profile", customerAuthMiddleware, async (req, res) => {
  try {
    const name = String(req.body.name ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
    const phone = require("../../utiles/shipping").normalizePhone(req.body.phone);
    if (name.length < 2) return res.status(400).json({ error: "Вкажіть ім'я" });
    if (!phone) return res.status(400).json({ error: "Вкажіть коректний номер телефону, напр. +380501234567" });
    await customerModel.updateOne({ _id: req.id }, { $set: { name, phone } });
    res.json({ profile: { name, phone }, message: "Дані збережено" });
  } catch (e) {
    console.error("💥 profile:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
});

router.delete("/home/customer/saved-recipient/:id", customerAuthMiddleware, removeSaved("savedRecipients"));
router.delete("/home/customer/saved-company/:id", customerAuthMiddleware, removeSaved("savedCompanies"));

// Нова пошта: підказки міст, відділень/поштоматів, вулиць. Збій API не ламає оформлення — фронт дає вводити вручну.
const npHandler = (fn) => async (req, res) => {
  if (!np.isEnabled()) return res.json({ enabled: false, items: [] });
  try {
    res.json({ enabled: true, items: await fn(req) });
  } catch (e) {
    console.error("💥 Нова пошта:", e.message);
    res.json({ enabled: false, items: [] });
  }
};
router.get("/np/cities", npLimiter, npHandler((req) => np.searchCities(req.query.q)));
router.get(
  "/np/warehouses",
  npLimiter,
  npHandler((req) => np.searchWarehouses(req.query.cityRef, req.query.q, req.query.type === "postomat" ? "postomat" : "warehouse"))
);
router.get("/np/streets", npLimiter, npHandler((req) => np.searchStreets(req.query.settlementRef, req.query.q)));

module.exports = router;
