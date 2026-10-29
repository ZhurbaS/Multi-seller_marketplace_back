// Спільна логіка скасування замовлення (адмін, схвалена заявка покупця).
// Скасування повертає товар на склад, знімає нарахування продавцям і відпускає купон.
// Повернення грошей покупцю — окремо (utiles/returnService.js).

const customerOrderModel = require("../models/customerOrderModel");
const authorOrderModel = require("../models/authorOrderModel");
const stockService = require("./stockService");
const ledger = require("./ledger");
const couponService = require("./couponService");
const ReturnRequest = require("../models/returnRequestModel");

// Чому замовлення НЕ можна скасувати повністю ("" — можна):
//  - продавець уже відправив/доставив підзамовлення (товар у покупця або в дорозі);
//  - є відкрита заявка на повернення товару (інакше повернення й скасування задвоїлись би).
async function cancelBlocker(orderId) {
  const subs = await authorOrderModel.find({ orderId });
  if (subs.some((a) => ["shipped", "delivered"].includes(a.delivery_status))) {
    return "Частину замовлення вже відправлено — скасувати все замовлення не можна. Скористайтеся поверненням";
  }
  const open = await ReturnRequest.exists({
    orderId,
    kind: "return",
    status: { $in: ["requested", "approved", "shipped", "received", "refund_pending"] },
  });
  if (open) return "За замовленням є відкрита заявка на повернення — спершу завершіть або відхиліть її";
  return "";
}

// Скасовує замовлення, якщо воно ще не доставлене й не скасоване. Атомарно:
// повертає стан замовлення ДО скасування або null (вже скасоване / доставлене).
async function cancelWholeOrder(orderId) {
  const prev = await customerOrderModel.findOneAndUpdate(
    { _id: orderId, delivery_status: { $nin: ["cancelled", "delivered"] } },
    { $set: { delivery_status: "cancelled" } },
    { new: false }
  );
  if (!prev) return null;
  await authorOrderModel.updateMany({ orderId }, { delivery_status: "cancelled" });
  await stockService.releaseForOrder(orderId);
  await ledger.reverseForOrder(orderId);
  await couponService.releaseForOrder(orderId);
  await require("./invoiceService").cancelIfInvoice(orderId); // рахунок більше не діє
  return prev;
}

module.exports = { cancelWholeOrder, cancelBlocker };
