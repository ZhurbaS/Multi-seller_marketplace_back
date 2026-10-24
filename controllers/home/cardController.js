const { responseReturn } = require("../../utiles/response");
const cardModel = require("../../models/cardModel");
// const {
//   mongo: { ObjectId },
// } = require("mongoose");

const mongoose = require("mongoose");
const wishlistModel = require("../../models/wishlistModel");
const ObjectId = mongoose.Types.ObjectId;

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
        responseReturn(res, 404, { error: "Товар уже в кошику" });
      } else {
        const product = await cardModel.create({
          userId,
          productId,
          quantity,
        });

        responseReturn(res, 201, {
          message: "Товар додано до кошика",
          product,
        });
      }
    } catch (error) {
      console.error("💥 Error in cardController: add_to_card:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  };

  async get_card_products(req, res) {
    const commission = 5;
    // console.log("hello");
    const { userId } = req.params;
    // console.log(userId);

    try {
      const card_products = await cardModel.aggregate([
        {
          $match: {
            userId: {
              $eq: new ObjectId(userId),
            },
          },
        },
        {
          $lookup: {
            from: "products",
            localField: "productId",
            foreignField: "_id",
            as: "products",
          },
        },
      ]);

      let buy_product_item = 0;
      let calculatePrice = 0;
      let card_product_count = 0;

      const outOfStockProduct = card_products.filter(
        (p) => p.products[0].stock < p.quantity
      );
      for (let i = 0; i < outOfStockProduct.length; i++) {
        card_product_count = card_product_count + outOfStockProduct[i].quantity;
      }

      const stockProduct = card_products.filter(
        (p) => p.products[0].stock >= p.quantity
      );
      for (let i = 0; i < stockProduct.length; i++) {
        const { quantity } = stockProduct[i];
        card_product_count = buy_product_item + quantity;
        buy_product_item = buy_product_item + quantity;
        const { price, discount } = stockProduct[i].products[0];
        if (discount !== 0) {
          calculatePrice =
            calculatePrice +
            quantity * (price - Math.floor((price * discount) / 100));
        } else {
          calculatePrice = calculatePrice + quantity * price;
        }
      }

      let p = [];
      let uniqueSellerId = [
        ...new Set(stockProduct.map((p) => p.products[0].sellerId.toString())),
      ];
      for (let i = 0; i < uniqueSellerId.length; i++) {
        let price = 0;
        for (let j = 0; j < stockProduct.length; j++) {
          const tempProduct = stockProduct[j].products[0];
          if (uniqueSellerId[i] === tempProduct.sellerId.toString()) {
            let pri = 0;
            if (tempProduct.discount !== 0) {
              pri =
                tempProduct.price -
                Math.floor((tempProduct.price * tempProduct.discount) / 100);
            } else {
              pri = tempProduct.price;
            }
            pri = pri - Math.floor((pri * commission) / 100);
            price = price + pri * stockProduct[j].quantity;
            p[i] = {
              sellerId: uniqueSellerId[i],
              shopName: tempProduct.shopName,
              price,
              products: p[i]
                ? [
                    ...p[i].products,
                    {
                      _id: stockProduct[j]._id,
                      quantity: stockProduct[j].quantity,
                      productInfo: tempProduct,
                    },
                  ]
                : [
                    {
                      _id: stockProduct[j]._id,
                      quantity: stockProduct[j].quantity,
                      productInfo: tempProduct,
                    },
                  ],
            };
          }
        }
      }
      responseReturn(res, 200, {
        card_products: p,
        price: calculatePrice,
        card_product_count,
        shipping_fee: 20 * p.length,
        buy_product_item,
        outOfStockProduct,
      });
      // console.log(p);
    } catch (error) {
      console.error("💥 Error in cardController: get_card_products:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  async delete_card_product(req, res) {
    const { card_id } = req.params;
    // console.log(card_id);
    try {
      await cardModel.findByIdAndDelete(card_id);
      responseReturn(res, 200, {
        message: "Товар видалено з кошика",
      });
    } catch (error) {
      console.error("💥 Error in cardController: delete_card_product:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  async quantity_inc(req, res) {
    const { card_id } = req.params;
    // console.log(card_id);
    if (!mongoose.Types.ObjectId.isValid(card_id)) {
      return responseReturn(res, 400, { error: "Некоректний ідентифікатор кошика" });
    }

    try {
      const product = await cardModel.findById(card_id);
      if (!product) {
        return responseReturn(res, 404, { error: "Товар не знайдено в кошику" });
      }
      const { quantity } = product;
      await cardModel.findByIdAndUpdate(card_id, { quantity: quantity + 1 });
      responseReturn(res, 200, {
        message: "Кількість оновлено",
      });
    } catch (error) {
      console.error("💥 Error in cardController: quantity_inc:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  async quantity_dec(req, res) {
    const { card_id } = req.params;
    // console.log(card_id);
    if (!mongoose.Types.ObjectId.isValid(card_id)) {
      return responseReturn(res, 400, { error: "Некоректний ідентифікатор кошика" });
    }

    try {
      const product = await cardModel.findById(card_id);
      if (!product) {
        return responseReturn(res, 404, { error: "Товар не знайдено в кошику" });
      }
      const { quantity } = product;
      await cardModel.findByIdAndUpdate(card_id, { quantity: quantity - 1 });
      responseReturn(res, 200, {
        message: "Кількість оновлено",
      });
    } catch (error) {
      console.error("💥 Error in cardController: quantity_dec:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  async add_wishlist(req, res) {
    // console.log(req.body);
    const { slug, slugBase } = req.body;
    try {
      const product = await wishlistModel.findOne({ slugBase });
      if (product) {
        responseReturn(res, 404, {
          error: "Товар уже в списку бажань",
        });
      } else {
        await wishlistModel.create(req.body);
        responseReturn(res, 201, {
          message: "Товар додано до списку бажань",
        });
      }
    } catch (error) {
      console.error("💥 Error in cardController: add_wishlist:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  async get_wishlist(req, res) {
    // console.log(req.params);
    const { userId } = req.params;

    try {
      const wishlistProducts = await wishlistModel.find({
        userId: userId,
      });
      responseReturn(res, 200, {
        wishlistCount: wishlistProducts.length,
        wishlistProducts,
      });
    } catch (error) {
      console.error("💥 Error in cardController: get_wishlist:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  async remove_wishlist(req, res) {
    // console.log(req.params);

    const { wishlistId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(wishlistId)) {
      return responseReturn(res, 404, { error: "Некоректний ідентифікатор елемента списку бажань" });
    }

    try {
      const wishlist = await wishlistModel.findByIdAndDelete(wishlistId);
      if (!wishlist) {
        return responseReturn(res, 404, { error: "Елемент списку бажань не знайдено" });
      }
      responseReturn(res, 200, {
        message: "Товар видалено зі списку бажань",
        wishlistId,
      });
    } catch (error) {
      console.error("💥 Error in cardController: remove_wishlist:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }
}

module.exports = new cardController();
