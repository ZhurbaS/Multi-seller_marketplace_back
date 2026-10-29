// Купони, дані покупця (юрособа), розрахунок повернень і політика повернень.
// Запуск: npm test (чисті функції, без MongoDB)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function stubModule(rel, exportsObj) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
// Моделі не потрібні для чистих функцій
for (const m of ["couponModel", "couponUsageModel", "couponRedemptionModel", "customerOrderModel"]) {
  stubModule(`models/${m}.js`, {});
}

const coupons = require("../utiles/couponService");
const buyer = require("../utiles/buyer");
const math = require("../utiles/returnMath");
const policy = require("../utiles/returnPolicy");

// ---------- Купони ----------
test("купон: нормалізація коду і генерація без двозначних символів", () => {
  assert.equal(coupons.normalizeCode("  sale 10 "), "SALE10");
  const code = coupons.generateCode(12);
  assert.equal(code.length, 12);
  assert.ok(!/[01OIL]/.test(code));
});

test("купон: відсоток, стеля, фіксована сума; платіж ніколи не нульовий", () => {
  assert.equal(coupons.computeDiscount({ type: "percent", value: 10 }, 1000), 100);
  assert.equal(coupons.computeDiscount({ type: "percent", value: 10, maxDiscount: 50 }, 1000), 50);
  assert.equal(coupons.computeDiscount({ type: "percent", value: 15 }, 999), 149); // вниз до цілих
  assert.equal(coupons.computeDiscount({ type: "fixed", value: 200 }, 1000), 200);
  assert.equal(coupons.computeDiscount({ type: "fixed", value: 5000 }, 300), 299); // лишається ₴1
  assert.equal(coupons.computeDiscount({ type: "fixed", value: 100 }, 1), 0);
});

test("купон: статичні правила (активність, дати, ліміт, мінімальна сума)", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const base = { active: true, usedCount: 0, totalLimit: null, minSubtotal: 0 };
  assert.equal(coupons.checkStatic(base, { subtotal: 100 }, now).ok, true);
  assert.equal(coupons.checkStatic({ ...base, active: false }, { subtotal: 100 }, now).ok, false);
  assert.equal(coupons.checkStatic({ ...base, startsAt: new Date("2026-07-01") }, { subtotal: 100 }, now).ok, false);
  assert.equal(coupons.checkStatic({ ...base, endsAt: new Date("2026-05-01") }, { subtotal: 100 }, now).ok, false);
  assert.equal(coupons.checkStatic({ ...base, totalLimit: 5, usedCount: 5 }, { subtotal: 100 }, now).ok, false);
  const min = coupons.checkStatic({ ...base, minSubtotal: 500 }, { subtotal: 100 }, now);
  assert.equal(min.ok, false);
  assert.match(min.message, /500/);
  // повідомлення про недійсний купон однакове — щоб не вгадували коди
  const a = coupons.checkStatic({ ...base, active: false }, { subtotal: 100 }, now).message;
  const b = coupons.checkStatic({ ...base, totalLimit: 1, usedCount: 1 }, { subtotal: 100 }, now).message;
  assert.equal(a, b);
});

test("купон: валідація форми адміна", () => {
  const s = coupons.sanitizeCoupon;
  const ok = s({ code: "spring-10", type: "percent", value: 10 });
  assert.equal(ok.value.code, "SPRING-10");
  assert.equal(ok.value.perCustomerLimit, 1);
  assert.ok(s({ code: "x", type: "percent", value: 10 }).error);
  assert.ok(s({ code: "ABC", type: "percent", value: 95 }).error);
  assert.ok(s({ code: "ABC", type: "fixed", value: 10.5 }).error);
  assert.ok(s({ code: "ABC", type: "fixed", value: 500, minSubtotal: 400 }).error);
  assert.ok(s({ code: "ABC", type: "percent", value: 10, startsAt: "2026-02-01", endsAt: "2026-01-01" }).error);
  assert.ok(s({ code: "ABC", type: "other", value: 10 }).error);
  // «лише перше замовлення» → 1 використання на покупця
  assert.equal(s({ code: "ABC", type: "percent", value: 10, firstOrderOnly: true, perCustomerLimit: 5 }).value.perCustomerLimit, 1);
  // стеля має сенс лише для відсотків
  assert.equal(s({ code: "ABC", type: "fixed", value: 10, maxDiscount: 5 }).value.maxDiscount, null);
});

// ---------- Покупець: фізособа / юрособа ----------
test("ЄДРПОУ: контрольна цифра", () => {
  for (const c of ["14360570", "00032112", "21560766", "20053145"]) assert.equal(buyer.isValidEdrpou(c), true, c);
  assert.equal(buyer.isValidEdrpou("14360571"), false);
  assert.equal(buyer.isValidEdrpou("1436057"), false);
  assert.equal(buyer.isValidEdrpou("abcdefgh"), false);
});

test("покупець: фізособа — реквізити порожні; юрособа — перевіряються", () => {
  assert.deepEqual(buyer.sanitizeBuyer(undefined).value, { kind: "individual", companyName: "", edrpou: "", ipn: "" });
  assert.deepEqual(buyer.sanitizeBuyer({ kind: "individual", companyName: "ТОВ", edrpou: "14360570" }).value.companyName, "");

  const good = buyer.sanitizeBuyer({ kind: "company", companyName: '  ТОВ  "Ромашка" ', edrpou: "14360570", ipn: "143605704321" });
  assert.deepEqual(good.value, { kind: "company", companyName: 'ТОВ "Ромашка"', edrpou: "14360570", ipn: "143605704321" });
  // ІПН необов'язковий
  assert.ok(buyer.sanitizeBuyer({ kind: "company", companyName: "ТОВ Х", edrpou: "14360570" }).value);
  // ФОП: 10 цифр РНОКПП замість ЄДРПОУ
  assert.ok(buyer.sanitizeBuyer({ kind: "company", companyName: "ФОП Іванов", edrpou: "1234567890" }).value);

  assert.ok(buyer.sanitizeBuyer({ kind: "company", companyName: "", edrpou: "14360570" }).error);
  assert.ok(buyer.sanitizeBuyer({ kind: "company", companyName: "ТОВ Х", edrpou: "14360571" }).error);
  assert.ok(buyer.sanitizeBuyer({ kind: "company", companyName: "ТОВ Х", edrpou: "123" }).error);
  assert.ok(buyer.sanitizeBuyer({ kind: "company", companyName: "ТОВ Х", edrpou: "14360570", ipn: "12345" }).error);
});

// ---------- Розрахунок повернення ----------
test("повернення: без знижки — повна вартість товарів", () => {
  const r = math.refundForItems({ goodsTotal: 1000, price: 1000 }, { refunded: 0, goods: 0 }, 400);
  assert.equal(r.goodsAmount, 400);
  assert.equal(r.discountShare, 0);
});

test("повернення: частка знижки/купона віднімається пропорційно", () => {
  // товарів на 1000, заплачено 900 (знижка 100)
  const r = math.refundForItems({ goodsTotal: 1000, price: 900 }, { refunded: 0, goods: 0 }, 400);
  assert.equal(r.goodsAmount, 360);
  assert.equal(r.discountShare, 40);
});

test("повернення: останнє часткове повернення добирає залишок без втрат на копійках", () => {
  const order = { goodsTotal: 1000, price: 901 };
  const a = math.refundForItems(order, { refunded: 0, goods: 0 }, 333);
  const b = math.refundForItems(order, { refunded: a.goodsAmount, goods: 333 }, 333);
  const c = math.refundForItems(order, { refunded: a.goodsAmount + b.goodsAmount, goods: 666 }, 334);
  assert.equal(Math.round((a.goodsAmount + b.goodsAmount + c.goodsAmount) * 100), 90100);
});

test("повернення: ніколи не більше за залишок оплаченого", () => {
  const r = math.refundForItems({ goodsTotal: 500, price: 500 }, { refunded: 450, goods: 450 }, 300);
  assert.equal(r.goodsAmount, 50);
});

test("повернення: утримання і зворотна доставка (платить покупець) зменшують суму", () => {
  assert.equal(math.finalRefund({ goodsAmount: 500, deduction: 50 }), 450);
  assert.equal(math.finalRefund({ goodsAmount: 500, shippingCost: 80, shippingPayer: "customer" }), 420);
  assert.equal(math.finalRefund({ goodsAmount: 500, shippingCost: 80, shippingPayer: "seller" }), 500);
  assert.equal(math.finalRefund({ goodsAmount: 50, deduction: 100 }), 0);
});

test("повернення: частка комісії пропорційна кількості", () => {
  assert.equal(math.commissionShare(30, 3, 1), 10);
  assert.equal(math.commissionShare(0, 3, 1), 0);
});

// ---------- Політика повернень ----------
const DAY = 86400000;
const delivered = (daysAgo, over = {}) => ({
  delivery_status: "delivered",
  deliveredAt: new Date(Date.now() - daysAgo * DAY),
  refund_status: "none",
  buyer: { kind: "individual" },
  products: [{ _id: "p1", name: "Товар", quantity: 2, price: 100, category: "Ноутбуки" }],
  ...over,
});

test("політика: фізособа — відмова 14 днів, брак довше", () => {
  const pol = policy.defaultPolicy();
  let e = policy.checkEligibility({ order: delivered(5), policy: pol });
  assert.equal(e.canReturn, true);
  assert.equal(e.reasons.find((r) => r.reason === "withdrawal").allowed, true);

  e = policy.checkEligibility({ order: delivered(20), policy: pol });
  assert.equal(e.reasons.find((r) => r.reason === "withdrawal").allowed, false);
  assert.equal(e.reasons.find((r) => r.reason === "defect").allowed, true);
  assert.equal(e.canReturn, true);

  e = policy.checkEligibility({ order: delivered(400), policy: pol });
  assert.equal(e.canReturn, false);
});

test("політика: юрособа — за замовчуванням без відмови «передумав»", () => {
  const pol = policy.defaultPolicy();
  const e = policy.checkEligibility({ order: delivered(2, { buyer: { kind: "company" } }), policy: pol });
  assert.equal(e.reasons.find((r) => r.reason === "withdrawal").allowed, false);
  assert.equal(e.reasons.find((r) => r.reason === "defect").allowed, true);
});

test("політика: адмін може вимкнути повернення або дозволити виняток для замовлення", () => {
  const off = { ...policy.defaultPolicy(), enabled: false };
  assert.equal(policy.checkEligibility({ order: delivered(1), policy: off }).enabled, false);
  assert.equal(policy.checkEligibility({ order: delivered(1, { returnOverride: "allow" }), policy: off }).canReturn, true);
  assert.equal(policy.checkEligibility({ order: delivered(1, { returnOverride: "deny" }), policy: policy.defaultPolicy() }).enabled, false);
  // «allow» знімає й часові обмеження
  assert.equal(policy.checkEligibility({ order: delivered(800, { returnOverride: "allow" }), policy: policy.defaultPolicy() }).canReturn, true);
});

test("політика: до відправки — лише скасування; категорії-виключення; врахування вже повернених", () => {
  const pol = policy.defaultPolicy();
  const pre = policy.checkEligibility({ order: { delivery_status: "processing", refund_status: "none", products: [] }, policy: pol });
  assert.equal(pre.canCancel, true);
  assert.equal(pre.canReturn, false);
  assert.equal(policy.checkEligibility({ order: { delivery_status: "cancelled", products: [] }, policy: pol }).canCancel, false);

  const blocked = { ...pol, nonReturnableCategories: ["Ноутбуки"] };
  const e = policy.checkEligibility({ order: delivered(3), policy: blocked });
  assert.equal(e.items[0].withdrawalBlocked, true);

  const left = policy.checkEligibility({ order: delivered(3), policy: pol, returnedQty: { p1: 1 } });
  assert.equal(left.items[0].availableQuantity, 1);
  const none = policy.checkEligibility({ order: delivered(3), policy: pol, returnedQty: { p1: 2 } });
  assert.equal(none.canReturn, false);
});

test("політика: хто платить зворотну доставку за замовчуванням", () => {
  const pol = policy.defaultPolicy();
  assert.equal(policy.defaultShippingPayer(pol, "individual", "withdrawal"), "seller");
  assert.equal(policy.defaultShippingPayer(pol, "company", "withdrawal"), "customer");
  assert.equal(policy.defaultShippingPayer(pol, "company", "defect"), "seller");
});

test("політика: нормалізація некоректних значень повертає безпечні типові", () => {
  const n = policy.normalizePolicy({ individual: { withdrawalDays: "abc", shippingPayerDefect: "хтось" } });
  assert.equal(n.individual.withdrawalDays, 14);
  assert.equal(n.individual.shippingPayerDefect, "seller");
  assert.equal(n.enabled, true);
});
