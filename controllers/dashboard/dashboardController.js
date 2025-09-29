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

const { IncomingForm } = require("formidable");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
  secure: true,
});

const mongoose = require("mongoose");
const bannerModel = require("../../models/bannerModel");
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

  async add_banner(req, res) {
    const form = new IncomingForm({
      multiples: true,
      keepExtensions: true,
      allowEmptyFiles: false,
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) * 1024 * 1024,
    });

    form.parse(req, async (err, field, files) => {
      const productIdRaw = field.productId;
      const productId = Array.isArray(productIdRaw)
        ? productIdRaw[0]
        : productIdRaw;
      const mainbanRaw = files.mainban;
      const mainban = Array.isArray(mainbanRaw) ? mainbanRaw[0] : mainbanRaw;
      if (err) {
        return responseReturn(res, 400, { error: "😢 Parse error" });
      }
      if (!productId || !mainban) {
        return responseReturn(res, 400, {
          error: "ProductId and image are required",
        });
      }
      if (!mainban.filepath) {
        return responseReturn(res, 400, {
          error: "No valid banner file provided",
        });
      }
      // console.log(productIdRaw);
      // console.log(mainbanRaw);
      // console.log(productId);
      // console.log(mainban);

      try {
        const { slug } = await productModel.findById(productId);
        const result = await cloudinary.uploader.upload(mainban.filepath, {
          folder: "banners",
        });

        if (!result || !result.url) {
          return responseReturn(res, 500, {
            error: "Помилка завантаження банера",
          });
        }

        const banner = await bannerModel.create({
          productId: productId,
          banner: result.url,
          link: slug,
        });
        responseReturn(res, 200, {
          banner,
          message: "Банер додано успішно",
        });
      } catch (error) {
        return handleError(res, error, "bannerController → add_banner");
      }
    });
  }

  async get_banner(req, res) {
    const { productId } = req.params;

    // console.log(productId);

    try {
      const banner = await bannerModel.findOne({
        productId: new ObjectId(productId),
      });
      responseReturn(res, 200, { banner });
    } catch (error) {
      return handleError(res, error, "bannerController → get_banner");
    }
  }

  async update_banner(req, res) {
    const { bannerId } = req.params;
    // const { info } = req.body;
    // console.log(bannerId);
    // console.log(info);

    const form = new IncomingForm({
      multiples: true,
      keepExtensions: true,
      allowEmptyFiles: false,
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) * 1024 * 1024,
    });

    form.parse(req, async (err, _, files) => {
      let { mainban } = files;
      mainban = Array.isArray(mainban) ? mainban[0] : mainban;
      // console.log(mainban);
      if (err) {
        return responseReturn(res, 400, { error: "😢 Parse error" });
      }
      if (!mainban) {
        return responseReturn(res, 400, {
          error: "Mainban is required",
        });
      }
      if (!mainban.filepath) {
        return responseReturn(res, 400, {
          error: "No valid banner file provided",
        });
      }
      try {
        let banner = await bannerModel.findById(bannerId);
        // console.log(banner);
        let temp = banner.banner.split("/");
        temp = temp[temp.length - 1];
        const imageName = temp.split(".")[0];
        await cloudinary.uploader.destroy(imageName);

        const { url } = await cloudinary.uploader.upload(mainban.filepath, {
          folder: "banners",
        });

        await bannerModel.findByIdAndUpdate(bannerId, { banner: url });

        banner = await bannerModel.findById(bannerId);
        return responseReturn(res, 200, {
          banner,
          message: "Банер оновлено успішно",
        });
      } catch (error) {
        return handleError(res, error, "bannerController → update_banner");
      }
    });
  }

  async get_banners(req, res) {
    try {
      const banners = await bannerModel.aggregate([{ $sample: { size: 5 } }]);
      responseReturn(res, 200, { banners });
    } catch (error) {
      return handleError(res, error, "bannerController → get_banners");
    }
  }
}

module.exports = new dashboardController();
