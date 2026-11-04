// Регресійні тести за результатами рецензії модуля підписок/розсилок (без БД і мережі: фейкові моделі).
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SECRET = process.env.SECRET || "test-secret";

const tokens = require("../utiles/marketingTokens");
const cs = require("../utiles/contactService");
const w = require("../utiles/marketingWorker");

const CID = "64b7f0c2a1b2c3d4e5f60718";
const CAMP = "64b7f0c2a1b2c3d4e5f60799";
const DAY = 86400000;

// ---------- мінімальна in-memory «колекція» Mongo ----------
const getPath = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
const setPath = (o, p, v) => {
  const ks = p.split(".");
  let x = o;
  for (const k of ks.slice(0, -1)) x = x[k] ??= {};
  if (v === undefined) delete x[ks.at(-1)];
  else x[ks.at(-1)] = v;
};
const eq = (a, b) => (a instanceof Date || b instanceof Date ? +a === +b : a == null || b == null ? a == b : String(a) === String(b));
const isOps = (c) => c && typeof c === "object" && !(c instanceof Date) && !Array.isArray(c) && Object.keys(c).some((k) => k.startsWith("$"));
function matches(doc, q = {}) {
  return Object.entries(q).every(([k, c]) => {
    if (k === "$and") return c.every((x) => matches(doc, x));
    if (k === "$or") return c.some((x) => matches(doc, x));
    const v = getPath(doc, k);
    if (!isOps(c)) return eq(v, c);
    return Object.entries(c).every(([op, a]) => {
      switch (op) {
        case "$in":
          return a.some((x) => eq(v, x));
        case "$ne":
          return !eq(v, a);
        case "$exists":
          return a ? v !== undefined : v === undefined;
        case "$lt":
          return v != null && v < a;
        case "$lte":
          return v != null && v <= a;
        case "$gt":
          return v != null && v > a;
        case "$gte":
          return v != null && v >= a;
        default:
          throw new Error(`op ${op} не підтримано`);
      }
    });
  });
}
function applyUpdate(doc, u) {
  for (const [k, v] of Object.entries(u.$set || {})) setPath(doc, k, v);
  for (const k of Object.keys(u.$unset || {})) setPath(doc, k, undefined);
  for (const [k, v] of Object.entries(u.$inc || {})) setPath(doc, k, (getPath(doc, k) || 0) + v);
}
const clone = (d) => structuredClone(d);
function fakeModel(docs = []) {
  const rows = docs;
  const sortRows = (list, sort) => {
    if (!sort) return list;
    const [[k, dir]] = Object.entries(sort);
    return [...list].sort((a, b) => (getPath(a, k) > getPath(b, k) ? dir : getPath(a, k) < getPath(b, k) ? -dir : 0));
  };
  const query = (list) => {
    let out = list;
    const q = {
      sort: (s) => ((out = sortRows(out, s)), q),
      limit: (n) => ((out = out.slice(0, n)), q),
      select: () => q,
      lean: () => q,
      then: (res, rej) => Promise.resolve(out.map(clone)).then(res, rej),
    };
    return q;
  };
  return {
    rows,
    find: (q) => query(rows.filter((d) => matches(d, q))),
    updateMany: async (q, u) => {
      const hit = rows.filter((d) => matches(d, q));
      hit.forEach((d) => applyUpdate(d, u));
      return { matchedCount: hit.length, modifiedCount: hit.length };
    },
    updateOne: async (q, u) => {
      const d = rows.find((x) => matches(x, q));
      if (d) applyUpdate(d, u);
      return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 };
    },
    findOneAndUpdate: async (q, u, opts = {}) => {
      const d = sortRows(rows.filter((x) => matches(x, q)), opts.sort)[0];
      if (!d) return null;
      const before = clone(d);
      applyUpdate(d, u);
      return opts.new ? clone(d) : before;
    },
  };
}
async function withModels(models, fn) {
  const prev = { ...w._models };
  Object.assign(w._models, Object.fromEntries(Object.entries(models).map(([k, v]) => [k, () => v])));
  try {
    return await fn();
  } finally {
    Object.assign(w._models, prev);
  }
}

// Фейковий документ Mongoose (get/set/save) для функцій contactService
function fakeDoc(data) {
  const d = { _id: CID, ...clone(data) };
  d.get = (p) => getPath(d, p);
  d.set = (p, v) => setPath(d, p, v);
  d.save = async () => d;
  return d;
}
async function withConsentStub(fn) {
  const ConsentLog = require("../models/consentLogModel");
  const orig = ConsentLog.create;
  const logs = [];
  ConsentLog.create = async (x) => (logs.push(x), x);
  try {
    return await fn(logs);
  } finally {
    ConsentLog.create = orig;
  }
}

// ======================= токени =======================

test("токен відписки несе необов'язковий campaignId (cid); підробка cid ламає підпис", () => {
  const t = tokens.sign("unsub", CID, { campaignId: CAMP });
  const v = tokens.verify(t, "unsub");
  assert.equal(v.ok, true);
  assert.equal(v.campaignId, CAMP);
  assert.equal(tokens.verify(tokens.sign("unsub", CID), "unsub").campaignId, null);
  assert.equal(tokens.verify(tokens.sign("unsub", CID, { campaignId: "not-an-id" }), "unsub").campaignId, null);
  // підміна k у payload без перепідпису
  const [body, sig] = t.split(".");
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  p.k = "64b7f0c2a1b2c3d4e5f60000";
  const forged = `${Buffer.from(JSON.stringify(p)).toString("base64url")}.${sig}`;
  assert.equal(tokens.verify(forged, "unsub").ok, false);
});

test("без SECRET у production токени не підписуються (раніше — ключ 'dev', підробка будь-якої відписки)", () => {
  const prev = { s: process.env.SECRET, n: process.env.NODE_ENV };
  try {
    delete process.env.SECRET;
    process.env.NODE_ENV = "production";
    assert.throws(() => tokens.sign("unsub", CID), /SECRET/);
    assert.throws(() => require("../utiles/telegramBot").signStart(CID), /SECRET/);
    process.env.NODE_ENV = "development";
    assert.ok(tokens.sign("unsub", CID));
  } finally {
    process.env.SECRET = prev.s;
    if (prev.n === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.n;
  }
});

test("лист кампанії: посилання відписки й List-Unsubscribe несуть cid; тест/прев'ю — ні", async () => {
  const tpl = require("../utiles/emailTemplate");
  const ctx = tpl.contextFromSettings({}, { front: "https://shop.ua" });
  const blocks = [{ type: "text", text: "Привіт" }];
  const sent = await tpl.buildEmail({ subject: "S", blocks, contactId: CID, messageId: CID, campaignId: CAMP, mode: "send" }, ctx);
  const tok = (u) => decodeURIComponent(new URL(u).searchParams.get("t"));
  assert.equal(tokens.verify(tok(sent.links.oneClick), "unsub").campaignId, CAMP);
  assert.equal(tokens.verify(tok(sent.links.unsubscribe), "unsub").campaignId, CAMP);
  assert.match(sent.html, /Реклама/);
  assert.match(sent.html, /Відписатися/);
  const prev = await tpl.buildEmail({ subject: "S", blocks, contactId: CID, campaignId: CAMP, mode: "test" }, ctx);
  assert.equal(tokens.verify(tok(prev.links.unsubscribe), "unsub").campaignId, null);
});

// ======================= згоди: «воскресіння» статусів =======================

test("canConfirmOptIn / canResubscribe", () => {
  const now = Date.now();
  assert.equal(cs.canConfirmOptIn({ status: "pending" }), true);
  for (const st of ["none", "cleaned", "bounced", "complained", "subscribed"]) assert.equal(cs.canConfirmOptIn({ status: st, pendingSince: new Date() }), false, st);
  assert.equal(cs.canConfirmOptIn({ status: "unsubscribed" }), false);
  assert.equal(cs.canConfirmOptIn({ status: "unsubscribed", pendingSince: new Date(now), unsubscribedAt: new Date(now - DAY) }), true);
  assert.equal(cs.canConfirmOptIn({ status: "unsubscribed", pendingSince: new Date(now - 2 * DAY), unsubscribedAt: new Date(now - DAY) }), false);
  assert.equal(cs.canResubscribe("unsubscribed"), true);
  for (const st of ["pending", "none", "cleaned", "bounced", "complained"]) assert.equal(cs.canResubscribe(st), false, st);
  assert.equal(cs.canResubscribe("bounced", ["bounced", "unsubscribed"]), false, "bounced — ніколи");
});

test("footer-запит не знімає bounced/complained і не «відмиває» відписку; confirm — лише після нового запиту", async () => {
  await withConsentStub(async (logs) => {
    for (const st of ["bounced", "complained"]) {
      const d = await cs.requestOptIn(fakeDoc({ email: "a@b.ua", channels: { email: { status: st } } }), { source: "footer" });
      assert.equal(d.get("channels.email.status"), st);
      const c = await cs.confirmOptIn(d);
      assert.equal(c.get("channels.email.status"), st, `${st} не підтверджується`);
    }
    assert.equal(logs.length, 0);

    // відписаний: запит лишає unsubscribed (до підтвердження), підтвердження → subscribed
    const u = fakeDoc({ email: "a@b.ua", channels: { email: { status: "unsubscribed", unsubscribedAt: new Date(Date.now() - DAY) } } });
    await cs.requestOptIn(u, { source: "footer" });
    assert.equal(u.get("channels.email.status"), "unsubscribed");
    assert.ok(u.get("channels.email.pendingSince"));
    await cs.confirmOptIn(u);
    assert.equal(u.get("channels.email.status"), "subscribed");

    // старий confirm-лінк після відписки (без нового запиту) не повертає підписку
    const u2 = fakeDoc({ email: "a@b.ua", channels: { email: { status: "unsubscribed", unsubscribedAt: new Date() } } });
    await cs.confirmOptIn(u2);
    assert.equal(u2.get("channels.email.status"), "unsubscribed");
    const cl = fakeDoc({ email: "a@b.ua", channels: { email: { status: "cleaned" } } });
    await cs.confirmOptIn(cl);
    assert.equal(cl.get("channels.email.status"), "cleaned");

    const p = fakeDoc({ email: "a@b.ua", channels: { email: { status: "none" } } });
    await cs.requestOptIn(p, {});
    assert.equal(p.get("channels.email.status"), "pending");
    await cs.confirmOptIn(p);
    assert.equal(p.get("channels.email.status"), "subscribed");
  });
});

test("налаштування за токеном: resubscribe лише з unsubscribed; кабінет — також none/pending; bounced — ніколи", async () => {
  const ctrl = require("../controllers/home/marketingSubscriptionController");
  const consent = { text: "t", version: "v1" };
  await withConsentStub(async () => {
    const run = async (st, opts) =>
      (await ctrl.applyPreferences(fakeDoc({ email: "a@b.ua", channels: { email: { status: st }, telegram: {} } }), { resubscribe: true }, {}, consent, opts)).get(
        "channels.email.status"
      );
    assert.equal(await run("unsubscribed"), "subscribed");
    assert.equal(await run("pending"), "pending", "pending не обходить double opt-in через токен");
    assert.equal(await run("cleaned"), "cleaned");
    assert.equal(await run("bounced"), "bounced");
    assert.equal(await run("complained"), "complained");
    const ACC = { resubscribeFrom: ["unsubscribed", "none", "cleaned", "pending"] };
    assert.equal(await run("none", ACC), "subscribed");
    assert.equal(await run("bounced", ACC), "bounced");
  });
});

// ======================= stats.unsubscribed / complained / bounced =======================

test("creditFilter: messageId / campaignId / останній лист кампанії за 7 днів", () => {
  const now = Date.UTC(2026, 5, 15);
  assert.equal(cs.creditFilter({ contactId: CID, field: "clicks" }), null);
  const a = cs.creditFilter({ messageId: CAMP, field: "complained" });
  assert.equal(a.filter._id, CAMP);
  assert.deepEqual(a.filter.complainedAt, { $exists: false });
  const b = cs.creditFilter({ contactId: CID, campaignId: CAMP, field: "unsubscribed" });
  assert.equal(b.filter.campaignId, CAMP);
  assert.equal(b.filter.status, "sent");
  const c = cs.creditFilter({ contactId: CID, field: "unsubscribed", now });
  assert.equal(+c.filter.sentAt.$gte, now - 7 * DAY);
  assert.deepEqual(c.sort, { sentAt: -1 });
});

test("creditCampaign: $inc stats один раз на повідомлення; поза 7 днями — не зараховується", async () => {
  const now = Date.now();
  const Message = fakeModel([
    { _id: "m1", contactId: CID, campaignId: CAMP, status: "sent", sentAt: new Date(now - DAY) },
    { _id: "m2", contactId: CID, campaignId: "c-old", status: "sent", sentAt: new Date(now - 10 * DAY) },
  ]);
  const Campaign = fakeModel([
    { _id: CAMP, stats: { unsubscribed: 0, complained: 0 } },
    { _id: "c-old", stats: { unsubscribed: 0 } },
  ]);
  const M = { Message, Campaign };
  assert.equal(await cs.creditCampaign({ contactId: CID, field: "unsubscribed" }, M), true);
  assert.equal(await cs.creditCampaign({ contactId: CID, field: "unsubscribed" }, M), false, "повторно — ні");
  assert.equal(Campaign.rows[0].stats.unsubscribed, 1);
  assert.equal(Campaign.rows[1].stats.unsubscribed, 0, "лист 10-денної давнини не рахується");
  assert.equal(await cs.creditCampaign({ messageId: "64b7f0c2a1b2c3d4e5f6abcd", field: "complained" }, M), false);
  Message.rows[0]._id = "64b7f0c2a1b2c3d4e5f6abcd";
  assert.equal(await cs.creditCampaign({ messageId: "64b7f0c2a1b2c3d4e5f6abcd", field: "complained" }, M), true);
  assert.equal(await cs.creditCampaign({ messageId: "64b7f0c2a1b2c3d4e5f6abcd", field: "complained" }, M), false, "друга подія (інший svix-id) — без подвійного обліку");
  assert.equal(Campaign.rows[0].stats.complained, 1);
});

// ======================= воркер: ідемпотентність і cap =======================

test("isDupOnly: лише E11000 ігнорується", () => {
  assert.equal(w.isDupOnly({ code: 11000 }), true);
  assert.equal(w.isDupOnly({ writeErrors: [{ code: 11000 }, { err: { code: 11000 } }] }), true);
  assert.equal(w.isDupOnly({ writeErrors: [{ code: 11000 }, { code: 121 }] }), false);
  assert.equal(w.isDupOnly(new Error("network")), false);
});

test("claimQueued: queued→sending атомарно; повторний/паралельний tick не захоплює те саме", async () => {
  const now = Date.now();
  const Message = fakeModel([
    { _id: "a", status: "queued", queuedAt: new Date(now - 1000) },
    { _id: "b", status: "queued", queuedAt: new Date(now - 500) },
    { _id: "c", status: "sent", queuedAt: new Date(now - 500) },
  ]);
  await withModels({ Message }, async () => {
    const first = await w.claimQueued(["a", "b", "c"], now);
    assert.deepEqual(first.map((m) => m._id), ["a", "b"]);
    assert.ok(first.every((m) => m.status === "sending" && m.lockId === first[0].lockId));
    const second = await w.claimQueued(["a", "b", "c"], now);
    assert.equal(second.length, 0, "друге захоплення нічого не отримує → лист не піде двічі");
  });
});

test("recoverStale: зависле sending без початої відправки → queued; з початою → failed (без повтору)", async () => {
  const now = Date.now();
  const old = new Date(now - 30 * 60 * 1000);
  const Message = fakeModel([
    { _id: "x", status: "sending", lockId: "L", claimedAt: old },
    { _id: "y", status: "sending", lockId: "L", claimedAt: old, sendStartedAt: old },
    { _id: "z", status: "sending", lockId: "L2", claimedAt: new Date(now - 60 * 1000) },
  ]);
  await withModels({ Message }, async () => {
    const r = await w.recoverStale(now);
    assert.deepEqual(r, { requeued: 1, failed: 1 });
  });
  const by = Object.fromEntries(Message.rows.map((m) => [m._id, m]));
  assert.equal(by.x.status, "queued");
  assert.equal(by.x.lockId, undefined);
  assert.equal(by.y.status, "failed");
  assert.equal(by.z.status, "sending", "свіже захоплення не чіпаємо");
});

test("prepareQueue: два повідомлення одному контакту в одній пачці не обходять frequency cap; відписаний — suppressed", async () => {
  const now = Date.now();
  const C1 = "c1".padEnd(24, "0");
  const C2 = "c2".padEnd(24, "0");
  const Contact = fakeModel([
    {
      _id: "p1",
      email: "a@b.ua",
      channels: { email: { status: "subscribed", topics: { promo: true, news: true } } },
      marketingSentLog: [{ at: new Date(now - DAY), channel: "email", campaignId: "old" }],
    },
    { _id: "p2", email: "c@d.ua", channels: { email: { status: "unsubscribed", topics: { promo: true } } }, marketingSentLog: [] },
  ]);
  const Campaign = fakeModel([
    { _id: C1, status: "sending", subject: "A", blocks: [{ type: "text", text: "x" }], topic: "promo" },
    { _id: C2, status: "sending", subject: "B", blocks: [{ type: "text", text: "y" }], topic: "news" },
  ]);
  const Message = fakeModel([
    { _id: "m1", campaignId: C1, contactId: "p1", channel: "email", status: "sending", lockId: "L" },
    { _id: "m2", campaignId: C2, contactId: "p1", channel: "email", status: "sending", lockId: "L" },
    { _id: "m3", campaignId: C1, contactId: "p2", channel: "email", status: "sending", lockId: "L" },
  ]);
  const settings = { frequencyCap: { max: 2, days: 7 }, automations: {} };
  await withModels({ Contact, Campaign, Message }, async () => {
    const ready = await w.prepareQueue(clone(Message.rows), settings, now);
    assert.deepEqual(
      ready.map((r) => r.msg._id),
      ["m1"]
    );
  });
  const by = Object.fromEntries(Message.rows.map((m) => [m._id, m]));
  assert.equal(by.m2.status, "skipped");
  assert.equal(by.m2.skipReason, "frequency_cap");
  assert.equal(by.m3.skipReason, "suppressed", "відписка зупиняє вже поставлені в чергу листи");
});

// ======================= інше =======================

test("trustProxyValue: число хопів/підмережі; 'true' (підробка X-Forwarded-For) — ні", () => {
  const { trustProxyValue } = require("../utiles/rateLimit");
  assert.equal(trustProxyValue(""), false);
  assert.equal(trustProxyValue(undefined), false);
  assert.equal(trustProxyValue("1"), 1);
  assert.equal(trustProxyValue("true"), false);
  assert.equal(trustProxyValue("off"), false);
  assert.equal(trustProxyValue("loopback"), "loopback");
});

test("crm sortOf: ключі прототипу не потрапляють у sort", () => {
  const { sortOf } = require("../controllers/crmController")._pure;
  assert.deepEqual(sortOf("constructor"), { createdAt: -1 });
  assert.deepEqual(sortOf("__proto__"), { createdAt: -1 });
  assert.deepEqual(sortOf("ltv"), { "stats.ltv": -1, createdAt: -1 });
});
