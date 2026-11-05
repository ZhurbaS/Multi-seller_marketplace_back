// Інсайти продавця: каталог правил, пороги, мінімальні вибірки, сортування за серйозністю
const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../utiles/sellerInsights");

const P = (o) => ({ productId: o.id || "p1", name: o.name || "Товар", stock: 10, abc: "-", daysOfCover: null, units90: 0, revenue: 0, deadStock: false, views: 0, carts: 0, viewToCart: null, cartToOrder: null, qualityScore: 80, ...o });
const ids = (list) => list.map((x) => x.id.split(":")[0]);

test("no_products: лише онбординг", () => {
  const r = I.buildInsights({ hasProducts: false, products: [P({ stock: 0, units90: 5 })] });
  assert.deepEqual(ids(r), ["no_products"]);
  assert.equal(r[0].severity, "info");
});

test("no_orders_yet: є товари, немає замовлень", () => {
  const r = I.buildInsights({ hasProducts: true, hasOrders: false, products: [P({})] });
  assert.ok(ids(r).includes("no_orders_yet"));
});

test("out_of_stock: лише товари, що продавались", () => {
  assert.equal(I.ruleOutOfStock([P({ stock: 0, units90: 0 })]).length, 0);
  const r = I.ruleOutOfStock([P({ id: "x", stock: 0, units90: 3 })]);
  assert.equal(r.length, 1);
  assert.equal(r[0].severity, "critical");
  assert.equal(r[0].productId, "x");
  assert.match(r[0].link, /edit-product\/x/);
});

test("low_stock: daysOfCover < 7 лише для класу A", () => {
  assert.equal(I.ruleLowStock([P({ abc: "A", daysOfCover: 6.9 })]).length, 1);
  assert.equal(I.ruleLowStock([P({ abc: "A", daysOfCover: 7 })]).length, 0);
  assert.equal(I.ruleLowStock([P({ abc: "B", daysOfCover: 2 })]).length, 0);
  assert.equal(I.ruleLowStock([P({ abc: "A", daysOfCover: null })]).length, 0);
  assert.equal(I.ruleLowStock([P({ abc: "A", stock: 0, daysOfCover: 0 })]).length, 0, "закінчився — це out_of_stock");
});

test("перелік > MAX_PER_RULE зводиться в один інсайт", () => {
  const list = [1, 2, 3, 4].map((i) => P({ id: `p${i}`, name: `T${i}`, abc: "A", daysOfCover: i }));
  const r = I.ruleLowStock(list);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "low_stock");
  assert.match(r[0].title, /4/);
  assert.equal(r[0].productId, undefined);
});

test("dead_stock: один зведений інсайт", () => {
  const r = I.ruleDeadStock([P({ id: "a", deadStock: true }), P({ id: "b", deadStock: true }), P({ id: "c" })]);
  assert.equal(r.length, 1);
  assert.match(r[0].title, /2 товарів/);
  assert.equal(I.ruleDeadStock([P({})]).length, 0);
});

test("views_no_cart: views ≥ 200 і viewToCart < 0.5 × медіани", () => {
  assert.equal(I.ruleViewsNoCart([P({ views: 300, viewToCart: 0.02 })], 0.05).length, 1);
  assert.equal(I.ruleViewsNoCart([P({ views: 300, viewToCart: 0.03 })], 0.05).length, 0);
  assert.equal(I.ruleViewsNoCart([P({ views: 199, viewToCart: 0.0 })], 0.05).length, 0);
  assert.equal(I.ruleViewsNoCart([P({ views: 300, viewToCart: null })], 0.05).length, 0);
  assert.equal(I.ruleViewsNoCart([P({ views: 300, viewToCart: 0 })], 0).length, 0, "без медіани — не порівнюємо");
});

test("cart_no_order: carts ≥ 20 і cartToOrder < 10%", () => {
  assert.equal(I.ruleCartNoOrder([P({ carts: 40, cartToOrder: 0.05 })]).length, 1);
  assert.equal(I.ruleCartNoOrder([P({ carts: 40, cartToOrder: 0.1 })]).length, 0);
  assert.equal(I.ruleCartNoOrder([P({ carts: 19, cartToOrder: 0 })]).length, 0);
});

test("negative_reviews: ≥2 відгуки ≤2★", () => {
  assert.equal(I.ruleNegativeReviews([{ productId: "a", name: "A", count: 2 }]).length, 1);
  assert.equal(I.ruleNegativeReviews([{ productId: "a", name: "A", count: 1 }]).length, 0);
  assert.equal(I.ruleNegativeReviews(undefined).length, 0);
});

test("weak_card: якість < 60", () => {
  assert.equal(I.ruleWeakCard([P({ qualityScore: 59 })]).length, 1);
  assert.equal(I.ruleWeakCard([P({ qualityScore: 60 })]).length, 0);
});

test("revenue_drop / revenue_growth: ±20% при ≥10 замовлень", () => {
  const drop = I.ruleRevenue({ revenue: { value: 800, prev: 1000 }, orders: { value: 8, prev: 10 } });
  assert.equal(drop[0].id, "revenue_drop");
  assert.equal(drop[0].severity, "critical");
  assert.equal(I.ruleRevenue({ revenue: { value: 810, prev: 1000 }, orders: { value: 8, prev: 10 } }).length, 0);
  assert.equal(I.ruleRevenue({ revenue: { value: 100, prev: 1000 }, orders: { value: 1, prev: 9 } }).length, 0, "мала вибірка");
  const up = I.ruleRevenue({ revenue: { value: 1200, prev: 1000 }, orders: { value: 12, prev: 10 } });
  assert.equal(up[0].id, "revenue_growth");
  assert.equal(up[0].severity, "success");
  assert.equal(I.ruleRevenue({ revenue: { value: 5, prev: 0 }, orders: { value: 1, prev: 20 } }).length, 0);
  assert.equal(I.ruleRevenue(undefined).length, 0);
});

test("late_shipping: lateRate > 4% при достатній вибірці", () => {
  assert.equal(I.ruleLateShipping({ lateRate: 0.05, shippedCount: 30, overdueCount: 0 }).length, 1);
  assert.equal(I.ruleLateShipping({ lateRate: 0.04, shippedCount: 30, overdueCount: 0 }).length, 0);
  assert.equal(I.ruleLateShipping({ lateRate: 0.5, shippedCount: 5, overdueCount: 2 }).length, 0);
  assert.equal(I.ruleLateShipping({ lateRate: null, shippedCount: 50 }).length, 0);
});

test("pending_orders_old", () => {
  assert.equal(I.rulePendingOld(0).length, 0);
  assert.match(I.rulePendingOld(3)[0].title, /3 замовлень/);
});

test("buildInsights: сортування critical → warning → success → info, ліміт", () => {
  const r = I.buildInsights({
    hasProducts: true,
    hasOrders: true,
    products: [
      P({ id: "w", qualityScore: 30 }),
      P({ id: "o", stock: 0, units90: 4 }),
      P({ id: "l", abc: "A", daysOfCover: 3 }),
    ],
    kpi: { revenue: { value: 2000, prev: 1000 }, orders: { value: 20, prev: 15 } },
    pendingOld: 1,
  });
  const sev = r.map((x) => x.severity);
  const rank = sev.map((s) => I.SEVERITY_RANK[s]);
  assert.deepEqual(rank, [...rank].sort((a, b) => a - b));
  assert.deepEqual(ids(r), ["pending_orders_old", "out_of_stock", "low_stock", "revenue_growth", "weak_card"]);
  for (const x of r) {
    assert.ok(x.id && x.title && x.text && ["info", "warning", "critical", "success"].includes(x.severity));
  }
  const many = I.buildInsights({ hasProducts: true, hasOrders: true, products: Array.from({ length: 40 }, (_, i) => P({ id: `p${i}`, qualityScore: 10 })) });
  assert.ok(many.length <= I.THRESHOLDS.MAX_TOTAL);
});

test("median", () => {
  assert.equal(I.median([0.1, 0.3, 0.2]), 0.2);
  assert.equal(I.median([]), null);
});

test("LINKS: аналітичні сторінки кабінету — /seller/analytics/<page>", () => {
  for (const k of ["inventory", "products", "funnel", "reviews", "quality", "fulfillment", "sales"]) {
    assert.equal(I.LINKS[k], `/seller/analytics/${k}`);
  }
  const r = I.ruleWeakCard([P({ id: "w1", qualityScore: 40 }), P({ id: "w2", qualityScore: 41 }), P({ id: "w3", qualityScore: 42 }), P({ id: "w4", qualityScore: 43 })]);
  assert.equal(r[0].link, "/seller/analytics/quality");
});
