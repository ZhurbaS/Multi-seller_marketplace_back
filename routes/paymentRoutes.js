const paymentController = require("../controllers/payment/paymentController");
const { authMiddleware, requireRole } = require("../middleware/authMiddleware");

const router = require("express").Router();

router.get(
  "/payment/create-stripe-connect-account",
  authMiddleware,
  requireRole("seller"),
  paymentController.create_stripe_connect_account
);
router.put(
  "/payment/active-stripe-connect-account/:activeCode",
  authMiddleware,
  requireRole("seller"),
  paymentController.active_stripe_connect_account
);
// Дозволено і продавцю (лише свій сellerId — перевірка всередині контролера),
// і адміну (будь-який seller, потрібно для перегляду перед підтвердженням виплати).
router.get(
  "/payment/seller-payment-details/:sellerId",
  authMiddleware,
  paymentController.get_seller_payment_details
);
router.post(
  "/payment/withdrawal-request",
  authMiddleware,
  requireRole("seller"),
  paymentController.withdrawal_request
);
// Раніше без requireRole("admin") — будь-який продавець міг переглянути список
// усіх запитів на виплату і сам собі (чи будь-кому) підтвердити виплату нижче.
router.get(
  "/payment/requests",
  authMiddleware,
  requireRole("admin"),
  paymentController.get_payment_requests
);
router.post(
  "/payment/request-confirm",
  authMiddleware,
  requireRole("admin"),
  paymentController.payment_request_confirm
);

module.exports = router;
