// Надсилає листи підписникам, коли товар знову з'явився в наявності.
// Підписка закривається (notifiedAt) лише після успішного листа — якщо пошта ще не
// налаштована, підписки зберігаються й спрацюють при наступному поповненні складу.

const productModel = require("../models/productModel");
const customerModel = require("../models/customerModel");
const stockSubscriptionModel = require("../models/stockSubscriptionModel");
const { sendMail, isConfigured } = require("./mailer");

async function notifyBackInStock(productId) {
  if (!isConfigured()) return 0;
  const product = await productModel.findById(productId).select("name slug stock");
  if (!product || product.stock <= 0) return 0;

  const front = (process.env.PUBLIC_FRONT_URL || "").replace(/\/+$/, "");
  const subs = await stockSubscriptionModel.find({ productId, notifiedAt: null });
  let sent = 0;
  for (const sub of subs) {
    const customer = await customerModel.findById(sub.userId).select("email name");
    if (!customer?.email) continue;
    const ok = await sendMail({
      to: customer.email,
      subject: `Товар «${product.name}» знову в наявності`,
      text:
        `Вітаємо, ${customer.name || ""}!\n\n` +
        `Товар «${product.name}», на який ви підписувалися, знову в наявності.\n` +
        `Переглянути: ${front}/product/details/${product.slug}\n\n` +
        `Кількість обмежена — не зволікайте.`,
    });
    if (ok) {
      await stockSubscriptionModel.updateOne({ _id: sub._id }, { notifiedAt: new Date() });
      sent++;
    }
  }
  return sent;
}

module.exports = { notifyBackInStock };
