// CRM-контакти й маркетингові згоди. Див. MARKETING_SPEC.md §0, §1, §6.
// Верхня частина — чисті функції (без БД, покриті тестами), нижня — операції з БД.
// Кожна зміна статусу каналу супроводжується записом у ConsentLog (append-only).

const crypto = require("crypto");

const DAY = 24 * 60 * 60 * 1000;
const TOPICS = ["promo", "news", "restock", "tips"];
const KINDS = ["person", "company", "unknown"];
const MAX_TAGS = 30;
const SENT_LOG_MAX = 30;

// Строгість статусів: строгіший перемагає при злитті
const STATUS_RANK = {
  none: 0,
  cleaned: 1,
  pending: 2,
  subscribed: 3,
  unsubscribed: 4,
  blocked: 5, // telegram
  bounced: 5,
  complained: 6,
};
const SUPPRESSED = ["unsubscribed", "bounced", "complained", "blocked"];

// ======================= чисті функції =======================

const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

// '' — якщо адреса некоректна
function normalizeEmail(s) {
  if (typeof s !== "string") return "";
  const e = s.trim().toLowerCase();
  if (!e || e.length > 254) return "";
  const at = e.lastIndexOf("@");
  if (at < 1 || at > 64) return "";
  return EMAIL_RE.test(e) ? e : "";
}

// Український номер → E.164 (+380XXXXXXXXX) або ''. Приймає 0XXXXXXXXX, 80…, 380…, +380…, 00380…
// з пробілами, дужками, дефісами, крапками.
function normalizePhone(s) {
  if (typeof s !== "string" && typeof s !== "number") return "";
  const raw = String(s).trim();
  if (!raw || raw.length > 32) return "";
  if (!/^\+?[\d\s().-]+$/.test(raw)) return "";
  if (raw.indexOf("+") > 0) return "";
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (/^0\d{9}$/.test(d)) d = "38" + d;
  else if (/^80\d{9}$/.test(d)) d = "3" + d;
  if (!/^380[1-9]\d{8}$/.test(d)) return "";
  return "+" + d;
}

// 'ivan@example.com' → 'i***@example.com'
function maskEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return "";
  const at = e.lastIndexOf("@");
  return `${e[0]}***${e.slice(at)}`;
}

// SHA-256 (hex) від нормалізованої адреси; '' для некоректної
function emailHash(email) {
  const e = normalizeEmail(email);
  return e ? crypto.createHash("sha256").update(e).digest("hex") : "";
}

function defaultTopics() {
  return { promo: true, news: true, restock: true, tips: false };
}

const anyTopic = (t) => !!t && TOPICS.some((k) => t[k] === true);
const plain = (t) => {
  const src = t && typeof t.toObject === "function" ? t.toObject() : t || {};
  const out = {};
  for (const k of TOPICS) out[k] = src[k] === true;
  return out;
};

// Маркетинговий e-mail дозволений: підписка + увімкнена тема (topic не вказано/'all' — будь-яка тема)
function canEmail(contact, topic) {
  const ch = contact?.channels?.email;
  if (!contact || contact.anonymized || !normalizeEmail(contact.email || "")) return false;
  if (!ch || ch.status !== "subscribed") return false;
  if (!topic || topic === "all") return anyTopic(ch.topics);
  return ch.topics?.[topic] === true;
}

function canTelegram(contact, topic) {
  const ch = contact?.channels?.telegram;
  if (!contact || contact.anonymized || !ch || !ch.chatId) return false;
  if (ch.status !== "subscribed") return false;
  if (!topic || topic === "all") return anyTopic(ch.topics);
  return ch.topics?.[topic] === true;
}

function isSuppressedStatus(status) {
  return SUPPRESSED.includes(status);
}

// Строгіший статус: complained > bounced > unsubscribed > subscribed > pending > cleaned > none
function mergeStatus(a, b) {
  const ra = STATUS_RANK[a] ?? -1;
  const rb = STATUS_RANK[b] ?? -1;
  if (ra < 0 && rb < 0) return "none";
  return rb > ra ? b : a;
}

// Нові теми: лише відомі ключі й лише булеві значення з patch
function applyTopics(current, patch) {
  const out = plain(current);
  if (patch && typeof patch === "object") {
    for (const k of TOPICS) if (typeof patch[k] === "boolean") out[k] = patch[k];
  }
  return out;
}

// Чи можна ще одне маркетингове повідомлення (по всіх каналах) за останні `days` днів
function frequencyAllowed(contact, { max = 2, days = 7 } = {}, now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const since = t - Number(days) * DAY;
  const log = Array.isArray(contact?.marketingSentLog) ? contact.marketingSentLog : [];
  const count = log.filter((e) => {
    const at = new Date(e?.at).getTime();
    return Number.isFinite(at) && at > since && at <= t;
  }).length;
  return count < Number(max);
}

// Додає запис у marketingSentLog (мутує contact), залишає останні 30. Повертає новий журнал
function pushSentLog(contact, entry = {}) {
  const item = {
    at: entry.at ? new Date(entry.at) : new Date(),
    channel: entry.channel || "email",
    campaignId: entry.campaignId || null,
    automation: entry.automation || null,
  };
  const prev = Array.isArray(contact.marketingSentLog) ? [...contact.marketingSentLog] : [];
  prev.push(item);
  prev.sort((a, b) => new Date(a.at) - new Date(b.at));
  contact.marketingSentLog = prev.slice(-SENT_LOG_MAX);
  return contact.marketingSentLog;
}

// Чи можна підтвердити double opt-in. pending → так; unsubscribed → лише якщо після відписки був новий
// явний запит (pendingSince новіший за unsubscribedAt). bounced/complained/cleaned/none — ні.
function canConfirmOptIn(email = {}) {
  const st = email?.status || "none";
  if (st === "pending") return true;
  if (st !== "unsubscribed" || !email.pendingSince) return false;
  const ps = new Date(email.pendingSince).getTime();
  const us = email.unsubscribedAt ? new Date(email.unsubscribedAt).getTime() : 0;
  return Number.isFinite(ps) && ps > (Number.isFinite(us) ? us : 0);
}

// Чи дозволена повторна підписка (resubscribe) з поточного статусу. allowFrom — дозволені вихідні статуси;
// bounced/complained ніколи (лише адмін вручну).
function canResubscribe(status, allowFrom = ["unsubscribed"]) {
  const st = status || "none";
  if (st === "bounced" || st === "complained") return false;
  return allowFrom.includes(st);
}

const OID_RE = /^[a-f\d]{24}$/i;
const CREDIT_FIELDS = { unsubscribed: "unsubscribedAt", complained: "complainedAt", bounced: "bouncedAt" };
const CREDIT_WINDOW_DAYS = 7;

// Умова пошуку повідомлення кампанії, якому зарахувати подію (відписка/скарга/bounce) — один раз на повідомлення.
// messageId → саме це повідомлення; campaignId → повідомлення цієї кампанії контакту; інакше — останнє надіслане
// повідомлення кампанії за 7 днів. → { filter, sort, flag } | null
function creditFilter({ contactId, campaignId, messageId, field, now = Date.now() } = {}) {
  const flag = CREDIT_FIELDS[field];
  if (!flag) return null;
  const notYet = { [flag]: { $exists: false } };
  if (messageId && OID_RE.test(String(messageId))) {
    return { filter: { _id: String(messageId), campaignId: { $ne: null }, ...notYet }, sort: null, flag };
  }
  if (!contactId) return null;
  const base = { contactId, status: "sent", ...notYet };
  if (campaignId && OID_RE.test(String(campaignId))) return { filter: { ...base, campaignId: String(campaignId) }, sort: { sentAt: -1 }, flag };
  const t = now instanceof Date ? now.getTime() : Number(now);
  return { filter: { ...base, campaignId: { $ne: null }, sentAt: { $gte: new Date(t - CREDIT_WINDOW_DAYS * DAY) } }, sort: { sentAt: -1 }, flag };
}

const normTags = (list) =>
  [...new Set((Array.isArray(list) ? list : []).map((t) => String(t || "").trim().toLowerCase().slice(0, 50)).filter(Boolean))].slice(
    0,
    MAX_TAGS
  );

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ======================= БД =======================

const Contact = () => require("../models/contactModel");
const ConsentLog = () => require("../models/consentLogModel");
const SuppressedHash = () => require("../models/suppressedHashModel");

// Документ Mongoose з документа / lean-об'єкта / id
async function toDoc(c) {
  if (!c) throw new Error("Контакт не вказано");
  if (typeof c.save === "function") return c;
  const id = c._id || c;
  const d = await Contact().findById(id);
  if (!d) throw new Error("Контакт не знайдено");
  return d;
}

const get = (doc, p) => (typeof doc.get === "function" ? doc.get(p) : p.split(".").reduce((o, k) => o?.[k], doc));
const set = (doc, p, v) => (typeof doc.set === "function" ? doc.set(p, v) : null);

async function logConsent({
  contactId,
  channel = "email",
  topic = "all",
  action,
  source = "",
  ip = "",
  userAgent = "",
  text = "",
  textVersion = "",
  meta,
} = {}) {
  return ConsentLog().create({
    contactId,
    channel,
    topic,
    action,
    source: str(source, 100),
    at: new Date(),
    ip: str(ip, 100),
    userAgent: str(userAgent, 500),
    text: str(text, 2000),
    textVersion: str(textVersion, 20),
    meta: meta && typeof meta === "object" ? meta : undefined,
  });
}

// Знайти (email → customerId → телефон) або створити контакт; дозаповнює порожні поля.
// Статуси каналів НЕ змінює. → документ | null (немає жодного ідентифікатора)
async function upsertContact({ email, phone, name, kind, city, source, customerId, tags } = {}) {
  const e = normalizeEmail(email || "");
  const p = normalizePhone(phone || "");
  if (!e && !p && !customerId) return null;
  const M = Contact();

  let doc = null;
  if (e) doc = await M.findOne({ email: e });
  if (!doc && customerId) doc = await M.findOne({ customerId });
  if (!doc && p) doc = await M.findOne({ phone: p, ...(e ? { $or: [{ email: { $exists: false } }, { email: null }, { email: "" }] } : {}) });

  const k = KINDS.includes(kind) ? kind : "unknown";
  const n = str(name, 200);
  const ct = str(city, 100);
  const tg = normTags(tags);

  if (!doc) {
    try {
      return await M.create({
        email: e || undefined,
        phone: p || undefined,
        name: n,
        kind: k,
        city: ct,
        source: str(source, 50),
        customerId: customerId || null,
        tags: tg,
        lastActivityAt: new Date(),
      });
    } catch (err) {
      if (err?.code !== 11000 || !e) throw err;
      doc = await M.findOne({ email: e }); // гонка: створили паралельно
      if (!doc) throw err;
    }
  }

  if (e && !doc.email) {
    const taken = await M.exists({ email: e, _id: { $ne: doc._id } });
    if (!taken) doc.email = e;
  }
  if (p && !doc.phone) doc.phone = p;
  if (n && !doc.name) doc.name = n;
  if (ct && !doc.city) doc.city = ct;
  if (k !== "unknown" && (!doc.kind || doc.kind === "unknown")) doc.kind = k;
  if (customerId && !doc.customerId) doc.customerId = customerId;
  if (source && !doc.source) doc.source = str(source, 50);
  if (tg.length) doc.tags = normTags([...(doc.tags || []), ...tg]);
  doc.lastActivityAt = new Date();
  await doc.save();
  return doc;
}

// Footer-форма: double opt-in → pending. Уже підписаний — без змін
async function requestOptIn(contact, { source = "footer", ip, userAgent, text, textVersion, topics } = {}) {
  const doc = await toDoc(contact);
  const prev = get(doc, "channels.email.status") || "none";
  if (prev === "subscribed") return doc;
  // bounced/complained не «воскресають» через форму (будь-хто може ввести чужу адресу)
  if (prev === "bounced" || prev === "complained") return doc;
  const now = new Date();
  // unsubscribed лишається unsubscribed до підтвердження за посиланням (інакше сторонній запит «відмив» би відписку)
  if (prev !== "unsubscribed") set(doc, "channels.email.status", "pending");
  set(doc, "channels.email.pendingSince", now);
  set(doc, "channels.email.topics", applyTopics(defaultTopics(), topics));
  doc.lastActivityAt = now;
  await doc.save();
  await logConsent({
    contactId: doc._id,
    channel: "email",
    action: "opt_in_request",
    source,
    ip,
    userAgent,
    text,
    textVersion,
    meta: { previous: prev, ...(topics ? { topics: applyTopics(defaultTopics(), topics) } : {}) },
  });
  return doc;
}

// Підтвердження за посиланням із листа → subscribed (лише з pending або з unsubscribed після нового запиту)
async function confirmOptIn(contact, { ip, userAgent } = {}) {
  const doc = await toDoc(contact);
  if (get(doc, "channels.email.status") === "subscribed") return doc;
  const em = {
    status: get(doc, "channels.email.status"),
    pendingSince: get(doc, "channels.email.pendingSince"),
    unsubscribedAt: get(doc, "channels.email.unsubscribedAt"),
  };
  if (!canConfirmOptIn(em)) return doc;
  const now = new Date();
  set(doc, "channels.email.status", "subscribed");
  set(doc, "channels.email.confirmedAt", now);
  set(doc, "channels.email.subscribedAt", now);
  set(doc, "channels.email.unsubscribedAt", undefined);
  set(doc, "channels.email.pendingSince", undefined);
  const t = get(doc, "channels.email.topics");
  if (!anyTopic(t)) set(doc, "channels.email.topics", defaultTopics());
  doc.lastActivityAt = now;
  await doc.save();
  await logConsent({ contactId: doc._id, channel: "email", action: "opt_in_confirm", source: "confirm_link", ip, userAgent });
  return doc;
}

// Явна галочка (реєстрація/оформлення) → subscribed одразу
async function grantExplicit(contact, { source = "checkout", ip, userAgent, text, textVersion, topics } = {}) {
  const doc = await toDoc(contact);
  const now = new Date();
  const prev = get(doc, "channels.email.status");
  // bounced/complained — адреса недоступна або була скарга: лише адмін може вручну зняти блокування
  if (prev === "bounced" || prev === "complained") return doc;
  const wasSubscribed = prev === "subscribed";
  set(doc, "channels.email.status", "subscribed");
  if (!wasSubscribed) set(doc, "channels.email.subscribedAt", now);
  set(doc, "channels.email.unsubscribedAt", undefined);
  set(doc, "channels.email.pendingSince", undefined);
  const cur = get(doc, "channels.email.topics");
  const next = topics ? applyTopics(anyTopic(cur) ? cur : defaultTopics(), topics) : anyTopic(cur) ? plain(cur) : defaultTopics();
  set(doc, "channels.email.topics", anyTopic(next) ? next : defaultTopics());
  doc.lastActivityAt = now;
  await doc.save();
  await logConsent({ contactId: doc._id, channel: "email", action: "opt_in_explicit", source, ip, userAgent, text, textVersion });
  return doc;
}

// Відписка від усього маркетингу каналу (bounced/complained/blocked лишаються — вони строгіші)
async function unsubscribe(contact, { channel = "email", source = "link", ip, userAgent, reason } = {}) {
  const doc = await toDoc(contact);
  const ch = channel === "telegram" ? "telegram" : "email";
  const cur = get(doc, `channels.${ch}.status`) || "none";
  if (isSuppressedStatus(cur)) return doc;
  const now = new Date();
  set(doc, `channels.${ch}.status`, "unsubscribed");
  set(doc, `channels.${ch}.unsubscribedAt`, now);
  if (ch === "email") set(doc, "channels.email.pendingSince", undefined);
  doc.lastActivityAt = now;
  await doc.save();
  await logConsent({
    contactId: doc._id,
    channel: ch,
    action: "opt_out",
    source,
    ip,
    userAgent,
    meta: reason ? { reason: str(reason, 500), previous: cur } : { previous: cur },
  });
  return doc;
}

// Зміна тем каналу. meta: { source, ip, userAgent }
async function setTopics(contact, channel, patch, meta = {}) {
  const doc = await toDoc(contact);
  const ch = channel === "telegram" ? "telegram" : "email";
  const before = plain(get(doc, `channels.${ch}.topics`));
  const after = applyTopics(before, patch);
  const changed = TOPICS.filter((k) => before[k] !== after[k]);
  if (!changed.length) return doc;
  set(doc, `channels.${ch}.topics`, after);
  doc.lastActivityAt = new Date();
  await doc.save();
  await logConsent({
    contactId: doc._id,
    channel: ch,
    topic: changed.length === 1 ? changed[0] : "all",
    action: "topic_change",
    source: meta.source || "preferences",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: { before, after },
  });
  return doc;
}

async function markBounced(contact, { source = "resend", meta } = {}) {
  const doc = await toDoc(contact);
  const cur = get(doc, "channels.email.status") || "none";
  if (cur !== "complained" && cur !== "bounced") {
    set(doc, "channels.email.status", "bounced");
    await doc.save();
  }
  await logConsent({ contactId: doc._id, channel: "email", action: "bounce", source, meta: { ...(meta || {}), previous: cur } });
  return doc;
}

async function markComplained(contact, { source = "resend", meta } = {}) {
  const doc = await toDoc(contact);
  const cur = get(doc, "channels.email.status") || "none";
  if (cur !== "complained") {
    set(doc, "channels.email.status", "complained");
    await doc.save();
  }
  await logConsent({ contactId: doc._id, channel: "email", action: "complaint", source, meta: { ...(meta || {}), previous: cur } });
  return doc;
}

// Тип клієнта з акаунта: явне поле kind/customerType, інакше збережені організації → company, інакше unknown
function kindOfCustomer(customer) {
  const k = customer?.kind || customer?.customerType;
  if (KINDS.includes(k)) return k;
  if (Array.isArray(customer?.savedCompanies) && customer.savedCompanies.length) return "company";
  return "unknown";
}

// Реєстрація / гостьове оформлення / Google (§6). explicit=true → subscribed з журналом;
// інакше лише CRM-запис (статус каналу не змінюється, для нового — 'none')
async function upsertFromCustomer({ customer, source = "customer", explicit = false, text, textVersion, ip, userAgent } = {}) {
  if (!customer) return null;
  const doc = await upsertContact({
    email: customer.email,
    phone: customer.phone,
    name: customer.name,
    kind: kindOfCustomer(customer),
    source,
    customerId: customer._id || null,
  });
  if (!doc) return null;
  if (explicit === true && doc.email) {
    return grantExplicit(doc, { source, ip, userAgent, text, textVersion });
  }
  return doc;
}

const earliest = (a, b) => (a && b ? (new Date(a) < new Date(b) ? a : b) : a || b || undefined);
const latest = (a, b) => (a && b ? (new Date(a) > new Date(b) ? a : b) : a || b || undefined);

// Злиття дубліката в основний контакт: строгіші статуси перемагають, теги/журнали об'єднуються,
// історія згод дубліката копіюється (append-only) з позначкою mergedFrom. Дублікат видаляється.
async function mergeContacts(primary, duplicate) {
  const p = await toDoc(primary);
  const d = await toDoc(duplicate);
  if (String(p._id) === String(d._id)) return p;

  // email-канал
  const pe = (p.toObject().channels || {}).email || {};
  const de = (d.toObject().channels || {}).email || {};
  const status = mergeStatus(pe.status || "none", de.status || "none");
  const winner = status === (pe.status || "none") ? pe : de;
  set(p, "channels.email.status", status);
  set(p, "channels.email.topics", plain(winner.topics));
  set(p, "channels.email.frequency", winner.frequency || pe.frequency || "normal");
  set(p, "channels.email.confirmedAt", earliest(pe.confirmedAt, de.confirmedAt));
  set(p, "channels.email.subscribedAt", earliest(pe.subscribedAt, de.subscribedAt));
  set(p, "channels.email.unsubscribedAt", latest(pe.unsubscribedAt, de.unsubscribedAt));
  set(p, "channels.email.pendingSince", status === "pending" ? winner.pendingSince : undefined);

  // telegram-канал: якщо в основного немає чату — беремо дубліката
  const pt = (p.toObject().channels || {}).telegram || {};
  const dt = (d.toObject().channels || {}).telegram || {};
  if (!pt.chatId && dt.chatId) set(p, "channels.telegram", dt);
  else if (pt.chatId && dt.chatId === pt.chatId) set(p, "channels.telegram.status", mergeStatus(pt.status || "none", dt.status || "none"));

  const dupEmail = d.email;
  const dupPhone = d.phone;
  for (const f of ["name", "city", "source"]) if (!p[f] && d[f]) p[f] = d[f];
  if ((!p.kind || p.kind === "unknown") && d.kind && d.kind !== "unknown") p.kind = d.kind;
  if (!p.customerId && d.customerId) p.customerId = d.customerId;
  if (d.notes) p.notes = [p.notes, d.notes].filter(Boolean).join("\n").slice(0, 1000);
  p.tags = normTags([...(p.tags || []), ...(d.tags || [])]);
  p.marketingSentLog = [...(p.marketingSentLog || []), ...(d.marketingSentLog || [])]
    .map((x) => (typeof x.toObject === "function" ? x.toObject() : x))
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .slice(-SENT_LOG_MAX);
  if ((d.stats?.orders || 0) > (p.stats?.orders || 0)) p.stats = d.toObject().stats;
  p.lastActivityAt = latest(p.lastActivityAt, d.lastActivityAt);

  // історія згод (копії) і повідомлення
  const logs = await ConsentLog().find({ contactId: d._id }).lean();
  if (logs.length) {
    await ConsentLog().insertMany(
      logs.map(({ _id, ...l }) => ({ ...l, contactId: p._id, meta: { ...(l.meta || {}), mergedFrom: String(d._id), originalLogId: String(_id) } }))
    );
  }
  await require("../models/campaignMessageModel").updateMany({ contactId: d._id }, { $set: { contactId: p._id } });

  // спершу видаляємо дублікат — звільняємо унікальний email
  await Contact().deleteOne({ _id: d._id });
  if (!p.email && dupEmail) p.email = dupEmail;
  if (!p.phone && dupPhone) p.phone = dupPhone;
  await p.save();
  await logConsent({
    contactId: p._id,
    channel: "email",
    action: "merge",
    source: "admin",
    meta: { duplicateId: String(d._id), duplicateEmailHash: emailHash(dupEmail || "") || undefined },
  });
  return p;
}

// Зарахувати подію (unsubscribed|complained|bounced) кампанії: атомарно позначає повідомлення (один раз)
// і робить $inc Campaign.stats.<field>. → true, якщо зараховано. models — для тестів
async function creditCampaign(opts = {}, models = {}) {
  const spec = creditFilter(opts);
  if (!spec) return false;
  const Message = models.Message || require("../models/campaignMessageModel");
  const Campaign = models.Campaign || require("../models/campaignModel");
  const at = new Date(opts.now instanceof Date ? opts.now.getTime() : opts.now || Date.now());
  const msg = await Message.findOneAndUpdate(spec.filter, { $set: { [spec.flag]: at } }, { new: false, ...(spec.sort ? { sort: spec.sort } : {}), projection: { campaignId: 1 } });
  if (!msg?.campaignId) return false;
  await Campaign.updateOne({ _id: msg.campaignId }, { $inc: { [`stats.${opts.field}`]: 1 } });
  return true;
}

// Видалення персональних даних: лишаються агрегати (stats, журнал розсилок); хеш e-mail — у suppressedhashes
async function anonymize(contact, { source = "admin", ip, userAgent } = {}) {
  const doc = await toDoc(contact);
  const hash = emailHash(doc.email || "");
  if (hash) {
    await SuppressedHash().updateOne({ hash }, { $setOnInsert: { hash, at: new Date() } }, { upsert: true });
  }
  await logConsent({ contactId: doc._id, channel: "email", action: "erasure", source, ip, userAgent, meta: hash ? { emailHash: hash } : undefined });

  doc.email = undefined;
  doc.phone = undefined;
  doc.name = "";
  doc.city = "";
  doc.notes = "";
  doc.tags = [];
  doc.customerId = null;
  doc.anonymized = true;
  doc.erasureRequested = false;
  const now = new Date();
  const es = get(doc, "channels.email.status");
  if (!isSuppressedStatus(es)) set(doc, "channels.email.status", "unsubscribed");
  set(doc, "channels.email.unsubscribedAt", now);
  set(doc, "channels.email.pendingSince", undefined);
  set(doc, "channels.telegram.status", get(doc, "channels.telegram.status") === "none" ? "none" : "unsubscribed");
  set(doc, "channels.telegram.chatId", undefined);
  set(doc, "channels.telegram.username", "");
  await doc.save();
  return doc;
}

async function isHashSuppressed(email) {
  const hash = emailHash(email);
  if (!hash) return false;
  return !!(await SuppressedHash().exists({ hash }));
}

module.exports = {
  TOPICS,
  KINDS,
  STATUS_RANK,
  // чисті
  normalizeEmail,
  normalizePhone,
  maskEmail,
  emailHash,
  defaultTopics,
  canEmail,
  canTelegram,
  isSuppressedStatus,
  mergeStatus,
  applyTopics,
  frequencyAllowed,
  pushSentLog,
  kindOfCustomer,
  canConfirmOptIn,
  canResubscribe,
  creditFilter,
  // БД
  creditCampaign,
  logConsent,
  upsertContact,
  requestOptIn,
  confirmOptIn,
  grantExplicit,
  unsubscribe,
  setTopics,
  markBounced,
  markComplained,
  upsertFromCustomer,
  mergeContacts,
  anonymize,
  isHashSuppressed,
};
