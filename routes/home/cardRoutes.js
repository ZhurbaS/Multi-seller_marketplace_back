const cardController = require("../../controllers/home/cardController");
const { customerAuthMiddleware } = require("../../middleware/authMiddleware");

const rateLimit = require("express-rate-limit");
const router = require("express").Router();

// Перебір промокодів: лімітуємо лише запити кошика, у яких передано купон.
const couponLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.query.coupon,
  message: { error: "Забагато спроб з купоном. Спробуйте за хвилину" },
});

// Кошик і список бажань — лише для залогіненого покупця (customerToken).
// Раніше ці роути були відкритими: будь-хто міг читати/змінювати чужий кошик.
router.post(
  "/home/product/add-to-card",
  customerAuthMiddleware,
  cardController.add_to_card
);
router.get(
  "/home/product/get-card-product/:userId",
  customerAuthMiddleware,
  couponLimiter,
  cardController.get_card_products
);
router.delete(
  "/home/product/delete-card-product/:card_id",
  customerAuthMiddleware,
  cardController.delete_card_product
);
router.put(
  "/home/product/quantity-inc/:card_id",
  customerAuthMiddleware,
  cardController.quantity_inc
);
router.put(
  "/home/product/quantity-dec/:card_id",
  customerAuthMiddleware,
  cardController.quantity_dec
);
router.post(
  "/home/product/add-to-wishlist",
  customerAuthMiddleware,
  cardController.add_wishlist
);
router.get(
  "/home/product/get-wishlist-products/:userId",
  customerAuthMiddleware,
  cardController.get_wishlist
);
router.delete(
  "/home/product/remove-wishlist-product/:wishlistId",
  customerAuthMiddleware,
  cardController.remove_wishlist
);

// «Повідомити про наявність»
const subscriptionController = require("../../controllers/home/subscriptionController");
router.post(
  "/home/product/notify-me",
  customerAuthMiddleware,
  subscriptionController.subscribe
);
router.get(
  "/home/product/notify-me/:productId",
  customerAuthMiddleware,
  subscriptionController.status
);
router.delete(
  "/home/product/notify-me/:productId",
  customerAuthMiddleware,
  subscriptionController.unsubscribe
);

module.exports = router;
