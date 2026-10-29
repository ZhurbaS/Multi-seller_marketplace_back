// Облік залишків на складі.
//
// Модель: товар віднімається зі складу в момент оформлення замовлення («резерв»)
// і повертається, якщо замовлення скасовано або не оплачено вчасно.
//  - зменшення атомарне: updateOne({stock: {$gte: qty}}, {$inc: {stock: -qty}}) —
//    два покупці не можуть купити останню одиницю одночасно;
//  - прапорець authOrders.stock_reserved гарантує, що кожен підзамовлення
//    повертає склад не більше одного разу (повторне скасування нічого не змінить).

const productModel = require("../models/productModel");
const authorOrderModel = require("../models/authorOrderModel");

// Віднімає товари зі складу. items: [{_id, quantity, name}].
// Усе або нічого: при нестачі вже віднімене повертається назад.
async function reserveItems(items) {
  const done = [];
  for (const it of items) {
    if (it.preorder) continue; // передзамовлення склад не чіпає (товару ще немає)
    const res = await productModel.updateOne(
      { _id: it._id, stock: { $gte: it.quantity } },
      { $inc: { stock: -it.quantity } }
    );
    if (res.modifiedCount !== 1) {
      await restoreItems(done);
      return { ok: false, name: it.name };
    }
    done.push(it);
  }
  return { ok: true };
}

async function restoreItems(items) {
  for (const it of items) {
    if (it.preorder) continue;
    await productModel.updateOne({ _id: it._id }, { $inc: { stock: it.quantity } });
  }
}

// Повертає на склад товари одного підзамовлення (ідемпотентно).
async function releaseForAuthorOrder(authorOrderId) {
  const ao = await authorOrderModel.findOneAndUpdate(
    { _id: authorOrderId, stock_reserved: true },
    { $set: { stock_reserved: false } }
  );
  if (!ao) return false; // уже повернено або ніколи не резервувалось (старі замовлення)
  await restoreItems(ao.products);
  return true;
}

// Повертає товари всіх підзамовлень замовлення.
async function releaseForOrder(orderId) {
  const list = await authorOrderModel.find({ orderId, stock_reserved: true });
  let released = false;
  for (const ao of list) {
    released = (await releaseForAuthorOrder(ao._id)) || released;
  }
  return released;
}

// Знову резервує підзамовлення (напр. скасоване замовлення «відновили»).
async function reserveForAuthorOrder(authorOrderId) {
  const ao = await authorOrderModel.findOneAndUpdate(
    { _id: authorOrderId, stock_reserved: { $ne: true } },
    { $set: { stock_reserved: true } }
  );
  if (!ao) return { ok: true, already: true };
  const r = await reserveItems(ao.products);
  if (!r.ok) {
    await authorOrderModel.updateOne({ _id: ao._id }, { $set: { stock_reserved: false } });
  }
  return r;
}

async function reserveForOrder(orderId) {
  const list = await authorOrderModel.find({ orderId, stock_reserved: { $ne: true } });
  const taken = [];
  for (const ao of list) {
    const r = await reserveForAuthorOrder(ao._id);
    if (!r.ok) {
      // усе або нічого в межах замовлення
      for (const id of taken) await releaseForAuthorOrder(id);
      return r;
    }
    taken.push(ao._id);
  }
  return { ok: true };
}

module.exports = {
  reserveItems,
  restoreItems,
  releaseForAuthorOrder,
  releaseForOrder,
  reserveForAuthorOrder,
  reserveForOrder,
};
