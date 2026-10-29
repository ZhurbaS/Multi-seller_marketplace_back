const customerAuthController = require("../../controllers/home/customerAuthController");
const homeController = require("../../controllers/home/homeController");
const { loginLimiter } = require("../../middleware/rateLimiter");

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

module.exports = router;
