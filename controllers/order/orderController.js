const moment = require("moment");
const { responseReturn } = require("../../utiles/response");
const authorOrderModel = require("../../models/authorOrderModel");
const customerOrderModel = require("../../models/customerOrderModel");
const cardModel = require("../../models/cardModel");

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
    const {
      price,
      products,
      shipping_fee,
      items,
      shippingInfo,
      userId,
      navigate,
    } = req.body;
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

      setTimeout(() => {
        const hasItemsInCard = cardProductsId.length > 0; // Перевірка на наявність товарів
        if (hasItemsInCard) {
          this.paymentCheck(order.id); // Викликаємо метод paymentCheck тільки якщо є товари в картці
        } else {
          console.log("💥 Немає товарів в картці для перевірки оплати.");
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
}

module.exports = new orderController();
