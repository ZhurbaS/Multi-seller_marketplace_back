const homeController = require("../../controllers/home/homeController");
const {
  authMiddleware,
  customerAuthMiddleware,
  requireRole,
} = require("../../middleware/authMiddleware");
const { reviewLimiter } = require("../../middleware/rateLimiter");

const router = require("express").Router();

router.get("/get-categories", homeController.get_categories);
router.get("/get-products", homeController.get_products);
router.get("/price-range-latest-product", homeController.price_range_product);
router.get("/query-products", homeController.query_products);
router.get("/product-details/:slug", homeController.get_product_details);

// Відгуки — публічний список тільки зі схваленими; надсилання і перевірка
// права на відгук вимагають реального клієнта (customerAuthMiddleware),
// а не просто productId+ім'я з тіла запиту, як було раніше.
router.get("/customer/get-reviews/:productId", homeController.get_reviews);
router.post(
  "/customer/submit-review",
  customerAuthMiddleware,
  reviewLimiter,
  homeController.submit_review
);
router.get(
  "/customer/can-review/:productId",
  customerAuthMiddleware,
  homeController.can_review
);

// Модерація відгуків — лише адмін.
router.get(
  "/admin/reviews",
  authMiddleware,
  requireRole("admin"),
  homeController.admin_get_reviews
);
router.patch(
  "/admin/review/:reviewId/status",
  authMiddleware,
  requireRole("admin"),
  homeController.admin_review_status_update
);

module.exports = router;
