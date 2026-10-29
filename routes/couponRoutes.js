const couponController = require("../controllers/couponController");
const { authMiddleware, requireRole } = require("../middleware/authMiddleware");

const router = require("express").Router();
const admin = [authMiddleware, requireRole("admin")];

// Купони створює й веде лише адмін. Покупець вводить код у кошику (GET кошика з ?coupon=CODE).
router.get("/admin/coupons", ...admin, couponController.list);
router.get("/admin/coupons/generate-code", ...admin, couponController.generate_code);
router.post("/admin/coupons", ...admin, couponController.create);
router.put("/admin/coupons/:id", ...admin, couponController.update);
router.put("/admin/coupons/:id/active", ...admin, couponController.set_active);
router.delete("/admin/coupons/:id", ...admin, couponController.remove);
router.get("/admin/coupons/:id/redemptions", ...admin, couponController.redemptions);

module.exports = router;
