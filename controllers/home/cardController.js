const { responseReturn } = require("../../utiles/response");
const cardModel = require("../../models/cardModel");
const mongoose = require("mongoose");
const wishlistModel = require("../../models/wishlistModel");
const productModel = require("../../models/productModel");
const pricing = require("../../utiles/pricing");
const { buildCart, CART_TTL_DAYS } = require("../../utiles/cartService");

class cardController {
  add_to_card = async (req, res) => {
    // userId беремо з токена (customerAuthMiddleware), а не з тіла запиту.
    const userId = req.id;
    const { productId } = req.body;
    const requested = Number(req.body.quantity);
    try {
      if (!mongoose.Types.ObjectId.isValid(productId)) {
        return responseReturn(res, 400, { error: "Некоректний товар" });
      }
      const dbProduct = await productModel.findById(productId);
      if (!dbProduct) {
        return responseReturn(res, 404, { error: "Товар не знайдено" });
      }
      // Якщо кількість не вказано — беремо мінімальне замовлення товару.
      const quantity = Number.isFinite(requested) && req.body.quantity !== undefined
        ? requested
        : dbProduct.minOrderQty || 1;
      const avail = pricing.availability(dbProduct, quantity);
      if (!avail.ok) {
        return responseReturn(res, 400, { error: avail.error });
      }

      const existing = await cardModel.findOne({ productId, userId });
      if (existing) {
        return responseReturn(res, 404, { error: "Товар уже в кошику" });
      }
      const product = await cardModel.create({ userId, productId, quantity });
      responseReturn(res, 201, {
        message: avail.preorder
          ? "Передзамовлення додано до кошика"
          : "Товар додано до кошика",
        product,
      });
    } catch (error) {
      console.error("💥 Error in cardController: add_to_card:", error);
      return responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  };

  async get_card_products(req, res) {
    const { userId } = req.params;
    // Раніше будь-хто міг прочитати чужий кошик, підставивши userId.
    if (req.id !== userId) {
      return responseReturn(res, 403, { error: "Доступ заборонено" });
    }

    try {
      // Збір кошика (ціни, знижки, купон) — у utiles/cartService.js
      const couponCode =
        typeof req.query.coupon === "string" ? req.query.coupon.slice(0, 64) : "";
      const cart = await buildCart(userId, { couponCode });
      responseReturn(res, 200, cart);
    } catch (error) {
      console.error("💥 Error in cardController: get_card_products:", error);
      return responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  async delete_card_product(req, res) {
    const { card_id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(card_id)) {
      return responseReturn(res, 400, { error: "Некоректний ідентифікатор кошика" });
    }
    try {
      // Видаляємо лише власну позицію кошика.
      await cardModel.deleteOne({ _id: card_id, userId: req.id });
      responseReturn(res, 200, { message: "Товар видалено з кошика" });
    } catch (error) {
      console.error("💥 Error in cardController: delete_card_product:", error);
      return responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Змінює кількість на один крок товару (orderStep). direction: +1 / -1.
  async changeQuantity(req, res, direction) {
    const { card_id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(card_id)) {
      return responseReturn(res, 400, { error: "Некоректний ідентифікатор кошика" });
    }
    try {
      const item = await cardModel.findById(card_id);
      if (!item) {
        return responseReturn(res, 404, { error: "Товар не знайдено в кошику" });
      }
      if (item.userId.toString() !== req.id) {
        return responseReturn(res, 403, { error: "Доступ заборонено" });
      }
      const product = await productModel.findById(item.productId);
      if (!product) {
        return responseReturn(res, 404, { error: "Товар більше не продається" });
      }
      const step = Math.max(1, product.orderStep || 1);
      const newQty = item.quantity + direction * step;
      const avail = pricing.availability(product, newQty);
      if (!avail.ok) {
        return responseReturn(res, 400, { error: avail.error });
      }
      await cardModel.findByIdAndUpdate(card_id, { quantity: newQty });
      responseReturn(res, 200, { message: "Кількість оновлено" });
    } catch (error) {
      console.error("💥 Error in cardController: changeQuantity:", error);
      return responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  quantity_inc = (req, res) => this.changeQuantity(req, res, +1);
  quantity_dec = (req, res) => this.changeQuantity(req, res, -1);

  async add_wishlist(req, res) {
    const { productId, name, price, slug, slugBase, discount, image, rating } =
      req.body;
    try {
      // Раніше перевірка була лише за slugBase (без userId) — товар одного покупця
      // блокував його додавання іншим, а в БД потрапляв довільний req.body.
      const product = await wishlistModel.findOne({ userId: req.id, slugBase });
      if (product) {
        responseReturn(res, 404, { error: "Товар уже в списку бажань" });
      } else {
        await wishlistModel.create({
          userId: req.id,
          productId,
          name,
          price,
          slug,
          slugBase,
          discount,
          image,
          rating,
        });
        responseReturn(res, 201, { message: "Товар додано до списку бажань" });
      }
    } catch (error) {
      console.error("💥 Error in cardController: add_wishlist:", error);
      return responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  async get_wishlist(req, res) {
    const { userId } = req.params;
    if (req.id !== userId) {
      return responseReturn(res, 403, { error: "Доступ заборонено" });
    }
    try {
      const wishlistProducts = await wishlistModel.find({ userId });
      responseReturn(res, 200, {
        wishlistCount: wishlistProducts.length,
        wishlistProducts,
      });
    } catch (error) {
      console.error("💥 Error in cardController: get_wishlist:", error);
      return responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  async remove_wishlist(req, res) {
    const { wishlistId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(wishlistId)) {
      return responseReturn(res, 404, {
        error: "Некоректний ідентифікатор елемента списку бажань",
      });
    }
    try {
      const wishlist = await wishlistModel.findOneAndDelete({
        _id: wishlistId,
        userId: req.id,
      });
      if (!wishlist) {
        return responseReturn(res, 404, { error: "Елемент списку бажань не знайдено" });
      }
      responseReturn(res, 200, {
        message: "Товар видалено зі списку бажань",
        wishlistId,
      });
    } catch (error) {
      console.error("💥 Error in cardController: remove_wishlist:", error);
      return responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }
}

module.exports = new cardController();
module.exports.CART_TTL_DAYS = CART_TTL_DAYS;
