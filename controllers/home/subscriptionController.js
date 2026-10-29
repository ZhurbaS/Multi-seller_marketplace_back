const mongoose = require("mongoose");
const { responseReturn } = require("../../utiles/response");
const productModel = require("../../models/productModel");
const stockSubscriptionModel = require("../../models/stockSubscriptionModel");

const validId = (id) => mongoose.Types.ObjectId.isValid(id);

class subscriptionController {
  // Підписатись на повідомлення про наявність
  async subscribe(req, res) {
    try {
      const { productId } = req.body;
      if (!validId(productId)) {
        return responseReturn(res, 400, { error: "Некоректний товар" });
      }
      const product = await productModel.findById(productId).select("stock");
      if (!product) return responseReturn(res, 404, { error: "Товар не знайдено" });
      if (product.stock > 0) {
        return responseReturn(res, 400, { error: "Товар уже є в наявності" });
      }
      // upsert: повторна підписка (в т.ч. після отриманого листа) знову активує повідомлення
      await stockSubscriptionModel.updateOne(
        { userId: req.id, productId },
        { $set: { notifiedAt: null } },
        { upsert: true }
      );
      responseReturn(res, 200, {
        subscribed: true,
        message: "Ми повідомимо вас, коли товар з'явиться в наявності",
      });
    } catch (error) {
      console.error("💥 subscriptionController.subscribe:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  async unsubscribe(req, res) {
    try {
      const { productId } = req.params;
      if (!validId(productId)) {
        return responseReturn(res, 400, { error: "Некоректний товар" });
      }
      await stockSubscriptionModel.deleteOne({ userId: req.id, productId });
      responseReturn(res, 200, { subscribed: false, message: "Підписку скасовано" });
    } catch (error) {
      console.error("💥 subscriptionController.unsubscribe:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  async status(req, res) {
    try {
      const { productId } = req.params;
      if (!validId(productId)) {
        return responseReturn(res, 400, { error: "Некоректний товар" });
      }
      const sub = await stockSubscriptionModel.findOne({
        userId: req.id,
        productId,
        notifiedAt: null,
      });
      responseReturn(res, 200, { subscribed: !!sub });
    } catch (error) {
      console.error("💥 subscriptionController.status:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }
}

module.exports = new subscriptionController();
