// require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const { responseReturn } = require("../../utiles/response");

const handleError = require("../../utiles/handleError");
const stripeModel = require("../../models/stripeModel");
const sellerModel = require("../../models/sellerModel");
const sellerWallet = require("../../models/sellerWallet");
const withdrawalRequest = require("../../models/withdrawalRequest");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

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
    // console.log(sellerId);

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
    console.log(req.body);

    const { amount, sellerId } = req.body;

    try {
      const withdrawal = await withdrawalRequest.create({
        sellerId,
        amount: parseInt(amount),
      });
      return responseReturn(res, 200, {
        withdrawal,
        message: "Запит відправлено",
      });
    } catch (error) {
      return handleError(res, error, "paymentController → withdrawal_request");
    }
  }
}

module.exports = new paymentController();
