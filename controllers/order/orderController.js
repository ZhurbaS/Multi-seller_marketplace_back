const moment = require("moment");
const { responseReturn } = require("../../utiles/response");
const authorOrderModel = require("../../models/authorOrderModel");
const customerOrderModel = require("../../models/customerOrderModel");
const cardModel = require("../../models/cardModel");
const handleError = require("../../utiles/handleError");
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
    const { price, products, shipping_fee, shippingInfo, userId } = req.body;
    let authorOrderData = [];
    let cardProductsId = [];
    const tempDate = moment(Date.now()).format("LLL");
    // console.log(tempDate);

    let customerOrderProducts = [];

    for (let i = 0; i < products.length; i++) {
      const productsPerSeller = products[i].products;
      for (let j = 0; j < productsPerSeller.length; j++) {
        const tempCustomerProduct = productsPerSeller[j].productInfo;
        // console.log(tempCustomerProduct);
        tempCustomerProduct.quantity = productsPerSeller[j].quantity;
        customerOrderProducts.push(tempCustomerProduct);
        if (productsPerSeller[j]._id) {
          cardProductsId.push(productsPerSeller[j]._id);
        }
      }
    }
    // console.log(customerOrderProducts);
    // console.log(cardProductsId);

    try {
      const order = await customerOrderModel.create({
        customerId: userId,
        shippingInfo,
        products: customerOrderProducts,
        price: price + shipping_fee,
        payment_status: "unpaid",
        delivery_status: "pending",
        date: tempDate,
      });

      for (let i = 0; i < products.length; i++) {
        const productsPerSeller = products[i].products;
        const pricePerSeller = products[i].price;
        const sellerId = products[i].sellerId;
        let storeProducts = [];
        for (let j = 0; j < productsPerSeller.length; j++) {
          const tempProduct = productsPerSeller[j].productInfo;
          tempProduct.quantity = productsPerSeller[j].quantity;
          storeProducts.push(tempProduct);
        }
        authorOrderData.push({
          orderId: order.id,
          sellerId,
          products: storeProducts,
          price: pricePerSeller,
          payment_status: "unpaid",
          shippingInfo: "Easy Main Warehouse",
          delivery_status: "pending",
          date: tempDate,
        });
      }

      await authorOrderModel.insertMany(authorOrderData);
      for (let k = 0; k < cardProductsId.length; k++) {
        await cardModel.findByIdAndDelete(cardProductsId[k]);
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
        message: "Order placed successfully",
        orderId: order.id,
      });
    } catch (error) {
      console.error("💥 Error in orderController: place_order:", error);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  }

  async get_customer_dashboard_data(req, res) {
    // console.log(req.params);
    const { userId } = req.params;
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
        error: error.message || "Something went wrong",
      });
    }
  }

  async get_orders(req, res) {
    // console.log(req.params);
    const { customerId, status = "all" } = req.params;

    if (!ObjectId.isValid(customerId)) {
      return responseReturn(res, 404, { error: "Invalid customerId" });
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
        error: error.message || "Something went wrong",
      });
    }
  }

  async get_orders_details(req, res) {
    // console.log(req.params);

    const { orderId } = req.params;

    try {
      const order = await customerOrderModel.findById(orderId);

      responseReturn(res, 200, {
        order,
      });
    } catch (error) {
      console.error("💥 Error in orderController: get_orders_details:", error);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
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
}

module.exports = new orderController();
