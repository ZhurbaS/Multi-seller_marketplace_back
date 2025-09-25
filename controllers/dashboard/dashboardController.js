const { responseReturn } = require("../../utiles/response");
const myShopWallet = require("../../models/myShopWallet");
const sellerWallet = require("../../models/sellerWallet");
const authorOrderModel = require("../../models/authorOrderModel");
const productModel = require("../../models/productModel");
const customerOrderModel = require("../../models/customerOrderModel");
const sellerModel = require("../../models/sellerModel");

const handleError = require("../../utiles/handleError");
const adminSellerMessage = require("../../models/chat/adminSellerMessage");
const sellerCustomerMessage = require("../../models/chat/sellerCustomerMessage");

const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;

class dashboardController {
  async get_admin_dashboard_data(req, res) {
    const { id } = req;
    // console.log(id);

    try {
      const totalSale = await myShopWallet.aggregate([
        { $group: { _id: null, totalAmount: { $sum: "$amount" } } },
      ]);

      const totalProduct = await productModel.find({}).countDocuments();
      const totalOrder = await customerOrderModel.find({}).countDocuments();
      const totalSeller = await sellerModel.find({}).countDocuments();
      const messages = await adminSellerMessage.find({}).limit(3);
      const recentOrders = await customerOrderModel.find({}).limit(5);

      responseReturn(res, 200, {
        totalProduct,
        totalOrder,
        totalSeller,
        messages,
        recentOrders,
        totalSale: totalSale.length > 0 ? totalSale[0].totalAmount : 0,
      });
    } catch (error) {
      console.error(
        "💥 Error in dashboardController: get_admin_dashboard_data:",
        error
      );
      return handleError(
        res,
        error,
        "paymentController → get_admin_dashboard_data"
      );
    }
  }

  async get_seller_dashboard_data(req, res) {
    const { id } = req;
    // console.log(id);

    try {
      const totalSale = await sellerWallet.aggregate([
        { $match: { sellerId: { $eq: id } } },
        { $group: { _id: null, totalAmount: { $sum: "$amount" } } },
      ]);

      const totalProduct = await productModel
        .find({ sellerId: new ObjectId(id) })
        .countDocuments();
      const totalOrder = await authorOrderModel
        .find({ sellerId: new ObjectId(id) })
        .countDocuments();
      const totalPendingOrder = await authorOrderModel
        .find({
          $and: [
            { sellerId: { $eq: new ObjectId(id) } },
            { delivery_status: { $eq: "pending" } },
          ],
        })
        .countDocuments();

      const messages = await sellerCustomerMessage
        .find({ $or: [{ senderId: { $eq: id } }, { receiverId: { $eq: id } }] })
        .limit(3);
      const recentOrders = await authorOrderModel
        .find({ sellerId: new ObjectId(id) })
        .limit(5);

      responseReturn(res, 200, {
        totalProduct,
        totalOrder,
        totalPendingOrder,
        messages,
        recentOrders,
        totalSale: totalSale.length > 0 ? totalSale[0].totalAmount : 0,
      });
    } catch (error) {
      console.error(
        "💥 Error in dashboardController: get_seller_dashboard_data:",
        error
      );
      return handleError(
        res,
        error,
        "paymentController → get_seller_dashboard_data"
      );
    }
  }
}

module.exports = new dashboardController();
