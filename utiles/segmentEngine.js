// Рушій сегментів (MARKETING_SPEC.md §3). Фільтр: { match:'all'|'any', rules:[{field, op, value}] }.
// Безпека: шляхи Mongo беруться ЛИШЕ з білого списку FIELDS (сирі ключі з фільтра не підставляються),
// оператори — з білого списку поля, значення — суворо типізовані (рядок/число/булеве з переліку),
// рядки для пошуку екрануються в RegExp. Об'єкти/масиви як значення відхиляються (захист від $where/$ne тощо).

const DAY = 24 * 60 * 60 * 1000;
const MAX_RULES = 30;
const MAX_STR = 100;

const EMAIL_STATUSES = ["none", "pending", "subscribed", "unsubscribed", "bounced", "complained", "cleaned"];
const TELEGRAM_STATUSES = ["none", "subscribed", "unsubscribed", "blocked"];
const TOPICS = ["promo", "news", "restock", "tips"];
const KINDS = ["person", "company", "unknown"];
const RFM_SEGMENTS = ["champions", "loyal", "new", "promising", "at_risk", "hibernating", "lost"];

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// type: enum | string | tag | number | bool | days
const FIELDS = {
  "channel.email.status": { label: "Статус e-mail", type: "enum", values: EMAIL_STATUSES, ops: ["is", "isNot"], path: "channels.email.status" },
  topic: { label: "Тема e-mail", type: "enum", values: TOPICS, ops: ["has"] },
  kind: { label: "Тип клієнта", type: "enum", values: KINDS, ops: ["is"], path: "kind" },
  city: { label: "Місто", type: "string", ops: ["is", "contains"], path: "city" },
  tags: { label: "Тег", type: "tag", ops: ["has", "notHas"], path: "tags" },
  source: { label: "Джерело", type: "string", ops: ["is"], path: "source" },
  isCustomer: { label: "Є покупцем (акаунт)", type: "bool", ops: ["is"] },
  "stats.orders": { label: "Кількість замовлень", type: "number", ops: ["gte", "lte", "eq"], path: "stats.orders" },
  "stats.ltv": { label: "Сума покупок (LTV), ₴", type: "number", ops: ["gte", "lte"], path: "stats.ltv" },
  "stats.lastOrderAt": { label: "Остання покупка", type: "days", ops: ["daysAgoGte", "daysAgoLte"], path: "stats.lastOrderAt" },
  "stats.firstOrderAt": { label: "Перша покупка", type: "days", ops: ["daysAgoGte", "daysAgoLte"], path: "stats.firstOrderAt" },
  createdAt: { label: "Доданий у базу", type: "days", ops: ["daysAgoGte", "daysAgoLte"], path: "createdAt" },
  "stats.categories": { label: "Купував категорію", type: "string", ops: ["has"], path: "stats.categories.name" },
  "rfm.segment": { label: "RFM-сегмент", type: "enum", values: RFM_SEGMENTS, ops: ["is"], path: "stats.rfm.segment" },
  "channel.telegram.status": { label: "Статус Telegram", type: "enum", values: TELEGRAM_STATUSES, ops: ["is"], path: "channels.telegram.status" },
  hasTelegram: { label: "Має Telegram", type: "bool", ops: ["is"] },
};

const OP_LABELS = {
  is: "дорівнює",
  isNot: "не дорівнює",
  has: "має",
  notHas: "не має",
  contains: "містить",
  gte: "≥",
  lte: "≤",
  eq: "=",
  daysAgoGte: "днів тому ≥",
  daysAgoLte: "днів тому ≤",
};

const VALUE_LABELS = {
  none: "немає",
  pending: "очікує підтвердження",
  subscribed: "підписаний",
  unsubscribed: "відписаний",
  bounced: "недоставлено (bounce)",
  complained: "скарга",
  cleaned: "прострочене підтвердження",
  blocked: "заблокував бота",
  promo: "акції",
  news: "новинки",
  restock: "надходження",
  tips: "поради",
  person: "фізособа",
  company: "юрособа",
  unknown: "невідомо",
  champions: "чемпіони",
  loyal: "лояльні",
  new: "нові",
  promising: "перспективні",
  at_risk: "під ризиком",
  hibernating: "сплячі",
  lost: "втрачені",
};

// Значення правила → нормалізоване значення | { error }
function normValue(def, op, v) {
  switch (def.type) {
    case "enum": {
      if (typeof v !== "string" || !def.values.includes(v)) return { error: `Недопустиме значення для «${def.label}»` };
      return { value: v };
    }
    case "string":
    case "tag": {
      if (typeof v !== "string") return { error: `Значення «${def.label}» має бути рядком` };
      let s = v.trim();
      if (def.type === "tag") s = s.toLowerCase();
      if (!s) return { error: `Вкажіть значення для «${def.label}»` };
      if (s.length > MAX_STR) return { error: `Значення «${def.label}» задовге` };
      return { value: s };
    }
    case "number":
    case "days": {
      const n = typeof v === "number" ? v : typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 1e9) return { error: `Значення «${def.label}» має бути невід'ємним числом` };
      return { value: def.type === "days" ? Math.floor(n) : n };
    }
    case "bool": {
      if (v === true || v === "true") return { value: true };
      if (v === false || v === "false") return { value: false };
      return { error: `Значення «${def.label}» має бути так/ні` };
    }
    default:
      return { error: "Невідомий тип поля" };
  }
}

const isPlainObj = (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

// → { ok, errors:[...], value:{match, rules} }
function validate(filter) {
  const errors = [];
  if (filter === null || filter === undefined) return { ok: true, errors, value: { match: "all", rules: [] } };
  if (!isPlainObj(filter)) return { ok: false, errors: ["Фільтр має бути об'єктом"], value: null };
  for (const k of Object.keys(filter)) if (k !== "match" && k !== "rules") errors.push(`Невідомий ключ фільтра: ${String(k).slice(0, 40)}`);
  const match = filter.match === undefined ? "all" : filter.match;
  if (match !== "all" && match !== "any") errors.push("match має бути 'all' або 'any'");
  const rulesIn = filter.rules === undefined ? [] : filter.rules;
  if (!Array.isArray(rulesIn)) errors.push("rules має бути масивом");
  const rules = [];
  if (Array.isArray(rulesIn)) {
    if (rulesIn.length > MAX_RULES) errors.push(`Не більше ${MAX_RULES} правил`);
    rulesIn.slice(0, MAX_RULES).forEach((r, i) => {
      const n = i + 1;
      if (!isPlainObj(r)) return errors.push(`Правило ${n}: має бути об'єктом`);
      for (const k of Object.keys(r)) if (!["field", "op", "value"].includes(k)) errors.push(`Правило ${n}: невідомий ключ ${String(k).slice(0, 40)}`);
      if (typeof r.field !== "string" || !Object.prototype.hasOwnProperty.call(FIELDS, r.field)) {
        return errors.push(`Правило ${n}: невідоме поле`);
      }
      const def = FIELDS[r.field];
      if (typeof r.op !== "string" || !def.ops.includes(r.op)) return errors.push(`Правило ${n}: недопустимий оператор для «${def.label}»`);
      const v = normValue(def, r.op, r.value);
      if (v.error) return errors.push(`Правило ${n}: ${v.error}`);
      rules.push({ field: r.field, op: r.op, value: v.value });
    });
  }
  return errors.length ? { ok: false, errors, value: null } : { ok: true, errors, value: { match, rules } };
}

const nonEmpty = { $exists: true, $nin: [null, ""] };

// Одне (вже валідне) правило → умова Mongo
function ruleToQuery({ field, op, value }, now) {
  const def = FIELDS[field];
  const path = def.path;
  switch (field) {
    case "topic":
      return { [`channels.email.topics.${TOPICS[TOPICS.indexOf(value)]}`]: true };
    case "isCustomer":
      return value ? { customerId: { $ne: null } } : { customerId: null };
    case "hasTelegram":
      return value ? { "channels.telegram.chatId": nonEmpty } : { "channels.telegram.chatId": { $in: [null, ""] } };
    default:
      break;
  }
  switch (def.type) {
    case "enum":
      return op === "isNot" ? { [path]: { $ne: value } } : { [path]: value };
    case "string":
      if (op === "contains") return { [path]: { $regex: escapeRe(value), $options: "i" } };
      if (field === "city" || field === "stats.categories") return { [path]: { $regex: `^${escapeRe(value)}$`, $options: "i" } };
      return { [path]: value };
    case "tag":
      return op === "notHas" ? { [path]: { $ne: value } } : { [path]: value };
    case "number":
      return op === "eq" ? { [path]: value } : { [path]: { [op === "gte" ? "$gte" : "$lte"]: value } };
    case "days": {
      const cutoff = new Date(now - value * DAY);
      // daysAgoGte N: подія була N+ днів тому → дата ≤ cutoff; daysAgoLte N: не пізніше N днів тому → дата ≥ cutoff
      return op === "daysAgoGte" ? { [path]: { $lte: cutoff } } : { [path]: { $gte: cutoff } };
    }
    default:
      throw new Error("Невідомий тип поля");
  }
}

// → умова Mongo. Анонімізовані контакти завжди виключено. Невалідний фільтр → Error(.code='INVALID_FILTER', .errors)
function toMongoQuery(filter, { now = Date.now() } = {}) {
  const v = validate(filter);
  if (!v.ok) {
    const e = new Error(v.errors.join("; "));
    e.code = "INVALID_FILTER";
    e.status = 400;
    e.errors = v.errors;
    throw e;
  }
  const t = now instanceof Date ? now.getTime() : Number(now);
  const parts = v.value.rules.map((r) => ruleToQuery(r, t));
  const base = { anonymized: { $ne: true } };
  if (!parts.length) return base;
  if (v.value.match === "any") return { $and: [base, { $or: parts }] };
  return { $and: [base, ...parts] };
}

// Людський опис українською
function describe(filter) {
  const v = validate(filter);
  if (!v.ok) return "Некоректний фільтр";
  if (!v.value.rules.length) return "Усі контакти";
  const parts = v.value.rules.map(({ field, op, value }) => {
    const def = FIELDS[field];
    let val = value;
    if (def.type === "bool") val = value ? "так" : "ні";
    else if (def.type === "enum") val = VALUE_LABELS[value] || value;
    else if (def.type === "days") val = `${value}`;
    else if (typeof value === "string") val = `«${value}»`;
    if (def.type === "days") return `${def.label}: ${op === "daysAgoGte" ? `${val}+ днів тому` : `за останні ${val} днів`}`;
    if (def.type === "bool") return `${def.label}: ${val}`;
    return `${def.label} ${OP_LABELS[op]} ${val}`;
  });
  return parts.join(v.value.match === "any" ? " АБО " : " І ");
}

// Опис полів для конструктора в адмінці
function fieldCatalog() {
  return Object.entries(FIELDS).map(([field, d]) => ({
    field,
    label: d.label,
    type: d.type,
    ops: d.ops.map((op) => ({ op, label: OP_LABELS[op] })),
    values: d.values ? d.values.map((v) => ({ value: v, label: VALUE_LABELS[v] || v })) : undefined,
  }));
}

// Вбудовані сегменти-шаблони (лише читання)
const SYSTEM_SEGMENTS = [
  { systemKey: "email_subscribers", name: "Усі підписники email", filter: { match: "all", rules: [{ field: "channel.email.status", op: "is", value: "subscribed" }] } },
  { systemKey: "telegram_subscribers", name: "Підписники Telegram", filter: { match: "all", rules: [{ field: "channel.telegram.status", op: "is", value: "subscribed" }] } },
  { systemKey: "buyers", name: "Покупці (≥1 замовлення)", filter: { match: "all", rules: [{ field: "stats.orders", op: "gte", value: 1 }] } },
  {
    systemKey: "subscribers_no_orders",
    name: "Підписники без покупок",
    filter: { match: "all", rules: [{ field: "channel.email.status", op: "is", value: "subscribed" }, { field: "stats.orders", op: "eq", value: 0 }] },
  },
  { systemKey: "companies", name: "Юрособи", filter: { match: "all", rules: [{ field: "kind", op: "is", value: "company" }] } },
  { systemKey: "inactive_180", name: "Не купували 180+ днів", filter: { match: "all", rules: [{ field: "stats.lastOrderAt", op: "daysAgoGte", value: 180 }] } },
  { systemKey: "rfm_champions", name: "Чемпіони (RFM)", filter: { match: "all", rules: [{ field: "rfm.segment", op: "is", value: "champions" }] } },
  { systemKey: "rfm_at_risk", name: "Під ризиком (RFM)", filter: { match: "all", rules: [{ field: "rfm.segment", op: "is", value: "at_risk" }] } },
  { systemKey: "new_30", name: "Нові за 30 днів", filter: { match: "all", rules: [{ field: "createdAt", op: "daysAgoLte", value: 30 }] } },
].map((s) => Object.freeze({ ...s, description: describe(s.filter) }));

// Створює/оновлює системні сегменти в БД (ідемпотентно)
async function ensureSystemSegments() {
  const Segment = require("../models/segmentModel");
  await Segment.bulkWrite(
    SYSTEM_SEGMENTS.map((s) => ({
      updateOne: {
        filter: { systemKey: s.systemKey },
        update: { $set: { name: s.name, description: s.description, filter: s.filter, system: true }, $setOnInsert: { systemKey: s.systemKey } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
}

module.exports = {
  FIELDS,
  OP_LABELS,
  VALUE_LABELS,
  RFM_SEGMENTS,
  MAX_RULES,
  SYSTEM_SEGMENTS,
  validate,
  toMongoQuery,
  describe,
  fieldCatalog,
  ensureSystemSegments,
  escapeRe,
};
