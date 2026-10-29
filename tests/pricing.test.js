const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../utiles/pricing");

const product = (over = {}) => ({
  price: 1000,
  discount: 0,
  stock: 500,
  minOrderQty: 1,
  orderStep: 1,
  priceTiers: [],
  allowPreorder: false,
  ...over,
});

test("ціна за шт: знижка товару", () => {
  assert.equal(p.baseUnitPrice(product({ discount: 10 })), 900);
  assert.equal(p.unitPrice(product({ discount: 10 }), 1), 900);
});

test("знижка за кількість: береться найбільший підходящий поріг", () => {
  const prod = product({
    priceTiers: [
      { minQty: 10, percent: 5 },
      { minQty: 50, percent: 10 },
    ],
  });
  assert.equal(p.unitPrice(prod, 9), 1000);
  assert.equal(p.unitPrice(prod, 10), 950);
  assert.equal(p.unitPrice(prod, 49), 950);
  assert.equal(p.unitPrice(prod, 50), 900);
});

test("знижка за кількість додається до знижки товару", () => {
  const prod = product({ discount: 10, priceTiers: [{ minQty: 10, percent: 10 }] });
  assert.equal(p.unitPrice(prod, 10), 810); // 1000 → 900 → 810
});

test("мінімум і кратність", () => {
  const prod = product({ minOrderQty: 100, orderStep: 100 });
  assert.match(p.validateQuantity(prod, 50), /Мінімальне замовлення — 100/);
  assert.match(p.validateQuantity(prod, 150), /кратною 100/);
  assert.equal(p.validateQuantity(prod, 100), null);
  assert.equal(p.validateQuantity(prod, 300), null);
  assert.match(p.validateQuantity(prod, 0), /Некоректна/);
  assert.match(p.validateQuantity(prod, 1.5), /Некоректна/);
  const odd = product({ minOrderQty: 10, orderStep: 5 });
  assert.equal(p.validateQuantity(odd, 15), null);
  assert.match(p.validateQuantity(odd, 12), /кратною 5/);
});

test("наявність: у межах складу, більше складу, немає, передзамовлення", () => {
  const inStock = product({ stock: 5 });
  assert.equal(p.availability(inStock, 5).ok, true);
  assert.match(p.availability(inStock, 6).error, /Доступно лише 5/);

  const out = product({ stock: 0 });
  assert.match(p.availability(out, 1).error, /немає в наявності/);

  const pre = product({ stock: 0, allowPreorder: true });
  assert.deepEqual(p.availability(pre, 3), { ok: true, preorder: true, error: null });

  // є на складі менше за мінімальне замовлення — замовити неможливо
  const small = product({ stock: 50, minOrderQty: 100, orderStep: 100 });
  assert.equal(p.availability(small, 100).ok, false);
});

test("передзамовлення діє лише коли склад порожній", () => {
  const pre = product({ stock: 2, allowPreorder: true });
  assert.equal(p.availability(pre, 3).ok, false);
});

test("автокорекція кількості до допустимої", () => {
  const prod = product({ minOrderQty: 10, orderStep: 5 });
  assert.equal(p.nearestValidQuantity(prod, 3), 10);
  assert.equal(p.nearestValidQuantity(prod, 12), 15);
  assert.equal(p.nearestValidQuantity(prod, 15), 15);
});

test("знижка за сумою замовлення + підказка наступного порогу", () => {
  const tiers = [
    { minTotal: 5000, percent: 3 },
    { minTotal: 10000, percent: 5 },
  ];
  assert.deepEqual(p.orderDiscount(tiers, 4999), { percent: 0, amount: 0 });
  assert.deepEqual(p.orderDiscount(tiers, 5000), { percent: 3, amount: 150 });
  assert.deepEqual(p.orderDiscount(tiers, 12345), { percent: 5, amount: 617 });
  assert.deepEqual(p.orderDiscount([], 99999), { percent: 0, amount: 0 });
  assert.deepEqual(p.nextOrderDiscount(tiers, 4000), {
    minTotal: 5000,
    percent: 3,
    remaining: 1000,
  });
  assert.equal(p.nextOrderDiscount(tiers, 10000), null);
});

test("sanitizePriceTiers: валідні, сортування, помилки", () => {
  assert.deepEqual(p.sanitizePriceTiers([{ minQty: 50, percent: 10 }, { minQty: 10, percent: 5 }]).value, [
    { minQty: 10, percent: 5 },
    { minQty: 50, percent: 10 },
  ]);
  assert.deepEqual(p.sanitizePriceTiers([{ minQty: "", percent: "" }]).value, []);
  assert.ok(p.sanitizePriceTiers([{ minQty: 1, percent: 5 }]).error);
  assert.ok(p.sanitizePriceTiers([{ minQty: 10, percent: 95 }]).error);
  assert.ok(p.sanitizePriceTiers([{ minQty: 10, percent: 5 }, { minQty: 10, percent: 6 }]).error);
  assert.ok(p.sanitizePriceTiers([{ minQty: 10, percent: 8 }, { minQty: 20, percent: 5 }]).error);
  assert.ok(p.sanitizePriceTiers("не масив").error);
});

test("sanitizeOrderTiers: валідні й помилки", () => {
  assert.deepEqual(p.sanitizeOrderTiers([{ minTotal: "5000", percent: "3" }]).value, [
    { minTotal: 5000, percent: 3 },
  ]);
  assert.ok(p.sanitizeOrderTiers([{ minTotal: 0, percent: 3 }]).error);
  assert.ok(p.sanitizeOrderTiers([{ minTotal: 5000, percent: 60 }]).error);
  assert.ok(p.sanitizeOrderTiers([
    { minTotal: 5000, percent: 5 },
    { minTotal: 9000, percent: 3 },
  ]).error);
});

test("sanitizeSaleRules: значення за замовчуванням і помилки", () => {
  const ok = p.sanitizeSaleRules({});
  assert.deepEqual(ok.value, {
    minOrderQty: 1,
    orderStep: 1,
    packLabel: "",
    priceTiers: [],
    restockDaysMin: null,
    restockDaysMax: null,
    allowPreorder: false,
  });
  const full = p.sanitizeSaleRules({
    minOrderQty: "100",
    orderStep: "100",
    packLabel: " Упаковка по 100 шт ",
    priceTiers: JSON.stringify([{ minQty: 500, percent: 7 }]),
    restockDaysMin: "20",
    restockDaysMax: "30",
    allowPreorder: "true",
  });
  assert.equal(full.value.minOrderQty, 100);
  assert.equal(full.value.packLabel, "Упаковка по 100 шт");
  assert.equal(full.value.allowPreorder, true);
  assert.deepEqual(full.value.priceTiers, [{ minQty: 500, percent: 7 }]);
  assert.ok(p.sanitizeSaleRules({ minOrderQty: 0 }).error);
  assert.ok(p.sanitizeSaleRules({ orderStep: 2.5 }).error);
  assert.ok(p.sanitizeSaleRules({ restockDaysMin: 30, restockDaysMax: 20 }).error);
  assert.ok(p.sanitizeSaleRules({ restockDaysMin: 400 }).error);
  assert.ok(p.sanitizeSaleRules({ priceTiers: "{ погано" }).error);
});
