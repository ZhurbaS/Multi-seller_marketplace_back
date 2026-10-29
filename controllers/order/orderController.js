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
const { markOrderPaid } = require("../../payments/paymentService");
const stockService = require("../../utiles/stockService");
const pricing = require("../../utiles/pricing");
const sellerModel = require("../../models/sellerModel");
const categoryModel = require("../../models/categoryModel");
const ledger = require("../../utiles/ledger");
const couponService = require("../../utiles/couponService");
const { sanitizeBuyer } = require("../../utiles/buyer");
const orderLifecycle = require("../../utiles/orderLifecycle");
const returnService = require("../../utiles/returnService");
const invoiceService = require("../../utiles/invoiceService");
const STATUSES = ["placed", "processing", "packing", "shipped", "delivered", "cancelled"];
const { loadSettings, loadOrderDiscountTiers } = require("../settingsController");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;

class orderController {
  constructor() {
    this.place_order = this.place_order.bind(this);
    this.admin_order_status_update = this.admin_order_status_update.bind(this);
    this.seller_order_status_update = this.seller_order_status_update.bind(this);
    this.settleCodIfDelivered = this.settleCodIfDelivered.bind(this);
  }

  // Оплата при отриманні: після статусу «delivered» вважаємо замовлення оплаченим
  // (ідемпотентно — повторний виклик нічого не нарахує вдруге).
  async settleCodIfDelivered(orderId) {
    try {
      const order = await customerOrderModel.findById(orderId);
      if (
        order &&
        order.payment_method === "cod" &&
        order.delivery_status === "delivered" &&
        order.payment_status !== "paid"
      ) {
        await markOrderPaid(order._id, { provider: "cod" });
      }
    } catch (error) {
      console.error("💥 settleCodIfDelivered:", error.message);
    }
  }

  async paymentCheck(id) {
    try {
      // Атомарно: якщо оплата встигла надійти, замовлення не скасовується (раніше платіж міг
      // потрапити в скасоване замовлення без повернення коштів).
      // Замовлення з оплатою при отриманні оплачується при доставці — не скасовуємо за таймером.
      const order = await customerOrderModel.findOneAndUpdate(
        {
          _id: id,
          payment_status: "unpaid",
          payment_method: { $ne: "cod" },
          delivery_status: { $ne: "cancelled" },
          // «за рахунком» скасовуємо лише коли строк дії рахунку справді минув
          $or: [{ payment_method: { $ne: "invoice" } }, { "invoice.dueAt": { $lt: new Date() } }],
        },
        { delivery_status: "cancelled" },
        { new: false }
      );
      if (order) {
        if (order.payment_method === "invoice" && order.invoice?.number) {
          await customerOrderModel.updateOne({ _id: id }, { $set: { "invoice.status": "expired" } });
        }
        await authorOrderModel.updateMany({ orderId: id }, { delivery_status: "cancelled" });
        await stockService.releaseForOrder(id);
        await couponService.releaseForOrder(id); // купон знову доступний
      }
      return true;
    } catch (error) {
      console.error("💥 Error in orderController: paymentCheck:", error);
    }
  }

  async place_order(req, res) {
    // console.log(req.body);
    // Вартість доставки в замовлення НЕ входить (її оплачує покупець перевізнику
    // при отриманні), тому shipping_fee з клієнта ігноруємо.
    const { products, shippingInfo, couponCode, buyer: buyerInput } = req.body;
    // customerId завжди з токена (customerAuthMiddleware), а НЕ з тіла запиту —
    // раніше клієнт міг підставити чужий userId.
    const userId = req.id;

    if (!Array.isArray(products) || products.length === 0) {
      return responseReturn(res, 400, { error: "Кошик порожній" });
    }

    // Фізособа чи юрособа (для юрособи — назва, ЄДРПОУ, ІПН)
    const buyerCheck = sanitizeBuyer(buyerInput);
    if (buyerCheck.error) {
      return responseReturn(res, 400, { error: buyerCheck.error });
    }
    const buyer = buyerCheck.value;

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

      // Комісія: індивідуальна ставка продавця → ставка категорії → типова.
      const settings = await loadSettings();
      // У товару категорія зберігається назвою, у налаштуваннях — за id: зіставляємо за назвою.
      const rateById = new Map(
        settings.categoryCommissions.map((c) => [String(c.categoryId), c.percent])
      );
      const categoryDocs = rateById.size
        ? await categoryModel.find({ _id: { $in: [...rateById.keys()] } }).select("name")
        : [];
      const categoryRates = new Map(
        categoryDocs.map((c) => [c.name, rateById.get(String(c._id))])
      );
      const sellerDocs = await sellerModel
        .find({ _id: { $in: dbProducts.map((p) => p.sellerId) } })
        .select("commissionPercent");
      const sellerRates = new Map(
        sellerDocs.map((s) => [String(s._id), s.commissionPercent])
      );

      // Групуємо за РЕАЛЬНИМ продавцем товару з БД (а не за групами з клієнта).
      const groups = new Map(); // sellerId -> { products: [], price, commission }
      let customerOrderProducts = [];
      let cardProductsId = [];
      let totalPrice = 0;

      for (const sellerGroup of products) {
        for (const item of sellerGroup?.products || []) {
          const dbProduct = dbProductMap.get(item?.productInfo?._id);
          if (!dbProduct) {
            return responseReturn(res, 400, {
              error: "Один з товарів не знайдено — оновіть кошик",
            });
          }

          const quantity = Number(item.quantity);
          // Мінімум, кратність і наявність (або передзамовлення) — перевіряємо на сервері.
          const avail = pricing.availability(dbProduct, quantity);
          if (!avail.ok) {
            return responseReturn(res, 400, {
              error: `${dbProduct.name}: ${avail.error}`,
            });
          }

          // Ціна за шт. з урахуванням знижки товару й знижки за кількість.
          const unitPrice = pricing.unitPrice(dbProduct, quantity);
          const lineTotal = unitPrice * quantity;

          const sid = String(dbProduct.sellerId);
          const commissionPercent = pricing.resolveCommissionPercent({
            sellerPercent: sellerRates.get(sid),
            categoryPercent: categoryRates.get(dbProduct.category),
            defaultPercent: settings.defaultCommissionPercent,
          });
          const commission = pricing.commissionAmount(lineTotal, commissionPercent);

          const orderedProduct = {
            _id: dbProduct._id,
            name: dbProduct.name,
            price: dbProduct.price,
            discount: dbProduct.discount,
            unitPrice, // фактична ціна за 1 шт. у цьому замовленні
            quantityDiscount: pricing.tierPercent(dbProduct.priceTiers, quantity),
            preorder: avail.preorder,
            commissionPercent, // знімок ставки на момент замовлення
            commission,
            images: dbProduct.images,
            brand: dbProduct.brand,
            category: dbProduct.category, // знімок для правил повернення (категорії-виключення)
            sellerId: dbProduct.sellerId,
            quantity,
          };

          if (!groups.has(sid)) {
            groups.set(sid, { sellerId: dbProduct.sellerId, products: [], price: 0, commission: 0 });
          }
          const g = groups.get(sid);
          g.products.push(orderedProduct);
          g.price += lineTotal;
          g.commission = pricing.round2(g.commission + commission);

          customerOrderProducts.push(orderedProduct);
          totalPrice += lineTotal;

          if (item._id) cardProductsId.push(item._id);
        }
      }

      let authorOrderData = [...groups.values()].map((g) => ({
        sellerId: g.sellerId,
        products: g.products,
        price: g.price,
        commission: g.commission,
        payout: pricing.round2(g.price - g.commission),
      }));

      // Знижка за сумою замовлення (налаштовує адмін для всього магазину).
      const autoDisc = pricing.orderDiscount(settings.orderDiscountTiers, totalPrice);

      // Купон: діє більша з двох знижок (купон або за сумою), разом вони не складаються.
      let orderDisc = autoDisc;
      let couponUse = null; // { coupon, discount }
      let couponNotice = null;
      if (couponCode) {
        const ev = await couponService.evaluate({
          code: couponCode,
          customerId: userId,
          subtotal: totalPrice,
          autoDiscount: autoDisc.amount,
        });
        if (!ev.ok) return responseReturn(res, 400, { error: ev.message });
        if (ev.beatsAuto) {
          couponUse = { coupon: ev.coupon, discount: ev.discount };
          orderDisc = { percent: 0, amount: 0 };
        } else {
          couponNotice = "Купон не застосовано: знижка за сумою замовлення вигідніша";
        }
      }
      const couponAmount = couponUse ? couponUse.discount : 0;
      const finalPrice = totalPrice - orderDisc.amount - couponAmount;
      const hasPreorder = customerOrderProducts.some((p) => p.preorder);

      // Резервуємо склад атомарно (віднімаємо кількість). Якщо останню одиницю
      // встиг купити хтось інший — отримуємо помилку, замовлення не створюється.
      const reserve = await stockService.reserveItems(customerOrderProducts);
      if (!reserve.ok) {
        return responseReturn(res, 400, {
          error: `Недостатньо товару "${reserve.name}" на складі`,
        });
      }

      // Займаємо використання купона (атомарно перевіряє ліміти). При відмові склад повертаємо.
      let couponReserved = false;
      if (couponUse) {
        const cr = await couponService.reserve(couponUse.coupon, userId);
        if (!cr.ok) {
          await stockService.restoreItems(customerOrderProducts);
          return responseReturn(res, 400, { error: cr.message });
        }
        couponReserved = true;
      }

      let order;
      try {
        order = await customerOrderModel.create({
          customerId: userId,
          shippingInfo,
          products: customerOrderProducts,
          price: finalPrice,
          goods_total: totalPrice,
          order_discount: orderDisc,
          ...(couponUse
            ? {
                coupon: {
                  couponId: couponUse.coupon._id,
                  code: couponUse.coupon.code,
                  discountType: couponUse.coupon.type,
                  value: couponUse.coupon.value,
                  amount: couponAmount,
                },
              }
            : {}),
          buyer,
          has_preorder: hasPreorder,
          payment_status: "unpaid",
          delivery_status: "pending",
          date: tempDate,
        });

        if (couponUse) {
          await couponService.recordRedemption({
            coupon: couponUse.coupon,
            customerId: userId,
            orderId: order._id,
            amount: couponAmount,
            orderTotal: totalPrice,
          });
        }

        authorOrderData = authorOrderData.map((sellerOrder) => ({
          ...sellerOrder,
          orderId: order.id,
          payment_status: "unpaid",
          shippingInfo: "Easy Main Warehouse",
          delivery_status: "pending",
          date: tempDate,
          stock_reserved: true,
        }));

        await authorOrderModel.insertMany(authorOrderData);
      } catch (err) {
        // Замовлення не збереглось повністю — повертаємо склад і купон, прибираємо залишки.
        await stockService.restoreItems(customerOrderProducts);
        if (couponReserved) {
          // якщо запису про використання ще немає — повертаємо лічильники напряму
          const released = order ? await couponService.releaseForOrder(order._id) : false;
          if (!released) await couponService.giveBack(couponUse.coupon._id, userId);
        }
        if (order) {
          await customerOrderModel.deleteOne({ _id: order._id });
          await authorOrderModel.deleteMany({ orderId: order._id });
        }
        throw err;
      }

      for (const cardId of cardProductsId) {
        // лише власні позиції кошика
        await cardModel.deleteOne({ _id: cardId, userId });
      }

      // Автоскасування неоплачених замовлень робить фонова перевірка
      // (utiles/orderExpiry.js) — вона переживає перезапуск сервера, на відміну від setTimeout.

      responseReturn(res, 200, {
        message: "Замовлення успішно оформлено",
        orderId: order.id,
        price: finalPrice, // остаточна сума (з урахуванням знижок, без доставки)
        ...(couponNotice ? { couponNotice } : {}),
      });
    } catch (error) {
      console.error("💥 Error in orderController: place_order:", error);
      return responseReturn(res, 500, {
        error: "Щось пішло не так",
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
        error: "Щось пішло не так",
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
        error: "Щось пішло не так",
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
        error: "Щось пішло не так",
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
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: perPage },
            {
              $lookup: {
                from: "authorders",
                localField: "_id",
                foreignField: "orderId",
                as: "suborder",
              },
            },
          ]);

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
      const current = await customerOrderModel.findById(orderId);
      if (!current) {
        return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      }

      if (!STATUSES.includes(status)) {
        return responseReturn(res, 400, { error: "Некоректний статус замовлення" });
      }
      if (status === current.delivery_status) {
        return responseReturn(res, 200, { message: "Статус замовлення не змінився" });
      }

      // --- Скасування: товар повертається на склад, нарахування знімаються, купон звільняється.
      // Оплачене замовлення → створюється заявка на повернення коштів (Дашборд → Повернення).
      if (status === "cancelled") {
        if (current.delivery_status === "delivered") {
          return responseReturn(res, 409, {
            error: "Доставлене замовлення не можна скасувати — оформіть повернення (Дашборд → Повернення)",
          });
        }
        if (current.refund_status === "full" || current.refund_inflight > 0) {
          return responseReturn(res, 409, { error: "За цим замовленням уже є повернення коштів" });
        }
        const blocker = await orderLifecycle.cancelBlocker(orderId);
        if (blocker) return responseReturn(res, 409, { error: blocker });
        const prev = await orderLifecycle.cancelWholeOrder(orderId);
        if (prev && prev.payment_status === "paid") {
          await returnService.createCancellationRefund({ order: prev, by: "admin" });
        }
        return responseReturn(res, 200, {
          message:
            prev && prev.payment_status === "paid"
              ? "Замовлення скасовано. Потрібно повернути кошти покупцю — Дашборд → Повернення"
              : "Замовлення скасовано",
        });
      }

      // --- «Відновлення» скасованого: знову резервуємо склад і купон.
      if (current.delivery_status === "cancelled") {
        // Оплачене скасоване замовлення відновлювати не можна: нарахування вже знято, а покупцю
        // повернено (або буде повернено) кошти. Для такого покупця оформіть нове замовлення.
        if (current.payment_status === "paid") {
          return responseReturn(res, 409, {
            error: "Оплачене скасоване замовлення відновити не можна — оформіть нове замовлення",
          });
        }
        const r = await stockService.reserveForOrder(orderId);
        if (!r.ok) {
          return responseReturn(res, 409, {
            error: `Не можна відновити замовлення: недостатньо товару "${r.name}" на складі`,
          });
        }
        await couponService.reacquireForOrder(orderId);
        await invoiceService.reviveIfInvoice(orderId);
        await authorOrderModel.updateMany({ orderId: new ObjectId(orderId) }, { delivery_status: status });
      }

      const patch = { delivery_status: status };
      if (status === "delivered" && !current.deliveredAt) patch.deliveredAt = new Date();
      await customerOrderModel.findByIdAndUpdate(orderId, patch);
      if (status === "delivered") {
        await authorOrderModel.updateMany(
          { orderId: new ObjectId(orderId), delivery_status: { $ne: "cancelled" } },
          { delivery_status: "delivered", deliveredAt: patch.deliveredAt || current.deliveredAt || new Date() }
        );
      }
      await this.settleCodIfDelivered(orderId);
      if (status === "delivered") {
        // Доставлено → починається відлік утримання (термін повернення)
        await ledger.releaseForOrder(new ObjectId(orderId));
      }

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

      if (!STATUSES.includes(status)) {
        return responseReturn(res, 400, { error: "Некоректний статус замовлення" });
      }
      if (status === order.delivery_status) {
        return responseReturn(res, 200, { message: "Статус замовлення не змінився" });
      }
      const parent = await customerOrderModel.findById(order.orderId);
      const hasRefund = parent && (parent.refund_status !== "none" || parent.refund_inflight > 0);

      if (status === "cancelled" && order.delivery_status === "delivered") {
        return responseReturn(res, 409, {
          error: "Доставлене замовлення не можна скасувати — покупець може оформити повернення",
        });
      }
      if (order.delivery_status === "cancelled" && parent && (hasRefund || parent.payment_status === "paid")) {
        return responseReturn(res, 409, {
          error: "Оплачене скасоване замовлення відновити не можна — покупцю вже повертаються кошти",
        });
      }

      // Склад: скасування підзамовлення повертає його товари; відновлення — знову резервує.
      if (status !== "cancelled" && order.delivery_status === "cancelled") {
        const r = await stockService.reserveForAuthorOrder(orderId);
        if (!r.ok) {
          return responseReturn(res, 409, {
            error: `Не можна відновити замовлення: недостатньо товару "${r.name}" на складі`,
          });
        }
        if (parent && parent.delivery_status === "cancelled") {
          await customerOrderModel.updateOne({ _id: parent._id }, { delivery_status: "processing" });
          await couponService.reacquireForOrder(parent._id);
          await invoiceService.reviveIfInvoice(parent._id);
        }
      }
      const patch = { delivery_status: status };
      if (status === "delivered") patch.deliveredAt = new Date();
      await authorOrderModel.findByIdAndUpdate(orderId, patch);
      if (status === "cancelled") {
        await stockService.releaseForAuthorOrder(orderId);
        await ledger.reverseForAuthorOrder(order._id);
        // Оплачене замовлення: кошти за скасовану частину потрібно повернути покупцю.
        if (parent && parent.payment_status === "paid") {
          await returnService.createCancellationRefund({
            order: parent,
            authOrderIds: [order._id],
            by: "seller",
            reason: "cancel_by_store",
          });
        }
        // Усі підзамовлення скасовано → скасовано і замовлення покупця, купон звільняється.
        const siblings = await authorOrderModel.find({ orderId: order.orderId });
        if (siblings.every((s) => s.delivery_status === "cancelled")) {
          await customerOrderModel.updateOne(
            { _id: order.orderId, delivery_status: { $ne: "cancelled" } },
            { delivery_status: "cancelled" }
          );
          await couponService.releaseForOrder(order.orderId);
        }
      }
      // COD: коли всі підзамовлення доставлено — гроші отримано, нараховуємо гаманці.
      if (status === "delivered") {
        const siblings = await authorOrderModel.find({ orderId: order.orderId });
        const live = siblings.filter((s) => s.delivery_status !== "cancelled");
        if (live.length && live.every((s) => s.delivery_status === "delivered")) {
          await customerOrderModel.findByIdAndUpdate(order.orderId, {
            delivery_status: "delivered",
            ...(parent && !parent.deliveredAt ? { deliveredAt: patch.deliveredAt } : {}),
          });
          await this.settleCodIfDelivered(order.orderId);
        }
        await ledger.releaseForAuthorOrder(order._id);
      }

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

  // PDF рахунку: покупець (лише своє замовлення) або адмін
  async invoice_pdf(req, res) {
    try {
      if (!/^[a-f\d]{24}$/i.test(String(req.params.orderId))) {
        return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      }
      const order = await customerOrderModel.findById(req.params.orderId);
      if (!order) return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      const isAdmin = req.role === "admin";
      if (!isAdmin && String(order.customerId) !== String(req.id)) {
        return responseReturn(res, 403, { error: "Доступ заборонено" });
      }
      const pdf = await invoiceService.pdfFor(order);
      // номер містить кирилицю — res.attachment безпечно кодує ім'я файлу (RFC 5987)
      res.attachment(`rahunok-${order.invoice.number}.pdf`);
      res.type("application/pdf");
      res.status(200).send(pdf);
    } catch (error) {
      if (error instanceof invoiceService.InvoiceError) {
        return responseReturn(res, error.status, { error: error.message });
      }
      console.error("💥 orderController.invoice_pdf:", error);
      responseReturn(res, 500, { error: "Не вдалося сформувати рахунок" });
    }
  }

  // Адмін: надіслати рахунок повторно (за потреби — продовжити строк дії)
  async invoice_resend(req, res) {
    try {
      const r = await invoiceService.resend(req.params.orderId, { extend: req.body?.extend === true });
      responseReturn(res, 200, {
        invoice: r.order.invoice,
        sent: r.sent,
        message: r.sent ? `Рахунок надіслано на ${r.to}` : `Лист не надіслано: ${r.error}`,
      });
    } catch (error) {
      if (error instanceof invoiceService.InvoiceError) {
        return responseReturn(res, error.status, { error: error.message });
      }
      console.error("💥 orderController.invoice_resend:", error);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Ручне підтвердження оплати адміном (наприклад, переказ на рахунок).
  // Використовує ту саму ідемпотентну логіку, що й вебхуки платіжних систем.
  async order_confirm(req, res) {
    const { orderId } = req.params;

    try {
      const existingOrder = await customerOrderModel.findById(orderId);
      if (!existingOrder) {
        return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      }
      const result = await markOrderPaid(orderId, {
        provider: existingOrder.payment_method === "invoice" ? "invoice" : "manual",
      });
      if (!result.changed) {
        return responseReturn(res, 400, {
          error: "Це замовлення вже підтверджено як оплачене",
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
