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
  assert.equal(policy.defaultShippingPayer(pol, "individual", "withdrawal"), "customer");
  assert.equal(policy.defaultShippingPayer(pol, "company", "withdrawal"), "customer");
  assert.equal(policy.defaultShippingPayer(pol, "company", "defect"), "seller");
});

test("політика: нормалізація некоректних значень повертає безпечні типові", () => {
  const n = policy.normalizePolicy({ individual: { withdrawalDays: "abc", shippingPayerDefect: "хтось" } });
  assert.equal(n.individual.withdrawalDays, 14);
  assert.equal(n.individual.shippingPayerDefect, "seller");
  assert.equal(n.enabled, true);
});

// ---------- Доставка ----------
const shipping = require("../utiles/shipping");
const base = { deliveryType: "nova_poshta_warehouse", name: "Іван", phone: "050 123-45-67", district: "Київська", city: "Київ", warehouse: "12" };

test("доставка: телефон нормалізується до +380XXXXXXXXX", () => {
  for (const p of ["0501234567", "+380501234567", "380501234567", "(050) 123 45 67", "501234567"]) {
    assert.equal(shipping.normalizePhone(p), "+380501234567", p);
  }
  for (const p of ["", "12345", "+48501234567", "050123456", "abc"]) assert.equal(shipping.normalizePhone(p), null, p);
});

test("доставка: Нова пошта на відділення — область, місто, № відділення обов'язкові", () => {
  const ok = shipping.sanitizeShipping(base);
  assert.equal(ok.value.phone, "+380501234567");
  assert.equal(ok.value.warehouse, "12");
  for (const f of ["district", "city", "warehouse", "name", "phone", "deliveryType"]) {
    assert.ok(shipping.sanitizeShipping({ ...base, [f]: "" }).error, f);
  }
  // зайві поля адреси для відділення не зберігаються
  assert.equal(shipping.sanitizeShipping({ ...base, address: "вул. Х", post: "01001" }).value.address, "");
});

test("доставка: кур'єр — додатково адреса, індекс (5 цифр), район", () => {
  const courier = { ...base, deliveryType: "ukrposhta", warehouse: "", address: "вул. Хрещатик, 1, кв. 2", post: "01001", area: "Шевченківський" };
  assert.ok(shipping.sanitizeShipping(courier).value);
  for (const f of ["address", "post", "area"]) assert.ok(shipping.sanitizeShipping({ ...courier, [f]: "" }).error, f);
  assert.ok(shipping.sanitizeShipping({ ...courier, post: "123" }).error);
});

test("доставка: самовивіз не вимагає адреси; невідомий тип відхиляється", () => {
  assert.ok(shipping.sanitizeShipping({ deliveryType: "pickup", name: "Іван", phone: "0501234567" }).value);
  assert.ok(shipping.sanitizeShipping({ ...base, deliveryType: "drone" }).error);
  assert.ok(shipping.sanitizeShipping(undefined).error);
});

test("доставка: інший отримувач — прізвище, ім'я, телефон обов'язкові, по батькові ні", () => {
  const r = { other: true, lastName: "Петренко", firstName: "Олег", middleName: "", phone: "0671234567" };
  const ok = shipping.sanitizeShipping({ ...base, recipient: r });
  assert.equal(ok.value.recipient.other, true);
  assert.equal(ok.value.recipient.phone, "+380671234567");
  for (const f of ["lastName", "firstName", "phone"]) {
    assert.ok(shipping.sanitizeShipping({ ...base, recipient: { ...r, [f]: "" } }).error, f);
  }
  // без галочки дані отримувача ігноруються
  assert.equal(shipping.sanitizeShipping({ ...base, recipient: { ...r, other: false } }).value.recipient.other, false);
});

test("рекомендації: ранжування, без сміття, без кошикових товарів", () => {
  const rec = require("../utiles/recommendations");
  const cart = [{ _id: "a", category: "c1", price: 1000, discount: 0 }];
  const candidates = [
    { _id: "a", category: "c1", brand: "X", rating: 5, price: 900, discount: 0 }, // у кошику
    { _id: "b", category: "c1", brand: "X", rating: 4, price: 100, discount: 0 }, // разом купують
    { _id: "c", category: "c2", brand: "Y", rating: 5, price: 100, discount: 0 }, // без сигналу
    { _id: "d", category: "c2", brand: "Y", rating: 5, price: 9000, discount: 0 }, // задорогий
    { _id: "e", category: "c1", brand: "Z", rating: 3, price: 1200, discount: 0 }, // та сама категорія
  ];
  const out = rec.rankCandidates({ cart, candidates, co: new Map([["b", 5], ["d", 5]]) });
  const ids = out.map((o) => String(o.p._id));
  assert.deepEqual(ids, ["b", "e"]);
  assert.equal(out[0].reason, "together");
  assert.deepEqual(rec.rankCandidates({ cart, candidates: [] }), []);
});

test("доставка: поштомат, кур'єр НП без індексу, коментар", () => {
  const sh = require("../utiles/shipping");
  const base = { name: "Іван", phone: "+38(067)-323-57-85", district: "Київська", city: "Київ" };
  assert.ok(sh.sanitizeShipping({ ...base, deliveryType: "nova_poshta_postomat", warehouse: "123" }).value);
  assert.ok(sh.sanitizeShipping({ ...base, deliveryType: "nova_poshta_postomat" }).error);
  const c = sh.sanitizeShipping({ ...base, deliveryType: "nova_poshta_courier", address: "вул. Хрещатик, 1, кв. 2" });
  assert.equal(c.value.phone, "+380673235785");
  assert.ok(sh.sanitizeShipping({ ...base, deliveryType: "ukrposhta", address: "вул. Х, 1" }).error);
  assert.equal(sh.sanitizeComment("  a\r\n\r\n\r\n\r\nb   c ").length, 6);
  assert.equal(sh.sanitizeComment("x".repeat(2000)).length, 1000);
});

test("збережені контакти: дубль оновлюється, ліміт 10, лише інший отримувач/юрособа", () => {
  const sc = require("../utiles/savedContacts");
  const r = (n, p) => ({ other: true, lastName: n, firstName: "І", middleName: "", phone: p });
  let l = sc.upsertRecipient([], r("А", "+380501111111"));
  l = sc.upsertRecipient(l, r("Б", "+380502222222"));
  l = sc.upsertRecipient(l, r("А2", "+380501111111"));
  assert.deepEqual(l.map((x) => x.lastName), ["А2", "Б"]);
  assert.equal(sc.upsertRecipient(l, { other: false }).length, 2);
  let big = [];
  for (let i = 0; i < 15; i++) big = sc.upsertRecipient(big, r("X" + i, "+38050000000" + (i % 10) + i));
  assert.equal(big.length, 10);
  assert.deepEqual(sc.upsertCompany([], { kind: "individual" }), []);
  const c = sc.upsertCompany([], { kind: "company", companyName: "ТОВ", edrpou: "14360570", ipn: "" });
  assert.equal(sc.upsertCompany(c, { kind: "company", companyName: "ТОВ Нова", edrpou: "14360570" })[0].companyName, "ТОВ Нова");
});

test("Нова пошта: мапінг міст і відділень (fetch підмінено)", async () => {
  process.env.NOVA_POSHTA_API_KEY = "test";
  const np = require("../utiles/novaPoshta");
  const orig = global.fetch;
  const ref = "e221d627-391c-11dd-90d9-001a92567626";
  global.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    const data =
      b.calledMethod === "searchSettlements"
        ? [{ Addresses: [{ DeliveryCity: ref, Ref: "s1", MainDescription: "Київ", Area: "Київська", Region: "", Present: "м. Київ, Київська обл." }, { Ref: "x", MainDescription: "Без доставки" }] }]
        : [
            { Ref: "w1", Number: "1", Description: "Відділення №1", ShortAddress: "Київ, вул. А", CategoryOfWarehouse: "Branch", TypeOfWarehouse: "t" },
            { Ref: "p1", Number: "9", Description: "Поштомат №9", CategoryOfWarehouse: "Postomat", TypeOfWarehouse: np.POSTOMAT_TYPE_REF },
          ];
    return { json: async () => ({ success: true, data }) };
  };
  try {
    const cities = await np.searchCities("Київ");
    assert.deepEqual(cities.map((c) => c.ref), [ref]);
    assert.deepEqual((await np.searchWarehouses(ref, "", "warehouse")).map((w) => w.ref), ["w1"]);
    assert.deepEqual((await np.searchWarehouses(ref, "9", "postomat")).map((w) => w.ref), ["p1"]);
    assert.deepEqual(await np.searchWarehouses("bad", "", "warehouse"), []);
  } finally {
    global.fetch = orig;
    delete process.env.NOVA_POSHTA_API_KEY;
  }
});

test("адреси: збереження без дублів, самовивіз не зберігається; номер/лейбл замовлення", () => {
  const sh = require("../utiles/shipping");
  const sc = require("../utiles/savedContacts");
  const a = sh.sanitizeAddress({ deliveryType: "nova_poshta_warehouse", city: "Київ", district: "Київська", warehouse: "Відділення №1" });
  assert.ok(a.value);
  assert.equal(a.value.phone, undefined);
  let l = sc.upsertAddress([], a.value);
  l = sc.upsertAddress(l, { ...a.value });
  assert.equal(l.length, 1);
  assert.ok(sh.sanitizeAddress({ deliveryType: "pickup" }).error);
  const { orderLabel } = require("../utiles/orderNumber");
  assert.equal(orderLabel({ orderNumber: 100245 }), "№100245");
  assert.equal(orderLabel({ _id: "6ae846f2dad2d87546544b94" }), "№544B94");
});
