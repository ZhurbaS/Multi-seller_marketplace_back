// Маркетингові HMAC-токени: підпис, підробка, прострочення, purpose
const test = require("node:test");
const assert = require("node:assert/strict");
const t = require("../utiles/marketingTokens");

const ID = "65f1c0ffee0000000000abcd";

test("підпис і перевірка", () => {
  for (const p of ["unsub", "pref", "confirm", "tg"]) {
    const tok = t.sign(p, ID);
    assert.match(tok, /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    const r = t.verify(tok, p);
    assert.equal(r.ok, true, p);
    assert.equal(r.contactId, ID);
  }
  assert.equal(t.verify(t.sign("unsub", ID), "unsub").exp, 0, "unsub безстроковий");
  const c = t.verify(t.sign("confirm", ID), "confirm");
  assert.ok(c.exp > Date.now() + 6 * 24 * 3600 * 1000 && c.exp <= Date.now() + 7 * 24 * 3600 * 1000);
});

test("невірний purpose", () => {
  const tok = t.sign("pref", ID);
  assert.deepEqual(t.verify(tok, "unsub"), { ok: false, error: "purpose" });
  assert.equal(t.verify(tok, "nope").ok, false);
  assert.throws(() => t.sign("admin", ID));
  assert.throws(() => t.sign("unsub", ""));
  assert.equal(t.verifyClick(tok).ok, false);
});

test("підробка", () => {
  const tok = t.sign("unsub", ID);
  const [body, sig] = tok.split(".");
  const forged = Buffer.from(JSON.stringify({ c: "65f1c0ffee0000000000ffff", p: "unsub", e: 0 })).toString("base64url");
  assert.equal(t.verify(`${forged}.${sig}`, "unsub").ok, false);
  const flipped = sig.slice(0, -1) + (sig.at(-1) === "a" ? "b" : "a");
  assert.equal(t.verify(`${body}.${flipped}`, "unsub").ok, false);
  assert.equal(t.verify(`${body}.${sig.slice(0, 40)}`, "unsub").ok, false);
  for (const bad of ["", ".", "abc", null, undefined, 123, `${body}`, `${body}.${sig}.x`, "x".repeat(3000)]) {
    assert.equal(t.verify(bad, "unsub").ok, false, String(bad).slice(0, 20));
  }
  // інший секрет → недійсний
  const old = process.env.SECRET;
  process.env.SECRET = "other-secret";
  assert.equal(t.verify(tok, "unsub").ok, false);
  if (old === undefined) delete process.env.SECRET;
  else process.env.SECRET = old;
  assert.equal(t.verify(tok, "unsub").ok, true);
});

test("прострочення", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const tok = t.sign("confirm", ID, { ttlMs: 1000, now });
  assert.equal(t.verify(tok, "confirm", { now: now + 999 }).ok, true);
  const r = t.verify(tok, "confirm", { now: now + 1001 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "expired");
  const def = t.sign("confirm", ID, { now });
  assert.equal(t.verify(def, "confirm", { now: now + 7 * 24 * 3600 * 1000 - 1 }).ok, true);
  assert.equal(t.verify(def, "confirm", { now: now + 7 * 24 * 3600 * 1000 + 1 }).ok, false);
  const pref = t.sign("pref", ID, { ttlMs: 50, now });
  assert.equal(t.verify(pref, "pref", { now: now + 100 }).ok, false);
});

test("токен кліку: прив'язка до url (захист від open-redirect)", () => {
  const url = "https://shop.ua/product/x?utm_source=email";
  const tok = t.signClick({ messageId: "m1", campaignId: "c1", url });
  const v = t.verifyClick(tok);
  assert.equal(v.ok, true);
  assert.equal(v.messageId, "m1");
  assert.equal(v.campaignId, "c1");
  assert.equal(v.exp, 0);
  assert.equal(v.urlHash, t.urlHash(url));
  assert.equal(t.clickUrlMatches(v, url), true);
  assert.equal(t.clickUrlMatches(v, "https://evil.example/phish"), false);
  assert.equal(t.clickUrlMatches(v, url + "&x=1"), false);
  assert.equal(t.clickUrlMatches({ ok: true }, url), false);
  const auto = t.verifyClick(t.signClick({ messageId: "m2", url }));
  assert.equal(auto.campaignId, null);
  assert.equal(t.verify(tok, "click").ok, false, "click-токен не містить contactId");
  assert.equal(t.verifyClick(t.sign("unsub", ID)).ok, false);
  assert.throws(() => t.signClick({}));
  assert.throws(() => t.signClick({ messageId: "m1" }), /url/);
  const now = Date.now();
  const exp = t.signClick({ messageId: "m3", url }, { ttlMs: 10, now });
  assert.equal(t.verifyClick(exp, { now: now + 20 }).error, "expired");
  const [, sig] = tok.split(".");
  const forged = Buffer.from(JSON.stringify({ c: { m: "m9", k: "c1", h: t.urlHash("https://evil.example") }, p: "click", e: 0 })).toString("base64url");
  assert.equal(t.verifyClick(`${forged}.${sig}`).ok, false);
});

test("токен кліку без відбитка url (старий формат) — недійсний", () => {
  const crypto = require("crypto");
  const body = Buffer.from(JSON.stringify({ c: { m: "m1", k: null }, p: "click", e: 0 })).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.SECRET || "dev").update(`mkt:${body}`).digest("hex");
  assert.equal(t.verifyClick(`${body}.${sig}`).ok, false);
});
