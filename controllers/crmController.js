// Адмін CRM (MARKETING_SPEC.md §7): контакти, теги, сегменти, імпорт/експорт CSV, аналітика, RFM,
// health, налаштування маркетингу, автоматизації. Маршрути — routes/crmRoutes.js (/api/admin/crm).
// Верхня частина — чисті помічники (тести без БД), нижче — обробники.

const fs = require("fs");
const mongoose = require("mongoose");
const { IncomingForm } = require("formidable");
const handleError = require("../utiles/handleError");
const cs = require("../utiles/contactService");
const csv = require("../utiles/csv");
const engine = require("../utiles/segmentEngine");
const mkSettings = require("../utiles/marketingSettings");

const Contact = () => require("../models/contactModel");
const ConsentLog = () => require("../models/consentLogModel");
const Segment = () => require("../models/segmentModel");
const Message = () => require("../models/campaignMessageModel");
const Campaign = () => require("../models/campaignModel");
const SuppressedHash = () => require("../models/suppressedHashModel");

const DAY = 24 * 60 * 60 * 1000;
const TOPICS = ["promo", "news", "restock", "tips"];
const EMAIL_STATUSES = ["none", "pending", "subscribed", "unsubscribed", "bounced", "complained", "cleaned"];
const TG_STATUSES = ["none", "subscribed", "unsubscribed", "blocked"];
const KINDS = ["person", "company", "unknown"];
const IMPORT_MAX_ROWS = 5000;
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const BULK_MAX = 5000;
const BULK_DELETE_MAX = 1000;
const MAX_TAGS = 30;

// ======================= чисті помічники =======================

const isId = (v) => typeof v === "string" && mongoose.Types.ObjectId.isValid(v) && /^[a-f\d]{24}$/i.test(v);
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const bad = (res, error, extra = {}) => res.status(400).json({ error, ...extra });
const escapeRe = engine.escapeRe;
const truthy = (v) => v === true || ["true", "1", "on", "yes", "так"].includes(String(v ?? "").trim().toLowerCase());

function normTag(t) {
  return String(t ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 50);
}
function normTags(list) {
  const src = Array.isArray(list) ? list : typeof list === "string" ? list.split(/[,;|]/) : [];
  return [...new Set(src.map(normTag).filter(Boolean))].slice(0, MAX_TAGS);
}

function pageArgs(q = {}, { def = 25, max = 100 } = {}) {
  const limit = Math.min(max, Math.max(1, parseInt(q.limit, 10) || def));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  return { page, limit, skip: (page - 1) * limit };
}

const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name: { name: 1, createdAt: -1 },
  ltv: { "stats.ltv": -1, createdAt: -1 },
  orders: { "stats.orders": -1, createdAt: -1 },
  lastOrder: { "stats.lastOrderAt": -1, createdAt: -1 },
  activity: { lastActivityAt: -1, createdAt: -1 },
};

// Фільтри списку контактів (query-рядок) → умова Mongo. Лише білий список; значення — рядки з переліків
function contactListQuery(q = {}) {
  const and = [{ anonymized: { $ne: true } }];
  const s = (k, max = 100) => (typeof q[k] === "string" ? q[k].trim().slice(0, max) : "");
  const search = s("q");
  if (search) {
    const re = { $regex: escapeRe(search), $options: "i" };
    const digits = search.replace(/\D/g, "");
    const or = [{ email: re }, { name: re }, { city: re }];
    if (digits.length >= 4) or.push({ phone: { $regex: escapeRe(digits) } });
    and.push({ $or: or });
  }
  const status = s("status");
  if (EMAIL_STATUSES.includes(status)) and.push({ "channels.email.status": status });
  const topic = s("topic");
  if (TOPICS.includes(topic)) and.push({ [`channels.email.topics.${topic}`]: true });
  const kind = s("kind");
  if (KINDS.includes(kind)) and.push({ kind });
  const city = s("city");
  if (city) and.push({ city: { $regex: `^${escapeRe(city)}$`, $options: "i" } });
  const tag = normTag(s("tag"));
  if (tag) and.push({ tags: tag });
  const rfm = s("rfm");
  if (engine.RFM_SEGMENTS.includes(rfm)) and.push({ "stats.rfm.segment": rfm });
  const source = s("source", 50);
  if (source && /^[\w-]+$/.test(source)) and.push({ source });
  const tg = s("telegram");
  if (TG_STATUSES.includes(tg)) and.push({ "channels.telegram.status": tg });
  return and.length === 1 ? and[0] : { $and: and };
}

const sortOf = (k) => (typeof k === "string" && Object.prototype.hasOwnProperty.call(SORTS, k) ? SORTS[k] : SORTS.newest);

// Контакт для таблиці (без журналу розсилок)
function listView(c) {
  const e = c.channels?.email || {};
  const t = c.channels?.telegram || {};
  return {
    _id: c._id,
    email: c.email || "",
    phone: c.phone || "",
    name: c.name || "",
    kind: c.kind || "unknown",
    city: c.city || "",
    tags: c.tags || [],
    source: c.source || "",
    customerId: c.customerId || null,
    createdAt: c.createdAt,
    lastActivityAt: c.lastActivityAt,
    erasureRequested: !!c.erasureRequested,
    channels: {
      email: { status: e.status || "none", topics: e.topics || {}, frequency: e.frequency || "normal", subscribedAt: e.subscribedAt, unsubscribedAt: e.unsubscribedAt },
      telegram: { status: t.status || "none", username: t.username || "", linked: !!t.chatId, topics: t.topics || {} },
    },
    stats: {
      orders: c.stats?.orders || 0,
      ltv: c.stats?.ltv || 0,
      avgOrder: c.stats?.avgOrder || 0,
      lastOrderAt: c.stats?.lastOrderAt || null,
      firstOrderAt: c.stats?.firstOrderAt || null,
      categories: c.stats?.categories || [],
      rfm: c.stats?.rfm || null,
    },
  };
}

// Експорт: лише бізнес-поля, без id/токенів/chatId
const EXPORT_HEADERS = [
  "email",
  "phone",
  "name",
  "kind",
  "city",
  "tags",
  "source",
  "email_status",
  "email_topics",
  "telegram_status",
  "telegram_username",
  "orders",
  "ltv",
  "last_order_at",
  "rfm_segment",
  "created_at",
];
function exportRow(c) {
  const e = c.channels?.email || {};
  const t = c.channels?.telegram || {};
  const iso = (d) => (d ? new Date(d).toISOString() : "");
  return [
    c.email || "",
    c.phone || "",
    c.name || "",
    c.kind || "",
    c.city || "",
    (c.tags || []).join(", "),
    c.source || "",
    e.status || "none",
    TOPICS.filter((k) => e.topics?.[k] === true).join(", "),
    t.status || "none",
    t.username || "",
    c.stats?.orders || 0,
    c.stats?.ltv || 0,
    iso(c.stats?.lastOrderAt),
    c.stats?.rfm?.segment || "",
    iso(c.createdAt),
  ];
}

// ---- імпорт CSV
const IMPORT_ALIASES = {
  "e-mail": "email",
  mail: "email",
  пошта: "email",
  "ел. пошта": "email",
  імя: "name",
  "ім'я": "name",
  "ім’я": "name",
  піб: "name",
  name: "name",
  телефон: "phone",
  tel: "phone",
  місто: "city",
  тип: "kind",
  теги: "tags",
  tag: "tags",
};
const KIND_ALIASES = {
  person: "person",
  фізособа: "person",
  "фіз. особа": "person",
  "фізична особа": "person",
  фоп: "company",
  company: "company",
  юрособа: "company",
  "юр. особа": "company",
  "юридична особа": "company",
};

// Рядки CSV → { ok:[{row, email, phone, name, city, kind, tags}], invalid:[{row, reason}] } з дедупом у файлі
function prepareImportRows(records) {
  const ok = [];
  const invalid = [];
  const seen = new Set();
  for (const { row, data } of records || []) {
    const rawEmail = str(data.email, 300);
    const rawPhone = str(data.phone, 40);
    const email = rawEmail ? cs.normalizeEmail(rawEmail) : "";
    const phone = rawPhone ? cs.normalizePhone(rawPhone) : "";
    if (rawEmail && !email) {
      invalid.push({ row, reason: "Некоректний e-mail" });
      continue;
    }
    if (!email && !phone) {
      invalid.push({ row, reason: rawPhone ? "Некоректний телефон" : "Немає e-mail або телефону" });
      continue;
    }
    const key = email ? `e:${email}` : `p:${phone}`;
    if (seen.has(key)) {
      invalid.push({ row, reason: "Дублікат у файлі" });
      continue;
    }
    seen.add(key);
    const kindRaw = str(data.kind, 40).toLowerCase();
    ok.push({
      row,
      email,
      phone,
      name: str(data.name, 200),
      city: str(data.city, 100),
      kind: KIND_ALIASES[kindRaw] || "unknown",
      tags: normTags(data.tags || ""),
    });
  }
  return { ok, invalid };
}

function decodeLinkKey(k) {
  try {
    return decodeURIComponent(k);
  } catch {
    return k;
  }
}

// ======================= обробники: контакти =======================

async function resolveListQuery(q) {
  const base = contactListQuery(q);
  if (!isId(q.segmentId)) return base;
  const seg = await Segment().findById(q.segmentId).lean();
  if (!seg) return base;
  return { $and: [base, engine.toMongoQuery(seg.filter)] };
}

exports.list_contacts = async (req, res) => {
  try {
    const q = req.query || {};
    const { page, limit, skip } = pageArgs(q);
    const where = await resolveListQuery(q);
    const [list, total] = await Promise.all([
      Contact().find(where).sort(sortOf(q.sort)).skip(skip).limit(limit).select("-marketingSentLog").lean(),
      Contact().countDocuments(where),
    ]);
    res.json({ contacts: list.map(listView), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (e) {
    if (e.code === "INVALID_FILTER") return bad(res, e.message);
    handleError(res, e, "crm → list_contacts");
  }
};

exports.export_contacts = async (req, res) => {
  try {
    const where = await resolveListQuery(req.query || {});
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="contacts-${date}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.write(csv.BOM + csv.stringifyRow(EXPORT_HEADERS));
    const cursor = Contact().find(where).sort(sortOf(req.query?.sort)).select("-marketingSentLog").lean().cursor({ batchSize: 500 });
    for await (const c of cursor) {
      if (!res.write(csv.stringifyRow(exportRow(c)))) await new Promise((r) => res.once("drain", r));
    }
    res.end();
  } catch (e) {
    if (res.headersSent) {
      console.error("💥 crm → export_contacts:", e.message);
      return res.end();
    }
    if (e.code === "INVALID_FILTER") return bad(res, e.message);
    handleError(res, e, "crm → export_contacts");
  }
};

exports.get_contact = async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, "Некоректний id");
    const c = await Contact().findById(req.params.id).lean();
    if (!c) return res.status(404).json({ error: "Контакт не знайдено" });
    const [consents, msgs] = await Promise.all([
      ConsentLog().find({ contactId: c._id }).sort({ at: -1 }).limit(200).lean(),
      Message().find({ contactId: c._id }).sort({ queuedAt: -1 }).limit(50).lean(),
    ]);
    const campIds = [...new Set(msgs.filter((m) => m.campaignId).map((m) => String(m.campaignId)))];
    const camps = campIds.length ? await Campaign().find({ _id: { $in: campIds } }).select("name subject").lean() : [];
    const cmap = new Map(camps.map((x) => [String(x._id), x]));
    let orders = { count: 0, ltv: c.stats?.ltv || 0, last5: [] };
    if (c.customerId) {
      const orderModel = require("../models/customerOrderModel");
      const [count, last5] = await Promise.all([
        orderModel.countDocuments({ customerId: c.customerId }),
        orderModel
          .find({ customerId: c.customerId })
          .sort({ createdAt: -1 })
          .limit(5)
          .select("orderNumber price payment_status delivery_status createdAt date")
          .lean(),
      ]);
      orders = { count, ltv: c.stats?.ltv || 0, last5 };
    }
    res.json({
      contact: { ...listView(c), notes: c.notes || "", anonymized: !!c.anonymized, marketingSentLog: (c.marketingSentLog || []).slice(-30) },
      consents: consents.map(({ ip, ...x }) => ({ ...x, ip: ip ? String(ip).replace(/(\d+)\.(\d+)$/, "*.*") : "" })),
      messages: msgs.map((m) => ({
        _id: m._id,
        campaignId: m.campaignId,
        campaign: m.campaignId ? cmap.get(String(m.campaignId))?.name || "" : "",
        automation: m.automation,
        step: m.step,
        channel: m.channel,
        status: m.status,
        skipReason: m.skipReason,
        error: m.error,
        queuedAt: m.queuedAt,
        sentAt: m.sentAt,
        clicks: m.clicks || 0,
      })),
      orders,
    });
  } catch (e) {
    handleError(res, e, "crm → get_contact");
  }
};

const reqMeta = (req, source) => ({ source, ip: req.ip || "", userAgent: String(req.get?.("user-agent") || "").slice(0, 500) });

exports.create_contact = async (req, res) => {
  try {
    const b = req.body || {};
    const email = b.email ? cs.normalizeEmail(String(b.email)) : "";
    const phone = b.phone ? cs.normalizePhone(String(b.phone)) : "";
    if (b.email && !email) return bad(res, "Некоректний e-mail");
    if (b.phone && !phone) return bad(res, "Некоректний телефон (формат +380…)");
    if (!email && !phone) return bad(res, "Вкажіть e-mail або телефон");
    const consent = b.consent && typeof b.consent === "object" ? b.consent : {};
    const proof = consent.proof === true;
    const note = str(consent.note, 500);
    if (proof && !note) return bad(res, "Опишіть підставу згоди (джерело/доказ)");
    if (proof && !email) return bad(res, "Підписати на e-mail розсилку можна лише контакт з e-mail");
    if (email && (await Contact().exists({ email }))) return res.status(409).json({ error: "Контакт з таким e-mail уже існує" });
    if (email && (await cs.isHashSuppressed(email))) return res.status(409).json({ error: "Ця адреса була анонімізована на запит власника — додавати її знову не можна" });
    const doc = await cs.upsertContact({
      email,
      phone,
      name: str(b.name, 200),
      kind: KINDS.includes(b.kind) ? b.kind : "unknown",
      city: str(b.city, 100),
      tags: normTags(b.tags),
      source: "admin",
    });
    if (!doc) return bad(res, "Не вдалося створити контакт");
    if (b.notes) {
      doc.notes = str(b.notes, 1000);
      await doc.save();
    }
    let out = doc;
    if (proof) out = await cs.grantExplicit(doc, { ...reqMeta(req, "admin"), text: note, textVersion: "admin" });
    res.status(201).json({ contact: listView(out.toObject ? out.toObject() : out) });
  } catch (e) {
    if (e?.code === 11000) return res.status(409).json({ error: "Контакт уже існує" });
    handleError(res, e, "crm → create_contact");
  }
};

exports.update_contact = async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, "Некоректний id");
    const doc = await Contact().findById(req.params.id);
    if (!doc || doc.anonymized) return res.status(404).json({ error: "Контакт не знайдено" });
    const b = req.body || {};
    if (b.name !== undefined) doc.name = str(b.name, 200);
    if (b.kind !== undefined) {
      if (!KINDS.includes(b.kind)) return bad(res, "Некоректний тип");
      doc.kind = b.kind;
    }
    if (b.city !== undefined) doc.city = str(b.city, 100);
    if (b.notes !== undefined) doc.notes = str(b.notes, 1000);
    if (b.tags !== undefined) doc.tags = normTags(b.tags);
    if (b.phone !== undefined) {
      const p = b.phone ? cs.normalizePhone(String(b.phone)) : "";
      if (b.phone && !p) return bad(res, "Некоректний телефон (формат +380…)");
      doc.phone = p || undefined;
    }
    await doc.save();
    let out = doc;
    if (b.topics && typeof b.topics === "object") out = await cs.setTopics(out, "email", b.topics, reqMeta(req, "admin"));
    if (b.telegramTopics && typeof b.telegramTopics === "object") out = await cs.setTopics(out, "telegram", b.telegramTopics, reqMeta(req, "admin"));
    if (b.frequency !== undefined) {
      if (!["normal", "weekly", "monthly"].includes(b.frequency)) return bad(res, "Некоректна частота");
      out.set("channels.email.frequency", b.frequency);
      await out.save();
    }
    res.json({ contact: listView(out.toObject()) });
  } catch (e) {
    handleError(res, e, "crm → update_contact");
  }
};

// PUT /contacts/:id/status {channel, status:'subscribed'|'unsubscribed', reason}
exports.set_status = async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, "Некоректний id");
    const { channel = "email", status } = req.body || {};
    const reason = str(req.body?.reason, 500);
    if (!["email", "telegram"].includes(channel)) return bad(res, "Некоректний канал");
    if (!["subscribed", "unsubscribed"].includes(status)) return bad(res, "Статус — subscribed або unsubscribed");
    if (status === "subscribed" && !reason) return bad(res, "Вкажіть підставу (згоду) для підписки");
    const doc = await Contact().findById(req.params.id);
    if (!doc || doc.anonymized) return res.status(404).json({ error: "Контакт не знайдено" });
    if (status === "subscribed" && channel === "email" && !doc.email) return bad(res, "У контакту немає e-mail");
    if (status === "subscribed" && channel === "telegram" && !doc.get("channels.telegram.chatId")) return bad(res, "Контакт не прив'язав Telegram — підписати неможливо");
    const prev = doc.get(`channels.${channel}.status`) || "none";
    if (prev === status) return res.json({ contact: listView(doc.toObject()), changed: false });
    const now = new Date();
    doc.set(`channels.${channel}.status`, status);
    if (status === "subscribed") {
      doc.set(`channels.${channel}.subscribedAt`, now);
      doc.set(`channels.${channel}.unsubscribedAt`, undefined);
      const t = doc.get(`channels.${channel}.topics`) || {};
      if (!TOPICS.some((k) => t[k] === true)) doc.set(`channels.${channel}.topics`, cs.defaultTopics());
      if (channel === "email") doc.set("channels.email.pendingSince", undefined);
    } else doc.set(`channels.${channel}.unsubscribedAt`, now);
    await doc.save();
    await cs.logConsent({ contactId: doc._id, channel, action: "admin_set", ...reqMeta(req, "admin"), text: reason, meta: { previous: prev, status, adminId: req.id ? String(req.id) : undefined } });
    res.json({ contact: listView(doc.toObject()), changed: true });
  } catch (e) {
    handleError(res, e, "crm → set_status");
  }
};

function parseForm(req) {
  const form = new IncomingForm({
    multiples: false,
    keepExtensions: true,
    allowEmptyFiles: false,
    maxFiles: 1,
    maxFileSize: IMPORT_MAX_BYTES,
    maxFields: 20,
    maxFieldsSize: 64 * 1024,
  });
  return new Promise((resolve) => {
    form.parse(req, (err, fields, files) => resolve({ err, fields: fields || {}, files: files || {} }));
  });
}
const one = (v) => (Array.isArray(v) ? v[0] : v);

// POST /contacts/import (multipart: file, consentProof, consentNote, dryRun)
exports.import_contacts = async (req, res) => {
  let files = {};
  try {
    const parsed = await parseForm(req);
    files = parsed.files;
    if (parsed.err) return bad(res, /maxFileSize/i.test(parsed.err.message || "") ? "Файл завеликий (до 5 МБ)" : "Помилка обробки форми");
    const f = parsed.fields;
    const file = one(files.file) || one(Object.values(files)[0]);
    if (!file?.filepath) return bad(res, "Додайте CSV-файл");
    const consentProof = truthy(one(f.consentProof));
    const consentNote = str(one(f.consentNote) || "", 500);
    const dryRun = truthy(one(f.dryRun));
    if (consentProof && !consentNote) return bad(res, "Опишіть джерело/доказ згоди (обов'язково, якщо імпорт підписує контакти)");
    const text = await fs.promises.readFile(file.filepath, "utf8");
    let rows;
    try {
      rows = csv.parse(text, { maxRows: IMPORT_MAX_ROWS + 1 });
    } catch (e) {
      return bad(res, e.code === "TOO_MANY_ROWS" ? `Не більше ${IMPORT_MAX_ROWS} рядків` : e.message);
    }
    const { headers, records } = csv.toObjects(rows, { aliases: IMPORT_ALIASES });
    if (!headers.includes("email") && !headers.includes("phone")) return bad(res, "Потрібна колонка email або phone (перший рядок — заголовки)");
    if (records.length > IMPORT_MAX_ROWS) return bad(res, `Не більше ${IMPORT_MAX_ROWS} рядків`);
    const result = await runImport(records, { consentProof, consentNote, dryRun, meta: reqMeta(req, "import"), fileName: str(file.originalFilename || "", 200) });
    res.json(result);
  } catch (e) {
    handleError(res, e, "crm → import_contacts");
  } finally {
    for (const v of Object.values(files || {})) for (const x of Array.isArray(v) ? v : [v]) if (x?.filepath) fs.promises.unlink(x.filepath).catch(() => {});
  }
};

async function runImport(records, { consentProof, consentNote, dryRun, meta, fileName }) {
  const { ok, invalid } = prepareImportRows(records);
  const emails = ok.filter((r) => r.email).map((r) => r.email);
  const phones = ok.filter((r) => !r.email && r.phone).map((r) => r.phone);
  const [byEmail, byPhone, suppressed] = await Promise.all([
    emails.length ? Contact().find({ email: { $in: emails } }).lean() : [],
    phones.length ? Contact().find({ phone: { $in: phones } }).lean() : [],
    emails.length ? SuppressedHash().find({ hash: { $in: emails.map(cs.emailHash) } }).select("hash").lean() : [],
  ]);
  const eMap = new Map(byEmail.map((c) => [c.email, c]));
  const pMap = new Map(byPhone.map((c) => [c.phone, c]));
  const sup = new Set(suppressed.map((s) => s.hash));
  const now = new Date();
  const creates = [];
  const updates = [];
  const subscribeIds = []; // для ConsentLog
  let skipped = 0;
  const skippedRows = [];

  for (const r of ok) {
    if (r.email && sup.has(cs.emailHash(r.email))) {
      skipped++;
      skippedRows.push({ row: r.row, reason: "Адресу анонімізовано на запит власника" });
      continue;
    }
    const existing = r.email ? eMap.get(r.email) : pMap.get(r.phone);
    if (existing) {
      if (existing.anonymized) {
        skipped++;
        continue;
      }
      const set = {};
      if (r.name && !existing.name) set.name = r.name;
      if (r.city && !existing.city) set.city = r.city;
      if (r.phone && !existing.phone) set.phone = r.phone;
      if (r.kind !== "unknown" && (!existing.kind || existing.kind === "unknown")) set.kind = r.kind;
      const tags = normTags([...(existing.tags || []), ...r.tags]);
      if (tags.length !== (existing.tags || []).length) set.tags = tags;
      const st = existing.channels?.email?.status || "none";
      const willSubscribe = consentProof && r.email && ["none", "pending", "cleaned"].includes(st);
      if (willSubscribe) {
        set["channels.email.status"] = "subscribed";
        set["channels.email.subscribedAt"] = now;
        const t = existing.channels?.email?.topics || {};
        if (!TOPICS.some((k) => t[k] === true)) set["channels.email.topics"] = cs.defaultTopics();
        subscribeIds.push({ id: existing._id, row: r.row, previous: st });
      }
      if (Object.keys(set).length) updates.push({ updateOne: { filter: { _id: existing._id }, update: { $set: set } } });
      else {
        skipped++;
        skippedRows.push({ row: r.row, reason: "Без змін" });
      }
      continue;
    }
    const _id = new mongoose.Types.ObjectId();
    const subscribe = consentProof && !!r.email;
    creates.push({
      _id,
      email: r.email || undefined,
      phone: r.phone || undefined,
      name: r.name,
      city: r.city,
      kind: r.kind,
      tags: r.tags,
      source: "import",
      lastActivityAt: now,
      channels: {
        email: subscribe ? { status: "subscribed", subscribedAt: now, topics: cs.defaultTopics(), frequency: "normal" } : { status: "none" },
        telegram: { status: "none" },
      },
    });
    if (subscribe) subscribeIds.push({ id: _id, row: r.row, previous: "none" });
  }

  const out = {
    dryRun: !!dryRun,
    total: records.length,
    created: creates.length,
    updated: updates.length,
    subscribed: subscribeIds.length,
    skipped,
    invalid: invalid.slice(0, 500),
    invalidCount: invalid.length,
    skippedRows: skippedRows.slice(0, 200),
  };
  if (dryRun) return out;

  let created = 0;
  for (let i = 0; i < creates.length; i += 500) {
    try {
      const r = await Contact().insertMany(creates.slice(i, i + 500), { ordered: false });
      created += r.length;
    } catch (e) {
      created += e?.insertedDocs?.length ?? e?.result?.insertedCount ?? 0; // дублікати (гонка) — пропускаємо
    }
  }
  for (let i = 0; i < updates.length; i += 500) await Contact().bulkWrite(updates.slice(i, i + 500), { ordered: false });
  if (subscribeIds.length) {
    const logs = subscribeIds.map((s) => ({
      contactId: s.id,
      channel: "email",
      topic: "all",
      action: "import",
      source: "import",
      at: now,
      ip: meta.ip,
      userAgent: meta.userAgent,
      text: consentNote,
      textVersion: "import",
      meta: { row: s.row, file: fileName || undefined, previous: s.previous },
    }));
    for (let i = 0; i < logs.length; i += 1000) await ConsentLog().insertMany(logs.slice(i, i + 1000), { ordered: false });
  }
  return { ...out, created };
}

exports.merge_contacts = async (req, res) => {
  try {
    const { primaryId, duplicateId } = req.body || {};
    if (!isId(primaryId) || !isId(duplicateId)) return bad(res, "Некоректні id");
    if (primaryId === duplicateId) return bad(res, "Оберіть два різні контакти");
    const [p, d] = await Promise.all([Contact().findById(primaryId), Contact().findById(duplicateId)]);
    if (!p || !d) return res.status(404).json({ error: "Контакт не знайдено" });
    const merged = await cs.mergeContacts(p, d);
    res.json({ contact: listView(merged.toObject()) });
  } catch (e) {
    handleError(res, e, "crm → merge_contacts");
  }
};

exports.delete_contact = async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, "Некоректний id");
    const doc = await Contact().findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Контакт не знайдено" });
    if (!doc.anonymized) await cs.anonymize(doc, reqMeta(req, "admin"));
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "crm → delete_contact");
  }
};

// POST /contacts/bulk {ids|filter, action, tag}
exports.bulk = async (req, res) => {
  try {
    const { ids, filter, action } = req.body || {};
    const tag = normTag(req.body?.tag);
    if (!["addTag", "removeTag", "unsubscribe", "delete"].includes(action)) return bad(res, "Невідома дія");
    if ((action === "addTag" || action === "removeTag") && !tag) return bad(res, "Вкажіть тег");
    let where;
    if (Array.isArray(ids)) {
      const list = ids.filter(isId).slice(0, BULK_MAX);
      if (!list.length) return bad(res, "Не обрано контактів");
      where = { _id: { $in: list }, anonymized: { $ne: true } };
    } else if (filter && typeof filter === "object") {
      where = engine.toMongoQuery(filter);
    } else return bad(res, "Передайте ids або filter");

    if (action === "addTag") {
      const r = await Contact().updateMany({ $and: [where, { [`tags.${MAX_TAGS - 1}`]: { $exists: false } }] }, { $addToSet: { tags: tag } });
      return res.json({ matched: r.matchedCount, modified: r.modifiedCount });
    }
    if (action === "removeTag") {
      const r = await Contact().updateMany(where, { $pull: { tags: tag } });
      return res.json({ matched: r.matchedCount, modified: r.modifiedCount });
    }
    const limit = action === "delete" ? BULK_DELETE_MAX : BULK_MAX;
    const docs = await Contact().find(where).limit(limit + 1);
    if (docs.length > limit) return bad(res, `За один раз — не більше ${limit} контактів`);
    let modified = 0;
    for (const d of docs) {
      if (action === "unsubscribe") {
        const before = d.get("channels.email.status");
        if (["pending", "subscribed", "cleaned"].includes(before)) {
          await cs.unsubscribe(d, { channel: "email", ...reqMeta(req, "admin_bulk") });
          modified++;
        }
        if (d.get("channels.telegram.status") === "subscribed") {
          await cs.unsubscribe(d, { channel: "telegram", ...reqMeta(req, "admin_bulk") });
          modified++;
        }
      } else {
        await cs.anonymize(d, reqMeta(req, "admin_bulk"));
        modified++;
      }
    }
    res.json({ matched: docs.length, modified });
  } catch (e) {
    if (e.code === "INVALID_FILTER") return bad(res, e.message, { errors: e.errors });
    handleError(res, e, "crm → bulk");
  }
};

// ======================= теги =======================

exports.list_tags = async (req, res) => {
  try {
    const list = await Contact().aggregate([
      { $match: { anonymized: { $ne: true }, "tags.0": { $exists: true } } },
      { $unwind: "$tags" },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 500 },
    ]);
    res.json({ tags: list.map((t) => ({ tag: t._id, count: t.count })) });
  } catch (e) {
    handleError(res, e, "crm → list_tags");
  }
};

exports.rename_tag = async (req, res) => {
  try {
    const from = normTag(req.body?.from);
    const to = normTag(req.body?.to);
    if (!from || !to) return bad(res, "Вкажіть старий і новий тег");
    if (from === to) return res.json({ modified: 0 });
    await Contact().updateMany({ tags: from }, { $addToSet: { tags: to } });
    const r = await Contact().updateMany({ tags: from }, { $pull: { tags: from } });
    res.json({ modified: r.modifiedCount });
  } catch (e) {
    handleError(res, e, "crm → rename_tag");
  }
};

exports.delete_tag = async (req, res) => {
  try {
    const tag = normTag(req.params.tag);
    if (!tag) return bad(res, "Вкажіть тег");
    const r = await Contact().updateMany({ tags: tag }, { $pull: { tags: tag } });
    res.json({ modified: r.modifiedCount });
  } catch (e) {
    handleError(res, e, "crm → delete_tag");
  }
};

// ======================= сегменти =======================

let systemEnsured = null;
const ensureSystem = () => {
  if (!systemEnsured) systemEnsured = engine.ensureSystemSegments().catch((e) => ((systemEnsured = null), Promise.reject(e)));
  return systemEnsured;
};

const segmentView = (s) => ({
  _id: s._id,
  name: s.name,
  description: s.description || engine.describe(s.filter),
  filter: s.filter,
  system: !!s.system,
  systemKey: s.systemKey,
  cachedCount: s.cachedCount || 0,
  cachedAt: s.cachedAt,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

exports.list_segments = async (req, res) => {
  try {
    await ensureSystem();
    const list = await Segment().find({}).sort({ system: -1, createdAt: -1 }).lean();
    res.json({ segments: list.map(segmentView), fields: engine.fieldCatalog() });
  } catch (e) {
    handleError(res, e, "crm → list_segments");
  }
};

function segmentInput(body) {
  const name = str(body?.name, 120);
  if (!name) return { error: "Вкажіть назву сегмента" };
  const v = engine.validate(body?.filter);
  if (!v.ok) return { error: v.errors.join("; "), errors: v.errors };
  return { value: { name, description: str(body?.description, 500) || engine.describe(v.value), filter: v.value } };
}

async function countFor(filter) {
  return Contact().countDocuments(engine.toMongoQuery(filter));
}

exports.create_segment = async (req, res) => {
  try {
    const r = segmentInput(req.body);
    if (r.error) return bad(res, r.error, { errors: r.errors });
    const seg = await Segment().create({ ...r.value, system: false, createdBy: isId(String(req.id || "")) ? req.id : null, cachedCount: await countFor(r.value.filter), cachedAt: new Date() });
    res.status(201).json({ segment: segmentView(seg.toObject()) });
  } catch (e) {
    handleError(res, e, "crm → create_segment");
  }
};

exports.update_segment = async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, "Некоректний id");
    const seg = await Segment().findById(req.params.id);
    if (!seg) return res.status(404).json({ error: "Сегмент не знайдено" });
    if (seg.system) return res.status(403).json({ error: "Системний сегмент лише для читання — створіть копію" });
    const r = segmentInput(req.body);
    if (r.error) return bad(res, r.error, { errors: r.errors });
    Object.assign(seg, r.value, { cachedCount: await countFor(r.value.filter), cachedAt: new Date() });
    seg.markModified("filter");
    await seg.save();
    res.json({ segment: segmentView(seg.toObject()) });
  } catch (e) {
    handleError(res, e, "crm → update_segment");
  }
};

exports.delete_segment = async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, "Некоректний id");
    const seg = await Segment().findById(req.params.id).lean();
    if (!seg) return res.status(404).json({ error: "Сегмент не знайдено" });
    if (seg.system) return res.status(403).json({ error: "Системний сегмент не можна видалити" });
    const used = await Campaign().exists({ segmentId: seg._id, status: { $in: ["scheduled", "sending"] } });
    if (used) return res.status(409).json({ error: "Сегмент використовує запланована/активна розсилка" });
    await Segment().deleteOne({ _id: seg._id });
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "crm → delete_segment");
  }
};

exports.preview_segment = async (req, res) => {
  try {
    const v = engine.validate(req.body?.filter);
    if (!v.ok) return bad(res, v.errors.join("; "), { errors: v.errors });
    const q = engine.toMongoQuery(v.value);
    const [count, sample] = await Promise.all([
      Contact().countDocuments(q),
      Contact().find(q).sort({ createdAt: -1 }).limit(10).select("-marketingSentLog").lean(),
    ]);
    res.json({ count, sample: sample.map(listView), description: engine.describe(v.value) });
  } catch (e) {
    handleError(res, e, "crm → preview_segment");
  }
};

exports.segment_contacts = async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, "Некоректний id");
    const seg = await Segment().findById(req.params.id).lean();
    if (!seg) return res.status(404).json({ error: "Сегмент не знайдено" });
    const { page, limit, skip } = pageArgs(req.query);
    const q = engine.toMongoQuery(seg.filter);
    const [list, total] = await Promise.all([
      Contact().find(q).sort(sortOf(req.query?.sort)).skip(skip).limit(limit).select("-marketingSentLog").lean(),
      Contact().countDocuments(q),
    ]);
    Segment()
      .updateOne({ _id: seg._id }, { $set: { cachedCount: total, cachedAt: new Date() } })
      .catch(() => {});
    res.json({ segment: segmentView(seg), contacts: list.map(listView), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (e) {
    if (e.code === "INVALID_FILTER") return bad(res, e.message);
    handleError(res, e, "crm → segment_contacts");
  }
};

// ======================= товари для блоку «products» =======================

exports.product_search = async (req, res) => {
  try {
    const productModel = require("../models/productModel");
    const { productView } = require("../utiles/emailTemplate");
    const q = str(req.query?.q, 60);
    const idList = String(req.query?.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(isId)
      .slice(0, 6);
    const filter = idList.length ? { _id: { $in: idList } } : q ? { name: { $regex: escapeRe(q), $options: "i" } } : {};
    const list = await productModel.find(filter).sort({ createdAt: -1 }).limit(12).select("name slug price discount images stock").lean();
    res.json({ products: list.map((p) => ({ ...productView(p), stock: p.stock })) });
  } catch (e) {
    handleError(res, e, "crm → product_search");
  }
};

// ======================= аналітика / RFM / health =======================

const countBy = (groups) => Object.fromEntries(groups.filter((g) => g._id !== null && g._id !== undefined && g._id !== "").map((g) => [String(g._id), g.n]));

exports.analytics = async (req, res) => {
  try {
    const base = { anonymized: { $ne: true } };
    const C = Contact();
    const since = new Date(Date.now() - 30 * DAY);
    const [emailSt, tgSt, topicsAgg, sources, kinds, rfm, growthSub, growthUnsub, campaigns] = await Promise.all([
      C.aggregate([{ $match: base }, { $group: { _id: "$channels.email.status", n: { $sum: 1 } } }]),
      C.aggregate([{ $match: base }, { $group: { _id: "$channels.telegram.status", n: { $sum: 1 } } }]),
      C.aggregate([
        { $match: { ...base, "channels.email.status": "subscribed" } },
        { $group: { _id: null, ...Object.fromEntries(TOPICS.map((k) => [k, { $sum: { $cond: [{ $eq: [`$channels.email.topics.${k}`, true] }, 1, 0] } }])) } },
      ]),
      C.aggregate([{ $match: base }, { $group: { _id: "$source", n: { $sum: 1 } } }]),
      C.aggregate([{ $match: base }, { $group: { _id: "$kind", n: { $sum: 1 } } }]),
      C.aggregate([{ $match: { ...base, "stats.rfm.segment": { $exists: true, $ne: null } } }, { $group: { _id: "$stats.rfm.segment", n: { $sum: 1 } } }]),
      ConsentLog().aggregate([
        { $match: { at: { $gte: since }, action: { $in: ["opt_in_confirm", "opt_in_explicit", "import", "telegram_start"] } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: "Europe/Kyiv" } }, n: { $sum: 1 } } },
      ]),
      ConsentLog().aggregate([
        { $match: { at: { $gte: since }, action: { $in: ["opt_out", "telegram_stop"] } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: "Europe/Kyiv" } }, n: { $sum: 1 } } },
      ]),
      Campaign().find({}).sort({ createdAt: -1 }).limit(10).select("name status stats startedAt finishedAt scheduledAt createdAt channels topic").lean(),
    ]);
    const sub = countBy(growthSub);
    const uns = countBy(growthUnsub);
    const growth = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY).toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
      growth.push({ date: d, subscribed: sub[d] || 0, unsubscribed: uns[d] || 0 });
    }
    const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] || 0]));
    const t = topicsAgg[0] || {};
    res.json({
      subscribers: {
        email: pick(countBy(emailSt), ["pending", "subscribed", "unsubscribed", "bounced", "complained", "cleaned", "none"]),
        telegram: pick(countBy(tgSt), ["subscribed", "unsubscribed", "blocked", "none"]),
      },
      growth,
      topics: pick(t, TOPICS),
      sources: countBy(sources),
      kinds: pick(countBy(kinds), KINDS),
      rfm: countBy(rfm),
      campaigns: campaigns.map((c) => {
        const s = c.stats || {};
        const sent = s.sent || 0;
        return { _id: c._id, name: c.name, status: c.status, channels: c.channels, topic: c.topic, stats: s, ctr: sent ? (s.clicks || 0) / sent : 0, unsubRate: sent ? (s.unsubscribed || 0) / sent : 0, at: c.finishedAt || c.startedAt || c.scheduledAt || c.createdAt };
      }),
    });
  } catch (e) {
    handleError(res, e, "crm → analytics");
  }
};

exports.rfm_recompute = async (req, res) => {
  try {
    const r = await require("../utiles/rfm").recomputeAll();
    res.json(r);
  } catch (e) {
    handleError(res, e, "crm → rfm_recompute");
  }
};

// Попередження health-панелі (чиста функція)
function healthWarnings(h) {
  const w = [];
  if (!h.resendConfigured) w.push("Не задано RESEND_API_KEY — масові листи не надсилаються.");
  if (!h.marketingFromConfigured) w.push("Не задано MARKETING_MAIL_FROM (окремий піддомен для розсилок) — кампанії чекатимуть у статусі «заплановано».");
  if (!h.webhookConfigured) w.push("Не задано RESEND_WEBHOOK_SECRET — bounce/скарги не обробляються автоматично.");
  if (h.complaintRate7d > 0.003) w.push(`Частка скарг за 7 днів ${(h.complaintRate7d * 100).toFixed(2)}% — вище порогу 0.3%. Призупиніть розсилки й перевірте аудиторію.`);
  if (h.bounceRate7d > 0.04) w.push(`Частка недоставлених за 7 днів ${(h.bounceRate7d * 100).toFixed(1)}% — очистіть базу.`);
  if (h.dailyLimit && h.sentToday >= h.dailyLimit) w.push("Денний ліміт відправки вичерпано — решта листів піде завтра.");
  if (h.worker && h.worker.enabled === false) w.push("Маркетинговий воркер вимкнено (MARKETING_WORKER=off) — розсилки не надсилаються.");
  if (h.stuckScheduled) w.push(`${h.stuckScheduled} розсилок чекають на налаштування відправника.`);
  return w;
}

exports.health = async (req, res) => {
  try {
    const mailer = require("../utiles/marketingMailer");
    const worker = require("../utiles/marketingWorker");
    const s = await mkSettings.load();
    const since = new Date(Date.now() - 7 * DAY);
    const [sentToday, sent7, complaints7, bounces7, stuckScheduled] = await Promise.all([
      worker.sentTodayCount(),
      Message().countDocuments({ status: "sent", channel: "email", sentAt: { $gte: since } }),
      ConsentLog().countDocuments({ action: "complaint", at: { $gte: since } }),
      ConsentLog().countDocuments({ action: "bounce", at: { $gte: since } }),
      Campaign().countDocuments({ status: "scheduled", scheduledAt: { $lte: new Date() }, lastError: { $nin: ["", null] } }),
    ]);
    const h = {
      resendConfigured: !!String(process.env.RESEND_API_KEY || "").trim(),
      marketingFromConfigured: !!mailer.resolveFrom(s),
      marketingFrom: mailer.resolveFrom(s) || null,
      webhookConfigured: !!String(process.env.RESEND_WEBHOOK_SECRET || "").trim(),
      telegramConfigured: worker.tgConfigured(),
      dnsHint:
        "Для піддомену розсилок (напр. news.ваш-домен.ua) додайте в DNS записи SPF і DKIM із панелі Resend та DMARC (_dmarc: «v=DMARC1; p=none; rua=mailto:…»), дочекайтеся статусу Verified. Транзакційні листи й розсилки — з різних піддоменів.",
      sentToday,
      dailyLimit: s.dailyLimit,
      sent7d: sent7,
      complaintRate7d: sent7 ? complaints7 / sent7 : 0,
      bounceRate7d: sent7 ? bounces7 / sent7 : 0,
      worker: worker.status(),
      stuckScheduled,
    };
    h.warnings = healthWarnings(h);
    res.json(h);
  } catch (e) {
    handleError(res, e, "crm → health");
  }
};

// ======================= налаштування / автоматизації =======================

exports.get_settings = async (req, res) => {
  try {
    res.json({ settings: await mkSettings.load(), envFrom: process.env.MARKETING_MAIL_FROM || "" });
  } catch (e) {
    handleError(res, e, "crm → get_settings");
  }
};

exports.save_settings = async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body.settings || req.body : {};
    res.json({ settings: await mkSettings.save(body) });
  } catch (e) {
    handleError(res, e, "crm → save_settings");
  }
};

exports.get_automations = async (req, res) => {
  try {
    const s = await mkSettings.load();
    res.json({ automations: s.automations });
  } catch (e) {
    handleError(res, e, "crm → get_automations");
  }
};

exports.save_automations = async (req, res) => {
  try {
    const a = req.body?.automations && typeof req.body.automations === "object" ? req.body.automations : req.body;
    if (!a || typeof a !== "object") return bad(res, "Некоректні дані");
    const s = await mkSettings.save({ automations: a });
    res.json({ automations: s.automations });
  } catch (e) {
    handleError(res, e, "crm → save_automations");
  }
};

exports.automation_stats = async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * DAY);
    const groups = await Message().aggregate([
      { $match: { automation: { $ne: null }, queuedAt: { $gte: since } } },
      { $group: { _id: { a: "$automation", s: "$status", st: "$step" }, n: { $sum: 1 }, clicks: { $sum: "$clicks" } } },
    ]);
    const out = {};
    for (const g of groups) {
      const a = (out[g._id.a] ||= { queued: 0, sent: 0, failed: 0, skipped: 0, clicks: 0, steps: {} });
      a[g._id.s] = (a[g._id.s] || 0) + g.n;
      a.clicks += g.clicks || 0;
      if (g._id.st !== undefined && g._id.st !== null) {
        const st = (a.steps[g._id.st] ||= { queued: 0, sent: 0, failed: 0, skipped: 0, clicks: 0 });
        st[g._id.s] = (st[g._id.s] || 0) + g.n;
        st.clicks += g.clicks || 0;
      }
    }
    res.json({ periodDays: 30, stats: out });
  } catch (e) {
    handleError(res, e, "crm → automation_stats");
  }
};

exports._pure = { contactListQuery, sortOf, listView, exportRow, EXPORT_HEADERS, prepareImportRows, normTags, pageArgs, healthWarnings, decodeLinkKey, truthy, IMPORT_ALIASES };
