// Збирає кошик покупця: актуальні ціни, наявність, знижки (за кількість, за сумою, купон).
// Усе рахується на сервері з даних БД. Кошик не резервує товар.

const mongoose = require("mongoose");
const cardModel = require("../models/cardModel");
const pricing = require("./pricing");
const couponService = require("./couponService");
const { loadOrderDiscountTiers } = require("../controllers/settingsController");

const ObjectId = mongoose.Types.ObjectId;

// Скільки днів позиція лежить у кошику без змін (TTL-індекс у cardModel має те саме значення).
const CART_TTL_DAYS = 30;

async function buildCart(userId, { couponCode } = {}) {
  const raw = await cardModel.aggregate([
    { $match: { userId: { $eq: new ObjectId(userId) } } },
    {
      $lookup: {
        from: "products",
        localField: "productId",
        foreignField: "_id",
        as: "products",
      },
    },
  ]);

  // Товар могли видалити з магазину — прибираємо такі позиції.
  const orphaned = raw.filter((p) => !p.products[0]);
  if (orphaned.length) {
    await cardModel.deleteMany({ _id: { $in: orphaned.map((p) => p._id) } });
  }

  const orderable = []; // можна замовити (є в наявності або передзамовлення)
  const outOfStockProduct = [];

  for (const entry of raw.filter((p) => p.products[0])) {
    const product = entry.products[0];

    // Продавець міг змінити мінімум/крок — підтягуємо кількість до допустимої.
    if (pricing.validateQuantity(product, entry.quantity)) {
      const fixed = pricing.nearestValidQuantity(product, entry.quantity);
      if (!pricing.validateQuantity(product, fixed)) {
        entry.quantity = fixed;
        await cardModel.updateOne({ _id: entry._id }, { quantity: fixed });
      }
    }

    const avail = pricing.availability(product, entry.quantity);
    if (avail.ok) {
      entry.unitPrice = pricing.unitPrice(product, entry.quantity);
      entry.lineTotal = entry.unitPrice * entry.quantity;
      entry.tierPercent = pricing.tierPercent(product.priceTiers, entry.quantity);
      entry.preorder = avail.preorder;
      orderable.push(entry);
    } else {
      entry.problem = avail.error;
      outOfStockProduct.push(entry);
    }
  }

  const subtotal = orderable.reduce((s, e) => s + e.lineTotal, 0);
  const buy_product_item = orderable.reduce((s, e) => s + e.quantity, 0);
  const tiers = await loadOrderDiscountTiers();
  const autoDiscount = pricing.orderDiscount(tiers, subtotal);

  // Купон: діє більша з двох знижок — купон або автоматична за сумою замовлення.
  let coupon = null;
  let order_discount = autoDiscount;
  let couponAmount = 0;
  if (couponCode) {
    const ev = subtotal > 0
      ? await couponService.evaluate({
          code: couponCode,
          customerId: userId,
          subtotal,
          autoDiscount: autoDiscount.amount,
        })
      : { ok: false, message: "Додайте товари до кошика, щоб застосувати купон" };
    if (!ev.ok) {
      coupon = { code: couponService.normalizeCode(couponCode), status: "invalid", message: ev.message };
    } else if (!ev.beatsAuto) {
      coupon = {
        code: ev.coupon.code,
        status: "not_applied",
        discount: ev.discount,
        message: `Знижка за сумою замовлення (₴${autoDiscount.amount}) вигідніша за купон — застосована вона`,
      };
    } else {
      couponAmount = ev.discount;
      order_discount = { percent: 0, amount: 0 };
      coupon = {
        code: ev.coupon.code,
        status: "applied",
        type: ev.coupon.type,
        value: ev.coupon.value,
        discount: ev.discount,
        message:
          autoDiscount.amount > 0
            ? "Купон замінює знижку за сумою замовлення — діє вигідніша"
            : "Купон застосовано",
      };
    }
  }

  // Групуємо за продавцем (у кошику кілька магазинів маркетплейсу).
  const bySeller = new Map();
  for (const e of orderable) {
    const product = e.products[0];
    const sid = product.sellerId.toString();
    if (!bySeller.has(sid)) {
      bySeller.set(sid, {
        sellerId: sid,
        shopName: product.shopName,
        price: 0,
        products: [],
      });
    }
    const group = bySeller.get(sid);
    group.price += e.lineTotal;
    group.products.push({
      _id: e._id,
      quantity: e.quantity,
      unitPrice: e.unitPrice,
      lineTotal: e.lineTotal,
      tierPercent: e.tierPercent,
      preorder: e.preorder,
      productInfo: product,
    });
  }

  return {
    card_products: [...bySeller.values()],
    price: subtotal,
    order_discount,
    coupon,
    coupon_discount: couponAmount,
    total: subtotal - order_discount.amount - couponAmount,
    next_order_discount: pricing.nextOrderDiscount(tiers, subtotal),
    card_product_count: buy_product_item,
    buy_product_item,
    outOfStockProduct,
    cart_ttl_days: CART_TTL_DAYS,
  };
}

module.exports = { buildCart, CART_TTL_DAYS };
