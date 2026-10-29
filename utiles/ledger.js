// Журнал нарахувань: хто скільки заробив із замовлення.
//
//  - sellerWallets: частка продавця (сума його товарів мінус комісія). Гроші «заморожені»
//    (availableAt = null), поки замовлення не доставлене; після доставки — ще holdDays днів
//    (термін повернення), і лише потім доступні для виплати.
//  - myShopWallets: чистий дохід магазину = комісії мінус знижка за сумою замовлення.
//  - Повернення/скасування оплаченого замовлення не видаляє записи, а додає від'ємні (reversal).
//
// Старі записи (до комісії) не мають нових полів і трактуються як «доступні одразу».

const moment = require("moment");
const sellerWallet = require("../models/sellerWallet");
const myShopWallet = require("../models/myShopWallet");
const authorOrderModel = require("../models/authorOrderModel");
const customerOrderModel = require("../models/customerOrderModel");
const pricing = require("./pricing");

const addDays = (date, days) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

// Скільки днів утримувати гроші після доставки (налаштування адміна, 14 за замовчуванням).
async function getHoldDays() {
  // require тут, щоб не створювати цикл залежностей при завантаженні модулів
  const { loadSettings } = require("../controllers/settingsController");
  return (await loadSettings()).payoutHoldDays;
}

// Записує нарахування для щойно оплаченого замовлення.
async function recordPaidOrder(order, authOrders) {
  const [month, , year] = moment().format("l").split("/");
  const holdDays = await getHoldDays();
  const now = new Date();

  // Знижки фінансує магазин: за сумою замовлення і/або купон (разом не діють, але рахуємо обидві)
  const autoFunding = order.order_discount?.amount || 0;
  const couponFunding = order.coupon?.amount || 0;

  for (const ao of authOrders) {
    const isNew = typeof ao.commission === "number";
    const commission = isNew ? ao.commission : 0;
    const payout = isNew ? ao.payout : ao.price;

    // Продавець: для нових замовлень — із затримкою виплати, для старих — як раніше
    const sellerEntry = {
      sellerId: ao.sellerId.toString(),
      amount: payout,
      month,
      year,
    };
    if (isNew) {
      Object.assign(sellerEntry, {
        type: "sale",
        orderId: order._id,
        authOrderId: ao._id,
        gross: ao.price,
        commission,
        // уже доставлено (напр. оплата при отриманні) — одразу відлік утримання
        availableAt: ao.delivery_status === "delivered" ? addDays(now, holdDays) : null,
      });
    }
    await sellerWallet.create(sellerEntry);

    // Магазин: комісія з цього підзамовлення
    if (isNew) {
      await myShopWallet.create({
        amount: commission,
        month,
        year,
        type: "commission",
        orderId: order._id,
        authOrderId: ao._id,
      });
    }
  }

  const hasNew = authOrders.some((ao) => typeof ao.commission === "number");
  if (hasNew) {
    // Знижка за сумою замовлення / купон — витрата магазину
    if (autoFunding > 0) {
      await myShopWallet.create({
        amount: -autoFunding,
        month,
        year,
        type: "discount",
        orderId: order._id,
      });
    }
    if (couponFunding > 0) {
      await myShopWallet.create({
        amount: -couponFunding,
        month,
        year,
        type: "coupon",
        orderId: order._id,
      });
    }
  } else {
    // Старий формат: у гаманець магазину йшла вся сума замовлення
    await myShopWallet.create({ amount: order.price, month, year });
  }
}

// Підзамовлення доставлено → запускаємо відлік утримання (термін повернення).
async function releaseForAuthorOrder(authOrderId) {
  const holdDays = await getHoldDays();
  const at = addDays(new Date(), holdDays);
  const res = await sellerWallet.updateMany(
    { authOrderId, type: "sale", reversed: { $ne: true }, availableAt: null },
    { $set: { availableAt: at } }
  );
  // Записи про повернення, створені до доставки (відмова від отримання), «рухаються» разом з продажем
  await sellerWallet.updateMany(
    { authOrderId, type: "return", availableAt: null },
    { $set: { availableAt: at } }
  );
  return res.modifiedCount || 0;
}

async function releaseForOrder(orderId) {
  const list = await authorOrderModel.find({ orderId });
  let n = 0;
  for (const ao of list) n += await releaseForAuthorOrder(ao._id);
  return n;
}

// Скасування/повернення оплаченого підзамовлення: додаємо від'ємні записи.
// Повернення коштів ПОКУПЦЕВІ (в monobank/LiqPay) робиться окремо.
async function reverseForAuthorOrder(authOrderId) {
  const [month, , year] = moment().format("l").split("/");
  let reversed = 0;

  const sellerEntry = await sellerWallet.findOneAndUpdate(
    { authOrderId, type: "sale", reversed: { $ne: true } },
    { $set: { reversed: true } }
  );
  if (sellerEntry) {
    await sellerWallet.create({
      sellerId: sellerEntry.sellerId,
      amount: -sellerEntry.amount,
      month,
      year,
      type: "reversal",
      orderId: sellerEntry.orderId,
      authOrderId,
      // та сама доступність, що в оригіналу, щоб пара обнулялась у тому ж «кошику» балансу
      availableAt: sellerEntry.availableAt === undefined ? undefined : sellerEntry.availableAt,
      reversed: true,
    });
    reversed++;
  }

  const shopEntry = await myShopWallet.findOneAndUpdate(
    { authOrderId, type: "commission", reversed: { $ne: true } },
    { $set: { reversed: true } }
  );
  if (shopEntry) {
    await myShopWallet.create({
      amount: -shopEntry.amount,
      month,
      year,
      type: "reversal",
      orderId: shopEntry.orderId,
      authOrderId,
      reversed: true,
    });

    // Знижка за сумою / купон фінансується магазином пропорційно вартості товарів:
    // скасували підзамовлення — частка знижки, що на нього припадала, повертається магазину.
    // (Сума часток за всі підзамовлення = уся знижка, тож окремо «знижку замовлення» не скасовуємо.)
    const order = (await customerOrderModel.find({ _id: shopEntry.orderId }))[0];
    const ao = (await authorOrderModel.find({ _id: authOrderId }))[0];
    const funding = (order?.order_discount?.amount || 0) + (order?.coupon?.amount || 0);
    const goods = order?.goods_total || 0;
    if (funding > 0 && goods > 0 && ao) {
      const share = pricing.round2((funding * ao.price) / goods);
      if (share > 0) {
        await myShopWallet.create({
          amount: share,
          month,
          year,
          type: "discount_back",
          orderId: shopEntry.orderId,
          authOrderId,
          reversed: true,
        });
      }
    }
  }
  return reversed;
}

// Скасування всього замовлення: усі підзамовлення (разом з частками знижки).
async function reverseForOrder(orderId) {
  const list = await authorOrderModel.find({ orderId });
  let n = 0;
  for (const ao of list) n += await reverseForAuthorOrder(ao._id);
  return n;
}

// Повернення частини замовлення (товари повертаються на склад, покупець отримує гроші назад).
//
// Для кожного продавця:
//   − частка продавця за повернуті товари = вартість товарів − комісія за них − утримання
//     (утримання, напр. за пошкодження, лишається в продавця);
//   − комісія магазину за ці товари скасовується, а частка знижки/купона, яку фінансував магазин,
//     повертається магазину;
//   − якщо зворотну доставку оплачує продавець — окремий запис «return_shipping»;
//     якщо магазин — списання з гаманця магазину; якщо покупець — вона вже віднята від суми повернення.
//
// request: { _id, orderId, items[], refund: { goodsAmount, discountShare, deduction, shippingCost, shippingPayer } }
// Ідемпотентно: повторний виклик для тієї самої заявки нічого не додає.
async function recordReturn(request) {
  const [month, , year] = moment().format("l").split("/");
  const refund = request.refund || {};
  const itemsValue = request.items.reduce((s, i) => s + (i.value || 0), 0) || 1;
  const deduction = refund.deduction || 0;
  const discountShare = refund.discountShare || 0;

  // Кожен запис створюється лише один раз (перевірка за заявкою, продавцем, підзамовленням і типом),
  // тому повтор після збою дописує лише те, чого не вистачає, і нічого не дублює.
  let created = 0;
  const sellerOnce = async (entry) => {
    const exists = (await sellerWallet.find({ returnId: request._id, sellerId: entry.sellerId, type: entry.type })).find(
      (e) => String(e.authOrderId || "") === String(entry.authOrderId || "")
    );
    if (exists) return;
    await sellerWallet.create(entry);
    created++;
  };
  const shopOnce = async (entry) => {
    if ((await myShopWallet.find({ returnId: request._id, type: entry.type })).length) return;
    await myShopWallet.create(entry);
    created++;
  };

  // групуємо по підзамовленнях/продавцях
  const groups = new Map();
  for (const it of request.items) {
    const key = String(it.authOrderId || it.sellerId);
    if (!groups.has(key)) {
      groups.set(key, { sellerId: it.sellerId, authOrderId: it.authOrderId, value: 0, commission: 0 });
    }
    const g = groups.get(key);
    g.value += it.value || 0;
    g.commission += it.commission || 0;
  }

  let shopDelta = 0;
  for (const g of groups.values()) {
    const weight = g.value / itemsValue;
    const sellerDeduction = pricing.round2(deduction * weight);
    const commission = pricing.round2(g.commission);
    const payoutShare = pricing.round2(g.value - commission - sellerDeduction);

    // Дата «відкриття» грошей у запису, який ми частково скасовуємо
    const sale = g.authOrderId
      ? (await sellerWallet.find({ authOrderId: g.authOrderId, type: "sale" }))[0]
      : null;
    const entry = {
      sellerId: String(g.sellerId),
      amount: -payoutShare,
      month,
      year,
      type: "return",
      orderId: request.orderId,
      authOrderId: g.authOrderId,
      returnId: request._id,
    };
    if (sale && sale.availableAt !== undefined) entry.availableAt = sale.availableAt;
    await sellerOnce(entry);

    // магазин: комісія повертається продавцю (мінус), а фінансована знижка — магазину (плюс)
    shopDelta += -commission + pricing.round2(discountShare * weight);

    // зворотна доставка за рахунок продавця (розподіляється пропорційно вартості товарів)
    if (refund.shippingPayer === "seller" && refund.shippingCost > 0) {
      await sellerOnce({
        sellerId: String(g.sellerId),
        amount: -pricing.round2(refund.shippingCost * weight),
        month,
        year,
        type: "return_shipping",
        orderId: request.orderId,
        authOrderId: g.authOrderId,
        returnId: request._id,
      });
    }
  }

  if (shopDelta !== 0) {
    await shopOnce({
      amount: pricing.round2(shopDelta),
      month,
      year,
      type: "return",
      orderId: request.orderId,
      returnId: request._id,
    });
  }
  if (refund.shippingPayer === "store" && refund.shippingCost > 0) {
    await shopOnce({
      amount: -pricing.round2(refund.shippingCost),
      month,
      year,
      type: "return_shipping",
      orderId: request.orderId,
      returnId: request._id,
    });
  }
  return created > 0;
}

// Баланс продавця: available — можна виводити; hold — чекає доставки або закінчення терміну повернення.
async function sellerBalances(sellerId) {
  const now = new Date();
  const rows = await sellerWallet.find({ sellerId: String(sellerId) });
  let available = 0;
  let hold = 0;
  for (const r of rows) {
    const free =
      r.availableAt === undefined || (r.availableAt !== null && r.availableAt <= now);
    if (free) available += r.amount;
    else hold += r.amount;
  }
  return { available: pricing.round2(available), hold: pricing.round2(hold) };
}

module.exports = {
  recordPaidOrder,
  releaseForAuthorOrder,
  releaseForOrder,
  reverseForAuthorOrder,
  reverseForOrder,
  recordReturn,
  sellerBalances,
};
