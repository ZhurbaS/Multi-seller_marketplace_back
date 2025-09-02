const customerAuthController = require("../../controllers/home/customerAuthController");
const homeController = require("../../controllers/home/homeController");

const router = require("express").Router();

router.post(
  "/customer/customer-register",
  customerAuthController.customer_register
);
router.post("/customer/customer-login", customerAuthController.customer_login);

module.exports = router;
