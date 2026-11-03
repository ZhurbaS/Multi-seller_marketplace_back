const settingsController = require("../controllers/settingsController");
const { authMiddleware, requireRole } = require("../middleware/authMiddleware");

const router = require("express").Router();

router.get("/home/settings/discounts", settingsController.get_discounts);
router.put(
  "/admin/settings/discounts",
  authMiddleware,
  requireRole("admin"),
  settingsController.update_discounts
);

// Комісія магазину й виплати (лише адмін)
router.get(
  "/admin/settings/commission",
  authMiddleware,
  requireRole("admin"),
  settingsController.get_commission
);
router.put(
  "/admin/settings/commission",
  authMiddleware,
  requireRole("admin"),
  settingsController.update_commission
);
router.put(
  "/admin/seller/:sellerId/commission",
  authMiddleware,
  requireRole("admin"),
  settingsController.update_seller_commission
);

// Умови повернення: адмін повністю керує; публічна частина — для покупців
router.get(
  "/admin/settings/returns",
  authMiddleware,
  requireRole("admin"),
  settingsController.get_returns_policy
);
router.put(
  "/admin/settings/returns",
  authMiddleware,
  requireRole("admin"),
  settingsController.update_returns_policy
);
router.get("/home/returns/policy", settingsController.get_public_returns_policy);

// Реквізити магазину для рахунків юридичним особам
router.get(
  "/admin/settings/company",
  authMiddleware,
  requireRole("admin"),
  settingsController.get_company
);
router.put(
  "/admin/settings/company",
  authMiddleware,
  requireRole("admin"),
  settingsController.update_company
);

// Юридичні документи (публічна оферта): публічно — лише опубліковане; адмін редагує й вмикає показ
const legalController = require("../controllers/legalController");
router.get("/home/legal/status", legalController.status);
router.get("/home/legal/:slug", legalController.public_doc);
const adminOnly = [authMiddleware, requireRole("admin")];
router.get("/admin/settings/legal/:slug", ...adminOnly, legalController.admin_get);
router.put("/admin/settings/legal/:slug", ...adminOnly, legalController.admin_save);
router.put("/admin/settings/legal/:slug/published", ...adminOnly, legalController.admin_publish);
router.post("/admin/settings/legal/:slug/reset", ...adminOnly, legalController.admin_reset);

// Продавець бачить свою комісію
router.get(
  "/seller/commission-info",
  authMiddleware,
  requireRole("seller"),
  settingsController.get_seller_commission_info
);

module.exports = router;
