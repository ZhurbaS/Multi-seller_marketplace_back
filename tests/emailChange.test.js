const test = require("node:test");
const assert = require("node:assert/strict");
const ec = require("../utiles/emailChange");

test("normalizeEmail: нижній регістр, валідація", () => {
  assert.equal(ec.normalizeEmail("  Test@Example.COM ").value, "test@example.com");
  assert.ok(ec.normalizeEmail("bad").error);
  assert.ok(ec.normalizeEmail("a@b").error);
  assert.ok(ec.normalizeEmail("").error);
});

test("makeCode: 6 цифр", () => {
  for (let i = 0; i < 200; i++) assert.match(ec.makeCode(), /^\d{6}$/);
});

test("hashCode/codesEqual: збіг лише для правильних коду й пошти", () => {
  const h = ec.hashCode("123456", "a@b.ua");
  assert.ok(ec.codesEqual(ec.hashCode("123456", "a@b.ua"), h));
  assert.ok(!ec.codesEqual(ec.hashCode("123457", "a@b.ua"), h));
  assert.ok(!ec.codesEqual(ec.hashCode("123456", "c@b.ua"), h));
  assert.ok(!ec.codesEqual("", h));
});

test("escapeRe екранує спецсимволи", () => {
  assert.ok(new RegExp(`^${ec.escapeRe("a.b+c@x.ua")}$`, "i").test("A.B+C@x.ua"));
  assert.ok(!new RegExp(`^${ec.escapeRe("a.b@x.ua")}$`, "i").test("aXb@x.ua"));
});
