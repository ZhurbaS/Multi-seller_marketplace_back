// require("dotenv").config();
const moment = require("moment");
const { responseReturn } = require("../../utiles/response");
const authorOrderModel = require("../../models/authorOrderModel");
const customerOrderModel = require("../../models/customerOrderModel");
const myShopWallet = require("../../models/myShopWallet");
const sellerWallet = require("../../models/sellerWallet");
const cardModel = require("../../models/cardModel");
const productModel = require("../../models/productModel");
const handleError = require("../../utiles/handleError");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;

class orderController {
  constructor() {
    this.place_order = this.place_order.bind(this);
  }

  async paymentCheck(id) {
    try {
      const order = await customerOrderModel.findById(id);
      if (order.payment_status === "unpaid") {
        await customerOrderModel.findByIdAndUpdate(id, {
          delivery_status: "cancelled",
        });
        await authorOrderModel.updateMany(
          {
            orderId: id,
          },
          {
            delivery_status: "cancelled",
          }
        );
      }
      return true;
    } catch (error) {
      console.error("💥 Error in orderController: paymentCheck:", error);
    }
  }

  async place_order(req, res) {
    // console.log(req.body);
    const { products, shipping_fee, shippingInfo } = req.body;
    // customerId завжди з токена (customerAuthMiddleware), а НЕ з тіла запиту —
    // раніше клієнт міг підставити чужий userId.
    const userId = req.id;

    if (!Array.isArray(products) || products.length === 0) {
      return responseReturn(res, 400, { error: "Кошик порожній" });
    }

    const numericShippingFee = Number(shipping_fee);
    if (!Number.isFinite(numericShippingFee) || numericShippingFee < 0) {
      return responseReturn(res, 400, {
        error: "Некоректна вартість доставки",
      });
    }

    const tempDate = moment(Date.now()).format("LLL");

    try {
      // Зібрати всі id товарів і підвантажити РЕАЛЬНІ дані з БД. Раніше price,
      // discount і навіть sellerId бралися напряму з тіла запиту — клієнт міг
      // вписати будь-яку ціну чи чужий sellerId (щоб гроші пішли не тому продавцю).
      const allProductIds = [];
      for (const sellerGroup of products) {
        for (const item of sellerGroup?.products || []) {
          if (item?.productInfo?._id) allProductIds.push(item.productInfo._id);
        }
      }

      const dbProducts = await productModel.find({
        _id: { $in: allProductIds },
      });
      const dbProductMap = new Map(
        dbProducts.map((p) => [p._id.toString(), p])
      );

      let authorOrderData = [];
      let customerOrderProducts = [];
      let cardProductsId = [];
      let totalPrice = 0;

      for (const sellerGroup of products) {
        let sellerTotal = 0;
        let storeProducts = [];
        let sellerId = null;

        for (const item of sellerGroup?.products || []) {
          const dbProduct = dbProductMap.get(item?.productInfo?._id);
          if (!dbProduct) {
            return responseReturn(res, 400, {
              error: "Один з товарів не знайдено — оновіть кошик",
            });
          }

          const quantity = Number(item.quantity);
          if (!Number.isInteger(quantity) || quantity < 1) {
            return responseReturn(res, 400, {
              error: "Некоректна кількість товару",
            });
          }
          if (quantity > dbProduct.stock) {
            return responseReturn(res, 400, {
              error: `Недостатньо товару "${dbProduct.name}" на складі`,
            });
          }

          const unitPrice =
            dbProduct.price -
            Math.floor((dbProduct.price * dbProduct.discount) / 100);

          const orderedProduct = {
            _id: dbProduct._id,
            name: dbProduct.name,
            price: dbProduct.price,
            discount: dbProduct.discount,
            images: dbProduct.images,
            sellerId: dbProduct.sellerId,
            quantity,
          };

          storeProducts.push(orderedProduct);
          customerOrderProducts.push(orderedProduct);
          sellerTotal += unitPrice * quantity;
          sellerId = dbProduct.sellerId;

          if (item._id) cardProductsId.push(item._id);
        }

        totalPrice += sellerTotal;
        authorOrderData.push({
          sellerId,
          products: storeProducts,
          price: sellerTotal,
        });
      }

      const finalPrice = totalPrice + numericShippingFee;

      const order = await customerOrderModel.create({
        customerId: userId,
        shippingInfo,
        products: customerOrderProducts,
        price: finalPrice,
        payment_status: "unpaid",
        delivery_status: "pending",
        date: tempDate,
      });

      authorOrderData = authorOrderData.map((sellerOrder) => ({
        ...sellerOrder,
        orderId: order.id,
        payment_status: "unpaid",
        shippingInfo: "Easy Main Warehouse",
        delivery_status: "pending",
        date: tempDate,
      }));

      await authorOrderModel.insertMany(authorOrderData);
      for (const cardId of cardProductsId) {
        await cardModel.findByIdAndDelete(cardId);
      }

      setTimeout(async () => {
        try {
          const orderFromDB = await customerOrderModel.findById(order.id);
          if (orderFromDB && orderFromDB.payment_status === "unpaid") {
            await this.paymentCheck(order.id);
          }
        } catch (err) {
          console.error("💥 Error in scheduled payment check:", err);
        }
      }, process.env.ORDER_PAYMENT_CHECK_IN * 60 * 60 * 24 * 1000);

      responseReturn(res, 200, {
        message: "Замовлення успішно оформлено",
        orderId: order.id,
      });
    } catch (error) {
      console.error("💥 Error in orderController: place_order:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  async get_customer_dashboard_data(req, res) {
    // console.log(req.params);
    const { userId } = req.params;
    // Клієнт міг раніше підставити чужий userId в URL і побачити чужі замовлення.
    if (req.id !== userId) {
      return responseReturn(res, 403, { error: "Доступ заборонено" });
    }
    try {
      const recentOrdersLimit =
        Number(process.env.USER_DASHBOARD_RECENT_ORDERS_LIMIT) || 5;
      const pipeline = [
        { $match: { customerId: new ObjectId(userId) } },
        {
          $facet: {
            recentOrders: [
              { $sort: { createdAt: -1 } },
              { $limit: recentOrdersLimit },
            ],
            totalOrders: [{ $count: "totalOrders" }],
            pendingOrders: [
              { $match: { delivery_status: "pending" } },
              { $count: "pendingOrders" },
            ],
            cancelledOrders: [
              { $match: { delivery_status: "cancelled" } },
              { $count: "cancelledOrders" },
            ],
          },
        },
      ];

      const [result] = await customerOrderModel.aggregate(pipeline);

      responseReturn(res, 200, {
        recentOrders: result.recentOrders,
        totalOrders: result.totalOrders[0]?.totalOrders || 0,
        pendingOrders: result.pendingOrders[0]?.pendingOrders || 0,
        cancelledOrders: result.cancelledOrders[0]?.cancelledOrders || 0,
      });
    } catch (error) {
      console.error(
        "💥 Error in orderController: get_customer_dashboard_data:",
        error
      );
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  async get_orders(req, res) {
    // console.log(req.params);
    const { customerId, status = "all" } = req.params;

    if (!ObjectId.isValid(customerId)) {
      return responseReturn(res, 404, { error: "Некоректний customerId" });
    }
    // Раніше будь-хто залогінений як клієнт міг підставити чужий customerId і
    // побачити чиїсь замовлення.
    if (req.id !== customerId) {
      return responseReturn(res, 403, { error: "Доступ заборонено" });
    }

    try {
      let orders = [];
      if (status !== "all") {
        orders = await customerOrderModel.find({
          customerId: new ObjectId(customerId),
          delivery_status: status,
        });
      } else {
        orders = await customerOrderModel.find({
          customerId: new ObjectId(customerId),
        });
      }

      responseReturn(res, 200, {
        orders,
      });
    } catch (error) {
      console.error("💥 Error in orderController: get_orders:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  async get_orders_details(req, res) {
    // console.log(req.params);

    const { orderId } = req.params;

    try {
      const order = await customerOrderModel.findById(orderId);
      if (!order) {
        return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      }
      // Раніше будь-хто залогінений як клієнт міг підставити чужий orderId і
      // прочитати чиїсь ПІБ/адресу/склад замовлення.
      if (order.customerId.toString() !== req.id) {
        return responseReturn(res, 403, { error: "Доступ заборонено" });
      }

      responseReturn(res, 200, {
        order,
      });
    } catch (error) {
      console.error("💥 Error in orderController: get_orders_details:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  async get_admin_orders(req, res) {
    // console.log(req.query);

    try {
      let { page = 1, searchValue = "", perPage = 10 } = req.query;

      page = parseInt(page);
      perPage = parseInt(perPage);

      const skip = perPage * (page - 1);

      if (searchValue) {
      } else {
        const orders = await customerOrderModel
          .aggregate([
            {
              $lookup: {
                from: "authorders",
                localField: "_id",
                foreignField: "orderId",
                as: "suborder",
              },
            },
          ])
          .skip(skip)
          .limit(perPage)
          .sort({ createdAt: -1 });

        const totalOrder = await customerOrderModel.aggregate([
          {
            $lookup: {
              from: "authorders",
              localField: "_id",
              foreignField: "orderId",
              as: "suborder",
            },
          },
        ]);

        // console.log(orders);
        // console.log(totalOrder);
        return responseReturn(res, 200, {
          myOrdersArr: orders,
          totalOrderCount: totalOrder.length,
        });
      }
    } catch (error) {
      console.error("❌ orderController → get_admin_orders:", error.message);
      return handleError(res, error, "orderController → get_admin_orders");
    }
  }

  async get_admin_order_details(req, res) {
    // console.log(req.params);
    const { orderId } = req.params;

    try {
      const order = await customerOrderModel.aggregate([
        { $match: { _id: new ObjectId(orderId) } },
        {
          $lookup: {
            from: "authorders",
            localField: "_id",
            foreignField: "orderId",
            as: "suborder",
          },
        },
      ]);
      return responseReturn(res, 200, { order: order[0] });
    } catch (error) {
      console.error(
        "❌ orderController → get_admin_order_details:",
        error.message
      );
      return handleError(
        res,
        error,
        "orderController → get_admin_order_details"
      );
    }
  }

  async admin_order_status_update(req, res) {
    const { orderId } = req.params;
    const { status } = req.body;

    // console.log(orderId);
    // console.log(status);

    try {
      await customerOrderModel.findByIdAndUpdate(orderId, {
        delivery_status: status,
      });

      return responseReturn(res, 200, {
        message: "Статус замовлення успішно змінено",
      });
    } catch (error) {
      console.error(
        "❌ orderController → admin_order_status_update:",
        error.message
      );
      return handleError(
        res,
        error,
        "orderController → admin_order_status_update"
      );
    }
  }

  async get_seller_orders(req, res) {
    const { sellerId } = req.params;

    // console.log(sellerId);
    // console.log(req.query);

    // Раніше один продавець міг підставити чужий sellerId в URL і побачити
    // замовлення іншого продавця.
    if (req.id !== sellerId) {
      return responseReturn(res, 403, { error: "Доступ заборонено" });
    }

    let { page = 1, searchValue = "", perPage = 10 } = req.query;
    page = parseInt(page);
    perPage = parseInt(perPage);

    const skip = perPage * (page - 1);

    try {
      if (searchValue) {
      } else {
        const orders = await authorOrderModel
          .find({
            sellerId,
          })
          .skip(skip)
          .limit(perPage)
          .sort({ createdAt: -1 });

        const totalOrder = await authorOrderModel
          .find({ sellerId })
          .countDocuments();

        return responseReturn(res, 200, {
          myOrdersArr: orders,
          totalOrderCount: totalOrder,
        });
      }
    } catch (error) {
      console.error("❌ orderController → get_seller_orders:", error.message);
      return handleError(res, error, "orderController → get_seller_orders");
    }
  }

  async get_seller_order_details(req, res) {
    const { orderId } = req.params;
    // console.log(orderId);

    try {
      const order = await authorOrderModel.findById(orderId);
      if (!order) {
        return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      }
      // Раніше продавець міг підставити чужий orderId і прочитати замовлення
      // іншого продавця.
      if (order.sellerId.toString() !== req.id) {
        return responseReturn(res, 403, { error: "Доступ заборонено" });
      }

      return responseReturn(res, 200, { order });
    } catch (error) {
      console.error(
        "❌ orderController → get_seller_order_details:",
        error.message
      );
      return handleError(
        res,
        error,
        "orderController → get_seller_order_details"
      );
    }
  }

  async seller_order_status_update(req, res) {
    const { orderId } = req.params;
    const { status } = req.body;

    // console.log(orderId);
    // console.log(status);

    try {
      const order = await authorOrderModel.findById(orderId);
      if (!order) {
        return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      }
      // Раніше продавець міг змінити статус чужого замовлення.
      if (order.sellerId.toString() !== req.id) {
        return responseReturn(res, 403, { error: "Доступ заборонено" });
      }

      await authorOrderModel.findByIdAndUpdate(orderId, {
        delivery_status: status,
      });

      return responseReturn(res, 200, {
        message: "Статус замовлення успішно змінено",
      });
    } catch (error) {
      console.error(
        "❌ orderController → seller_order_status_update:",
        error.message
      );
      return handleError(
        res,
        error,
        "orderController → seller_order_status_update"
      );
    }
  }

  async create_payment(req, res) {
    // console.log("Received body:", req.body);

    const { price } = req.body;
    try {
      const payment = await stripe.paymentIntents.create({
        amount: price * 100,
        currency: "eur",

        automatic_payment_methods: {
          enabled: true,
        },
      });

      // console.log("PaymentIntent created:", payment);

      responseReturn(res, 200, { clientSecret: payment.client_secret });
    } catch (error) {
      console.log("Stripe error:", error.message);
      responseReturn(res, 500, { error: error.message });
    }
  }

  async order_confirm(req, res) {
    const { orderId } = req.params;
    // console.log(orderId);

    try {
      const existingOrder = await customerOrderModel.findById(orderId);
      if (!existingOrder) {
        return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      }
      // Захист від подвійного нарахування, якщо адмін (чи повторний запит)
      // викличе підтвердження оплати для вже підтвердженого замовлення.
      if (existingOrder.payment_status === "paid") {
        return responseReturn(res, 400, {
          error: "Це замовлення вже підтверджено як оплачене",
        });
      }

      await customerOrderModel.findByIdAndUpdate(orderId, {
        payment_status: "paid",
      });
      await authorOrderModel.updateMany(
        {
          orderId: new ObjectId(orderId),
        },
        { payment_status: "paid", delivery_status: "pending" }
      );
      const custOrder = await customerOrderModel.findById(orderId);
      const authOrder = await authorOrderModel.find({
        orderId: new ObjectId(orderId),
      });
      const time = moment(Date.now()).format("l"); // m/d/year
      const splitTime = time.split("/");

      await myShopWallet.create({
        amount: custOrder.price,
        month: splitTime[0],
        year: splitTime[2],
      });

      for (let i = 0; i < authOrder.length; i++) {
        await sellerWallet.create({
          sellerId: authOrder[i].sellerId.toString(),
          amount: authOrder[i].price,
          month: splitTime[0],
          year: splitTime[2],
        });
      }

      responseReturn(res, 200, { message: "Успішно" });
    } catch (error) {
      console.error("❌ orderController → order_confirm:", error.message);
      return handleError(res, error, "orderController → order_confirm");
    }
  }
}

module.exports = new orderController();
