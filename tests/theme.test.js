const test = require("node:test");
const assert = require("node:assert");
const th = require("../utiles/theme");

test("усі пресети проходять валідацію без помилок", () => {
  for (const id of Object.keys(th.PRESETS)) {
    const v = th.validate({ preset: id });
    assert.deepStrictEqual(v.errors, [], id);
  }
});
test("кастомний колір: невалідний hex → помилка", () => {
  const v = th.validate({ preset: "custom", overrides: { brand: "red" } });
  assert.ok(v.errors.length);
});
test("CSS містить лише hex і назви токенів", () => {
  const { css } = th.build({ preset: "custom", overrides: { brand: "#123456", cta: "#abcdef", sale: "#ff0000", headerBg: "#000000", footerBg: "#ffffff" } });
  assert.match(css, /^:root\{(--[a-z0-9-]+:#[0-9a-f]{6};)+\}$/);
});
test("brand-ink завжди ≥4.5 на білому", () => {
  for (const c of ["#ffcc00", "#22d3ee", "#1f5fd6", "#047e62"]) {
    assert.ok(th.contrast(th.brandInk(c), "#ffffff") >= 4.5, c);
  }
});
test("normalize ігнорує невідомі ключі", () => {
  const n = th.normalize({ preset: "custom", overrides: { brand: "#112233", evil: "x}" } });
  assert.ok(!("evil" in n.overrides));
  assert.strictEqual(n.overrides.brand, "#112233");
});
test("on-cta читабельний для всіх пресетів", () => {
  for (const id of Object.keys(th.PRESETS)) {
    const d = th.derive(th.resolve({ preset: id }).values);
    assert.ok(th.contrast(d.cta, d["on-cta"]) >= 4.5, id);
    assert.ok(th.contrast(d.brand, d["on-brand"]) >= 4.5, id);
  }
});
