// Юридичні документи магазину (поки — публічна оферта): змінні, підстановка, перевірка готовності.
// Чисті функції без БД (БД — у utiles/legalService.js).

const crypto = require("crypto");
const { OFERTA_TITLE, OFERTA_TEMPLATE } = require("./legalDefaults");

const DOCS = {
  oferta: { title: OFERTA_TITLE, template: OFERTA_TEMPLATE },
};

const MAX_TEMPLATE = 60000;
// Змінні, яким дозволено бути порожніми (підставляється порожній рядок)
const OPTIONAL = new Set(["ipn_line", "phone_line"]);

const MONTHS = [
  "січня", "лютого", "березня", "квітня", "травня", "червня",
  "липня", "серпня", "вересня", "жовтня", "листопада", "грудня",
];
const dateUa = (d) => {
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, "0")} ${MONTHS[x.getMonth()]} ${x.getFullYear()} р.`;
};

const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

const str = (v, max) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);

// → { value } | { error } для полів «Бренд», «Домен», «E-mail для претензій»
function sanitizeVars(body) {
  const b = body && typeof body === "object" ? body : {};
  const brand = str(b.brand, 80);
  const domain = str(b.domain, 120)
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  const claimsEmail = str(b.claimsEmail, 120).toLowerCase();
  if (domain && !/^[a-z0-9а-яіїєґ.-]+\.[a-z0-9а-яіїєґ-]{2,}$/i.test(domain)) {
    return { error: "Домен має вигляд example.ua (без http:// і слешів)" };
  }
  if (claimsEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claimsEmail)) {
    return { error: "Некоректний e-mail для претензій" };
  }
  return { value: { brand, domain, claimsEmail } };
}

// → { value } | { error }
function sanitizeTemplate(raw) {
  const t = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (t.trim().length < 200) return { error: "Текст оферти надто короткий" };
  if (t.length > MAX_TEMPLATE) return { error: `Текст завеликий (максимум ${MAX_TEMPLATE} символів)` };
  return { value: t };
}

// Значення змінних з реквізитів магазину, умов повернення й полів «Бренд/Домен».
// date — дата редакції (рядок); якщо не передано, лишається {{date}} (для порівняння версій).
function buildValues({ company, returns, vars, date, cardDays }) {
  const c = company || {};
  const r = returns || {};
  const v = vars || {};
  const vatPayer = c.vatPayer === true;
  return {
    brand: v.brand || "",
    domain: v.domain || "",
    seller_name: c.name || "",
    edrpou: c.edrpou || "",
    ipn_line: c.ipn ? `, ІПН ${c.ipn}` : "",
    address: c.address || "",
    email: c.email || "",
    phone_line: c.phone ? `, тел.: ${c.phone}` : "",
    claims_email: v.claimsEmail || c.email || "",
    vat_status: vatPayer
      ? `Продавець є платником податку на додану вартість (ставка ${c.vatPercent ?? 20}%).`
      : "Продавець не є платником податку на додану вартість.",
    vat_text: vatPayer ? `з урахуванням ПДВ (${c.vatPercent ?? 20}%)` : "без ПДВ (Продавець не є платником ПДВ)",
    invoice_days: String(c.invoiceValidDays || 3),
    card_days: String(cardDays || 3),
    withdrawal_days: String(r.individual?.withdrawalDays ?? 14),
    refund_days: String(r.refundDeadlineDays ?? 30),
    withdrawal_shipping:
      (r.individual?.shippingPayerWithdrawal ?? "customer") === "customer"
        ? "Витрати на зворотну доставку товару при відмові від договору несе Покупець."
        : "Витрати на зворотну доставку товару при відмові від договору несе Продавець.",
    ...(date ? { date } : {}),
  };
}

// Підставляє {{змінні}}. missing — імена змінних, яких немає або які порожні (крім необов'язкових).
function render(template, values) {
  const missing = new Set();
  const text = String(template).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, name) => {
    if (name === "date" && !("date" in values)) return m; // дата ще не проставлена
    const val = values[name];
    if (val === undefined) {
      missing.add(name);
      return m;
    }
    if (val === "" && !OPTIONAL.has(name)) missing.add(name);
    return val;
  });
  return { text, missing: [...missing] };
}

// Людські назви для повідомлень адміну
const LABELS = {
  brand: "Бренд (на цій сторінці)",
  domain: "Домен сайту (на цій сторінці)",
  seller_name: "Повна назва в реквізитах магазину",
  edrpou: "Код ЄДРПОУ/РНОКПП у реквізитах",
  address: "Юридична адреса в реквізитах",
  email: "E-mail у реквізитах (або e-mail для претензій)",
  claims_email: "E-mail для претензій",
};
const missingLabels = (missing) => missing.map((m) => LABELS[m] || `{{${m}}}`);

module.exports = {
  DOCS,
  MAX_TEMPLATE,
  dateUa,
  sha,
  sanitizeVars,
  sanitizeTemplate,
  buildValues,
  render,
  missingLabels,
};
