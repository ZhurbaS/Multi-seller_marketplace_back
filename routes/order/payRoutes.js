const express = require("express");
const rateLimit = require("express-rate-limit");
const payController = require("../../controllers/order/payController");
const messengerController = require("../../controllers/order/messengerController");
const { authMiddleware, requireRole } = require("../../middleware/authMiddleware");
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
// Канали надсилання рахунку (e-mail + месенджери, якщо адмін їх увімкнув)
router.get("/pay/invoice-channels", messengerController.channels);
// Адмін: перемикачі месенджерів
router.get("/admin/settings/messengers", authMiddleware, requireRole("admin"), messengerController.admin_get);
router.put("/admin/settings/messengers", authMiddleware, requireRole("admin"), messengerController.admin_save);
// Підписане посилання на PDF рахунку для месенджерів
router.get("/invoice-file/:orderId/:exp/:sig.pdf", messengerController.invoice_file);
// Вебхуки статусів доставки повідомлень
router.get("/webhooks/whatsapp", messengerController.whatsapp_verify);
router.post("/webhooks/whatsapp", messengerController.whatsapp_hook);
router.post("/webhooks/viber", messengerController.viber_hook);
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
