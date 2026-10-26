const express = require("express");
const rateLimit = require("express-rate-limit");
const payController = require("../../controllers/order/payController");
const { customerAuthMiddleware } = require("../../middleware/authMiddleware");

const router = express.Router();

const payLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Забагато запитів, спробуйте за хвилину" },
});

// Покупець (потребує customerToken)
router.get("/pay/methods", payController.methods);
router.post("/pay/start", customerAuthMiddleware, payLimiter, payController.start);
router.get(
  "/pay/verify/:orderId",
  customerAuthMiddleware,
  payLimiter,
  payController.verify
);
router.post(
  "/pay/mock/complete",
  customerAuthMiddleware,
  payLimiter,
  payController.mockComplete
);

// Вебхуки платіжних систем — БЕЗ cookie-авторизації; захищені підписом.
router.post("/pay/webhook/monobank", payController.monobankWebhook);
router.post(
  "/pay/webhook/liqpay",
  express.urlencoded({ extended: false }),
  payController.liqpayWebhook
);

module.exports = router;
