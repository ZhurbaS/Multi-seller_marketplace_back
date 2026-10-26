const { responseReturn } = require("../../utiles/response");
const customerOrderModel = require("../../models/customerOrderModel");
const payments = require("../../payments/paymentService");

// Завантажує замовлення й гарантує, що воно належить поточному покупцю.
async function loadOwnOrder(req, res, orderId) {
  if (!orderId || !/^[a-f\d]{24}$/i.test(String(orderId))) {
    responseReturn(res, 404, { error: "Замовлення не знайдено" });
    return null;
  }
  const order = await customerOrderModel.findById(orderId);
  if (!order) {
    responseReturn(res, 404, { error: "Замовлення не знайдено" });
    return null;
  }
  if (order.customerId.toString() !== req.id) {
    responseReturn(res, 403, { error: "Доступ заборонено" });
    return null;
  }
  return order;
}

const publicState = (order) => ({
  orderId: order._id,
  payment_status: order.payment_status,
  payment_method: order.payment_method,
  state: order.payment?.status || null, // pending | paid | failed | null
  price: order.price,
});

class payController {
  // Доступні способи оплати (показуємо лише те, що налаштовано в .env)
  methods(req, res) {
    responseReturn(res, 200, { methods: payments.availableMethods() });
  }

  // Старт оплати: сума береться з БД, а не з запиту.
  async start(req, res) {
    try {
      const { orderId, method } = req.body || {};
      const order = await loadOwnOrder(req, res, orderId);
      if (!order) return;
      const result = await payments.startPayment(order, String(method));
      responseReturn(res, 200, result);
    } catch (error) {
      if (error instanceof payments.PaymentError) {
        return responseReturn(res, error.status, { error: error.message });
      }
      console.error("💥 payController.start:", error.message);
      responseReturn(res, 502, {
        error: "Не вдалося створити платіж. Спробуйте інший спосіб оплати або пізніше",
      });
    }
  }

  // Покупець повернувся з платіжної сторінки — перевіряємо статус на боці сервера.
  async verify(req, res) {
    try {
      const order = await loadOwnOrder(req, res, req.params.orderId);
      if (!order) return;
      const fresh = await payments.verifyOrderPayment(order);
      responseReturn(res, 200, publicState(fresh));
    } catch (error) {
      console.error("💥 payController.verify:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Тестова оплата (лише поза production)
  async mockComplete(req, res) {
    try {
      const { orderId, success } = req.body || {};
      const order = await loadOwnOrder(req, res, orderId);
      if (!order) return;
      await payments.completeMockPayment(order, success === true);
      const fresh = await customerOrderModel.findById(order._id);
      responseReturn(res, 200, publicState(fresh));
    } catch (error) {
      if (error instanceof payments.PaymentError) {
        return responseReturn(res, error.status, { error: error.message });
      }
      console.error("💥 payController.mockComplete:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Вебхук monobank: тіло — сирий JSON (req.rawBody), підпис — заголовок x-sign.
  async monobankWebhook(req, res) {
    try {
      await payments.handleMonobankWebhook(req.rawBody, req.get("x-sign"));
      res.sendStatus(200);
    } catch (error) {
      if (error instanceof payments.PaymentError) {
        console.error("monobank webhook відхилено:", error.message);
        return res.sendStatus(error.status === 401 ? 401 : 409);
      }
      console.error("💥 monobank webhook:", error.message);
      res.sendStatus(500); // monobank повторить спробу
    }
  }

  // Callback LiqPay: form-urlencoded { data, signature }.
  async liqpayWebhook(req, res) {
    try {
      const { data, signature } = req.body || {};
      await payments.handleLiqpayCallback(data, signature);
      res.sendStatus(200);
    } catch (error) {
      if (error instanceof payments.PaymentError) {
        console.error("LiqPay callback відхилено:", error.message);
        return res.sendStatus(error.status === 401 ? 401 : 409);
      }
      console.error("💥 LiqPay callback:", error.message);
      res.sendStatus(500);
    }
  }
}

module.exports = new payController();
