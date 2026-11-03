const test = require("node:test");
const assert = require("node:assert/strict");
const { formatFooter, priceOf } = require("../utiles/mailFooter");

test("підпис: З повагою, контакти, сайт", () => {
  const t = formatFooter({ name: "TechScout", phone: "+380501234567", email: "info@x.ua", site: "https://x.ua" });
  assert.match(t, /З повагою,\nTechScout/);
  assert.match(t, /Тел\.: \+380501234567/);
  assert.match(t, /E-mail: info@x\.ua/);
  assert.match(t, /Сайт: https:\/\/x\.ua/);
  assert.ok(!/цікаво/.test(t));
});

test("порожні контакти не друкуються", () => {
  const t = formatFooter({ name: "", site: "" });
  assert.match(t, /команда магазину/);
  assert.ok(!/Тел\.|E-mail|Сайт/.test(t));
});

test("блок «Вам може бути цікаво» лише в режимі withProducts і з сайтом", () => {
  const products = [{ name: "Телефон", slug: "tel-1", price: 1000, discount: 10, tag: "−10%" }];
  const full = formatFooter({ name: "S", site: "https://x.ua", products, withProducts: true });
  assert.match(full, /Вам може бути цікаво:/);
  assert.match(full, /Телефон — ₴900 \(−10%\)/);
  assert.match(full, /https:\/\/x\.ua\/product\/details\/tel-1/);
  assert.ok(!/цікаво/.test(formatFooter({ name: "S", site: "https://x.ua", products, withProducts: false })));
  assert.ok(!/цікаво/.test(formatFooter({ name: "S", site: "", products, withProducts: true })));
});

test("priceOf враховує знижку", () => {
  assert.equal(priceOf({ price: 200, discount: 25 }), 150);
  assert.equal(priceOf({ price: 200 }), 200);
});
