const sellerController = require("../../controllers/dashboard/sellerController");
const { authMiddleware, requireRole } = require("../../middleware/authMiddleware");

const router = require("express").Router();

// Усі роути нижче — керування продавцями (черга на модерацію, активація,
// деактивація). Раніше мали лише authMiddleware — будь-який залогінений
// продавець міг сам собі (чи будь-кому) виставити status: "active" через
// seller-status-update, минаючи модерацію адміном. Тепер лише адмін.
router.get(
  "/request-seller-get",
  authMiddleware,
  requireRole("admin"),
  sellerController.request_seller_get
);
router.get(
  "/get-seller/:sellerId",
  authMiddleware,
  requireRole("admin"),
  sellerController.get_seller
);
router.post(
  "/seller-status-update",
  authMiddleware,
  requireRole("admin"),
  sellerController.seller_status_update
);
router.get(
  "/get-sellers",
  authMiddleware,
  requireRole("admin"),
  sellerController.get_active_sellers
);
router.get(
  "/get-deactive-sellers",
  authMiddleware,
  requireRole("admin"),
  sellerController.get_deactive_sellers
);

module.exports = router;
