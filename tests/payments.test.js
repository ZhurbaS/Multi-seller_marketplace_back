// Запуск: npm test   (node:test, без додаткових залежностей і без MongoDB)
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

// ---------------------------------------------------------------------------
// monobank: еталонний приклад із офіційної документації
// https://monobank.ua/api-docs/acquiring/dev/webhooks/verify
// ---------------------------------------------------------------------------
const MONO_PUBKEY_B64 =
  "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUZrd0V3WUhLb1pJemowQ0FRWUlLb1pJemowREFRY0RRZ0FFQUc1LzZ3NnZubGJZb0ZmRHlYWE4vS29CbVVjTgo3NWJSUWg4MFBhaEdldnJoanFCQnI3OXNSS0JSbnpHODFUZVQ5OEFOakU1c0R3RmZ5Znhub0ZJcmZBPT0KLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tCg==";
const MONO_SIGN =
  "MEUCIQC/mVKhi8FKoayul2Mim3E2oaIOCNJk5dEXxTqbkeJSOQIgOM0hsW0qcP2H8iXy1aQYpmY0SJWEaWur7nQXlKDCFxA=";
const MONO_BODY = `{
  "invoiceId": "p2_9ZgpZVsl3",
  "status": "created",
  "failureReason": "string",
  "amount": 4200,
  "ccy": 980,
  "finalAmount": 4200,
  "createdDate": "2019-08-24T14:15:22Z",
  "modifiedDate": "2019-08-24T14:15:22Z",
  "reference": "84d0070ee4e44667b31371d8f8813947",
  "cancelList": [
    {
      "status": "processing",
      "amount": 4200,
      "ccy": 980,
      "createdDate": "2019-08-24T14:15:22Z",
      "modifiedDate": "2019-08-24T14:15:22Z",
      "approvalCode": "662476",
      "rrn": "060189181768",
      "extRef": "635ace02599849e981b2cd7a65f417fe"
    }
  ]
}`;

const monobank = require("../payments/providers/monobank");

test("monobank: підпис вебхука з документації валідний", () => {
  const pem = Buffer.from(MONO_PUBKEY_B64, "base64").toString("utf8");
  assert.equal(monobank._verifyWithKey(pem, Buffer.from(MONO_BODY), MONO_SIGN), true);
});

test("monobank: змінене тіло або підпис — відхиляється", () => {
  const pem = Buffer.from(MONO_PUBKEY_B64, "base64").toString("utf8");
  const tampered = MONO_BODY.replace('"amount": 4200', '"amount": 1');
  assert.equal(monobank._verifyWithKey(pem, Buffer.from(tampered), MONO_SIGN), false);
  assert.equal(monobank._verifyWithKey(pem, Buffer.from(MONO_BODY), "AAAA"), false);
  assert.equal(monobank._verifyWithKey("не ключ", Buffer.from(MONO_BODY), MONO_SIGN), false);
});

test("monobank: verifyWebhook без підпису/тіла → false (без мережі)", async () => {
  assert.equal(await monobank.verifyWebhook(null, MONO_SIGN), false);
  assert.equal(await monobank.verifyWebhook(Buffer.from("{}"), ""), false);
});

test("monobank: нормалізація статусів", () => {
  assert.equal(monobank.normalizeStatus("success"), "paid");
  for (const s of ["failure", "expired", "reversed"])
    assert.equal(monobank.normalizeStatus(s), "failed");
  for (const s of ["created", "processing", "hold"])
    assert.equal(monobank.normalizeStatus(s), "pending");
});

// ---------------------------------------------------------------------------
// LiqPay
// ---------------------------------------------------------------------------
const liqpay = require("../payments/providers/liqpay");

test("liqpay: підпис = base64(sha1(private+data+private)), як в офіційному SDK", () => {
  const priv = "sandbox_private_key";
  const data = Buffer.from(JSON.stringify({ version: 3, order_id: "x" })).toString("base64");
  const expected = crypto
    .createHash("sha1")
    .update(priv + data + priv)
    .digest("base64");
  assert.equal(liqpay.sign(data, priv, "sha1"), expected);
  assert.equal(liqpay.verifyCallback(data, expected, priv), true);
});

test("liqpay: приймаємо і sha3-256 підпис (на випадок зміни алгоритму)", () => {
  const priv = "k";
  const data = "ZGF0YQ==";
  const sig3 = crypto.createHash("sha3-256").update(priv + data + priv).digest("base64");
  assert.equal(liqpay.verifyCallback(data, sig3, priv), true);
});

test("liqpay: чужий/порожній підпис або змінені дані — відхиляється", () => {
  const priv = "k";
  const data = "ZGF0YQ==";
  const sig = liqpay.sign(data, priv, "sha1");
  assert.equal(liqpay.verifyCallback("ZGF0YTI=", sig, priv), false);
  assert.equal(liqpay.verifyCallback(data, sig, "інший ключ"), false);
  assert.equal(liqpay.verifyCallback(data, "", priv), false);
  assert.equal(liqpay.verifyCallback(undefined, sig, priv), false);
  assert.equal(liqpay.verifyCallback(data, sig, ""), false);
});

test("liqpay: нормалізація статусів", () => {
  assert.equal(liqpay.normalizeStatus("success"), "paid");
  assert.equal(liqpay.normalizeStatus("sandbox"), "paid");
  assert.equal(liqpay.normalizeStatus("failure"), "failed");
  assert.equal(liqpay.normalizeStatus("error"), "failed");
  assert.equal(liqpay.normalizeStatus("wait_accept"), "pending");
  assert.equal(liqpay.normalizeStatus("3ds_verify"), "pending");
});

test("liqpay: createCheckout — сума й order_id з замовлення, підпис валідний", () => {
  process.env.LIQPAY_PUBLIC_KEY = "pub";
  process.env.LIQPAY_PRIVATE_KEY = "priv";
  process.env.NODE_ENV = "development";
  const order = { _id: "6531a1b2c3d4e5f607182930", price: 1234.5 };
  const { url, fields } = liqpay.createCheckout({ order, amountUah: order.price });
  assert.match(url, /liqpay\.ua\/api\/3\/checkout$/);
  const params = liqpay.decodeData(fields.data);
  assert.equal(params.amount, 1234.5);
  assert.equal(params.currency, "UAH");
  assert.equal(params.order_id, order._id);
  assert.equal(params.sandbox, 1);
  assert.equal(liqpay.verifyCallback(fields.data, fields.signature, "priv"), true);
});

test("liqpay: у production sandbox не вмикається", () => {
  process.env.LIQPAY_PUBLIC_KEY = "pub";
  process.env.LIQPAY_PRIVATE_KEY = "priv";
  process.env.NODE_ENV = "production";
  const { fields } = liqpay.createCheckout({
    order: { _id: "6531a1b2c3d4e5f607182930" },
    amountUah: 10,
  });
  assert.equal(liqpay.decodeData(fields.data).sandbox, undefined);
  process.env.NODE_ENV = "development";
});

// ---------------------------------------------------------------------------
// paymentService: ідемпотентність і перевірка суми (моделі підмінені в пам'яті)
// ---------------------------------------------------------------------------
function stubModule(rel, exportsObj) {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

const db = { orders: new Map(), wallets: [], sellerWallets: [], authOrders: [] };

function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === "object" && "$ne" in v) return doc[k] !== v.$ne;
    return String(doc[k]) === String(v);
  });
}
function applySet(doc, set) {
  for (const [k, v] of Object.entries(set)) {
    const parts = k.split(".");
    let t = doc;
    parts.slice(0, -1).forEach((pp) => (t = t[pp] = t[pp] || {}));
    t[parts.at(-1)] = v;
  }
}

stubModule("models/customerOrderModel.js", {
  findById: async (id) => db.orders.get(String(id)) || null,
  findByIdAndUpdate: async (id, set) => {
    const d = db.orders.get(String(id));
    if (d) applySet(d, set);
    return d;
  },
  findOneAndUpdate: async (filter, upd) => {
    const d = [...db.orders.values()].find((o) => matches(o, filter));
    if (!d) return null;
    applySet(d, upd.$set);
    return d;
  },
  updateOne: async (filter, upd) => {
    const d = [...db.orders.values()].find((o) => matches(o, filter));
    if (d) applySet(d, upd.$set);
  },
});
stubModule("models/authorOrderModel.js", {
  updateMany: async (filter, set) => {
    db.authOrders.filter((o) => matches(o, filter)).forEach((o) => applySet(o, set));
  },
  find: async (filter) => db.authOrders.filter((o) => matches(o, filter)),
});
stubModule("models/myShopWallet.js", {
  create: async (d) => db.wallets.push(d),
});
stubModule("models/sellerWallet.js", {
  create: async (d) => db.sellerWallets.push(d),
});

// Склад тестується окремо (stock.test.js) — тут лише фіксуємо, що відновлення його викликає.
const stockCalls = [];
stubModule("utiles/stockService.js", {
  reserveForOrder: async (id) => {
    stockCalls.push(String(id));
    return { ok: true };
  },
});

// Купони тестуються окремо (coupon.test.js) — тут лише заглушки викликів.
stubModule("utiles/couponService.js", {
  markRedeemed: async () => {},
  releaseForOrder: async () => true,
  reacquireForOrder: async () => true,
});

// Налаштування (утримання виплат) — без MongoDB
stubModule("controllers/settingsController.js", {
  loadSettings: async () => ({ payoutHoldDays: 14 }),
});

const service = require("../payments/paymentService");

function seedOrder(over = {}) {
  const id = "6531a1b2c3d4e5f6071829" + String(db.orders.size).padStart(2, "0");
  const order = {
    _id: id,
    price: 500,
    payment_status: "unpaid",
    delivery_status: "pending",
    payment: {},
    ...over,
  };
  db.orders.set(id, order);
  db.authOrders.push({ orderId: id, sellerId: "s1", price: 450, payment_status: "unpaid" });
  db.authOrders.push({ orderId: id, sellerId: "s2", price: 50, payment_status: "unpaid" });
  return order;
}

test("markOrderPaid: нараховує гаманці один раз (ідемпотентність)", async () => {
  const order = seedOrder();
  const first = await service.markOrderPaid(order._id, { provider: "mock" });
  const second = await service.markOrderPaid(order._id, { provider: "mock" });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(order.payment_status, "paid");
  assert.equal(db.wallets.length, 1);
  assert.equal(db.wallets[0].amount, 500);
  assert.equal(db.sellerWallets.length, 2);
});

test("markOrderPaid: паралельні виклики не подвоюють нарахування", async () => {
  db.wallets.length = 0;
  db.sellerWallets.length = 0;
  const order = seedOrder();
  await Promise.all([
    service.markOrderPaid(order._id),
    service.markOrderPaid(order._id),
    service.markOrderPaid(order._id),
  ]);
  assert.equal(db.wallets.length, 1);
});

test("markOrderPaid: скасоване за таймером замовлення відновлюється після оплати", async () => {
  const order = seedOrder({ delivery_status: "cancelled" });
  await service.markOrderPaid(order._id);
  assert.equal(order.delivery_status, "pending");
  assert.deepEqual(stockCalls, [order._id]); // склад зарезервовано знову
});

test("LiqPay callback: невалідний підпис → 401, статус не змінюється", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "pub";
  process.env.LIQPAY_PRIVATE_KEY = "priv";
  const order = seedOrder();
  const data = Buffer.from(
    JSON.stringify({ order_id: order._id, status: "success", amount: 500, currency: "UAH" })
  ).toString("base64");
  await assert.rejects(() => service.handleLiqpayCallback(data, "підробка"), {
    status: 401,
  });
  assert.equal(order.payment_status, "unpaid");
});

test("LiqPay callback: правильна сума → paid; неправильна → 409 і не paid", async () => {
  process.env.LIQPAY_PUBLIC_KEY = "pub";
  process.env.LIQPAY_PRIVATE_KEY = "priv";
  const mk = (order, amount) => {
    const data = Buffer.from(
      JSON.stringify({ order_id: order._id, status: "success", amount, currency: "UAH" })
    ).toString("base64");
    return { data, sig: liqpay.sign(data, "priv", "sha1") };
  };
  const bad = seedOrder();
  const b = mk(bad, 1);
  await assert.rejects(() => service.handleLiqpayCallback(b.data, b.sig), { status: 409 });
  assert.equal(bad.payment_status, "unpaid");

  const good = seedOrder();
  const g = mk(good, 500);
  await service.handleLiqpayCallback(g.data, g.sig);
  assert.equal(good.payment_status, "paid");
  // повторний callback — без другого нарахування
  const before = db.wallets.length;
  await service.handleLiqpayCallback(g.data, g.sig);
  assert.equal(db.wallets.length, before);
});

test("LiqPay callback: невдача не затирає вже оплачене замовлення", async () => {
  process.env.LIQPAY_PRIVATE_KEY = "priv";
  const order = seedOrder();
  await service.markOrderPaid(order._id);
  const data = Buffer.from(
    JSON.stringify({ order_id: order._id, status: "failure", amount: 500, currency: "UAH" })
  ).toString("base64");
  await service.handleLiqpayCallback(data, liqpay.sign(data, "priv", "sha1"));
  assert.equal(order.payment_status, "paid");
});

test("startPayment: недоступний метод, оплачене й скасоване замовлення відхиляються", async () => {
  process.env.PAYMENTS_COD = "true";
  delete process.env.MONO_TOKEN;
  await assert.rejects(() => service.startPayment(seedOrder(), "monobank"), {
    message: /недоступний/,
  });
  await assert.rejects(
    () => service.startPayment(seedOrder({ payment_status: "paid" }), "cod"),
    { message: /вже оплачене/ }
  );
  await assert.rejects(
    () => service.startPayment(seedOrder({ delivery_status: "cancelled" }), "cod"),
    { message: /скасовано/ }
  );
});

test("startPayment: COD ставить payment_method=cod і не вимагає провайдера", async () => {
  const order = seedOrder();
  const r = await service.startPayment(order, "cod");
  assert.equal(r.type, "cod");
  assert.equal(order.payment_method, "cod");
});

test("mock: недоступний у production", async () => {
  process.env.NODE_ENV = "production";
  const order = seedOrder({ payment: { provider: "mock" } });
  await assert.rejects(() => service.completeMockPayment(order, true), { status: 403 });
  process.env.NODE_ENV = "development";
  await service.completeMockPayment(order, true);
  assert.equal(order.payment_status, "paid");
});

test("availableMethods: показує лише налаштовані способи", () => {
  delete process.env.MONO_TOKEN;
  delete process.env.LIQPAY_PUBLIC_KEY;
  delete process.env.LIQPAY_PRIVATE_KEY;
  process.env.NODE_ENV = "production";
  process.env.PAYMENTS_COD = "true";
  assert.deepEqual(service.availableMethods().map((m) => m.id), ["cod"]);
  process.env.MONO_TOKEN = "real_token_value";
  assert.deepEqual(service.availableMethods().map((m) => m.id), ["monobank", "cod"]);
  process.env.NODE_ENV = "development";
  assert.ok(service.availableMethods().some((m) => m.id === "mock"));
});
