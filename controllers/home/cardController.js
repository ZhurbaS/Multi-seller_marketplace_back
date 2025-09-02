const { responseReturn } = require("../../utiles/response");
const cardModel = require("../../models/cardModel");

class cardController {
  add_to_card = async (req, res) => {
    // console.log(req.body);
    const { userId, productId, quantity } = req.body;
    try {
      const product = await cardModel.findOne({
        $and: [
          {
            productId: {
              $eq: productId,
            },
          },
          {
            userId: {
              $eq: userId,
            },
          },
        ],
      });
      if (product) {
        responseReturn(res, 404, { error: "Product already added to card" });
      } else {
        const product = await cardModel.create({
          userId,
          productId,
          quantity,
        });

        responseReturn(res, 201, {
          message: "Added to card successfully",
          product,
        });
      }
    } catch (error) {
      console.error("💥 Error in cardController: add_to_card:", error);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  };
}

module.exports = new cardController();
