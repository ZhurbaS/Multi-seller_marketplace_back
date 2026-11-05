// Аналітика (DASHBOARD_SPEC.md §3, §6). Підключення в server.js: app.use("/api", require("./routes/dashboard/analyticsRoutes")).
// Продавець: /api/seller/analytics/* — sellerId лише з токена. Адмін: /api/admin/analytics/overview.
const router = require("express").Router();
const { authMiddleware, requireRole } = require("../../middleware/authMiddleware");
const seller = require("../../controllers/seller/analyticsController");
const admin = require("../../controllers/dashboard/adminAnalyticsController");

const S = "/seller/analytics";
const asSeller = [authMiddleware, requireRole("seller")];

router.get(`${S}/overview`, ...asSeller, seller.overview);
router.get(`${S}/sales`, ...asSeller, seller.sales);
router.get(`${S}/products`, ...asSeller, seller.products);
router.get(`${S}/inventory`, ...asSeller, seller.inventory);
router.get(`${S}/fulfillment`, ...asSeller, seller.fulfillment);
router.get(`${S}/reviews`, ...asSeller, seller.reviews);
router.get(`${S}/customers`, ...asSeller, seller.customers);
router.get(`${S}/funnel`, ...asSeller, seller.funnel);
router.get(`${S}/marketing`, ...asSeller, seller.marketing);
router.get(`${S}/quality`, ...asSeller, seller.quality);
router.get(`${S}/export/:report.csv`, ...asSeller, seller.export);

router.get("/admin/analytics/overview", authMiddleware, requireRole("admin"), admin.overview);

module.exports = router;
