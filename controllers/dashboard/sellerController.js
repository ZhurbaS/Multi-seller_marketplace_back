const { IncomingForm } = require("formidable");
const { responseReturn } = require("../../utiles/response");
const cloudinary = require("cloudinary").v2;
const sellerModel = require("../../models/sellerModel");
const slugify = require("slugify");
const { nanoid } = require("nanoid");

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
  secure: true,
});

class sellerController {
  request_seller_get = async (req, res) => {
    const { page, searchValue, perPage } = req.query;
    const skipPage = parseInt(perPage) * (parseInt(page) - 1);

    try {
      if (searchValue) {
      } else {
        const sellers = await sellerModel
          .find({ status: "pending" })
          .skip(skipPage)
          .limit(parseInt(perPage))
          .sort({ createdAt: -1 });
        const totalSeller = await sellerModel
          .find({ status: "pending" })
          .countDocuments();
        responseReturn(res, 200, { sellers, totalSeller });
      }
    } catch (error) {
      console.error("💥 Error in sellerController request_seller_get:", error);
      responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  };

  get_seller = async (req, res) => {
    const { sellerId } = req.params;
    // console.log(sellerId);
    try {
      const seller = await sellerModel.findById(sellerId);
      responseReturn(res, 200, { seller });
    } catch (error) {
      console.error("💥 Error in sellerController get_seller:", error);
      responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  };

  seller_status_update = async (req, res) => {
    const { sellerId, status } = req.body;
    console.log(sellerId);
    try {
      await sellerModel.findByIdAndUpdate(sellerId, { status });
      const seller = await sellerModel.findById(sellerId);
      responseReturn(res, 200, {
        seller,
        message: "Seller status updated successfully ✅",
      });
    } catch (error) {
      console.error(
        "💥 Error in sellerController seller_status_update:",
        error
      );
      responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  };
}

module.exports = new sellerController();
