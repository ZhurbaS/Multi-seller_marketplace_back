// Маркетингова підписка: публічні ендпойнти, редірект кліків, «Підписки» в кабінеті, вебхуки.
// Підключення в server.js: app.use("/api", require("./routes/home/subscriptionRoutes"))
const express = require("express");
const ctrl = require("../../controllers/home/marketingSubscriptionController");
const { customerAuthMiddleware } = require("../../middleware/authMiddleware");
const { middleware: rl, limiter } = require("../../utiles/rateLimit");

const HOUR = 60 * 60 * 1000;
const router = express.Router();

// Ліміти (in-memory): підписка — 5/год на IP і 3/год на e-mail (спека §5)
const subscribeIp = rl({ max: 5, windowMs: HOUR, message: "Забагато спроб підписки. Спробуйте пізніше" });
const subscribeEmail = limiter({ max: 3, windowMs: HOUR });
const confirmIp = rl({ max: 30, windowMs: 15 * 60 * 1000 });
const prefIp = rl({ max: 60, windowMs: 15 * 60 * 1000 });
// One-click приходить з IP поштових сервісів (спільні для багатьох людей) — ліміт м'якший
const unsubIp = rl({ max: 300, windowMs: 15 * 60 * 1000 });
// List-Unsubscribe=One-Click надсилається як application/x-www-form-urlencoded
const form = express.urlencoded({ extended: false, limit: "10kb" });

router.post("/home/subscribe", subscribeIp, (req, res, next) => ctrl.subscribe(req, res, next, { emailLimiter: subscribeEmail }));
router.post("/home/subscribe/confirm", confirmIp, ctrl.confirm);
router.get("/home/preferences", prefIp, ctrl.getPreferences);
router.put("/home/preferences", prefIp, ctrl.putPreferences);
router.post("/home/preferences/erase", prefIp, ctrl.erase);
router.get("/home/unsubscribe", unsubIp, ctrl.unsubscribe);
router.post("/home/unsubscribe", unsubIp, form, ctrl.unsubscribe);
router.get("/home/marketing-config", ctrl.config);
router.get("/home/customer/subscriptions", customerAuthMiddleware, ctrl.getCustomerSubscriptions);
router.put("/home/customer/subscriptions", customerAuthMiddleware, prefIp, ctrl.putCustomerSubscriptions);
router.get("/r/:msgToken", ctrl.click);

router.use(require("../webhookRoutes"));

module.exports = router;
