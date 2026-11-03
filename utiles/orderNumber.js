// Короткі зрозумілі номери замовлень (100001, 100002…) замість 24-символьного _id.
// Старі замовлення без номера підписуємо останніми символами _id.

const START = 100000;

async function nextOrderNumber() {
  const storeSettingsModel = require("../models/storeSettingsModel");
  const st = await storeSettingsModel.findOneAndUpdate(
    { key: "main" },
    { $inc: { orderSeq: 1 } },
    { upsert: true, new: true }
  );
  return START + st.orderSeq;
}

const orderLabel = (order) =>
  `№${order?.orderNumber || String(order?._id || "").slice(-6).toUpperCase()}`;

module.exports = { START, nextOrderNumber, orderLabel };
