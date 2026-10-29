const express = require("express");
const rateLimit = require("express-rate-limit");
const returnController = require("../controllers/returnController");
const { authMiddleware, customerAuthMiddleware, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

// Не більше 10 заявок на годину з однієї адреси
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Забагато заявок. Спробуйте пізніше або зверніться до підтримки" },
});

// ---- Покупець (публічна політика — у settingsRoutes: GET /home/returns/policy)
router.get("/home/returns/eligibility/:orderId", customerAuthMiddleware, returnController.eligibility);
router.get("/home/returns", customerAuthMiddleware, returnController.list);
router.post("/home/returns", customerAuthMiddleware, createLimiter, returnController.create);
router.get("/home/returns/:id", customerAuthMiddleware, returnController.details);
router.put("/home/returns/:id/shipment", customerAuthMiddleware, returnController.ship);
router.put("/home/returns/:id/cancel", customerAuthMiddleware, returnController.cancel);

// ---- Адмін
const admin = [authMiddleware, requireRole("admin")];
router.get("/admin/returns", ...admin, returnController.admin_list);
router.post("/admin/returns", ...admin, returnController.admin_create);
router.get("/admin/returns/:id", ...admin, returnController.admin_details);
router.put("/admin/returns/:id/approve", ...admin, returnController.admin_approve);
router.put("/admin/returns/:id/reject", ...admin, returnController.admin_reject);
router.put("/admin/returns/:id/shipment", ...admin, returnController.admin_shipment);
router.put("/admin/returns/:id/receive", ...admin, returnController.admin_receive);
router.put("/admin/returns/:id/exchange", ...admin, returnController.admin_exchange);
router.put("/admin/returns/:id/visibility", ...admin, returnController.admin_visibility);
router.post("/admin/returns/:id/refund", ...admin, returnController.admin_refund);
router.post("/admin/returns/:id/refund/retry", ...admin, returnController.admin_refund_retry);
router.post("/admin/returns/:id/refund/manual", ...admin, returnController.admin_refund_manual);
router.post("/admin/returns/:id/refund/sync", ...admin, returnController.admin_refund_sync);
router.put("/admin/orders/:orderId/return-override", ...admin, returnController.admin_order_override);

// ---- Продавець (лише перегляд)
router.get("/seller/returns", authMiddleware, requireRole("seller"), returnController.seller_list);

module.exports = router;
