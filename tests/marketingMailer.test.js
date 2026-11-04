// Маркетинговий мейлер: конфіг, заголовки List-Unsubscribe(+Post), батчинг по 100, ретраї, помилки (fetch підмінено)
const test = require("node:test");
const assert = require("node:assert/strict");
const mm = require("../utiles/marketingMailer");

function withEnv(env, fn) {
  const old = {};
  for (const k of Object.keys(env)) {
    old[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const restore = () => {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}
const ENV = { RESEND_API_KEY: "re_test", MARKETING_MAIL_FROM: "news@news.shop.ua" };
const msg = (i = 0) => ({ to: `u${i}@x.ua`, subject: `Тема ${i}`, html: "<p>x</p>", text: "x", unsubscribeUrl: `https://api.shop.ua/api/home/unsubscribe?t=${i}` });
const okFetch = (calls) => async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, init, body });
  return { ok: true, status: 200, json: async () => ({ data: body.map((_, i) => ({ id: `id-${calls.length}-${i}` })) }) };
};
const noSleep = async () => {};

test("конфіг: not_configured без ключа/відправника", () =>
  withEnv({ RESEND_API_KEY: undefined, MARKETING_MAIL_FROM: undefined }, async () => {
    assert.equal(mm.isConfigured({}), false);
    assert.match(mm.configHint({}), /RESEND_API_KEY/);
    const r = await mm.sendBatch([msg()], { fetch: () => assert.fail("не має бути запиту") });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not_configured");
    assert.equal(r.results[0].error, "not_configured");
    process.env.RESEND_API_KEY = "k";
    assert.match(mm.configHint({}), /MARKETING_MAIL_FROM/);
    assert.equal((await mm.sendBatch([msg()], { fetch: () => assert.fail() })).reason, "not_configured");
  }));

test("resolveFrom", () =>
  withEnv({ MARKETING_MAIL_FROM: "news@news.shop.ua" }, () => {
    assert.equal(mm.resolveFrom({ senderName: "TechScout" }), "TechScout <news@news.shop.ua>");
    assert.equal(mm.resolveFrom({ fromEmail: "Shop <a@b.ua>" }), "Shop <a@b.ua>");
    assert.equal(mm.resolveFrom({ fromEmail: "bad", senderName: "x" }), "");
    assert.equal(mm.resolveFrom({ senderName: 'Evil"\r\nBcc: x' }), "EvilBcc: x <news@news.shop.ua>");
  }));

test("buildPayload: List-Unsubscribe + One-Click (RFC 8058), reply_to, теги", () => {
  const p = mm.buildPayload({ ...msg(1), unsubscribeMailto: "unsub@shop.ua", subject: "a\r\nBcc: x", tags: [{ name: "campaign", value: "65f/1" }] }, { from: "F <f@x.ua>", replyTo: "r@x.ua" });
  assert.equal(p.headers["List-Unsubscribe"], "<https://api.shop.ua/api/home/unsubscribe?t=1>, <mailto:unsub@shop.ua>");
  assert.equal(p.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(p.subject, "a Bcc: x", "без переносів рядків у темі");
  assert.equal(p.reply_to, "r@x.ua");
  assert.deepEqual(p.to, ["u1@x.ua"]);
  assert.deepEqual(p.tags, [{ name: "campaign", value: "65f_1" }]);
  const noUnsub = mm.buildPayload({ to: "a@b.ua", subject: "s", html: "x" }, { from: "f@x.ua" });
  assert.equal(noUnsub.headers["List-Unsubscribe-Post"], undefined);
});

test("батчинг по 100 і порядок результатів", () =>
  withEnv(ENV, async () => {
    const calls = [];
    const list = Array.from({ length: 250 }, (_, i) => msg(i));
    const r = await mm.sendBatch(list, { fetch: okFetch(calls), sleep: noSleep });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.body.length), [100, 100, 50]);
    assert.equal(calls[0].url, mm.BATCH_URL);
    assert.equal(calls[0].init.headers.Authorization, "Bearer re_test");
    assert.equal(calls[0].body[0].from, "news@news.shop.ua");
    assert.equal(calls[0].body[5].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.equal(r.ok, true);
    assert.equal(r.results.length, 250);
    assert.equal(r.results[0].id, "id-1-0");
    assert.equal(r.results[249].id, "id-3-49");
  }));

test("некоректний лист — помилка лише цього листа", () =>
  withEnv(ENV, async () => {
    const calls = [];
    const r = await mm.sendBatch([msg(0), { to: "", subject: "x", html: "x" }, { ...msg(2), subject: " " }, msg(3)], { fetch: okFetch(calls), sleep: noSleep });
    assert.equal(calls[0].body.length, 2);
    assert.equal(r.ok, false);
    assert.ok(r.results[0].id && r.results[3].id);
    assert.equal(r.results[1].error, "invalid_message");
    assert.equal(r.results[2].retryable, false);
  }));

test("5xx — ретраї (≤3), 4xx — без ретраїв, мережеві помилки", () =>
  withEnv(ENV, async () => {
    let n = 0;
    const flaky = async (url, init) => {
      n++;
      if (n < 3) return { ok: false, status: 503, headers: { get: () => null }, text: async () => "unavailable" };
      return okFetch([])(url, init);
    };
    const r = await mm.sendBatch([msg()], { fetch: flaky, sleep: noSleep });
    assert.equal(n, 3);
    assert.equal(r.ok, true);

    n = 0;
    const always500 = async () => (n++, { ok: false, status: 500, headers: { get: () => null }, text: async () => "boom" });
    const r2 = await mm.sendBatch([msg()], { fetch: always500, sleep: noSleep });
    assert.equal(n, mm.MAX_ATTEMPTS);
    assert.equal(r2.ok, false);
    assert.equal(r2.results[0].status, 500);
    assert.equal(r2.results[0].retryable, true);

    n = 0;
    const r3 = await mm.sendBatch([msg()], { fetch: async () => (n++, { ok: false, status: 422, headers: { get: () => null }, text: async () => "invalid from" }), sleep: noSleep });
    assert.equal(n, 1);
    assert.equal(r3.results[0].retryable, false);
    assert.match(r3.results[0].error, /422/);

    const r4 = await mm.sendBatch([msg()], { fetch: async () => { throw new Error("ECONNRESET"); }, sleep: noSleep });
    assert.match(r4.results[0].error, /network/);
    assert.equal(r4.results[0].retryable, true);
  }));

test("Idempotency-Key та пауза між запитами (≤2/с)", () =>
  withEnv(ENV, async () => {
    const calls = [];
    const sleeps = [];
    const list = Array.from({ length: 150 }, (_, i) => ({ ...msg(i), idempotencyKey: `m${i}` }));
    await mm.sendBatch(list, { fetch: okFetch(calls), sleep: async (ms) => sleeps.push(ms) });
    assert.match(calls[0].init.headers["Idempotency-Key"], /^mkt-[a-f0-9]{48}$/);
    assert.notEqual(calls[0].init.headers["Idempotency-Key"], calls[1].init.headers["Idempotency-Key"]);
    assert.ok(sleeps.length >= 1 && sleeps.every((ms) => ms > 0 && ms <= 500));
  }));
