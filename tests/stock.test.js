// Запуск: npm test  (моделі підмінені в пам'яті, MongoDB не потрібна)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function stubModule(rel, exportsObj) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

const products = new Map(); // id -> {_id, stock}
const authOrders = new Map(); // id -> doc

const eq = (a, b) => String(a) === String(b);

stubModule("models/productModel.js", {
  updateOne: async (filter, upd) => {
    const p = products.get(String(filter._id));
    if (!p) return { modifiedCount: 0 };
    if (filter.stock?.$gte !== undefined && !(p.stock >= filter.stock.$gte))
      return { modifiedCount: 0 };
    p.stock += upd.$inc.stock;
    return { modifiedCount: 1 };
  },
});

function matchAO(doc, f) {
  return Object.entries(f).every(([k, v]) => {
    if (v && typeof v === "object" && "$ne" in v) return !eq(doc[k], v.$ne) && doc[k] !== v.$ne;
    return eq(doc[k], v);
  });
}
stubModule("models/authorOrderModel.js", {
  findOneAndUpdate: async (f, upd) => {
    const d = [...authOrders.values()].find((x) => matchAO(x, f));
    if (!d) return null;
    const before = JSON.parse(JSON.stringify(d)); // як Mongoose: повертає документ ДО зміни
    Object.assign(d, upd.$set);
    return before;
  },
  updateOne: async (f, upd) => {
    const d = [...authOrders.values()].find((x) => matchAO(x, f));
    if (d) Object.assign(d, upd.$set);
  },
  find: async (f) => [...authOrders.values()].filter((x) => matchAO(x, f)),
});

const stock = require("../utiles/stockService");

function setup(stocks) {
  products.clear();
  authOrders.clear();
  for (const [id, s] of Object.entries(stocks)) products.set(id, { _id: id, stock: s });
}
function addAO(id, orderId, items, reserved = true) {
  authOrders.set(id, { _id: id, orderId, products: items, stock_reserved: reserved });
}

test("reserveItems: віднімає зі складу", async () => {
  setup({ a: 10, b: 5 });
  const r = await stock.reserveItems([
    { _id: "a", quantity: 3, name: "A" },
    { _id: "b", quantity: 5, name: "B" },
  ]);
  assert.equal(r.ok, true);
  assert.equal(products.get("a").stock, 7);
  assert.equal(products.get("b").stock, 0);
});

test("reserveItems: усе або нічого — при нестачі повертає вже віднімене", async () => {
  setup({ a: 10, b: 2 });
  const r = await stock.reserveItems([
    { _id: "a", quantity: 4, name: "A" },
    { _id: "b", quantity: 3, name: "B" },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.name, "B");
  assert.equal(products.get("a").stock, 10);
  assert.equal(products.get("b").stock, 2);
});

test("reserveItems: останню одиницю купує лише один з двох паралельних покупців", async () => {
  setup({ a: 1 });
  const results = await Promise.all([
    stock.reserveItems([{ _id: "a", quantity: 1, name: "A" }]),
    stock.reserveItems([{ _id: "a", quantity: 1, name: "A" }]),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(products.get("a").stock, 0);
});

test("releaseForOrder: повертає склад один раз (ідемпотентно)", async () => {
  setup({ a: 7 });
  addAO("ao1", "o1", [{ _id: "a", quantity: 3 }]);
  assert.equal(await stock.releaseForOrder("o1"), true);
  assert.equal(products.get("a").stock, 10);
  assert.equal(await stock.releaseForOrder("o1"), false);
  assert.equal(products.get("a").stock, 10);
});

test("releaseForAuthorOrder: паралельні виклики не повертають склад двічі", async () => {
  setup({ a: 0 });
  addAO("ao1", "o1", [{ _id: "a", quantity: 2 }]);
  await Promise.all([stock.releaseForAuthorOrder("ao1"), stock.releaseForAuthorOrder("ao1")]);
  assert.equal(products.get("a").stock, 2);
});

test("старі замовлення без резерву склад не повертають", async () => {
  setup({ a: 5 });
  addAO("ao1", "o1", [{ _id: "a", quantity: 3 }], false);
  assert.equal(await stock.releaseForAuthorOrder("ao1"), false);
  assert.equal(products.get("a").stock, 5);
});

test("reserveForOrder: відновлення скасованого замовлення знову віднімає склад", async () => {
  setup({ a: 10 });
  addAO("ao1", "o1", [{ _id: "a", quantity: 4 }], false);
  const r = await stock.reserveForOrder("o1");
  assert.equal(r.ok, true);
  assert.equal(products.get("a").stock, 6);
  assert.equal(authOrders.get("ao1").stock_reserved, true);
});

test("reserveForOrder: нестача на складі — помилка і нічого не змінюється", async () => {
  setup({ a: 1, b: 10 });
  addAO("ao1", "o1", [{ _id: "b", quantity: 2 }], false);
  addAO("ao2", "o1", [{ _id: "a", quantity: 5, name: "A" }], false);
  const r = await stock.reserveForOrder("o1");
  assert.equal(r.ok, false);
  assert.equal(products.get("a").stock, 1);
  assert.equal(products.get("b").stock, 10); // перший підзамовлення відкотився
  assert.equal(authOrders.get("ao1").stock_reserved, false);
  assert.equal(authOrders.get("ao2").stock_reserved, false);
});
