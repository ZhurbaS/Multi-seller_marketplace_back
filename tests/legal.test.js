// Публічна оферта: змінні, публікація, версії, прийняття покупцем (модель налаштувань — у пам'яті)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const stub = (rel, exportsObj) => {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
};

const db = { doc: null };
const setPath = (obj, p, v) => {
  const parts = p.split(".");
  let t = obj;
  parts.slice(0, -1).forEach((k) => (t = t[k] = t[k] || {}));
  t[parts.at(-1)] = v;
};
stub("models/storeSettingsModel.js", {
  findOne: () => ({ lean: async () => (db.doc ? JSON.parse(JSON.stringify(db.doc)) : null) }),
  findOneAndUpdate: async (_f, upd) => {
    db.doc = db.doc || { key: "main" };
    for (const [k, v] of Object.entries(upd.$set || {})) setPath(db.doc, k, v);
    return db.doc;
  },
});

const docs = require("../utiles/legalDocs");
const svc = require("../utiles/legalService");

const company = {
  name: 'ФОП Іваненко І.І.', edrpou: "1234567890", iban: "UA213223130000026007233566001",
  address: "м. Київ, вул. Тестова, 1", email: "shop@example.ua", invoiceValidDays: 3,
};
const reset = (c = company) => (db.doc = { key: "main", company: c, legal: {} });

test("render: підставляє змінні й повідомляє про порожні/невідомі", () => {
  const r = docs.render("Продавець {{seller_name}}{{ipn_line}}, {{brand}}, {{xyz}}", { seller_name: "ТОВ", ipn_line: "", brand: "" });
  assert.equal(r.text.startsWith("Продавець ТОВ,"), true);
  assert.deepEqual(r.missing.sort(), ["brand", "xyz"]);
  // дата без значення лишається маркером
  assert.equal(docs.render("від {{date}}", {}).text, "від {{date}}");
  assert.equal(docs.render("від {{date}}", { date: "01 січня 2027 р." }).text, "від 01 січня 2027 р.");
});

test("buildValues: ПДВ, ІПН, телефон, строки", () => {
  const v = docs.buildValues({ company: { ...company, vatPayer: true, vatPercent: 20, ipn: "123456789012", phone: "+380" }, returns: {}, vars: { brand: "Б" } });
  assert.match(v.vat_text, /з урахуванням ПДВ \(20%\)/);
  assert.equal(v.ipn_line, ", ІПН 123456789012");
  assert.match(v.phone_line, /\+380/);
  assert.equal(v.invoice_days, "3");
  assert.equal(v.withdrawal_days, "14");
  assert.equal(v.claims_email, "shop@example.ua"); // за замовчуванням — e-mail із реквізитів
  const v2 = docs.buildValues({ company, returns: {}, vars: { claimsEmail: "claims@x.ua" } });
  assert.equal(v2.claims_email, "claims@x.ua");
  assert.match(v2.vat_text, /без ПДВ/);
});

test("sanitizeVars: домен очищається, некоректне відхиляється", () => {
  assert.equal(docs.sanitizeVars({ brand: "  Тех  Скаут ", domain: "https://Shop.Example.UA/path" }).value.domain, "shop.example.ua");
  assert.equal(docs.sanitizeVars({ brand: "  Тех  Скаут " }).value.brand, "Тех Скаут");
  assert.ok(docs.sanitizeVars({ domain: "не домен" }).error);
  assert.ok(docs.sanitizeVars({ claimsEmail: "abc" }).error);
});

test("типовий текст оферти: після заповнення полів не лишається незаповнених змінних", async () => {
  reset();
  await svc.save("oferta", { template: docs.DOCS.oferta.template, vars: { brand: "TechScout", domain: "techscout.ua" } });
  const st = await svc.adminState("oferta");
  assert.deepEqual(st.preview.missing, []);
  assert.doesNotMatch(st.preview.text, /\{\{/);
  assert.match(st.preview.text, /ФОП Іваненко/);
  assert.equal(st.published, false);
});

test("публікація блокується, поки не заповнено бренд/домен/реквізити", async () => {
  reset();
  await assert.rejects(svc.setPublished("oferta", true), /Заповніть/);
  reset({});
  await svc.save("oferta", { template: docs.DOCS.oferta.template, vars: { brand: "Б", domain: "b.ua" } });
  await assert.rejects(svc.setPublished("oferta", true), /реквізитах/);
  assert.equal((await svc.publicDoc("oferta")).published, false);
});

test("публікація: версія 1, покупці бачать текст, повторна публікація не міняє версію", async () => {
  reset();
  await svc.save("oferta", { template: docs.DOCS.oferta.template, vars: { brand: "TechScout", domain: "techscout.ua" } });
  const pub = await svc.setPublished("oferta", true);
  assert.equal(pub.published, true);
  assert.equal(pub.version, 1);
  const pd = await svc.publicDoc("oferta");
  assert.equal(pd.published, true);
  assert.equal(pd.version, 1);
  assert.doesNotMatch(pd.text, /\{\{/);
  assert.match(pd.text, /Редакція від \d{2} \S+ \d{4} р\./);
  assert.deepEqual((await svc.publicStatus()).oferta, { published: true, version: 1 });
  // вимкнули й увімкнули без змін — та сама редакція
  await svc.setPublished("oferta", false);
  assert.equal((await svc.publicDoc("oferta")).published, false);
  assert.equal((await svc.setPublished("oferta", true)).version, 1);
});

test("збереження опублікованого тексту фіксує нову редакцію; покупці бачать зафіксовану, не чернетку", async () => {
  reset();
  const t = docs.DOCS.oferta.template;
  await svc.save("oferta", { template: t, vars: { brand: "TechScout", domain: "techscout.ua" } });
  await svc.setPublished("oferta", true);
  const v1 = (await svc.publicDoc("oferta")).text;
  const st2 = await svc.save("oferta", { template: t + "\n\n## 15. Додатково\n\n15.1. Новий пункт.", vars: { brand: "TechScout", domain: "techscout.ua" } });
  assert.equal(st2.version, 2);
  const v2 = (await svc.publicDoc("oferta")).text;
  assert.notEqual(v1, v2);
  assert.match(v2, /Новий пункт/);
  // зміна реквізитів (адреси) без повторної публікації: покупці бачать стару редакцію, адмін бачить stale
  db.doc.company = { ...company, address: "м. Львів, вул. Нова, 5" };
  assert.match((await svc.publicDoc("oferta")).text, /м\. Київ/);
  assert.equal((await svc.adminState("oferta")).stale, true);
  await svc.setPublished("oferta", true);
  assert.match((await svc.publicDoc("oferta")).text, /м\. Львів/);
  assert.equal((await svc.adminState("oferta")).stale, false);
  assert.equal((await svc.adminState("oferta")).version, 3);
});

test("опублікований документ не можна зберегти з порожніми змінними", async () => {
  reset();
  await svc.save("oferta", { template: docs.DOCS.oferta.template, vars: { brand: "TechScout", domain: "techscout.ua" } });
  await svc.setPublished("oferta", true);
  await assert.rejects(
    svc.save("oferta", { template: docs.DOCS.oferta.template + "\n{{unknown_var}}", vars: { brand: "TechScout", domain: "techscout.ua" } }),
    /опублікований/
  );
});

test("acceptanceFor: без публікації згода не потрібна; з публікацією — обов'язкова й записується з версією та хешем", async () => {
  reset();
  assert.deepEqual(await svc.acceptanceFor("oferta", false), { ok: true, acceptance: null });
  await svc.save("oferta", { template: docs.DOCS.oferta.template, vars: { brand: "TechScout", domain: "techscout.ua" } });
  await svc.setPublished("oferta", true);
  const no = await svc.acceptanceFor("oferta", false);
  assert.equal(no.ok, false);
  assert.match(no.error, /публічною офертою/);
  const yes = await svc.acceptanceFor("oferta", true);
  assert.equal(yes.ok, true);
  assert.equal(yes.acceptance.version, 1);
  assert.match(yes.acceptance.hash, /^[a-f0-9]{64}$/);
  await svc.setPublished("oferta", false);
  assert.equal((await svc.acceptanceFor("oferta", false)).ok, true);
});

test("reset повертає типовий текст; невідомий документ — 404", async () => {
  reset();
  await svc.save("oferta", { template: "x".repeat(300), vars: {} });
  assert.equal((await svc.adminState("oferta")).isDefaultTemplate, false);
  assert.equal((await svc.resetTemplate("oferta")).isDefaultTemplate, true);
  await assert.rejects(svc.adminState("nope"), (e) => e.status === 404);
});
