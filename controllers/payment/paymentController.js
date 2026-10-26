// require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const { responseReturn } = require("../../utiles/response");

const handleError = require("../../utiles/handleError");
const stripeModel = require("../../models/stripeModel");
const sellerModel = require("../../models/sellerModel");
const sellerWallet = require("../../models/sellerWallet");
const withdrawalRequest = require("../../models/withdrawalRequest");

const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;

// Stripe лишається лише для виплат продавцям (Connect). Клієнт створюємо ліниво,
// щоб бек запускався і без STRIPE_SECRET_KEY (оплати покупців тепер через /api/pay/*).
let _stripe = null;
const stripe = new Proxy(
  {},
  {
    get(_t, prop) {
      if (!_stripe) {
        if (!process.env.STRIPE_SECRET_KEY) {
          throw new Error("STRIPE_SECRET_KEY не задано — виплати продавцям через Stripe недоступні");
        }
        _stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      }
      return _stripe[prop];
    },
  }
);

class paymentController {
  constructor() {
    this.get_seller_payment_details =
      this.get_seller_payment_details.bind(this);
  }

  async create_stripe_connect_account(req, res) {
    // console.log("test");
    const { id } = req;
    // console.log(id);
    const uid = uuidv4();

    try {
      const stripeInfo = await stripeModel.findOne({ sellerId: id });

      if (stripeInfo) {
        await stripeModel.deleteOne({ sellerId: id });
        const account = await stripe.accounts.create({ type: "express" });

        const accountLink = await stripe.accountLinks.create({
          account: account.id,
          refresh_url: "http://localhost:5001/refresh",
          return_url: `http://localhost:5001/success?activeCode=${uid}`,
          type: "account_onboarding",
        });

        await stripeModel.create({
          sellerId: id,
          stripeId: account.id,
          code: uid,
        });
        return responseReturn(res, 201, { url: accountLink.url });
      } else {
        const account = await stripe.accounts.create({ type: "express" });

        const accountLink = await stripe.accountLinks.create({
          account: account.id,
          refresh_url: "http://localhost:5001/refresh",
          return_url: `http://localhost:5001/success?activeCode=${uid}`,
          type: "account_onboarding",
        });

        await stripeModel.create({
          sellerId: id,
          stripeId: account.id,
          code: uid,
        });
        return responseReturn(res, 201, { url: accountLink.url });
      }
    } catch (error) {
      return handleError(
        res,
        error,
        "paymentController → create_stripe_connect_account"
      );
    }
  }

  async active_stripe_connect_account(req, res) {
    // console.log(req.params);

    const { activeCode } = req.params;
    const { id } = req;

    try {
      const userStripeInfo = await stripeModel.findOne({ code: activeCode });

      if (userStripeInfo) {
        await sellerModel.findByIdAndUpdate(id, {
          payment: "active",
        });

        return responseReturn(res, 200, { message: "Платежі активовано" });
      } else {
        return responseReturn(res, 404, {
          message: "Платежі не вдалось активувати",
        });
      }
    } catch (error) {
      return handleError(
        res,
        error,
        "paymentController → active_stripe_connect_account"
      );
    }
  }

  sumAmount(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum = sum + data[i].amount;
    }
    return sum;
  }

  async get_seller_payment_details(req, res) {
    const { sellerId } = req.params;
    // Раніше будь-який залогінений продавець міг підставити чужий sellerId в
    // URL і побачити чийсь баланс/виплати. Дозволяємо самому продавцю (свій
    // sellerId) або адміну (будь-який).
    if (req.role !== "admin" && req.id !== sellerId) {
      return responseReturn(res, 403, { error: "Доступ заборонено" });
    }

    try {
      const payments = await sellerWallet.find({ sellerId });

      const pendingWithdrawals = await withdrawalRequest.find({
        $and: [{ sellerId: { $eq: sellerId } }, { status: { $eq: "pending" } }],
      });

      const successWithdrawals = await withdrawalRequest.find({
        $and: [{ sellerId: { $eq: sellerId } }, { status: { $eq: "success" } }],
      });

      const pendingAmount = this.sumAmount(pendingWithdrawals);
      const withdrawalAmount = this.sumAmount(successWithdrawals);
      const totalAmount = this.sumAmount(payments);

      let availableAmount = 0;
      if (totalAmount > 0) {
        availableAmount = totalAmount - (pendingAmount + withdrawalAmount);
      }

      return responseReturn(res, 200, {
        totalAmount,
        pendingAmount,
        withdrawalAmount,
        availableAmount,
        successWithdrawals,
        pendingWithdrawals,
      });
    } catch (error) {
      return handleError(
        res,
        error,
        "paymentController → get_seller_payment_details"
      );
    }
  }

  async withdrawal_request(req, res) {
    const { amount } = req.body;
    // sellerId завжди з токена, а не з тіла запиту — раніше продавець міг
    // підставити чужий sellerId і створити запит на виплату від чужого імені.
    const sellerId = req.id;

    const requestedAmount = parseInt(amount);
    if (!Number.isInteger(requestedAmount) || requestedAmount <= 0) {
      return responseReturn(res, 400, { error: "Некоректна сума" });
    }

    try {
      // Не даємо запитати виплату більшу за реально доступний баланс —
      // раніше цю суму ніхто не звіряв ні тут, ні при підтвердженні.
      const payments = await sellerWallet.find({ sellerId });
      const pendingWithdrawals = await withdrawalRequest.find({
        sellerId,
        status: "pending",
      });
      const successWithdrawals = await withdrawalRequest.find({
        sellerId,
        status: "success",
      });

      const totalAmount = this.sumAmount(payments);
      const pendingAmount = this.sumAmount(pendingWithdrawals);
      const withdrawalAmount = this.sumAmount(successWithdrawals);
      const availableAmount = Math.max(
        0,
        totalAmount - (pendingAmount + withdrawalAmount)
      );

      if (requestedAmount > availableAmount) {
        return responseReturn(res, 400, {
          error: `Недостатньо коштів на балансі (доступно ${availableAmount})`,
        });
      }

      const withdrawal = await withdrawalRequest.create({
        sellerId,
        amount: requestedAmount,
      });
      return responseReturn(res, 200, {
        withdrawal,
        message: "Запит відправлено",
      });
    } catch (error) {
      return handleError(res, error, "paymentController → withdrawal_request");
    }
  }

  async get_payment_requests(req, res) {
    try {
      const withdrawalRequestsArr = await withdrawalRequest.find({
        status: "pending",
      });
      return responseReturn(res, 200, { withdrawalRequestsArr });
    } catch (error) {
      return handleError(
        res,
        error,
        "paymentController → get_payment_requests"
      );
    }
  }

  async payment_request_confirm(req, res) {
    const { paymentId } = req.body;

    try {
      const payment = await withdrawalRequest.findById(paymentId);
      if (!payment) {
        return responseReturn(res, 404, { error: "Запит не знайдено" });
      }
      // Захист від подвійного підтвердження (і подвійного transfer у Stripe).
      if (payment.status !== "pending") {
        return responseReturn(res, 400, {
          error: "Цей запит вже оброблено",
        });
      }

      const stripeInfo = await stripeModel.findOne({
        sellerId: new ObjectId(payment.sellerId),
      });
      if (!stripeInfo) {
        return responseReturn(res, 400, {
          error: "У продавця не підключено Stripe-акаунт",
        });
      }
      const { stripeId } = stripeInfo;

      // ✅ КРОК 1: Створення тестового платежу через Charge (поповнює баланс платформи)
      // await stripe.charges.create({
      //   amount: payment.amount * 100 * 1000,
      //   currency: "eur",
      //   source: "tok_bypassPending", // 🔁 Тестовий токен, що імітує картку 4000000000000077
      // });

      await stripe.transfers.create({
        amount: payment.amount * 100,
        currency: "eur",

        destination: stripeId,
      });

      await withdrawalRequest.findByIdAndUpdate(paymentId, {
        status: "success",
      });

      return responseReturn(res, 200, {
        payment,
        message: "Запит успішно підтверджено",
      });
    } catch (error) {
      return handleError(
        res,
        error,
        "paymentController → payment_request_confirm"
      );
    }
  }
}

module.exports = new paymentController();
