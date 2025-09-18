const { v4: uuidv4 } = require("uuid");
const { responseReturn } = require("../../utiles/response");

const handleError = require("../../utiles/handleError");
const stripeModel = require("../../models/stripeModel");
const sellerModel = require("../../models/sellerModel");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

class paymentController {
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
}

module.exports = new paymentController();
