// Рахунок на оплату для юридичних осіб: перевірка реквізитів магазину, розрахунок сум, PDF.
// Чисті функції без доступу до БД (БД — у utiles/invoiceService.js).

const path = require("path");
const PDFDocument = require("pdfkit");
const { isValidEdrpou } = require("./buyer");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// IBAN України: UA + 2 контрольні цифри + 25 цифр (6 — МФО, 19 — рахунок), перевірка mod 97.
function isValidIban(raw) {
  const iban = String(raw || "").replace(/\s+/g, "").toUpperCase();
  if (!/^UA\d{27}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

const DEFAULT_COMPANY = {
  name: "",
  edrpou: "",
  ipn: "",
  vatPayer: false,
  vatPercent: 20,
  iban: "",
  bank: "",
  address: "",
  phone: "",
  email: "",
  director: "",
  invoicePrefix: "РФ",
  invoiceValidDays: 5,
  note: "",
};

const str = (v, max) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);

function normalizeCompany(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const days = Number(c.invoiceValidDays);
  return {
    ...DEFAULT_COMPANY,
    name: str(c.name, 200),
    edrpou: String(c.edrpou ?? "").replace(/\s+/g, ""),
    ipn: String(c.ipn ?? "").replace(/\s+/g, ""),
    vatPayer: c.vatPayer === true || c.vatPayer === "true",
    vatPercent: Number.isFinite(Number(c.vatPercent)) ? Number(c.vatPercent) : 20,
    iban: String(c.iban ?? "").replace(/\s+/g, "").toUpperCase(),
    bank: str(c.bank, 200),
    address: str(c.address, 300),
    phone: str(c.phone, 50),
    email: str(c.email, 100),
    director: str(c.director, 100),
    invoicePrefix: str(c.invoicePrefix, 10) || DEFAULT_COMPANY.invoicePrefix,
    invoiceValidDays: Number.isInteger(days) && days >= 1 && days <= 30 ? days : DEFAULT_COMPANY.invoiceValidDays,
    note: str(c.note, 500),
  };
}

// → { value } | { error }
function sanitizeCompany(body) {
  if (!body || typeof body !== "object") return { error: "Некоректні реквізити" };
  const days = body.invoiceValidDays;
  if (days !== undefined && days !== "" && (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 30)) {
    return { error: "Строк дії рахунку: від 1 до 30 днів" };
  }
  const c = normalizeCompany(body);
  if (c.name.length < 2) return { error: "Вкажіть повну назву (ФОП або юрособи)" };
  if (!/^\d{8}$|^\d{10}$/.test(c.edrpou)) return { error: "Код ЄДРПОУ — 8 цифр (для ФОП — 10 цифр РНОКПП)" };
  if (c.edrpou.length === 8 && !isValidEdrpou(c.edrpou)) {
    return { error: "Код ЄДРПОУ не пройшов перевірку контрольної цифри" };
  }
  if (c.ipn && !/^\d{10}$|^\d{12}$/.test(c.ipn)) return { error: "ІПН — 12 цифр (платник ПДВ) або 10 цифр" };
  if (!isValidIban(c.iban)) return { error: "IBAN некоректний: UA + 27 цифр (перевірте контрольні цифри)" };
  if (c.address.length < 5) return { error: "Вкажіть юридичну адресу" };
  if (c.vatPayer && ![20, 7, 0].includes(c.vatPercent)) return { error: "Ставка ПДВ: 20, 7 або 0%" };
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return { error: "Некоректний email магазину" };
  return { value: c };
}

// Достатньо даних, щоб виставляти рахунки
function isCompanyConfigured(raw) {
  return !!raw && sanitizeCompany(raw).value !== undefined;
}

// Номер: ПРЕФІКС-00001
const formatNumber = (prefix, seq) => `${prefix || DEFAULT_COMPANY.invoicePrefix}-${String(seq).padStart(5, "0")}`;

// Позиції і суми рахунку з замовлення. Ціни в замовленні вже включають ПДВ (якщо магазин — платник).
// Доставка в замовлення не входить (платить покупець перевізнику).
function buildInvoiceData(order, company) {
  const lines = (order.products || []).map((p, i) => {
    const qty = Number(p.quantity) || 0;
    const unit = round2(p.unitPrice ?? p.price - Math.floor((p.price * (p.discount || 0)) / 100));
    return { n: i + 1, name: p.name, quantity: qty, unit, sum: round2(unit * qty) };
  });
  const goods = round2(lines.reduce((s, l) => s + l.sum, 0));
  const discount = round2(goods - Number(order.price));
  const total = round2(order.price);
  const vat = company.vatPayer ? round2((total * company.vatPercent) / (100 + company.vatPercent)) : 0;
  return { lines, goods, discount: discount > 0 ? discount : 0, total, vat };
}

const MONTHS = [
  "січня", "лютого", "березня", "квітня", "травня", "червня",
  "липня", "серпня", "вересня", "жовтня", "листопада", "грудня",
];
const dateUa = (d) => {
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, "0")} ${MONTHS[x.getMonth()]} ${x.getFullYear()} р.`;
};
const money = (n) =>
  Number(n).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, " ");

const FONT = path.join(__dirname, "..", "assets", "fonts", "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "..", "assets", "fonts", "DejaVuSans-Bold.ttf");

// Призначення платежу для банку
const paymentPurpose = (order, number) =>
  `Оплата за рахунком ${number} (замовлення №${String(order._id).slice(-8).toUpperCase()})${
    ""
  }`;

// PDF рахунку → Promise<Buffer>
function renderPdf({ order, company, number, issuedAt, dueAt }) {
  const data = buildInvoiceData(order, company);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Рахунок ${number}`, Author: company.name } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("R", FONT);
    doc.registerFont("B", FONT_BOLD);
    const W = doc.page.width - 80;

    // Реквізити отримувача платежу
    doc.font("B").fontSize(11).text("Отримувач платежу", { continued: false });
    doc.font("R").fontSize(9.5);
    doc.text(`${company.name}`);
    doc.text(`Код ЄДРПОУ/РНОКПП: ${company.edrpou}${company.ipn ? `   ІПН: ${company.ipn}` : ""}`);
    doc.text(`IBAN: ${company.iban}${company.bank ? `   Банк: ${company.bank}` : ""}`);
    doc.text(`Адреса: ${company.address}`);
    if (company.phone || company.email) doc.text(`Контакти: ${[company.phone, company.email].filter(Boolean).join(", ")}`);
    doc.text(company.vatPayer ? `Платник ПДВ (ставка ${company.vatPercent}%)` : "Неплатник ПДВ");

    doc.moveDown(1);
    doc.font("B").fontSize(15).text(`Рахунок на оплату № ${number}`, { align: "center" });
    doc.font("R").fontSize(10).text(`від ${dateUa(issuedAt)}`, { align: "center" });
    doc.moveDown(0.8);

    doc.fontSize(10);
    doc.font("B").text("Покупець: ", { continued: true });
    doc.font("R").text(
      `${order.buyer?.companyName || ""}, код ЄДРПОУ/РНОКПП ${order.buyer?.edrpou || ""}${order.buyer?.ipn ? `, ІПН ${order.buyer.ipn}` : ""}`
    );
    doc.font("B").text("Замовлення: ", { continued: true });
    doc.font("R").text(`№${String(order._id).slice(-8).toUpperCase()}`);
    doc.moveDown(0.8);

    // Таблиця
    const cols = [
      { t: "№", w: 28, a: "left" },
      { t: "Найменування товару", w: W - 28 - 50 - 85 - 90, a: "left" },
      { t: "К-ть", w: 50, a: "right" },
      { t: "Ціна, грн", w: 85, a: "right" },
      { t: "Сума, грн", w: 90, a: "right" },
    ];
    const drawRow = (cells, bold) => {
      const y0 = doc.y;
      doc.font(bold ? "B" : "R").fontSize(9.5);
      let x = 40;
      let h = 0;
      cells.forEach((cell, i) => {
        const hh = doc.heightOfString(String(cell), { width: cols[i].w - 8 });
        h = Math.max(h, hh);
      });
      if (y0 + h + 10 > doc.page.height - 120) {
        doc.addPage();
      }
      const y = doc.y;
      cells.forEach((cell, i) => {
        doc.text(String(cell), x + 4, y + 4, { width: cols[i].w - 8, align: cols[i].a });
        x += cols[i].w;
      });
      doc.rect(40, y, W, h + 8).strokeColor("#888").lineWidth(0.5).stroke();
      doc.y = y + h + 8;
    };
    drawRow(cols.map((c) => c.t), true);
    data.lines.forEach((l) => drawRow([l.n, l.name, l.quantity, money(l.unit), money(l.sum)], false));

    doc.moveDown(0.6);
    const right = (label, value, bold) => {
      doc.font(bold ? "B" : "R").fontSize(10).text(`${label} ${value}`, 40, doc.y, { width: W, align: "right" });
    };
    if (data.discount > 0) {
      right("Сума товарів:", `${money(data.goods)} грн`);
      right("Знижка:", `−${money(data.discount)} грн`);
    }
    right("Разом до сплати:", `${money(data.total)} грн`, true);
    if (company.vatPayer) right(`у т.ч. ПДВ ${company.vatPercent}%:`, `${money(data.vat)} грн`);
    else right("Без ПДВ", "");

    doc.moveDown(1);
    doc.font("R").fontSize(9.5).text("Призначення платежу: ", 40, doc.y, { continued: true, width: W });
    doc.font("B").text(paymentPurpose(order, number));
    doc.font("R").text(`Рахунок дійсний до ${dateUa(dueAt)}. Після цієї дати замовлення буде автоматично скасоване, а товар повернуто в продаж.`, { width: W });
    doc.text("Вартість доставки в рахунок не входить: її оплачує покупець перевізнику при отриманні.", { width: W });
    if (company.note) doc.moveDown(0.4).text(company.note, { width: W });
    if (company.director) {
      doc.moveDown(1.5).text(`Виписав: ${company.director}`, { width: W });
    }
    doc.end();
  });
}

module.exports = {
  isValidIban,
  normalizeCompany,
  sanitizeCompany,
  isCompanyConfigured,
  formatNumber,
  buildInvoiceData,
  paymentPurpose,
  renderPdf,
  round2,
};
