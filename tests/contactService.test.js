// CRM-контакти: чисті функції (без БД)
const test = require("node:test");
const assert = require("node:assert/strict");
const cs = require("../utiles/contactService");

test("normalizeEmail", () => {
  const ok = [
    ["ivan@example.com", "ivan@example.com"],
    ["  Ivan.Petrenko@Example.COM ", "ivan.petrenko@example.com"],
    ["a+tag@sub.domain.ua", "a+tag@sub.domain.ua"],
    ["o'neil@mail.co.uk", "o'neil@mail.co.uk"],
    ["x_y-z@my-shop.com.ua", "x_y-z@my-shop.com.ua"],
  ];
  for (const [i, o] of ok) assert.equal(cs.normalizeEmail(i), o, i);
  const bad = [
    "",
    "   ",
    "ivan",
    "ivan@",
    "@example.com",
    "ivan@example",
    "iv an@example.com",
    "ivan@@example.com",
    "ivan..p@example.com",
    ".ivan@example.com",
    "ivan@-example.com",
    "ivan@example..com",
    "іван@приклад.укр",
    "a".repeat(65) + "@example.com",
    "a@" + "b".repeat(250) + ".com",
    null,
    undefined,
    42,
    { email: "a@b.cc" },
  ];
  for (const b of bad) assert.equal(cs.normalizeEmail(b), "", String(b));
});

test("normalizePhone → E.164 UA", () => {
  const ok = [
    ["0671234567", "+380671234567"],
    ["067 123 45 67", "+380671234567"],
    ["(067) 123-45-67", "+380671234567"],
    ["380671234567", "+380671234567"],
    ["+380671234567", "+380671234567"],
    ["+38 (050) 123 45 67", "+380501234567"],
    ["+380 93.123.45.67", "+380931234567"],
    ["80671234567", "+380671234567"],
    ["00380671234567", "+380671234567"],
    [" 0 9 9 1 2 3 4 5 6 7 ", "+380991234567"],
  ];
  for (const [i, o] of ok) assert.equal(cs.normalizePhone(i), o, i);
  const bad = [
    "",
    "067123456", // 9 цифр
    "06712345678", // 11 цифр
    "+48123456789", // Польща
    "+3800671234567",
    "0071234567x",
    "067-123-45-67 ext 1",
    "38+0671234567",
    "+380071234567", // код оператора з 0
    "abc",
    null,
    undefined,
  ];
  for (const b of bad) assert.equal(cs.normalizePhone(b), "", String(b));
});

test("maskEmail і emailHash", () => {
  assert.equal(cs.maskEmail("ivan@example.com"), "i***@example.com");
  assert.equal(cs.maskEmail(" A@x.ua"), "a***@x.ua");
  assert.equal(cs.maskEmail("bad"), "");
  const h = cs.emailHash(" Ivan@Example.com ");
  assert.match(h, /^[a-f0-9]{64}$/);
  assert.equal(h, cs.emailHash("ivan@example.com"));
  assert.notEqual(h, cs.emailHash("ivan2@example.com"));
  assert.equal(cs.emailHash("nope"), "");
});

test("defaultTopics і applyTopics", () => {
  assert.deepEqual(cs.defaultTopics(), { promo: true, news: true, restock: true, tips: false });
  const a = cs.defaultTopics();
  a.promo = false;
  assert.equal(cs.defaultTopics().promo, true, "нова копія щоразу");
  assert.deepEqual(cs.applyTopics(cs.defaultTopics(), { tips: true, promo: false }), {
    promo: false,
    news: true,
    restock: true,
    tips: true,
  });
  // невідомі ключі й не-булеві значення ігноруються
  assert.deepEqual(cs.applyTopics({ promo: true }, { hack: true, news: "yes", restock: 1, $set: {} }), {
    promo: true,
    news: false,
    restock: false,
    tips: false,
  });
  assert.deepEqual(cs.applyTopics(undefined, null), { promo: false, news: false, restock: false, tips: false });
});

test("mergeStatus: строгіший перемагає", () => {
  const order = ["none", "cleaned", "pending", "subscribed", "unsubscribed", "bounced", "complained"];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      assert.equal(cs.mergeStatus(order[i], order[j]), order[Math.max(i, j)], `${order[i]}+${order[j]}`);
    }
  }
  assert.equal(cs.mergeStatus("garbage", "subscribed"), "subscribed");
  assert.equal(cs.mergeStatus("pending", undefined), "pending");
  assert.equal(cs.mergeStatus(undefined, undefined), "none");
});

test("isSuppressedStatus", () => {
  for (const s of ["unsubscribed", "bounced", "complained", "blocked"]) assert.equal(cs.isSuppressedStatus(s), true, s);
  for (const s of ["none", "pending", "subscribed", "cleaned", undefined]) assert.equal(cs.isSuppressedStatus(s), false, s);
});

test("canEmail / canTelegram", () => {
  const c = (status, topics = cs.defaultTopics(), extra = {}) => ({
    email: "a@b.ua",
    channels: { email: { status, topics }, telegram: { status, topics, chatId: "123" } },
    ...extra,
  });
  assert.equal(cs.canEmail(c("subscribed"), "promo"), true);
  assert.equal(cs.canEmail(c("subscribed"), "tips"), false);
  assert.equal(cs.canEmail(c("subscribed")), true);
  assert.equal(cs.canEmail(c("subscribed", { promo: false, news: false, restock: false, tips: false })), false);
  for (const s of ["pending", "unsubscribed", "bounced", "complained", "none", "cleaned"]) {
    assert.equal(cs.canEmail(c(s), "promo"), false, s);
  }
  assert.equal(cs.canEmail(c("subscribed", undefined, { email: "" }), "promo"), false);
  assert.equal(cs.canEmail(c("subscribed", undefined, { anonymized: true }), "promo"), false);
  assert.equal(cs.canEmail(null, "promo"), false);
  assert.equal(cs.canEmail({ email: "a@b.ua" }, "promo"), false);

  assert.equal(cs.canTelegram(c("subscribed"), "news"), true);
  assert.equal(cs.canTelegram(c("blocked"), "news"), false);
  const noChat = c("subscribed");
  noChat.channels.telegram.chatId = "";
  assert.equal(cs.canTelegram(noChat, "news"), false);
});

test("frequencyAllowed і pushSentLog", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const day = 24 * 3600 * 1000;
  const contact = { marketingSentLog: [{ at: new Date(now - 8 * day) }, { at: new Date(now - 6 * day) }] };
  assert.equal(cs.frequencyAllowed(contact, { max: 2, days: 7 }, now), true);
  cs.pushSentLog(contact, { at: new Date(now - day), channel: "telegram" });
  assert.equal(cs.frequencyAllowed(contact, { max: 2, days: 7 }, now), false);
  assert.equal(cs.frequencyAllowed(contact, { max: 3, days: 7 }, now), true);
  assert.equal(cs.frequencyAllowed(contact, { max: 2, days: 5 }, now), true);
  assert.equal(cs.frequencyAllowed(contact, { max: 2, days: 7 }, new Date(now)), false);
  assert.equal(cs.frequencyAllowed({}, { max: 1, days: 7 }, now), true);
  assert.equal(cs.frequencyAllowed({ marketingSentLog: [{ at: "bad" }] }, { max: 1, days: 7 }, now), true);

  const big = { marketingSentLog: [] };
  for (let i = 0; i < 40; i++) cs.pushSentLog(big, { at: new Date(now - (40 - i) * 1000), campaignId: "c" + i });
  assert.equal(big.marketingSentLog.length, 30);
  assert.equal(big.marketingSentLog.at(-1).campaignId, "c39");
  assert.equal(big.marketingSentLog[0].campaignId, "c10");
  const e = cs.pushSentLog({}, {}).at(-1);
  assert.equal(e.channel, "email");
  assert.equal(e.campaignId, null);
  assert.equal(e.automation, null);
  assert.ok(e.at instanceof Date);
});

test("kindOfCustomer", () => {
  assert.equal(cs.kindOfCustomer({}), "unknown");
  assert.equal(cs.kindOfCustomer({ kind: "person" }), "person");
  assert.equal(cs.kindOfCustomer({ savedCompanies: [{ companyName: "ТОВ" }] }), "company");
  assert.equal(cs.kindOfCustomer({ kind: "alien" }), "unknown");
});
