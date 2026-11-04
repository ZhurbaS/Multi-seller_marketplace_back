// Шаблон маркетингового листа: екранування, безпечні url, футер (Реклама/реквізити/відписка), текст, обгортка кліків
const test = require("node:test");
const assert = require("node:assert/strict");
const tpl = require("../utiles/emailTemplate");
const tokens = require("../utiles/marketingTokens");

const FRONT = "https://shop.ua";
const ctx = (extra = {}) => ({
  front: FRONT,
  brand: "TechScout",
  company: { name: "ТОВ «Техскаут»", edrpou: "12345678", address: "Київ, вул. Хрещатик, 1", phone: "+380441234567", email: "info@shop.ua" },
  colors: { heading: "#111", link: "#00f", cta: "#f60", onCta: "#fff", headerBg: "#222", onHeader: "#fff", footerBg: "#eee", onFooter: "#333" },
  products: new Map(),
  banners: new Map(),
  ...extra,
});
const links = { unsubscribe: `${FRONT}/unsubscribe?t=abc`, preferences: `${FRONT}/preferences?t=def`, privacy: `${FRONT}/privacy` };

test("escapeHtml і екранування блоків", () => {
  assert.equal(tpl.escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  const { html } = tpl.renderEmail({
    subject: "<script>alert(1)</script>",
    preheader: "<img onerror=x>",
    blocks: [
      { type: "heading", text: "<b>Знижки</b>" },
      { type: "text", text: "Привіт <script>x</script> **жирно** і [тут](https://shop.ua/a)" },
      { type: "button", label: "<i>Купити</i>", url: "https://shop.ua/b" },
    ],
    ctx: ctx(),
    links,
  });
  assert.ok(!/<script>/i.test(html));
  assert.ok(!/<img onerror/i.test(html));
  assert.ok(!html.includes("<b>Знижки</b>"));
  assert.ok(html.includes("<strong>жирно</strong>"));
  assert.ok(html.includes("&lt;i&gt;Купити&lt;/i&gt;"));
});

test("safeUrl: лише http(s) (+mailto/tel для посилань), відносні — від фронту", () => {
  for (const u of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "//evil.com", "https://a.ua/ x", 'https://a.ua/"onmouseover=', "", null, 5, "http://"]) {
    assert.equal(tpl.safeUrl(u, { front: FRONT }), "", String(u));
  }
  assert.equal(tpl.safeUrl("/catalog", { front: FRONT }), `${FRONT}/catalog`);
  assert.equal(tpl.safeUrl("https://x.ua/a?b=1", { front: FRONT }), "https://x.ua/a?b=1");
  assert.equal(tpl.safeUrl("mailto:a@b.ua", { front: FRONT }), "mailto:a@b.ua");
  assert.equal(tpl.safeUrl("mailto:a@b.ua", { front: FRONT, kind: "image" }), "");
  const { html } = tpl.renderEmail({
    blocks: [
      { type: "button", label: "Зло", url: "javascript:alert(1)" },
      { type: "image", url: "data:image/png;base64,xx", alt: "x" },
      { type: "text", text: "[клік](javascript:alert(1))" },
    ],
    ctx: ctx(),
    links,
  });
  assert.ok(!/javascript:|data:image/i.test(html));
  assert.ok(!html.includes(">Зло<"), "кнопка з небезпечним url відкидається");
});

test("футер: Реклама, реквізити, відписка, налаштування, політика; текстова версія", () => {
  const r = tpl.renderEmail({ subject: "Тема", blocks: [{ type: "heading", text: "Привіт" }, { type: "text", text: "Абзац 1\n\nАбзац 2" }], ctx: ctx(), links });
  for (const s of ["Реклама", "ТОВ «Техскаут»", "ЄДРПОУ 12345678", "Київ, вул. Хрещатик, 1", "Відписатися", "Налаштування підписки", "Політика конфіденційності"]) {
    assert.ok(r.html.includes(tpl.escapeHtml(s)), `html: ${s}`);
  }
  assert.ok(r.html.includes(tpl.escapeHtml(links.unsubscribe)));
  assert.ok(r.html.includes('lang="uk"') && r.html.includes('width="600"'));
  assert.match(r.text, /^TechScout\nРеклама/);
  assert.ok(r.text.includes("ПРИВІТ"));
  assert.ok(r.text.includes("Абзац 1\n\nАбзац 2"));
  assert.ok(r.text.includes(`Відписатися: ${links.unsubscribe}`));
  assert.ok(r.text.includes("ЄДРПОУ 12345678"));
  assert.ok(!/<[a-z]/i.test(r.text), "текст без HTML");
  assert.deepEqual(tpl.companyLines({ edrpou: "1234567890" }, "B").slice(0, 2), ["B", "РНОКПП 1234567890"]);
});

test("UTM лише на власний домен; обгортка кліків з підписом url", () => {
  const api = "https://api.shop.ua";
  const wrap = tpl.clickWrapper({ messageId: "65f1c0ffee0000000000abcd", campaignId: "65f1c0ffee0000000000abce", api });
  const r = tpl.renderEmail({
    blocks: [
      { type: "button", label: "Каталог", url: "/catalog" },
      { type: "text", text: "[партнер](https://partner.ua/x) [пошта](mailto:a@b.ua)" },
    ],
    ctx: ctx({ wrap, utm: { source: "email", medium: "newsletter", campaign: "sale" } }),
    links,
  });
  const hrefs = [...r.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const wrapped = hrefs.filter((h) => h.startsWith(`${api}/api/r/`));
  assert.ok(wrapped.length >= 2, "http(s)-посилання обгорнуто");
  assert.ok(hrefs.includes("mailto:a@b.ua"), "mailto не обгортається");
  for (const h of wrapped) {
    const u = new URL(h);
    const target = u.searchParams.get("u");
    const v = tokens.verifyClick(decodeURIComponent(u.pathname.split("/").pop()));
    assert.equal(v.ok, true);
    assert.equal(tokens.clickUrlMatches(v, target), true, "токен прив'язаний до свого url");
    assert.equal(tokens.clickUrlMatches(v, "https://evil.example/"), false);
    if (target.startsWith(FRONT)) assert.match(target, /utm_source=email&utm_medium=newsletter&utm_campaign=sale/);
    else assert.ok(!target.includes("utm_"), "на чужий домен без UTM");
  }
  // посилання футера не обгортаються
  assert.ok(hrefs.includes(links.unsubscribe));
  assert.equal(tpl.clickWrapper({ messageId: null }), null);
});

test("товари й тест-позначка", () => {
  const products = new Map([["p1", { name: "Ноутбук <X>", price: 25999, oldPrice: 30000, image: "https://img/x.jpg", url: "/product/details/x" }]]);
  const r = tpl.renderEmail({ blocks: [{ type: "products", productIds: ["p1", "missing"], title: "Хіти" }], ctx: ctx({ products }), links, test: true });
  assert.ok(r.html.includes("Ноутбук &lt;X&gt;"));
  assert.ok(r.html.includes("25 999 ₴"));
  assert.ok(r.html.includes("ТЕСТОВИЙ ЛИСТ"));
  assert.ok(r.text.includes("• Ноутбук <X> — 25 999 ₴"));
  assert.equal(tpl.money(1234567.4), "1 234 567 ₴");
});

test("contactLinks: підписані токени відписки й налаштувань", () => {
  const id = "65f1c0ffee0000000000abcd";
  const l = tpl.contactLinks(id, { front: FRONT, api: "https://api.shop.ua" });
  const t = new URL(l.unsubscribe).searchParams.get("t");
  assert.equal(tokens.verify(t, "unsub").contactId, id);
  assert.equal(tokens.verify(new URL(l.preferences).searchParams.get("t"), "pref").contactId, id);
  assert.match(l.oneClick, /^https:\/\/api\.shop\.ua\/api\/home\/unsubscribe\?t=/);
});
