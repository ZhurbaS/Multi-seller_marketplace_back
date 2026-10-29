// Розрахунок сум повернення. Чисті функції — легко тестуються.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Скільки отримає покупець за товари на суму itemsValue з урахуванням частки знижки
// (знижка за сумою / купон розподіляється пропорційно вартості товарів).
//
//   order: { goodsTotal, price }       — сума товарів до знижок і сума, яку заплатив покупець
//   committed: { refunded, goods }     — Σ goodsAmount попередніх повернень (ДО утримань!) і
//                                        вартість уже повернутих товарів. Утримання не повертаються
//                                        покупцю, але й не збільшують «залишок до повернення».
//
// Якщо цим поверненням повертаються ВСІ товари замовлення, покупець отримує залишок
// до повної оплаченої суми (щоб копійки округлення не «губились»).
function refundForItems({ goodsTotal, price }, committed, itemsValue) {
  const total = goodsTotal || price;
  const value = round2(itemsValue);
  const refundedSoFar = round2(committed?.refunded || 0);
  const goodsSoFar = round2(committed?.goods || 0);
  const remaining = Math.max(0, round2(price - refundedSoFar));

  const discount = Math.max(0, round2(total - price));
  let refund = round2(value - (total > 0 ? (discount * value) / total : 0));
  if (round2(goodsSoFar + value) >= round2(total)) refund = remaining;
  refund = Math.max(0, Math.min(refund, remaining));
  return {
    goodsAmount: refund,
    discountShare: Math.max(0, round2(value - refund)),
    remaining,
  };
}

// Частка комісії для повернутої кількості позиції (комісія в позиції — на всю замовлену кількість).
function commissionShare(lineCommission, orderedQty, returnQty) {
  if (!orderedQty || !lineCommission) return 0;
  return round2((lineCommission * returnQty) / orderedQty);
}

// Підсумок для покупця: товари − утримання − (доставка, якщо її сплачує покупець)
function finalRefund({ goodsAmount, deduction = 0, shippingCost = 0, shippingPayer = "seller" }) {
  const shippingFromCustomer = shippingPayer === "customer" ? shippingCost : 0;
  return Math.max(0, round2(goodsAmount - deduction - shippingFromCustomer));
}

module.exports = { round2, refundForItems, commissionShare, finalRefund };
