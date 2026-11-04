// Налаштування маркетингу: типові значення, clamp, структура автоматизацій
const test = require("node:test");
const assert = require("node:assert/strict");
const ms = require("../utiles/marketingSettings");

test("типові значення", () => {
  const n = ms.normalize(undefined);
  assert.deepEqual(n, JSON.parse(JSON.stringify(ms.DEFAULTS)));
  assert.deepEqual(n.frequencyCap, { max: 2, days: 7 });
  assert.deepEqual(n.sendWindow, { from: "09:00", to: "20:00" });
  assert.equal(n.dailyLimit, 100);
  assert.equal(n.batchSize, 50);
  assert.equal(n.doubleOptInFooter, true);
  assert.equal(n.consentText.version, "v1");
  assert.equal(
    n.consentText.footer,
    "Хочу отримувати новини та пропозиції від TechScout на e-mail. Можна відписатися будь-коли."
  );
  assert.equal(n.automations.welcome.enabled, true);
  assert.equal(n.automations.welcome.steps.length, 2);
  assert.equal(n.automations.welcome.steps[1].delayHours, 72);
  assert.equal(n.automations.abandonedCart.enabled, false);
  assert.equal(n.automations.abandonedCart.afterHours, 24);
  assert.equal(n.automations.winback.afterDays, 180);
  for (const s of n.automations.welcome.steps) assert.ok(s.subject && s.blocks.length);
  // типові блоки проходять власну нормалізацію без втрат
  assert.deepEqual(ms.normalizeBlocks(n.automations.winback.blocks), n.automations.winback.blocks);
});

test("бренд у типових текстах", () => {
  const n = ms.normalize({}, { brand: "Мій Магазин" });
  assert.match(n.consentText.footer, /від Мій Магазин на e-mail/);
  assert.equal(n.senderName, "Мій Магазин");
  assert.equal(ms.brandOf({ legal: { _vars: { brand: "Б" } } }), "Б");
  assert.equal(ms.brandOf({}), "TechScout");
  // збережений текст не перезаписується
  assert.equal(ms.normalize({ consentText: { footer: "Свій текст" } }, { brand: "X" }).consentText.footer, "Свій текст");
});

test("clamp чисел", () => {
  const n = ms.normalize({
    frequencyCap: { max: 99, days: 0 },
    dailyLimit: 5,
    batchSize: 1000,
  });
  assert.deepEqual(n.frequencyCap, { max: 10, days: 1 });
  assert.equal(n.dailyLimit, 10);
  assert.equal(n.batchSize, 100);
  const m = ms.normalize({ frequencyCap: { max: 0, days: 999 }, dailyLimit: 1e9, batchSize: -5 });
  assert.deepEqual(m.frequencyCap, { max: 1, days: 30 });
  assert.equal(m.dailyLimit, 100000);
  assert.equal(m.batchSize, 1);
  const x = ms.normalize({ frequencyCap: { max: "abc" }, dailyLimit: "500", batchSize: 2.6 });
  assert.equal(x.frequencyCap.max, 2);
  assert.equal(x.dailyLimit, 500);
  assert.equal(x.batchSize, 3);
});

test("вікно відправки, тексти, адреси", () => {
  assert.deepEqual(ms.normalize({ sendWindow: { from: "8:00", to: "24:00" } }).sendWindow, { from: "09:00", to: "20:00" });
  assert.deepEqual(ms.normalize({ sendWindow: { from: "07:30", to: "22:15" } }).sendWindow, { from: "07:30", to: "22:15" });
  const n = ms.normalize({
    senderName: "x".repeat(500),
    fromEmail: "TechScout <news@news.shop.ua>",
    replyTo: "not-an-email",
    consentText: { footer: "y".repeat(5000), version: "v2<script>" },
    doubleOptInFooter: "no",
  });
  assert.equal(n.senderName.length, 100);
  assert.equal(n.fromEmail, "TechScout <news@news.shop.ua>");
  assert.equal(n.replyTo, "");
  assert.equal(n.consentText.footer.length, 1000);
  assert.equal(n.consentText.version, "v1");
  assert.equal(n.doubleOptInFooter, true);
  assert.equal(ms.normalize({ fromEmail: "bad" }).fromEmail, "");
  assert.equal(ms.normalize({ replyTo: " Help@Shop.UA " }).replyTo, "help@shop.ua");
});

test("автоматизації: кроки, затримки, блоки", () => {
  const step = (h) => ({ delayHours: h, subject: "S" + h, blocks: [{ type: "text", text: "T" }] });
  const n = ms.normalize({
    automations: {
      welcome: { enabled: false, steps: [step(-5), step(10), step(5000), step(1), step(2), step(3), step(4)] },
      abandonedCart: { enabled: true, afterHours: 0 },
      winback: { afterDays: 99999, subject: "W" },
    },
  });
  const w = n.automations.welcome;
  assert.equal(w.enabled, false);
  assert.equal(w.steps.length, 5);
  assert.deepEqual(
    w.steps.map((s) => s.delayHours),
    [0, 10, 720, 1, 2]
  );
  assert.equal(w.steps[0].subject, "S-5");
  assert.equal(n.automations.abandonedCart.enabled, true);
  assert.equal(n.automations.abandonedCart.afterHours, 1);
  assert.ok(n.automations.abandonedCart.blocks.length, "типові блоки, якщо порожньо");
  assert.equal(n.automations.winback.afterDays, 1095);
  assert.equal(n.automations.winback.subject, "W");
  assert.equal(ms.normalize({ automations: { welcome: { steps: [] } } }).automations.welcome.steps.length, 2);
});

test("нормалізація блоків", () => {
  const out = ms.normalizeBlocks([
    { type: "heading", text: "Привіт", level: 3 },
    { type: "text", text: "" },
    { type: "button", label: "Іти", url: "javascript:alert(1)" },
    { type: "button", label: "Іти", url: "https://shop.ua/x" },
    { type: "image", url: "/img/a.webp", alt: "a", href: "ftp://x" },
    { type: "products", productIds: ["65f1c0ffee0000000000abcd", "bad", "65f1c0ffee0000000000abcd"], title: "Хіти" },
    { type: "divider", junk: 1 },
    { type: "script" },
    null,
  ]);
  assert.deepEqual(out, [
    { type: "heading", text: "Привіт", level: 1 },
    { type: "button", label: "Іти", url: "https://shop.ua/x" },
    { type: "image", url: "/img/a.webp", alt: "a", href: "" },
    { type: "products", productIds: ["65f1c0ffee0000000000abcd"], title: "Хіти" },
    { type: "divider" },
  ]);
  assert.equal(ms.normalizeBlocks(Array(80).fill({ type: "spacer" })).length, 50);
  assert.deepEqual(ms.normalizeBlocks("x"), []);
});
