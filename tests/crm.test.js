// CRM/розсилки: чисті помічники контролерів + смоук маршрутів без БД
const test = require("node:test");
const assert = require("node:assert/strict");
const crm = require("../controllers/crmController")._pure;
const camp = require("../controllers/campaignController")._pure;

test("contactListQuery: білий список фільтрів, екранування пошуку", () => {
  assert.deepEqual(crm.contactListQuery({}), { anonymized: { $ne: true } });
  const q = crm.contactListQuery({ q: "a.b(", status: "subscribed", topic: "promo", kind: "company", tag: " VIP ", rfm: "champions", source: "import", telegram: "blocked", city: "Київ" });
  const parts = q.$and;
  assert.ok(parts.some((p) => p.$or && p.$or[0].email.$regex === "a\\.b\\("));
  assert.ok(parts.some((p) => p["channels.email.status"] === "subscribed"));
  assert.ok(parts.some((p) => p["channels.email.topics.promo"] === true));
  assert.ok(parts.some((p) => p.tags === "vip"));
  assert.ok(parts.some((p) => p["stats.rfm.segment"] === "champions"));
  assert.ok(parts.some((p) => p["channels.telegram.status"] === "blocked"));
  // невідомі значення ігноруються; об'єкти ($ne) не проходять
  const junk = crm.contactListQuery({ status: { $ne: "x" }, kind: "alien", topic: "$where", source: "a b", rfm: "x" });
  assert.deepEqual(junk, { anonymized: { $ne: true } });
  assert.deepEqual(crm.sortOf("ltv"), { "stats.ltv": -1, createdAt: -1 });
  assert.deepEqual(crm.sortOf("$natural"), { createdAt: -1 });
  assert.deepEqual(crm.pageArgs({ page: "3", limit: "1000" }), { page: 3, limit: 100, skip: 200 });
});

test("prepareImportRows: валідація, дедуп, kind/теги", () => {
  const { ok, invalid } = crm.prepareImportRows([
    { row: 2, data: { email: " Ivan@Shop.UA ", name: "Іван", kind: "Юрособа", tags: "VIP; опт" } },
    { row: 3, data: { email: "ivan@shop.ua" } },
    { row: 4, data: { email: "bad@" } },
    { row: 5, data: { phone: "067 123 45 67", city: "Львів" } },
    { row: 6, data: { phone: "123" } },
    { row: 7, data: {} },
  ]);
  assert.equal(ok.length, 2);
  assert.deepEqual(ok[0], { row: 2, email: "ivan@shop.ua", phone: "", name: "Іван", city: "", kind: "company", tags: ["vip", "опт"] });
  assert.equal(ok[1].phone, "+380671234567");
  assert.deepEqual(
    invalid.map((x) => x.row),
    [3, 4, 6, 7]
  );
  assert.match(invalid[0].reason, /Дублікат/);
});

test("exportRow: без id/токенів/chatId", () => {
  const row = crm.exportRow({
    _id: "65f1c0ffee0000000000abcd",
    customerId: "65f1c0ffee0000000000abce",
    email: "a@b.ua",
    tags: ["vip"],
    channels: { email: { status: "subscribed", topics: { promo: true, tips: false } }, telegram: { status: "subscribed", chatId: "999111", username: "ivan" } },
    stats: { orders: 2, ltv: 5000, rfm: { segment: "loyal" } },
  });
  assert.equal(row.length, crm.EXPORT_HEADERS.length);
  const s = row.join("|");
  assert.ok(!s.includes("65f1c0ffee") && !s.includes("999111"));
  assert.ok(s.includes("subscribed") && s.includes("promo") && s.includes("loyal"));
  for (const h of crm.EXPORT_HEADERS) assert.ok(!/id$|token|password|chat/i.test(h), h);
});

test("healthWarnings", () => {
  const w = crm.healthWarnings({ resendConfigured: false, marketingFromConfigured: false, webhookConfigured: false, complaintRate7d: 0.004, bounceRate7d: 0, sentToday: 100, dailyLimit: 100 });
  assert.equal(w.length, 5);
  assert.deepEqual(crm.healthWarnings({ resendConfigured: true, marketingFromConfigured: true, webhookConfigured: true, complaintRate7d: 0.001, bounceRate7d: 0.01, sentToday: 1, dailyLimit: 100 }), []);
});

test("кампанія: нормалізація, блокування відправки, розклад, ключі посилань", () => {
  const { value, errors } = camp.normalizeCampaignInput({ name: " Літо ", subject: "Тема", blocks: [{ type: "text", text: "x" }, { type: "evil" }], topic: "promo", channels: ["email", "sms", "email"], filter: { match: "all", rules: [] } });
  assert.deepEqual(errors, []);
  assert.equal(value.name, "Літо");
  assert.equal(value.blocks.length, 1);
  assert.deepEqual(value.channels, ["email"]);
  assert.equal(value.segmentId, null);
  assert.ok(camp.normalizeCampaignInput({}).errors.length);
  assert.ok(camp.normalizeCampaignInput({ name: "x", filter: { rules: [{ field: "$where", op: "is", value: 1 }] } }).errors.length);
  assert.deepEqual(Object.keys(camp.normalizeCampaignInput({ subject: "s" }, { partial: true }).value), ["subject"]);

  const good = { channels: ["email"], subject: "Тема", blocks: [{ type: "text", text: "x" }], filter: { match: "all", rules: [] } };
  const opts = { emailConfigured: true, tgConfigured: false, estimate: { eligible: 10 } };
  assert.equal(camp.sendBlockers(good, opts), null);
  assert.match(camp.sendBlockers({ ...good, subject: " " }, opts).error, /тему/);
  assert.match(camp.sendBlockers({ ...good, blocks: [] }, opts).error, /зміст/);
  assert.match(camp.sendBlockers({ ...good, filter: null }, opts).error, /сегмент/);
  const nc = camp.sendBlockers(good, { ...opts, emailConfigured: false, emailHint: "MARKETING_MAIL_FROM" });
  assert.match(nc.error, /не налаштована/);
  assert.equal(nc.hint, "MARKETING_MAIL_FROM");
  const zero = camp.sendBlockers(good, { ...opts, estimate: { eligible: 0 } });
  assert.match(zero.error, /отримувача/);
  assert.ok(zero.hint);
  assert.match(camp.sendBlockers({ ...good, channels: ["telegram"], telegramText: "x" }, opts).error, /Telegram/);

  const now = Date.parse("2026-06-01T10:00:00Z");
  assert.equal(camp.parseSchedule("", now).at.getTime(), now);
  assert.ok(camp.parseSchedule("2026-06-02T10:00:00Z", now).at);
  assert.match(camp.parseSchedule("2026-05-01T00:00:00Z", now).error, /минулому/);
  assert.match(camp.parseSchedule("2027-01-01T00:00:00Z", now).error, /90/);
  assert.match(camp.parseSchedule("nope", now).error, /Некоректна/);

  // формат ключів лічильника кліків: encodeURIComponent(url) з «.» → %2E
  const url = "https://shop.ua/a.b?x=1&y=$z";
  const key = encodeURIComponent(url).replace(/\./g, "%2E");
  assert.ok(!key.includes(".") && !key.startsWith("$"));
  assert.equal(camp.decodeLinkKey(key), url);
  assert.equal(camp.decodeLinkKey("%E0%A4%A"), "%E0%A4%A", "биті ключі — як є");
  assert.deepEqual(camp.topLinksFrom([{ k: key, n: 2 }, { k: encodeURIComponent(url), n: 3 }, { k: "https%3A%2F%2Fo", n: 1 }]), [
    { url, clicks: 5 },
    { url: "https://o", clicks: 1 },
  ]);
});

// Смоук маршрутів без БД: усе під /api/admin/crm вимагає входу; статичні шляхи — до `/:id`
test("маршрути CRM: смоук без БД", async () => {
  const express = require("express");
  const cookieParser = require("cookie-parser");
  const jwt = require("jsonwebtoken");
  const router = require("../routes/crmRoutes");
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", router);
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/admin/crm`;
  try {
    for (const [m, p] of [
      ["GET", "/contacts"],
      ["GET", "/contacts/export.csv"],
      ["POST", "/contacts/import"],
      ["POST", "/contacts/bulk"],
      ["GET", "/contacts/65f1c0ffee0000000000abcd"],
      ["DELETE", "/contacts/65f1c0ffee0000000000abcd"],
      ["GET", "/tags"],
      ["GET", "/segments"],
      ["POST", "/segments/preview"],
      ["GET", "/campaigns"],
      ["POST", "/campaigns/65f1c0ffee0000000000abcd/send"],
      ["GET", "/campaigns/65f1c0ffee0000000000abcd/report"],
      ["GET", "/automations"],
      ["GET", "/automations/stats"],
      ["GET", "/settings"],
      ["GET", "/health"],
      ["GET", "/analytics"],
      ["POST", "/rfm/recompute"],
      ["GET", "/product-search"],
    ]) {
      const res = await fetch(base + p, { method: m });
      assert.equal(res.status, 409, `${m} ${p} вимагає входу`);
    }
    // продавець — 403
    const seller = jwt.sign({ id: "65f1c0ffee0000000000abcd", role: "seller" }, process.env.SECRET || "dev-secret-for-tests");
    const admin = jwt.sign({ id: "65f1c0ffee0000000000abcd", role: "admin" }, process.env.SECRET || "dev-secret-for-tests");
    const old = process.env.SECRET;
    process.env.SECRET = process.env.SECRET || "dev-secret-for-tests";
    try {
      let res = await fetch(`${base}/contacts`, { headers: { cookie: `accessToken=${seller}` } });
      assert.equal(res.status, 403);
      // адмін: валідація без звернення до БД
      const h = { cookie: `accessToken=${admin}`, "content-type": "application/json" };
      res = await fetch(`${base}/contacts/not-an-id`, { headers: h });
      assert.equal(res.status, 400);
      res = await fetch(`${base}/campaigns/not-an-id/send`, { method: "POST", headers: h, body: "{}" });
      assert.equal(res.status, 400);
      res = await fetch(`${base}/segments/preview`, { method: "POST", headers: h, body: JSON.stringify({ filter: { $where: "1" } }) });
      assert.equal(res.status, 400);
      res = await fetch(`${base}/contacts/bulk`, { method: "POST", headers: h, body: JSON.stringify({ action: "drop" }) });
      assert.equal(res.status, 400);
      res = await fetch(`${base}/contacts/65f1c0ffee0000000000abcd/status`, { method: "PUT", headers: h, body: JSON.stringify({ channel: "email", status: "subscribed" }) });
      assert.equal(res.status, 400, "subscribed без reason");
      res = await fetch(`${base}/contacts`, { method: "POST", headers: h, body: JSON.stringify({ email: "a@b.ua", consent: { proof: true } }) });
      assert.equal(res.status, 400, "proof без note");
    } finally {
      if (old === undefined) delete process.env.SECRET;
      else process.env.SECRET = old;
    }
    const stack = router.stack.map((l) => l.route && `${Object.keys(l.route.methods)[0]} ${l.route.path}`).filter(Boolean);
    const idx = (s) => stack.indexOf(s);
    const P = "/admin/crm";
    for (const s of [`get ${P}/contacts/export.csv`, `post ${P}/contacts/import`, `post ${P}/contacts/merge`, `post ${P}/contacts/bulk`]) {
      assert.ok(idx(s) >= 0, s);
    }
    assert.ok(idx(`get ${P}/contacts/export.csv`) < idx(`get ${P}/contacts/:id`));
    assert.ok(idx(`post ${P}/segments/preview`) < idx(`put ${P}/segments/:id`));
    assert.ok(idx(`get ${P}/automations/stats`) >= 0);
    assert.ok(idx(`get ${P}/campaigns/:id/report`) < idx(`get ${P}/campaigns/:id`));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
