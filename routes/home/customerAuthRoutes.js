const customerAuthController = require("../../controllers/home/customerAuthController");
const homeController = require("../../controllers/home/homeController");
const { loginLimiter } = require("../../middleware/rateLimiter");
const { customerAuthMiddleware } = require("../../middleware/authMiddleware");
const access = require("../../controllers/home/accessController");
const rateLimit = require("express-rate-limit");
const accessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Забагато спроб. Спробуйте пізніше" },
});
const guestLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { error: "Забагато запитів" } });

const router = require("express").Router();

router.post(
  "/customer/customer-register",
  customerAuthController.customer_register
);
router.post(
  "/customer/customer-login",
  loginLimiter,
  customerAuthController.customer_login
);
router.get("/customer/logout", customerAuthController.customer_logout);

// Вхід без пароля, гостьове оформлення, Google
router.get("/customer/auth-config", access.config);
router.post("/customer/guest-session", guestLimiter, access.guest_session);
router.put("/customer/guest-claim", customerAuthMiddleware, accessLimiter, access.guest_claim);
router.post("/customer/otp/request", accessLimiter, access.otp_request);
router.post("/customer/otp/verify", accessLimiter, access.otp_verify);
router.post("/customer/google", accessLimiter, access.google);

module.exports = router;
