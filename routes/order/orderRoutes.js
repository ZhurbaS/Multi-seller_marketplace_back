const orderController = require("../../controllers/order/orderController");
const {
  authMiddleware,
  customerAuthMiddleware,
  requireRole,
} = require("../../middleware/authMiddleware");

const router = require("express").Router();

// Customer (потребують customerToken)
router.post(
  "/home/orders/place-order",
  customerAuthMiddleware,
  orderController.place_order
);
router.get(
  "/home/customer/get-dashboard-data/:userId",
  customerAuthMiddleware,
  orderController.get_customer_dashboard_data
);
router.get(
  "/home/customer/get-orders/:customerId/:status",
  customerAuthMiddleware,
  orderController.get_orders
);
router.get(
  "/home/customer/get-orders-details/:orderId",
  customerAuthMiddleware,
  orderController.get_orders_details
);
// Рахунок юрособи (PDF)
router.get(
  "/home/customer/orders/:orderId/invoice.pdf",
  customerAuthMiddleware,
  orderController.invoice_pdf
);
router.get(
  "/admin/orders/:orderId/invoice.pdf",
  authMiddleware,
  requireRole("admin"),
  orderController.invoice_pdf
);
router.post(
  "/admin/orders/:orderId/invoice/resend",
  authMiddleware,
  requireRole("admin"),
  orderController.invoice_resend
);
// Оплата тепер у /api/pay/* (див. payRoutes.js). Старий небезпечний
// /order/create-payment (Stripe, сума від клієнта) видалено.
// Ручне підтвердження оплати — лише адмін (напр., переказ на рахунок).
router.get(
  "/order/confirm/:orderId",
  authMiddleware,
  requireRole("admin"),
  orderController.order_confirm
);

// Admin (потребують accessToken з роллю admin)
router.get(
  "/admin/orders",
  authMiddleware,
  requireRole("admin"),
  orderController.get_admin_orders
);
router.get(
  "/admin/order/:orderId",
  authMiddleware,
  requireRole("admin"),
  orderController.get_admin_order_details
);
router.put(
  "/admin/order-status/update/:orderId",
  authMiddleware,
  requireRole("admin"),
  orderController.admin_order_status_update
);

// Seller (потребують accessToken з роллю seller)
router.get(
  "/seller/orders/:sellerId",
  authMiddleware,
  requireRole("seller"),
  orderController.get_seller_orders
);
router.get(
  "/seller/order/:orderId",
  authMiddleware,
  requireRole("seller"),
  orderController.get_seller_order_details
);
router.put(
  "/seller/order-status/update/:orderId",
  authMiddleware,
  requireRole("seller"),
  orderController.seller_order_status_update
);

module.exports = router;
