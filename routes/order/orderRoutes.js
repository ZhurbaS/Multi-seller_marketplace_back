const orderController = require("../../controllers/order/orderController");

const router = require("express").Router();

router.post("/home/oders/place-order", orderController.place_order);
router.get(
  "/home/customer/get-dashboard-data/:userId",
  orderController.get_customer_dashboard_data
);
router.get(
  "/home/customer/get-orders/:customerId/:status",
  orderController.get_orders
);
router.get(
  "/home/customer/get-orders-details/:orderId",
  orderController.get_orders_details
);

// Admin
router.get("/admin/orders", orderController.get_admin_orders);
router.get("/admin/order/:orderId", orderController.get_admin_order_details);

// Seller

module.exports = router;
