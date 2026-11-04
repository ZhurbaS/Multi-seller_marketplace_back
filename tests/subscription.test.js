const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

process.env.SECRET = process.env.SECRET || "test-secret";

const { limiter } = require("../utiles/rateLimit");
const wh = require("../controllers/webhookController");
const bot = require("../utiles/telegramBot");
const stats = require("../utiles/contactStats");
const mail = require("../utiles/subscriptionMail");
const tokens = require("../utiles/marketingTokens");

const SECRET_RAW = Buffer.from("super-secret-key-for-tests-123456");
const WHSEC = "whsec_" + SECRET_RAW.toString("base64");
const svixHeader = (id, ts, body, key = SECRET_RAW) =>
  "v1," + crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
const withEnv = async (vars, fn) => {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
};

// ---------------- rate limit

test("rateLimit: ліміт, окремі ключі, скидання після вікна, очищення", () => {
  const l = limiter({ max: 2, windowMs: 1000 });
  const t0 = 1_000_000;
  assert.equal(l.hit("a", t0).ok, true);
  assert.equal(l.hit("a", t0 + 1).remaining, 0);
  const r = l.hit("a", t0 + 2);
  assert.equal(r.ok, false);
  assert.ok(r.retryAfterMs > 0 && r.retryAfterMs <= 1000);
  assert.equal(l.hit("b", t0 + 2).ok, true, "інший ключ — окремий лічильник");
  assert.equal(l.hit("a", t0 + 1001).ok, true, "нове вікно");
  l.sweep(t0 + 5000);
  assert.equal(l.size(), 0);
  l.stop();
});

// ---------------- Svix

test("Svix: валідний підпис, кілька підписів, невалідний, прострочений, без секрету", () => {
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const body = JSON.stringify({ type: "email.bounced", data: { to: ["a@b.ua"] } });
  const sig = svixHeader("msg_1", ts, body);
  assert.deepEqual(wh.verifySvix({ secret: WHSEC, id: "msg_1", timestamp: ts, signature: sig, body, now }), { ok: true });
  assert.equal(wh.verifySvix({ secret: WHSEC, id: "msg_1", timestamp: ts, signature: sig, body: Buffer.from(body), now }).ok, true, "Buffer");
  assert.equal(wh.verifySvix({ secret: WHSEC, id: "msg_1", timestamp: ts, signature: `v1,AAAA ${sig}`, body, now }).ok, true, "ротація");
  assert.equal(wh.svixSign(WHSEC, "msg_1", ts, body), sig.slice(3));

  assert.equal(wh.verifySvix({ secret: WHSEC, id: "msg_1", timestamp: ts, signature: sig, body: body + " ", now }).error, "signature");
  assert.equal(wh.verifySvix({ secret: WHSEC, id: "msg_2", timestamp: ts, signature: sig, body, now }).error, "signature");
  assert.equal(
    wh.verifySvix({ secret: WHSEC, id: "msg_1", timestamp: ts, signature: svixHeader("msg_1", ts, body, Buffer.from("other")), body, now }).error,
    "signature"
  );
  assert.equal(wh.verifySvix({ secret: WHSEC, id: "msg_1", timestamp: ts, signature: "v2," + sig.slice(3), body, now }).error, "signature");

  const old = String(Math.floor(now / 1000) - 6 * 60);
  assert.equal(wh.verifySvix({ secret: WHSEC, id: "m", timestamp: old, signature: svixHeader("m", old, body), body, now }).error, "timestamp");
  const future = String(Math.floor(now / 1000) + 6 * 60);
  assert.equal(wh.verifySvix({ secret: WHSEC, id: "m", timestamp: future, signature: svixHeader("m", future, body), body, now }).error, "timestamp");
  const edge = String(Math.floor(now / 1000) - 4 * 60);
  assert.equal(wh.verifySvix({ secret: WHSEC, id: "m", timestamp: edge, signature: svixHeader("m", edge, body), body, now }).ok, true);

  assert.equal(wh.verifySvix({ secret: "", id: "m", timestamp: ts, signature: sig, body, now }).error, "secret");
  assert.equal(wh.verifySvix({ secret: WHSEC, id: "", timestamp: ts, signature: sig, body, now }).error, "missing");
  assert.equal(wh.verifySvix({ secret: WHSEC, id: "m", timestamp: "abc", signature: sig, body, now }).error, "timestamp");
});

test("Svix: дедуплікація svix-id з TTL і forget", () => {
  const d = wh.makeDeduper(1000);
  assert.equal(d.first("x", 0), true);
  assert.equal(d.first("x", 500), false, "повтор");
  assert.equal(d.first("x", 1501), true, "після TTL — знову перший");
  d.forget("x");
  assert.equal(d.first("x", 1600), true);
});

test("Resend: розбір подій", () => {
  const b = wh.parseResendEvent({ type: "email.bounced", data: { email_id: "re_1", to: ["A@B.ua"], bounce: { type: "Permanent" }, tags: { messageId: "m1" } } });
  assert.deepEqual(b, { kind: "bounce", email: "A@B.ua", providerId: "re_1", messageId: "m1", hard: true });
  assert.equal(wh.parseResendEvent({ type: "email.bounced", data: { to: ["a@b.ua"], bounce: { type: "Transient" } } }).hard, false);
  assert.equal(wh.parseResendEvent({ type: "email.complained", data: { to: "a@b.ua" } }).kind, "complaint");
  const s = wh.parseResendEvent({ type: "email.suppressed", data: { to: ["a@b.ua"], tags: [{ name: "message_id", value: "m2" }] } });
  assert.equal(s.kind, "bounce");
  assert.equal(s.messageId, "m2");
  assert.equal(wh.parseResendEvent({ type: "email.delivered", data: {} }).kind, null);
});

// ---------------- Telegram (чисті частини)

test("Telegram: парсинг команд і callback", () =>
  withEnv({ TELEGRAM_BOT_USERNAME: "ShopBot" }, () => {
    assert.deepEqual(bot.parseCommand("/start"), { cmd: "start", arg: "" });
    assert.deepEqual(bot.parseCommand("  /start abc_123  "), { cmd: "start", arg: "abc_123" });
    assert.deepEqual(bot.parseCommand("/START@shopbot payload"), { cmd: "start", arg: "payload" });
    assert.equal(bot.parseCommand("/start@OtherBot x"), null, "команда іншому боту");
    assert.deepEqual(bot.parseCommand("/stop"), { cmd: "stop", arg: "" });
    assert.equal(bot.parseCommand("привіт"), null);
    assert.equal(bot.parseCommand(undefined), null);
    assert.deepEqual(bot.parseCallback("sub:yes"), { action: "subscribe" });
    assert.deepEqual(bot.parseCallback("sub:no"), { action: "decline" });
    assert.deepEqual(bot.parseCallback("t:promo"), { action: "toggle", topic: "promo" });
    assert.equal(bot.parseCallback("t:evil"), null);
    assert.equal(bot.parseCallback("x"), null);
  }));

test("Telegram: токен прив'язки (deep-link ≤64 символів), прострочення, підробка", () => {
  const id = "64b7f0c2a1b2c3d4e5f60718";
  const now = Date.now();
  const t = bot.signStart(id, { now });
  assert.ok(t.length <= 64, `довжина ${t.length}`);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(bot.verifyStart(t, { now }), { ok: true, contactId: id });
  assert.equal(bot.verifyStart(t, { now: now + 31 * 24 * 3600 * 1000 }).error, "expired");
  const other = "64b7f0c2a1b2c3d4e5f60719";
  assert.equal(bot.verifyStart(other + t.slice(24), { now }).error, "invalid");
  assert.equal(bot.verifyStart(t.slice(0, -1) + (t.at(-1) === "A" ? "B" : "A"), { now }).error, "invalid");
  assert.equal(bot.verifyStart("garbage", { now }).error, "invalid");
  assert.throws(() => bot.signStart("not-an-id"));
});

test("Telegram: startLink, isConfigured, клавіатури", async () => {
  const contact = { _id: "64b7f0c2a1b2c3d4e5f60718" };
  await withEnv({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_BOT_USERNAME: "ShopBot" }, async () => {
    assert.equal(bot.isConfigured(), false);
    assert.equal(bot.startLink(contact), null);
    assert.equal(await bot.handleUpdate({ message: {} }), "disabled");
    assert.equal((await bot.api("getMe")).ok, false);
  });
  await withEnv({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_BOT_USERNAME: "@ShopBot" }, () => {
    const link = bot.startLink(contact);
    assert.match(link, /^https:\/\/t\.me\/ShopBot\?start=[A-Za-z0-9_-]+$/);
    assert.equal(bot.verifyStart(link.split("start=")[1]).contactId, contact._id);
    assert.equal(bot.startLink({}), null);
  });
  const kb = bot.topicsKeyboard({ promo: true, news: false, restock: true, tips: false });
  assert.equal(kb.flat().length, 4);
  assert.match(kb[0][0].text, /☑ Акції/);
  assert.match(kb[0][1].text, /☐ Новинки/);
  assert.deepEqual(bot.toMarkup([[{ text: "A", data: "t:promo" }, { text: "B", url: "https://x.ua" }]]), {
    inline_keyboard: [[{ text: "A", callback_data: "t:promo" }, { text: "B", url: "https://x.ua" }]],
  });
  assert.equal(bot.toMarkup([]), undefined);
});

// ---------------- contactStats

test("contactStats: computeStats — оплачені, скасовані, повернення, категорії", () => {
  const cat1 = "64b7f0c2a1b2c3d4e5f60001";
  const cat2 = "64b7f0c2a1b2c3d4e5f60002";
  const orders = [
    { price: 1000, payment_status: "paid", delivery_status: "delivered", createdAt: "2026-01-10T10:00:00Z", products: [{ category: cat1, quantity: 2 }] },
    { price: 3000, refunded_total: 500, payment_status: "paid", delivery_status: "processing", createdAt: "2026-03-01T10:00:00Z", products: [{ category: cat2, quantity: 1 }, { category: cat1 }] },
    { price: 700, payment_status: "unpaid", delivery_status: "pending", createdAt: "2026-04-01T10:00:00Z", products: [{ category: cat2 }] },
    { price: 900, payment_status: "paid", delivery_status: "cancelled", createdAt: "2026-05-01T10:00:00Z", products: [{ category: cat2, quantity: 9 }] },
  ];
  const s = stats.computeStats(orders, { names: new Map([[cat1, "Ноутбуки"], [cat2, "Монітори"]]) });
  assert.equal(s.orders, 3, "без скасованих");
  assert.equal(s.paidOrders, 2);
  assert.equal(s.ltv, 3500);
  assert.equal(s.avgOrder, 1750);
  assert.equal(s.firstOrderAt.toISOString(), "2026-01-10T10:00:00.000Z");
  assert.equal(s.lastOrderAt.toISOString(), "2026-03-01T10:00:00.000Z");
  assert.deepEqual(s.categories, [
    { name: "Ноутбуки", count: 3 },
    { name: "Монітори", count: 1 },
  ]);

  const empty = stats.computeStats([]);
  assert.deepEqual(empty, { orders: 0, paidOrders: 0, ltv: 0, avgOrder: 0, firstOrderAt: undefined, lastOrderAt: undefined, categories: [] });
  // невідомий id категорії без назви — відкидається; назва-рядок лишається як є
  const s2 = stats.computeStats([{ price: 10, payment_status: "paid", delivery_status: "delivered", products: [{ category: cat1 }, { category: "Кабелі" }] }]);
  assert.deepEqual(s2.categories, [{ name: "Кабелі", count: 1 }]);
  assert.equal(stats.orderValue({ price: 100, refunded_total: 150 }), 0);
  assert.equal(stats.orderDate({ date: "не дата" }), null);
});

// ---------------- лист підтвердження

test("лист підтвердження: посилання на фронт, валідний токен, тексти", () =>
  withEnv({ PUBLIC_FRONT_URL: "https://shop.example.ua/" }, () => {
    const id = "64b7f0c2a1b2c3d4e5f60718";
    const link = mail.confirmLink(id);
    assert.match(link, /^https:\/\/shop\.example\.ua\/subscribe\/confirm\?t=/);
    const t = decodeURIComponent(new URL(link).searchParams.get("t"));
    assert.deepEqual(tokens.verify(t, "confirm").contactId, id);
    assert.equal(tokens.verify(t, "unsub").ok, false);
    const m = mail.confirmMail({ link, brand: "TechScout" });
    assert.match(m.subject, /Підтвердіть підписку/);
    assert.ok(m.text.includes(link));
    assert.match(m.text, /7 днів/);
    const pl = mail.preferencesLink(id);
    assert.match(pl, /\/preferences\?t=/);
    const a = mail.alreadyMail({ link: pl, brand: "TechScout" });
    assert.match(a.subject, /вже підписані/);
    assert.ok(a.text.includes(pl));
  }));

// ---------------- смоук роутів (без БД)

test("роути підписки й вебхуків: валідація, ліміти, підписи (без БД)", async () => {
  const mongoose = require("mongoose");
  mongoose.set("bufferCommands", false); // без з'єднання запити до БД падають одразу, а не чекають 10 с
  const express = require("express");
  const bodyParser = require("body-parser");
  const cookieParser = require("cookie-parser");
  const app = express();
  app.use(bodyParser.json({ verify: (req, _res, buf) => (req.rawBody = buf) })); // як у server.js
  app.use(cookieParser());
  app.use("/api", require("../routes/home/subscriptionRoutes"));
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (p, body, headers = {}) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  try {
    let res = await post("/home/subscribe", { email: "a@b.ua", consent: true, website: "http://spam" });
    assert.equal(res.status, 200, "honeypot — тихо 200");
    assert.equal((await res.json()).ok, true);
    res = await post("/home/subscribe", { email: "not-an-email", consent: true });
    assert.equal(res.status, 400);
    res = await post("/home/subscribe", { email: "a@b.ua" });
    assert.equal(res.status, 400, "без згоди");
    res = await post("/home/subscribe", { email: "x", consent: true });
    res = await post("/home/subscribe", { email: "x", consent: true });
    assert.equal(res.status, 400, "5-й запит ще проходить");
    res = await post("/home/subscribe", { email: "x", consent: true });
    assert.equal(res.status, 429, "6-й запит з IP за годину");

    res = await post("/home/subscribe/confirm", { t: "bad" });
    assert.equal(res.status, 400);
    const expired = tokens.sign("confirm", "64b7f0c2a1b2c3d4e5f60718", { now: Date.now() - 8 * 24 * 3600 * 1000 });
    res = await post("/home/subscribe/confirm", { t: expired });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Строк дії/);

    res = await fetch(`${base}/home/preferences?t=bad`);
    assert.equal(res.status, 400);
    res = await fetch(`${base}/home/unsubscribe?t=bad`);
    assert.equal(res.status, 400);
    res = await fetch(`${base}/home/unsubscribe?t=bad`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    assert.equal(res.status, 400, "one-click (form) з недійсним токеном");

    const TARGET = "https://shop.ua/x?a=1";
    const click = tokens.signClick({ messageId: "64b7f0c2a1b2c3d4e5f60718", url: TARGET });
    res = await fetch(`${base}/r/${click}?u=${encodeURIComponent("javascript:alert(1)")}`, { redirect: "manual" });
    assert.equal(res.status, 400, "лише http/https");
    res = await fetch(`${base}/r/${click}?u=${encodeURIComponent("https://evil.example/phish")}`, { redirect: "manual" });
    assert.equal(res.status, 400, "open-redirect: url не збігається з підписаним");
    const jsTok = tokens.signClick({ messageId: "64b7f0c2a1b2c3d4e5f60718", url: "javascript:alert(1)" });
    res = await fetch(`${base}/r/${jsTok}?u=${encodeURIComponent("javascript:alert(1)")}`, { redirect: "manual" });
    assert.equal(res.status, 400, "навіть підписаний не-http url — 400");
    res = await fetch(`${base}/r/bad?u=${encodeURIComponent("https://shop.ua/")}`, { redirect: "manual" });
    assert.equal(res.status, 400, "недійсний токен — без редіректу");
    res = await fetch(`${base}/r/${click}?u=${encodeURIComponent(TARGET)}`, { redirect: "manual" });
    assert.equal(res.status, 302, "облік кліку може впасти (немає БД), редірект — ні");
    assert.equal(res.headers.get("location"), "https://shop.ua/x?a=1");

    res = await fetch(`${base}/home/marketing-config`);
    assert.equal(res.status, 200);
    const cfg = await res.json();
    assert.ok(cfg.consentText.footer && cfg.consentText.version);
    assert.ok(!("telegramBot" in cfg) || cfg.telegramBot === null || typeof cfg.telegramBot === "string");

    res = await fetch(`${base}/home/customer/subscriptions`);
    assert.equal(res.status, 409, "вимагає входу");

    // --- Resend
    await withEnv({ RESEND_WEBHOOK_SECRET: undefined }, async () => {
      res = await post("/webhooks/resend", { type: "email.delivered" });
      assert.equal(res.status, 503);
    });
    await withEnv({ RESEND_WEBHOOK_SECRET: WHSEC }, async () => {
      const body = JSON.stringify({ type: "email.delivered", data: { to: ["a@b.ua"] } });
      const ts = String(Math.floor(Date.now() / 1000));
      const id = "msg_" + crypto.randomUUID();
      const h = { "svix-id": id, "svix-timestamp": ts, "svix-signature": svixHeader(id, ts, body) };
      res = await post("/webhooks/resend", body, h);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).result, "ignored");
      res = await post("/webhooks/resend", body, h);
      assert.equal((await res.json()).duplicate, true, "повтор svix-id");
      res = await post("/webhooks/resend", body, { ...h, "svix-id": "msg_other" });
      assert.equal(res.status, 401, "підпис від іншого id");
      res = await post("/webhooks/resend", body, { "svix-id": "z" });
      assert.equal(res.status, 400);
      // не-JSON Content-Type: сире тіло читає express.raw на маршруті
      const id2 = "msg_" + crypto.randomUUID();
      res = await fetch(base + "/webhooks/resend", {
        method: "POST",
        headers: { "content-type": "text/plain", "svix-id": id2, "svix-timestamp": ts, "svix-signature": svixHeader(id2, ts, body) },
        body,
      });
      assert.equal(res.status, 200);
    });

    // --- Telegram
    await withEnv({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_WEBHOOK_SECRET: "s3cret" }, async () => {
      res = await post("/webhooks/telegram", {});
      assert.equal(res.status, 503);
    });
    await withEnv({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: "s3cret" }, async () => {
      res = await post("/webhooks/telegram", {}, { "x-telegram-bot-api-secret-token": "wrong" });
      assert.equal(res.status, 401);
      res = await post("/webhooks/telegram", { update_id: 1 }, { "x-telegram-bot-api-secret-token": "s3cret" });
      assert.equal(res.status, 200);
    });
  } finally {
    server.close();
    mongoose.set("bufferCommands", true);
  }
});
