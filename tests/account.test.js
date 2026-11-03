const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Модель/БД не потрібні: перевіряємо чисті функції (підміняємо залежності-моделі заглушками)
const stub = (rel, exportsObj) => {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
};
stub("models/customerModel.js", {});
stub("models/cardModel.js", {});
const acc = require("../utiles/accountService");
const ec = require("../utiles/emailChange");

const goodGoogle = () => ({
  iss: "https://accounts.google.com",
  aud: "cid",
  exp: String(Math.floor(Date.now() / 1000) + 600),
  sub: "123",
  email: "User@Gmail.com",
  email_verified: "true",
  name: "Іван",
});

test("Google: коректний токен", () => {
  const r = acc.validateGooglePayload(goodGoogle(), "cid");
  assert.equal(r.value.email, "user@gmail.com");
  assert.equal(r.value.sub, "123");
});

test("Google: чужий aud, прострочений, непідтверджений e-mail, без налаштування — відхиляються", () => {
  assert.ok(acc.validateGooglePayload({ ...goodGoogle(), aud: "x" }, "cid").error);
  assert.ok(acc.validateGooglePayload({ ...goodGoogle(), exp: "1" }, "cid").error);
  assert.ok(acc.validateGooglePayload({ ...goodGoogle(), email_verified: "false" }, "cid").error);
  assert.ok(acc.validateGooglePayload({ ...goodGoogle(), iss: "evil.com" }, "cid").error);
  assert.ok(acc.validateGooglePayload(goodGoogle(), "").error);
  assert.ok(acc.validateGooglePayload(null, "cid").error);
});

test("OTP: правильний код проходить, неправильний/прострочений/забагато спроб — ні", () => {
  const { code, record } = acc.newOtp("a@b.ua");
  assert.match(code, /^\d{6}$/);
  assert.equal(acc.otpProblem(record, code, "a@b.ua"), "");
  assert.equal(acc.otpProblem(record, code === "000000" ? "111111" : "000000", "a@b.ua"), "Невірний код");
  assert.match(acc.otpProblem({ ...record, expiresAt: new Date(Date.now() - 1000) }, code, "a@b.ua"), /Строк/);
  assert.match(acc.otpProblem({ ...record, attempts: 5 }, code, "a@b.ua"), /Забагато/);
  assert.match(acc.otpProblem(undefined, code, "a@b.ua"), /запросіть/i);
  // код прив'язаний до адреси
  assert.equal(acc.otpProblem(record, code, "other@b.ua"), "Невірний код");
});

test("emailRe: регістронезалежний збіг лише повної адреси", () => {
  assert.ok(acc.emailRe("a.b@x.ua").test("A.B@X.ua"));
  assert.ok(!acc.emailRe("a.b@x.ua").test("xa.b@x.ua"));
  assert.ok(!acc.emailRe("a.b@x.ua").test("aXb@x.ua"));
  assert.ok(ec.normalizeEmail("a@b.ua").value);
});
