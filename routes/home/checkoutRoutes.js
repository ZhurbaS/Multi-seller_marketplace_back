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
    const c = await customerModel.findById(req.id).select("savedRecipients savedCompanies").lean();
    res.json({
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
