// Рахунки для юросіб: реквізити, суми, PDF, виставлення/надсилання/статуси (моделі підмінені в пам'яті)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const stub = (rel, exportsObj) => {
  const p = require.resolve(path.join(__dirname, "..", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
};

const IBAN = "UA213223130000026007233566001";
const goodCompany = {
  name: 'ТОВ "Тест"',
  edrpou: "14360570",
  iban: IBAN,
  address: "м. Київ, вул. Тестова, 1",
  vatPayer: true,
  director: "Іваненко І.І.",
};

// ---- моделі в пам'яті
const db = { orders: new Map(), settings: { invoiceSeq: 0, company: goodCompany }, mails: [], mailOk: true };
const get = (obj, p) => p.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const setPath = (obj, p, v) => {
  const parts = p.split(".");
  let t = obj;
  parts.slice(0, -1).forEach((k) => (t = t[k] = t[k] || {}));
  t[parts.at(-1)] = v;
};
const matchOne = (doc, f) =>
  Object.entries(f).every(([k, v]) => {
    if (k === "$or") return v.some((sub) => matchOne(doc, sub));
    const val = get(doc, k);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("$ne" in v) return v.$ne === null ? val !== null && val !== undefined : val !== v.$ne;
      if ("$in" in v) return v.$in.includes(val);
      if ("$lt" in v) return val != null && val < v.$lt;
    }
    if (v === null) return val === null || val === undefined;
    return String(val) === String(v);
  });
const applyUpd = (doc, upd) => {
  for (const [k, v] of Object.entries(upd.$set || upd)) setPath(doc, k, v);
};
stub("models/customerOrderModel.js", {
  findById: async (id) => db.orders.get(String(id)) || null,
  findOneAndUpdate: async (f, u) => {
    const d = [...db.orders.values()].find((o) => matchOne(o, f));
    if (!d) return null;
    applyUpd(d, u);
    return d;
  },
  findByIdAndUpdate: async (id, u) => {
    const d = db.orders.get(String(id));
    if (d) applyUpd(d, u);
    return d || null;
  },
  updateOne: async (f, u) => {
    const d = [...db.orders.values()].find((o) => matchOne(o, f));
    if (d) applyUpd(d, u);
  },
});
stub("models/storeSettingsModel.js", {
  findOneAndUpdate: async (_f, u) => {
    if (u.$inc) db.settings.invoiceSeq += u.$inc.invoiceSeq;
    return db.settings;
  },
});
stub("models/customerModel.js", {
  findById: () => ({ select: () => ({ lean: async () => ({ email: db.email === undefined ? "buyer@example.com" : db.email }) }) }),
});
stub("controllers/settingsController.js", {
  loadSettings: async () => ({ company: require("../utiles/invoice").normalizeCompany(db.settings.company) }),
});
stub("utiles/mailer.js", {
  sendMail: async (m) => {
    db.mails.push(m);
    return db.mailOk;
  },
});

const inv = require("../utiles/invoice");
const service = require("../utiles/invoiceService");

const newOrder = (over = {}) => {
  const id = "6531a1b2c3d4e5f6071829" + String(db.orders.size).padStart(2, "0");
  const o = {
    _id: id,
    customerId: "c1",
    price: 900,
    payment_status: "unpaid",
    delivery_status: "pending",
    buyer: { kind: "company", companyName: "ТОВ Ромашка", edrpou: "21560766", ipn: "" },
    products: [{ name: "Ноутбук", quantity: 2, unitPrice: 500 }],
    invoice: { number: null, status: null, issuingAt: null, sendingAt: null },
    ...over,
  };
  db.orders.set(id, o);
  return o;
};

test("IBAN: контрольні цифри mod 97", () => {
  assert.equal(inv.isValidIban(IBAN), true);
  assert.equal(inv.isValidIban("UA21 3223 1300 0002 6007 2335 6600 1"), true);
  assert.equal(inv.isValidIban("UA213223130000026007233566002"), false);
  assert.equal(inv.isValidIban("UA21322313"), false);
  assert.equal(inv.isValidIban(""), false);
});

test("реквізити магазину: валідація", () => {
  assert.ok(inv.sanitizeCompany(goodCompany).value);
  assert.ok(inv.sanitizeCompany({ ...goodCompany, name: "" }).error);
  assert.ok(inv.sanitizeCompany({ ...goodCompany, edrpou: "14360571" }).error);
  assert.ok(inv.sanitizeCompany({ ...goodCompany, iban: "UA00" }).error);
  assert.ok(inv.sanitizeCompany({ ...goodCompany, address: "" }).error);
  assert.ok(inv.sanitizeCompany({ ...goodCompany, vatPercent: 13 }).error);
  assert.ok(inv.sanitizeCompany({ ...goodCompany, invoiceValidDays: 99 }).error);
  assert.ok(inv.sanitizeCompany({ ...goodCompany, email: "не пошта" }).error);
  assert.equal(inv.isCompanyConfigured({}), false);
  assert.equal(inv.isCompanyConfigured(goodCompany), true);
  assert.equal(inv.sanitizeCompany({ ...goodCompany, invoiceValidDays: "" }).value.invoiceValidDays, 5);
});

test("суми рахунку: знижка, ПДВ у складі ціни", () => {
  const c = inv.normalizeCompany(goodCompany);
  const d = inv.buildInvoiceData(
    { price: 950, products: [{ name: "А", quantity: 2, unitPrice: 500 }] },
    c
  );
  assert.equal(d.goods, 1000);
  assert.equal(d.discount, 50);
  assert.equal(d.total, 950);
  assert.equal(d.vat, 158.33); // 950 · 20 / 120
  const noVat = inv.buildInvoiceData({ price: 950, products: [{ name: "А", quantity: 1, unitPrice: 950 }] }, { ...c, vatPayer: false });
  assert.equal(noVat.vat, 0);
  assert.equal(inv.formatNumber("РФ", 7), "РФ-00007");
});

test("PDF: генерується валідний файл із кирилицею та довгими назвами", async () => {
  const order = {
    _id: "6531a1b2c3d4e5f607182901",
    price: 100,
    buyer: { companyName: "ТОВ Ромашка", edrpou: "21560766" },
    products: Array.from({ length: 60 }, (_, i) => ({ name: `Товар ${i} з довгою назвою `.repeat(3), quantity: 1, unitPrice: 100 / 60 })),
  };
  const buf = await inv.renderPdf({ order, company: inv.normalizeCompany(goodCompany), number: "РФ-00001", issuedAt: new Date(), dueAt: new Date() });
  assert.equal(buf.slice(0, 5).toString(), "%PDF-");
  assert.ok(buf.length > 5000);
});

test("виставлення: лише юрособі, нумерація послідовна, ідемпотентність", async () => {
  const o = newOrder();
  const issued = await service.issue(o);
  assert.equal(issued.invoice.number, "РФ-00001");
  assert.equal(issued.invoice.status, "awaiting");
  assert.equal(issued.payment_method, "invoice");
  assert.ok(issued.invoice.dueAt > issued.invoice.issuedAt);
  assert.equal(issued.invoice.company.iban, IBAN);
  // повторно — той самий номер, лічильник не росте
  const again = await service.issue(db.orders.get(String(o._id)));
  assert.equal(again.invoice.number, "РФ-00001");
  assert.equal(db.settings.invoiceSeq, 1);
  // наступне замовлення — наступний номер
  assert.equal((await service.issue(newOrder())).invoice.number, "РФ-00002");
  // фізособі — відмова
  await assert.rejects(service.issue(newOrder({ buyer: { kind: "individual" } })), /лише юридичним/);
});

test("виставлення: без реквізитів магазину — помилка 503 і без номера", async () => {
  const saved = db.settings.company;
  db.settings.company = {};
  const o = newOrder();
  await assert.rejects(service.issue(o), (e) => e.status === 503);
  assert.equal(db.orders.get(String(o._id)).invoice.number, null);
  db.settings.company = saved;
});

test("паралельні виклики виставляють лише один рахунок", async () => {
  db.settings.invoiceSeq = 10;
  const o = newOrder();
  const [a, b] = await Promise.all([service.issue(o), service.issue(o)]);
  const nums = new Set([a?.invoice?.number, b?.invoice?.number].filter(Boolean));
  assert.equal(nums.size, 1);
  assert.equal(db.settings.invoiceSeq, 11);
});

test("надсилання: лист із PDF-вкладенням → статус «sent»; без пошти → «awaiting» + повторне надсилання", async () => {
  db.mails.length = 0;
  db.mailOk = true;
  const r = await service.issueAndSend(newOrder());
  assert.equal(r.sent, true);
  assert.equal(r.order.invoice.status, "sent");
  assert.equal(r.order.invoice.sentTo, "buyer@example.com");
  assert.equal(db.mails.length, 1);
  assert.match(db.mails[0].subject, /Рахунок на оплату/);
  assert.equal(db.mails[0].attachments[0].content.slice(0, 5).toString(), "%PDF-");
  // повторний старт оплати не дублює лист
  const r2 = await service.issueAndSend(db.orders.get(String(r.order._id)));
  assert.equal(r2.sent, true);
  assert.equal(db.mails.length, 1);

  db.mailOk = false;
  const bad = await service.issueAndSend(newOrder());
  assert.equal(bad.sent, false);
  assert.equal(bad.order.invoice.status, "awaiting");
  assert.ok(bad.order.invoice.sendError);
  // адмін повторює, коли пошта запрацювала; extend продовжує строк
  db.mailOk = true;
  const before = bad.order.invoice.dueAt;
  const re = await service.resend(bad.order._id, { extend: true });
  assert.equal(re.sent, true);
  assert.equal(re.order.invoice.status, "sent");
  assert.ok(re.order.invoice.dueAt >= before);
});

test("надсилання: немає email покупця → awaiting з помилкою", async () => {
  db.email = null;
  db.mailOk = true;
  const r = await service.issueAndSend(newOrder());
  assert.equal(r.sent, false);
  assert.equal(r.order.invoice.status, "awaiting");
  assert.match(r.order.invoice.sendError, /email/);
  db.email = undefined;
});

test("повторне надсилання заборонене для оплаченого або скасованого замовлення", async () => {
  const issued = await service.issue(newOrder());
  db.orders.get(String(issued._id)).payment_status = "paid";
  await assert.rejects(service.resend(issued._id), /вже оплачене/);
  const i2 = await service.issue(newOrder());
  db.orders.get(String(i2._id)).delivery_status = "cancelled";
  await assert.rejects(service.resend(i2._id), /скасовано/);
  await assert.rejects(service.resend("6531a1b2c3d4e5f607182999"), /не знайдено/);
});

test("PDF за знімком реквізитів: зміна налаштувань не псує вже виставлений рахунок", async () => {
  const issued = await service.issue(newOrder());
  db.settings.company = { ...goodCompany, iban: "UA00" }; // «зіпсували» налаштування
  const buf = await service.pdfFor(issued);
  assert.equal(buf.slice(0, 5).toString(), "%PDF-");
  db.settings.company = goodCompany;
});

test("покупець повертається до оплати за рахунком після скасування рахунку → рахунок оживає зі свіжим строком", async () => {
  const issued = await service.issueAndSend(newOrder());
  const id = String(issued.order._id);
  await service.cancelIfInvoice(id);
  assert.equal(db.orders.get(id).invoice.status, "cancelled");
  db.orders.get(id).payment_method = "cod";
  db.orders.get(id).invoice.dueAt = new Date(Date.now() - 1000);
  const again = await service.issue(db.orders.get(id));
  assert.equal(again.payment_method, "invoice");
  assert.equal(again.invoice.status, "sent"); // лист уже надсилали раніше
  assert.ok(again.invoice.dueAt > new Date());
  // resend для скасованого рахунку з іншим способом — відмова
  db.orders.get(id).payment_method = "cod";
  db.orders.get(id).invoice.status = "cancelled";
  await assert.rejects(service.resend(id), /інший спосіб/);
});

test("відновлення простроченого замовлення продовжує рахунок", async () => {
  const issued = await service.issueAndSend(newOrder());
  const id = String(issued.order._id);
  const o = db.orders.get(id);
  o.invoice.status = "expired";
  o.invoice.dueAt = new Date(Date.now() - 86400000);
  await service.reviveIfInvoice(id);
  assert.equal(o.invoice.status, "sent");
  assert.ok(o.invoice.dueAt > new Date());
});

test("паралельне надсилання не дублює лист", async () => {
  db.mails.length = 0;
  db.mailOk = true;
  const issued = await service.issue(newOrder());
  const [a, b] = await Promise.all([service.send(issued), service.send(issued)]);
  assert.equal(db.mails.length, 1);
  assert.ok(a.busy || b.busy);
});
