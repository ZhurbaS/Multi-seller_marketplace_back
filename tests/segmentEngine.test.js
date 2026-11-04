// Рушій сегментів: валідація за білим списком, захист від ін'єкцій, генерація запитів Mongo
const test = require("node:test");
const assert = require("node:assert/strict");
const se = require("../utiles/segmentEngine");

const NOW = Date.parse("2026-06-01T00:00:00Z");
const DAY = 86400000;
const q = (rules, match = "all") => se.toMongoQuery({ match, rules }, { now: NOW });
const BASE = { anonymized: { $ne: true } };

test("validate: порожній/null — усі контакти", () => {
  assert.deepEqual(se.validate(null).value, { match: "all", rules: [] });
  assert.deepEqual(se.toMongoQuery(null), BASE);
  assert.deepEqual(se.toMongoQuery({ match: "any", rules: [] }), BASE);
});

test("validate: відмова на невідомі поля, оператори, значення", () => {
  const bad = (f) => assert.equal(se.validate(f).ok, false, JSON.stringify(f));
  bad({ match: "all", rules: [{ field: "password", op: "is", value: "x" }] });
  bad({ match: "all", rules: [{ field: "email", op: "is", value: "x" }] });
  bad({ match: "all", rules: [{ field: "constructor", op: "is", value: "x" }] });
  bad({ match: "all", rules: [{ field: "__proto__", op: "is", value: "x" }] });
  bad({ match: "all", rules: [{ field: "kind", op: "contains", value: "person" }] });
  bad({ match: "all", rules: [{ field: "kind", op: "is", value: "alien" }] });
  bad({ match: "all", rules: [{ field: "stats.orders", op: "gte", value: -1 }] });
  bad({ match: "all", rules: [{ field: "stats.orders", op: "gte", value: "1e3" }] });
  bad({ match: "all", rules: [{ field: "isCustomer", op: "is", value: "maybe" }] });
  bad({ match: "all", rules: [{ field: "city", op: "is", value: "" }] });
  bad({ match: "all", rules: [{ field: "city", op: "is", value: "x".repeat(101) }] });
  bad({ match: "some", rules: [] });
  bad({ match: "all", rules: "x" });
  bad({ match: "all", rules: [], extra: 1 });
  bad({ match: "all", rules: [{ field: "kind", op: "is", value: "person", path: "x" }] });
  bad({ match: "all", rules: Array.from({ length: 31 }, () => ({ field: "kind", op: "is", value: "person" })) });
  bad("string");
  bad([]);
  assert.throws(() => se.toMongoQuery({ rules: [{ field: "x", op: "is", value: 1 }] }), (e) => e.code === "INVALID_FILTER" && e.status === 400);
});

test("ін'єкції: $where/$ne/$regex як значення чи ключ відхиляються", () => {
  const bad = (f) => assert.equal(se.validate(f).ok, false, JSON.stringify(f));
  bad({ $where: "sleep(1000)" });
  bad({ match: "all", rules: [{ field: "$where", op: "is", value: "1" }] });
  bad({ match: "all", rules: [{ field: "city", op: "is", value: { $ne: null } }] });
  bad({ match: "all", rules: [{ field: "tags", op: "has", value: { $regex: ".*" } }] });
  bad({ match: "all", rules: [{ field: "stats.ltv", op: "gte", value: { $gt: 0 } }] });
  bad({ match: "all", rules: [{ field: "city", op: "$where", value: "x" }] });
  bad({ match: "all", rules: [{ field: "channel.email.status", op: "is", value: ["subscribed"] }] });
  // спецсимволи регулярних виразів екрануються
  const r = q([{ field: "city", op: "contains", value: "a.*(" }]);
  assert.deepEqual(r.$and[1], { city: { $regex: "a\\.\\*\\(", $options: "i" } });
  assert.ok(!JSON.stringify(q([{ field: "source", op: "is", value: "$where" }])).includes('"$where":'));
});

test("генерація запитів", () => {
  assert.deepEqual(q([{ field: "channel.email.status", op: "is", value: "subscribed" }]), { $and: [BASE, { "channels.email.status": "subscribed" }] });
  assert.deepEqual(q([{ field: "channel.email.status", op: "isNot", value: "bounced" }]).$and[1], { "channels.email.status": { $ne: "bounced" } });
  assert.deepEqual(q([{ field: "topic", op: "has", value: "promo" }]).$and[1], { "channels.email.topics.promo": true });
  assert.deepEqual(q([{ field: "tags", op: "has", value: " VIP " }]).$and[1], { tags: "vip" });
  assert.deepEqual(q([{ field: "tags", op: "notHas", value: "vip" }]).$and[1], { tags: { $ne: "vip" } });
  assert.deepEqual(q([{ field: "city", op: "is", value: "Київ" }]).$and[1], { city: { $regex: "^Київ$", $options: "i" } });
  assert.deepEqual(q([{ field: "isCustomer", op: "is", value: true }]).$and[1], { customerId: { $ne: null } });
  assert.deepEqual(q([{ field: "isCustomer", op: "is", value: "false" }]).$and[1], { customerId: null });
  assert.deepEqual(q([{ field: "stats.orders", op: "gte", value: "2" }]).$and[1], { "stats.orders": { $gte: 2 } });
  assert.deepEqual(q([{ field: "stats.orders", op: "eq", value: 0 }]).$and[1], { "stats.orders": 0 });
  assert.deepEqual(q([{ field: "stats.ltv", op: "lte", value: 1000 }]).$and[1], { "stats.ltv": { $lte: 1000 } });
  assert.deepEqual(q([{ field: "stats.lastOrderAt", op: "daysAgoGte", value: 180 }]).$and[1], { "stats.lastOrderAt": { $lte: new Date(NOW - 180 * DAY) } });
  assert.deepEqual(q([{ field: "createdAt", op: "daysAgoLte", value: 30 }]).$and[1], { createdAt: { $gte: new Date(NOW - 30 * DAY) } });
  assert.deepEqual(q([{ field: "rfm.segment", op: "is", value: "champions" }]).$and[1], { "stats.rfm.segment": "champions" });
  assert.deepEqual(q([{ field: "stats.categories", op: "has", value: "Ноутбуки" }]).$and[1], { "stats.categories.name": { $regex: "^Ноутбуки$", $options: "i" } });
  assert.ok(q([{ field: "hasTelegram", op: "is", value: true }]).$and[1]["channels.telegram.chatId"].$exists);
  const any = q([{ field: "kind", op: "is", value: "company" }, { field: "source", op: "is", value: "import" }], "any");
  assert.deepEqual(any, { $and: [BASE, { $or: [{ kind: "company" }, { source: "import" }] }] });
});

test("системні сегменти валідні, describe і каталог полів", () => {
  assert.equal(se.SYSTEM_SEGMENTS.length, 9);
  for (const s of se.SYSTEM_SEGMENTS) {
    assert.equal(se.validate(s.filter).ok, true, s.name);
    assert.ok(s.systemKey && s.description);
  }
  assert.equal(se.describe(null), "Усі контакти");
  assert.match(se.describe({ match: "any", rules: [{ field: "kind", op: "is", value: "company" }, { field: "stats.orders", op: "gte", value: 1 }] }), /юрособа АБО/);
  const cat = se.fieldCatalog();
  assert.ok(cat.find((f) => f.field === "channel.email.status").values.length >= 5);
});
