// Воркер маркетингу — чисті частини: вікно відправки (Київ), frequency cap, skipReason, пріоритет, estimate, Telegram
const test = require("node:test");
const assert = require("node:assert/strict");
const w = require("../utiles/marketingWorker");

const DAY = 86400000;
// 2026-06-15 — літній час, Київ = UTC+3; 2026-01-15 — зимовий, UTC+2
const kyivSummer = (h, m = 0) => Date.UTC(2026, 5, 15, h - 3, m);
const kyivWinter = (h, m = 0) => Date.UTC(2026, 0, 15, h - 2, m);
const WIN = { from: "09:00", to: "20:00" };

test("kyivParts / dayStart з урахуванням переходу на літній час", () => {
  assert.equal(w.kyivParts(kyivSummer(9, 30)).hour, 9);
  assert.equal(w.kyivParts(kyivWinter(9, 30)).hour, 9);
  assert.equal(w.kyivDateKey(Date.UTC(2026, 5, 15, 21, 30)), "2026-06-16", "00:30 за Києвом — вже наступна доба");
  assert.equal(w.kyivDayStart(kyivSummer(15)).toISOString(), "2026-06-14T21:00:00.000Z");
  assert.equal(w.kyivDayStart(kyivWinter(15)).toISOString(), "2026-01-14T22:00:00.000Z");
});

test("inSendWindow (09:00–20:00 Europe/Kyiv)", () => {
  assert.equal(w.inSendWindow(WIN, kyivSummer(8, 59)), false);
  assert.equal(w.inSendWindow(WIN, kyivSummer(9, 0)), true);
  assert.equal(w.inSendWindow(WIN, kyivSummer(19, 59)), true);
  assert.equal(w.inSendWindow(WIN, kyivSummer(20, 0)), false);
  assert.equal(w.inSendWindow(WIN, kyivWinter(9, 0)), true);
  assert.equal(w.inSendWindow(WIN, kyivWinter(8, 0)), false);
  assert.equal(w.inSendWindow(WIN, Date.UTC(2026, 5, 15, 6, 30)), true, "06:30 UTC = 09:30 Київ");
  // через північ
  assert.equal(w.inSendWindow({ from: "22:00", to: "02:00" }, kyivSummer(23)), true);
  assert.equal(w.inSendWindow({ from: "22:00", to: "02:00" }, kyivSummer(12)), false);
  // однакові/некоректні межі — цілодобово
  assert.equal(w.inSendWindow({ from: "10:00", to: "10:00" }, kyivSummer(3)), true);
  assert.equal(w.inSendWindow({}, kyivSummer(3)), true);
});

const NOW = Date.UTC(2026, 5, 15, 9);
const log = (daysAgo, extra = {}) => ({ at: new Date(NOW - daysAgo * DAY), channel: "email", campaignId: null, automation: null, ...extra });

test("frequency cap: ≤2/7 днів по всіх каналах; кампанія в кількох каналах — один раз", () => {
  const cap = { max: 2, days: 7 };
  assert.equal(w.capAllowed({ marketingSentLog: [] }, cap, NOW), true);
  assert.equal(w.capAllowed({ marketingSentLog: [log(1, { campaignId: "a" })] }, cap, NOW), true);
  assert.equal(w.capAllowed({ marketingSentLog: [log(1, { campaignId: "a" }), log(2, { automation: "welcome" })] }, cap, NOW), false);
  assert.equal(w.capAllowed({ marketingSentLog: [log(1, { campaignId: "a" }), log(8, { campaignId: "b" })] }, cap, NOW), true, "старші за 7 днів не рахуються");
  const twoCh = [log(1, { campaignId: "a" }), log(1, { campaignId: "a", channel: "telegram" })];
  assert.equal(w.capAllowed({ marketingSentLog: twoCh }, cap, NOW), true, "одна кампанія в двох каналах = 1");
  const full = [log(1, { campaignId: "a" }), log(2, { campaignId: "b" })];
  assert.equal(w.capAllowed({ marketingSentLog: full }, cap, NOW, { campaignId: "a" }), true, "поточна кампанія не рахується");
  // особистий вибір частоти
  assert.equal(w.capAllowed({ channels: { email: { frequency: "weekly" } }, marketingSentLog: [log(3, { campaignId: "x" })] }, cap, NOW), false);
  assert.equal(w.capAllowed({ channels: { email: { frequency: "monthly" } }, marketingSentLog: [log(20, { campaignId: "x" })] }, cap, NOW), false);
  assert.equal(w.capAllowed({ channels: { email: { frequency: "monthly" } }, marketingSentLog: [log(31, { campaignId: "x" })] }, cap, NOW), true);
});

const sub = (o = {}) => ({
  email: "a@b.ua",
  channels: { email: { status: "subscribed", topics: { promo: true, news: true, restock: true, tips: false } }, telegram: { status: "none" } },
  marketingSentLog: [],
  ...o,
});
const R = (c, o = {}) => w.resolveSkipReason(c, { topic: "promo", cap: { max: 2, days: 7 }, now: NOW, ...o });

test("resolveSkipReason: усі причини й пріоритет", () => {
  assert.equal(R(sub()), null);
  assert.equal(R(null), "no_address");
  for (const st of ["unsubscribed", "bounced", "complained"]) assert.equal(R(sub({ channels: { email: { status: st, topics: { promo: true } } } })), "suppressed", st);
  assert.equal(R(sub({ anonymized: true })), "suppressed");
  assert.equal(R(sub({ email: "" })), "no_address");
  assert.equal(R(sub({ email: "bad" })), "no_address");
  for (const st of ["none", "pending", "cleaned"]) assert.equal(R(sub({ channels: { email: { status: st, topics: { promo: true } } } })), "not_subscribed", st);
  assert.equal(R(sub(), { topic: "tips" }), "topic_off");
  assert.equal(R(sub({ channels: { email: { status: "subscribed", topics: {} } } }), { topic: "all" }), "topic_off");
  assert.equal(R(sub({ marketingSentLog: [log(1, { campaignId: "a" }), log(2, { campaignId: "b" })] })), "frequency_cap");
  assert.equal(R(sub({ marketingSentLog: [log(1, { campaignId: "a" }), log(2, { campaignId: "b" })] }), { checkCap: false }), null);
  // пріоритет: suppressed > no_address > not_subscribed > topic_off > frequency_cap
  assert.equal(R(sub({ email: "", channels: { email: { status: "bounced" } } })), "suppressed");
  assert.equal(R(sub({ email: "", channels: { email: { status: "pending" } } })), "no_address");
  assert.equal(R(sub({ channels: { email: { status: "pending", topics: {} } } }), { topic: "tips" }), "not_subscribed");
  assert.equal(R(sub({ marketingSentLog: [log(1), log(2, { automation: "x" })] }), { topic: "tips" }), "topic_off");
  assert.deepEqual(w.SKIP_PRIORITY, ["suppressed", "no_address", "not_subscribed", "topic_off", "frequency_cap"]);
});

test("resolveSkipReason: Telegram", () => {
  const tg = (t) => sub({ channels: { email: { status: "none" }, telegram: { topics: { promo: true }, ...t } } });
  assert.equal(R(tg({ status: "subscribed", chatId: "1" }), { channel: "telegram" }), null);
  assert.equal(R(tg({ status: "blocked", chatId: "1" }), { channel: "telegram" }), "suppressed");
  assert.equal(R(tg({ status: "subscribed" }), { channel: "telegram" }), "no_address");
  assert.equal(R(tg({ status: "none", chatId: "1" }), { channel: "telegram" }), "not_subscribed");
  assert.equal(R(tg({ status: "subscribed", chatId: "1", topics: { promo: false } }), { channel: "telegram" }), "topic_off");
});

test("pickReason і summarizeEstimate", () => {
  assert.equal(w.pickReason([null, "suppressed"]), null);
  assert.equal(w.pickReason(["topic_off", "no_address"]), "topic_off", "no_address одного каналу — шум");
  assert.equal(w.pickReason(["no_address", "no_address"]), "no_address");
  assert.equal(w.pickReason([undefined, "frequency_cap"]), "frequency_cap");
  const groups = [
    { e: "ok", t: "no_address", n: 150 },
    { e: "not_subscribed", t: "ok", n: 10 },
    { e: "suppressed", t: "no_address", n: 5 },
    { e: "topic_off", t: "no_address", n: 3 },
    { e: "frequency_cap", t: "no_address", n: 2 },
  ];
  const onlyEmail = w.summarizeEstimate(groups, { channels: ["email"], dailyLimit: 100 });
  assert.equal(onlyEmail.total, 170);
  assert.equal(onlyEmail.eligible, 150);
  assert.deepEqual(onlyEmail.excluded, { not_subscribed: 10, topic_off: 3, suppressed: 5, frequency_cap: 2, no_address: 0 });
  assert.deepEqual(onlyEmail.byChannel, { email: 150, telegram: 0 });
  assert.equal(onlyEmail.estimatedDays, 2);
  const both = w.summarizeEstimate(groups, { channels: ["email", "telegram"], dailyLimit: 100 });
  assert.equal(both.eligible, 160);
  assert.equal(both.byChannel.telegram, 10);
  assert.equal(both.excluded.no_address, 0);
  assert.equal(both.excluded.suppressed, 5);
  assert.equal(both.excluded.topic_off, 3);
  assert.equal(both.excluded.frequency_cap, 2);
  assert.equal(w.summarizeEstimate([], {}).estimatedDays, 0);
});

test("telegramPayload і normalizeTgResult", () => {
  const p = w.telegramPayload(
    { subject: "Тема", blocks: [{ type: "heading", text: "Знижки" }, { type: "text", text: "**До -30%** [тут](https://x.ua)" }, { type: "button", label: "Купити", url: "/sale" }] },
    { front: "https://shop.ua", wrap: (u) => `W(${u})` }
  );
  assert.match(p.text, /^Знижки\n\nДо -30% тут/);
  assert.match(p.text, /Реклама · Відписатися: \/stop$/);
  assert.deepEqual(p.buttons, [{ text: "Купити", url: "W(https://shop.ua/sale)" }]);
  assert.deepEqual(w.telegramPayload({ telegramText: "Свій", blocks: [{ type: "button", label: "x", url: "javascript:1" }] }).buttons, []);
  assert.equal(w.normalizeTgResult({ ok: true, result: { message_id: 5 } }).ok, true);
  assert.equal(w.normalizeTgResult({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }).blocked, true);
  assert.equal(w.normalizeTgResult({ ok: false, error_code: 429 }).retryable, true);
  assert.equal(w.normalizeTgResult({ ok: false, error_code: 400, description: "bad" }).retryable, false);
  assert.equal(w.normalizeTgResult(null, new Error("ETIMEDOUT")).retryable, true);
});

test("nightlyDue: після 03:00 за Києвом, раз на добу", () => {
  assert.equal(w.nightlyDue(null, kyivSummer(2, 59)), false);
  assert.equal(w.nightlyDue(null, kyivSummer(3, 1)), true);
  assert.equal(w.nightlyDue(w.kyivDateKey(kyivSummer(3, 1)), kyivSummer(10)), false);
});

test("start() поважає MARKETING_WORKER=off", () => {
  const old = process.env.MARKETING_WORKER;
  process.env.MARKETING_WORKER = "off";
  const origLog = console.log;
  console.log = () => {};
  try {
    assert.equal(w.start(), false);
    assert.equal(w.status().enabled, false);
    assert.equal(w.status().running, false);
  } finally {
    console.log = origLog;
    if (old === undefined) delete process.env.MARKETING_WORKER;
    else process.env.MARKETING_WORKER = old;
  }
});
