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

// Тема (кольори) магазину
const themeController = require("../controllers/themeController");
router.get("/home/settings/theme", themeController.get_public);
router.get("/admin/settings/theme", ...adminOnly, themeController.admin_get);
router.post("/admin/settings/theme/preview", ...adminOnly, themeController.admin_preview);
router.put("/admin/settings/theme", ...adminOnly, themeController.admin_save);

// Фізичні магазини (точки продажу/самовивозу) і налаштування вітрини
const storeLocationController = require("../controllers/storeLocationController");
router.get("/home/stores", storeLocationController.public_list);
router.get("/home/storefront", storeLocationController.public_storefront);
router.get("/admin/stores", ...adminOnly, storeLocationController.admin_list);
router.post("/admin/stores", ...adminOnly, storeLocationController.admin_create);
// reorder — до /:id, щоб "reorder" не сприймався як id
router.put("/admin/stores/reorder", ...adminOnly, storeLocationController.admin_reorder);
router.put("/admin/stores/:id/active", ...adminOnly, storeLocationController.admin_set_active);
router.put("/admin/stores/:id", ...adminOnly, storeLocationController.admin_update);
router.delete("/admin/stores/:id", ...adminOnly, storeLocationController.admin_delete);
router.get("/admin/settings/storefront", ...adminOnly, storeLocationController.admin_get_storefront);
router.put("/admin/settings/storefront", ...adminOnly, storeLocationController.admin_save_storefront);

// Банери сайту за плейсментами (BANNERS_SPEC.md). Старий GET /api/banners — без змін.
const siteBanner = require("../controllers/siteBannerController");
router.get("/home/banners/:placement", siteBanner.public_list);
router.post("/home/banners/:id/event", siteBanner.public_event);
// Статичні шляхи — до /admin/banners/:id
router.get("/admin/banners/meta", ...adminOnly, siteBanner.admin_meta);
router.get("/admin/banners/product-search", ...adminOnly, siteBanner.admin_product_search);
router.put("/admin/banners/reorder", ...adminOnly, siteBanner.admin_reorder);
router.get("/admin/banners/legacy", ...adminOnly, siteBanner.admin_legacy_list);
router.post("/admin/banners/legacy/:id/import", ...adminOnly, siteBanner.admin_legacy_import);
router.get("/admin/banners", ...adminOnly, siteBanner.admin_list);
router.post("/admin/banners", ...adminOnly, siteBanner.admin_create);
router.put("/admin/banners/:id/active", ...adminOnly, siteBanner.admin_set_active);
router.post("/admin/banners/:id/duplicate", ...adminOnly, siteBanner.admin_duplicate);
router.post("/admin/banners/:id/reset-stats", ...adminOnly, siteBanner.admin_reset_stats);
router.put("/admin/banners/:id", ...adminOnly, siteBanner.admin_update);
router.delete("/admin/banners/:id", ...adminOnly, siteBanner.admin_delete);
router.get("/admin/settings/banners", ...adminOnly, siteBanner.admin_get_settings);
router.put("/admin/settings/banners", ...adminOnly, siteBanner.admin_save_settings);

// Продавець бачить свою комісію
router.get(
  "/seller/commission-info",
  authMiddleware,
  requireRole("seller"),
  settingsController.get_seller_commission_info
);

module.exports = router;
