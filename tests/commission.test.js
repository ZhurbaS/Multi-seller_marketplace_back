// Запуск: npm test   (без MongoDB: моделі підмінені в пам'яті)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const pricing = require("../utiles/pricing");

// ---------- Розрахунок комісії ----------
test("комісія: пріоритет — продавець → категорія → типова; 0 для власного магазину", () => {
  const r = pricing.resolveCommissionPercent;
  assert.equal(r({ sellerPercent: 0, categoryPercent: 12, defaultPercent: 10 }), 0);
  assert.equal(r({ sellerPercent: 7, categoryPercent: 12, defaultPercent: 10 }), 7);
  assert.equal(r({ sellerPercent: null, categoryPercent: 12, defaultPercent: 10 }), 12);
  assert.equal(r({ sellerPercent: undefined, categoryPercent: undefined, defaultPercent: 10 }), 10);
});

test("комісія: сума округлюється до копійок, 0% дає 0", () => {
  assert.equal(pricing.commissionAmount(1000, 10), 100);
  assert.equal(pricing.commissionAmount(33.33, 10), 3.33);
  assert.equal(pricing.commissionAmount(500, 0), 0);
});

test("grossUpPrice: покупець платить так, щоб після комісії лишилось net", () => {
  for (const [net, c] of [[900, 10], [1234, 12.5], [100, 0]]) {
    const price = pricing.grossUpPrice(net, c);
    const left = price - pricing.commissionAmount(price, c);
    assert.ok(left >= net - 0.01, `net ${net}, c ${c}: ціна ${price}, лишається ${left}`);
  }
});

test("налаштування комісії: валідація", () => {
  const s = pricing.sanitizeCommissionSettings;
  assert.ok(s({ defaultCommissionPercent: 10, payoutHoldDays: 14, categoryCommissions: [] }).value);
  assert.ok(s({ defaultCommissionPercent: 60, payoutHoldDays: 14 }).error);
  assert.ok(s({ defaultCommissionPercent: 10, payoutHoldDays: -1 }).error);
  assert.ok(s({ defaultCommissionPercent: 10, payoutHoldDays: 14, categoryCommissions: [{ categoryId: "xx", percent: 5 }] }).error);
});

// ---------- Журнал нарахувань (ledger) ----------
function stubModule(rel, exportsObj) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
const db = { seller: [], shop: [], authOrders: [], orders: [] };
const matches = (doc, f) =>
  Object.entries(f).every(([k, v]) => {
    if (v && typeof v === "object" && "$ne" in v) return doc[k] !== v.$ne;
    return String(doc[k]) === String(v);
  });

stubModule("models/sellerWallet.js", {
  create: async (d) => (db.seller.push({ ...d }), d),
  find: async (f) => db.seller.filter((d) => matches(d, f)),
  findOneAndUpdate: async (f, u) => {
    const d = db.seller.find((x) => matches(x, f));
    if (d) Object.assign(d, u.$set);
    return d || null;
  },
  updateMany: async (f, u) => {
    const list = db.seller.filter((x) => matches(x, f));
    list.forEach((x) => Object.assign(x, u.$set));
    return { modifiedCount: list.length };
  },
});
stubModule("models/myShopWallet.js", {
  create: async (d) => (db.shop.push({ ...d }), d),
  find: async (f) => db.shop.filter((x) => matches(x, f)),
  findOneAndUpdate: async (f, u) => {
    const d = db.shop.find((x) => matches(x, f));
    if (d) Object.assign(d, u.$set);
    return d || null;
  },
});
stubModule("models/authorOrderModel.js", {
  find: async (f) => db.authOrders.filter((x) => matches(x, f)),
});
stubModule("models/customerOrderModel.js", {
  find: async (f) => db.orders.filter((x) => matches(x, f)),
});
let holdDays = 14;
stubModule("controllers/settingsController.js", {
  loadSettings: async () => ({ payoutHoldDays: holdDays }),
});

const ledger = require("../utiles/ledger");
const DAY = 86400000;

function reset() {
  db.seller.length = db.shop.length = db.authOrders.length = db.orders.length = 0;
}
function order(discount = 0) {
  const o = { _id: "o1", price: 1000 - discount, goods_total: 1000, order_discount: { amount: discount } };
  db.orders.push(o);
  return o;
}

test("ledger: нове замовлення — гроші на утриманні, комісія в гаманці магазину", async () => {
  reset();
  db.authOrders.push({ _id: "a1", orderId: "o1", sellerId: "s1", price: 1000, commission: 100, payout: 900, delivery_status: "pending" });
  await ledger.recordPaidOrder(order(), db.authOrders);
  assert.deepEqual(await ledger.sellerBalances("s1"), { available: 0, hold: 900 });
  assert.equal(db.shop.reduce((s, r) => s + r.amount, 0), 100);
});

test("ledger: після доставки — утримання 14 днів, потім доступно", async () => {
  reset();
  db.authOrders.push({ _id: "a1", orderId: "o1", sellerId: "s1", price: 1000, commission: 100, payout: 900, delivery_status: "pending" });
  await ledger.recordPaidOrder(order(), db.authOrders);
  await ledger.releaseForAuthorOrder("a1");
  assert.deepEqual(await ledger.sellerBalances("s1"), { available: 0, hold: 900 });
  // «через 15 днів»
  db.seller.forEach((r) => (r.availableAt = new Date(Date.now() - DAY)));
  assert.deepEqual(await ledger.sellerBalances("s1"), { available: 900, hold: 0 });
});

test("ledger: holdDays = 0 відкриває виплату одразу після доставки", async () => {
  reset();
  holdDays = 0;
  db.authOrders.push({ _id: "a1", orderId: "o1", sellerId: "s1", price: 500, commission: 0, payout: 500, delivery_status: "pending" });
  await ledger.recordPaidOrder(order(), db.authOrders);
  await ledger.releaseForAuthorOrder("a1");
  assert.deepEqual(await ledger.sellerBalances("s1"), { available: 500, hold: 0 });
  holdDays = 14;
});

test("ledger: власний магазин (комісія 0) — магазин не отримує комісії", async () => {
  reset();
  db.authOrders.push({ _id: "a1", orderId: "o1", sellerId: "own", price: 700, commission: 0, payout: 700, delivery_status: "pending" });
  await ledger.recordPaidOrder(order(), db.authOrders);
  assert.equal(db.shop.reduce((s, r) => s + r.amount, 0), 0);
  assert.equal((await ledger.sellerBalances("own")).hold, 700);
});

test("ledger: знижка за сумою фінансується магазином, продавець отримує повну суму", async () => {
  reset();
  db.authOrders.push({ _id: "a1", orderId: "o1", sellerId: "s1", price: 1000, commission: 100, payout: 900, delivery_status: "pending" });
  await ledger.recordPaidOrder(order(30), db.authOrders);
  assert.equal((await ledger.sellerBalances("s1")).hold, 900);
  assert.equal(db.shop.reduce((s, r) => s + r.amount, 0), 70); // 100 комісії − 30 знижки
});

test("ledger: скасування обнуляє нарахування, повторне — нічого не міняє", async () => {
  reset();
  db.authOrders.push({ _id: "a1", orderId: "o1", sellerId: "s1", price: 1000, commission: 100, payout: 900, delivery_status: "pending" });
  await ledger.recordPaidOrder(order(30), db.authOrders);
  await ledger.reverseForOrder("o1");
  await ledger.reverseForOrder("o1");
  assert.deepEqual(await ledger.sellerBalances("s1"), { available: 0, hold: 0 });
  assert.equal(db.shop.reduce((s, r) => s + r.amount, 0), 0);
});

test("ledger: старі записи (без комісії) доступні одразу, як раніше", async () => {
  reset();
  db.authOrders.push({ _id: "a1", orderId: "o1", sellerId: "s1", price: 300, delivery_status: "pending" });
  await ledger.recordPaidOrder(order(), db.authOrders);
  assert.deepEqual(await ledger.sellerBalances("s1"), { available: 300, hold: 0 });
});

test("ledger: повернення — продавець повертає виручку без комісії, утримання лишається в нього; зворотна доставка списується", async () => {
  reset();
  db.authOrders.push({ _id: "a1", orderId: "o1", sellerId: "s1", price: 1000, commission: 100, payout: 900, delivery_status: "pending" });
  await ledger.recordPaidOrder(order(50), db.authOrders);
  await ledger.releaseForAuthorOrder("a1");
  db.seller.forEach((r) => (r.availableAt = new Date(Date.now() - DAY)));
  assert.equal((await ledger.sellerBalances("s1")).available, 900);

  const request = {
    _id: "r1",
    orderId: "o1",
    items: [{ sellerId: "s1", authOrderId: "a1", value: 1000, commission: 100 }],
    refund: { goodsAmount: 850, discountShare: 50, deduction: 100, shippingCost: 80, shippingPayer: "seller" },
  };
  assert.equal(await ledger.recordReturn(request), true);
  // 900 − (1000 − 100 − 100) − 80 = 20: утримання ₴100 за пошкодження + виручка, за вирахуванням доставки
  assert.equal((await ledger.sellerBalances("s1")).available, 20);
  // магазин: комісія 100 повернена продавцю, частку знижки 50 повернено магазину → нетто 0 за цією парою
  const shop = db.shop.reduce((s, r) => s + r.amount, 0);
  assert.equal(shop, 0); // було 100 − 50 (знижка) = 50; повернення: −100 + 50 = −50 → разом 0
  // ідемпотентність
  assert.equal(await ledger.recordReturn(request), false);
});
