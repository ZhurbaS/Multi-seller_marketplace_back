// Адмін: розсилки (MARKETING_SPEC.md §7 «Кампанії», §8). Маршрути — routes/crmRoutes.js (/api/admin/crm/campaigns).
// Відправку виконує utiles/marketingWorker.js; тут — CRUD, прев'ю, тест, оцінка аудиторії, запуск, скасування, звіт.

const mongoose = require("mongoose");
const handleError = require("../utiles/handleError");
const engine = require("../utiles/segmentEngine");
const mkSettings = require("../utiles/marketingSettings");

const Campaign = () => require("../models/campaignModel");
const Message = () => require("../models/campaignMessageModel");
const Segment = () => require("../models/segmentModel");
const worker = () => require("../utiles/marketingWorker");
const mailer = () => require("../utiles/marketingMailer");
const template = () => require("../utiles/emailTemplate");

const DAY = 24 * 60 * 60 * 1000;
const TOPICS = ["promo", "news", "tips"];
const CHANNELS = ["email", "telegram"];
const EDITABLE = ["draft", "scheduled"];
const MAX_SCHEDULE_DAYS = 90;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isId = (v) => typeof v === "string" && /^[a-f\d]{24}$/i.test(v) && mongoose.Types.ObjectId.isValid(v);
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const bad = (res, error, extra = {}) => res.status(400).json({ error, ...extra });

// ======================= чисті помічники =======================

// Тіло запиту → поля кампанії. partial=true — лише передані поля. → { value, errors }
function normalizeCampaignInput(body = {}, { partial = false } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const v = {};
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has("name")) {
    v.name = str(b.name, 200);
    if (!v.name) errors.push("Вкажіть назву розсилки");
  }
  if (!partial || has("subject")) v.subject = str(b.subject, 200);
  if (!partial || has("preheader")) v.preheader = str(b.preheader, 250);
  if (!partial || has("blocks")) v.blocks = mkSettings.normalizeBlocks(b.blocks);
  if (!partial || has("topic")) {
    v.topic = TOPICS.includes(b.topic) ? b.topic : "promo";
    if (has("topic") && !TOPICS.includes(b.topic)) errors.push("Тема розсилки — promo, news або tips");
  }
  if (!partial || has("channels")) {
    const ch = Array.isArray(b.channels) ? [...new Set(b.channels.filter((c) => CHANNELS.includes(c)))] : ["email"];
    v.channels = ch.length ? ch : ["email"];
  }
  if (!partial || has("segmentId") || has("filter")) {
    const seg = b.segmentId ? String(b.segmentId) : "";
    if (seg) {
      if (!isId(seg)) errors.push("Некоректний сегмент");
      v.segmentId = seg;
      v.filter = null;
    } else if (b.filter) {
      const r = engine.validate(b.filter);
      if (!r.ok) errors.push(...r.errors);
      v.filter = r.value;
      v.segmentId = null;
    } else {
      v.segmentId = null;
      v.filter = null;
    }
  }
  if (!partial || has("utm")) {
    const u = b.utm && typeof b.utm === "object" ? b.utm : {};
    const tok = (x, d) => str(x, 100).replace(/[^\w.-]/g, "_") || d;
    v.utm = { campaign: tok(u.campaign, ""), source: tok(u.source, "email"), medium: tok(u.medium, "newsletter") };
  }
  if (!partial || has("telegramText")) v.telegramText = typeof b.telegramText === "string" ? b.telegramText.slice(0, 4000).trim() : "";
  return { value: v, errors };
}

// Перевірка перед відправкою → null | { error, hint? }
function sendBlockers(c, { emailConfigured, emailHint, tgConfigured, estimate } = {}) {
  const channels = c.channels || [];
  if (!channels.length) return { error: "Оберіть хоча б один канал" };
  const email = channels.includes("email");
  const tg = channels.includes("telegram");
  if (email && !String(c.subject || "").trim()) return { error: "Вкажіть тему листа" };
  if (!Array.isArray(c.blocks) || !c.blocks.length) {
    if (email || !String(c.telegramText || "").trim()) return { error: "Додайте зміст листа (хоча б один блок)" };
  }
  if (!c.segmentId && !c.filter) return { error: "Оберіть сегмент або задайте фільтр отримувачів" };
  if (email && !emailConfigured) return { error: "Відправка e-mail не налаштована", hint: emailHint || "Задайте RESEND_API_KEY і MARKETING_MAIL_FROM у .env бека" };
  if (tg && !email && !tgConfigured) return { error: "Telegram-бот не налаштовано", hint: "Задайте TELEGRAM_BOT_TOKEN у .env бека" };
  if (!estimate || !(estimate.eligible > 0)) {
    return { error: "Немає жодного отримувача, якому можна надіслати", hint: "Перевірте сегмент і розбивку виключень (estimate): підписка, тема, частота" };
  }
  return null;
}

// scheduleAt → Date (зараз, якщо порожньо) | { error }
function parseSchedule(v, now = Date.now()) {
  if (v === undefined || v === null || v === "") return { at: new Date(now) };
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return { error: "Некоректна дата відправки" };
  if (d.getTime() < now - 60 * 1000) return { error: "Дата відправки в минулому" };
  if (d.getTime() > now + MAX_SCHEDULE_DAYS * DAY) return { error: `Запланувати можна не далі ніж на ${MAX_SCHEDULE_DAYS} днів` };
  return { at: d };
}

// Лічильник кліків пише ключі links як encodeURIComponent(url) з «.» → %2E; у звіті — декодуємо
function decodeLinkKey(k) {
  try {
    return decodeURIComponent(String(k));
  } catch {
    return String(k);
  }
}

// [{k, n}] → топ посилань [{url, clicks}] (ключі декодовано, однакові url — сумуються)
function topLinksFrom(pairs, limit = 20) {
  const m = new Map();
  for (const { k, n } of pairs || []) {
    const url = decodeLinkKey(k);
    m.set(url, (m.get(url) || 0) + (Number(n) || 0));
  }
  return [...m.entries()]
    .map(([url, clicks]) => ({ url, clicks }))
    .sort((a, b) => b.clicks - a.clicks || a.url.localeCompare(b.url))
    .slice(0, limit);
}

const view = (c) => ({ ...c, stats: { recipients: 0, sent: 0, failed: 0, skipped: 0, clicks: 0, unsubscribed: 0, complained: 0, bounced: 0, ...(c.stats || {}) } });

async function load(req, res) {
  if (!isId(req.params.id)) {
    bad(res, "Некоректний id");
    return null;
  }
  const c = await Campaign().findById(req.params.id).lean();
  if (!c) res.status(404).json({ error: "Розсилку не знайдено" });
  return c;
}

async function checkSegment(v) {
  if (v.segmentId && !(await Segment().exists({ _id: v.segmentId }))) return "Сегмент не знайдено";
  return null;
}

// ======================= обробники =======================

exports.list = async (req, res) => {
  try {
    const q = req.query || {};
    const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const where = Campaign().STATUSES.includes(q.status) ? { status: q.status } : {};
    const [list, total] = await Promise.all([
      Campaign().find(where).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select("-blocks").lean(),
      Campaign().countDocuments(where),
    ]);
    res.json({ campaigns: list.map(view), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (e) {
    handleError(res, e, "campaign → list");
  }
};

exports.create = async (req, res) => {
  try {
    const { value, errors } = normalizeCampaignInput(req.body);
    if (errors.length) return bad(res, errors.join("; "), { errors });
    const segErr = await checkSegment(value);
    if (segErr) return bad(res, segErr);
    const c = await Campaign().create({ ...value, status: "draft", createdBy: isId(String(req.id || "")) ? req.id : null });
    res.status(201).json({ campaign: view(c.toObject()) });
  } catch (e) {
    handleError(res, e, "campaign → create");
  }
};

exports.get = async (req, res) => {
  try {
    const c = await load(req, res);
    if (!c) return;
    const segment = c.segmentId ? await Segment().findById(c.segmentId).select("name description filter system").lean() : null;
    res.json({ campaign: view(c), segment, audience: c.filter ? engine.describe(c.filter) : segment?.description || "" });
  } catch (e) {
    handleError(res, e, "campaign → get");
  }
};

exports.update = async (req, res) => {
  try {
    const c = await load(req, res);
    if (!c) return;
    if (!EDITABLE.includes(c.status)) return res.status(409).json({ error: "Редагувати можна лише чернетку або заплановану розсилку" });
    const { value, errors } = normalizeCampaignInput(req.body, { partial: true });
    if (errors.length) return bad(res, errors.join("; "), { errors });
    const segErr = await checkSegment(value);
    if (segErr) return bad(res, segErr);
    // Зміна запланованої — повертаємо в чернетку, щоб адмін заново пройшов estimate/send
    const set = { ...value, ...(c.status === "scheduled" ? { status: "draft", scheduledAt: null } : {}) };
    const out = await Campaign().findOneAndUpdate({ _id: c._id, status: c.status }, { $set: set }, { new: true }).lean();
    if (!out) return res.status(409).json({ error: "Статус розсилки змінився — оновіть сторінку" });
    res.json({ campaign: view(out) });
  } catch (e) {
    handleError(res, e, "campaign → update");
  }
};

exports.remove = async (req, res) => {
  try {
    const c = await load(req, res);
    if (!c) return;
    if (c.status === "sending" || c.status === "scheduled") return res.status(409).json({ error: "Спершу скасуйте розсилку" });
    await Campaign().deleteOne({ _id: c._id });
    if (c.status === "draft") await Message().deleteMany({ campaignId: c._id });
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "campaign → remove");
  }
};

exports.duplicate = async (req, res) => {
  try {
    const c = await load(req, res);
    if (!c) return;
    const copy = await Campaign().create({
      name: `${c.name} (копія)`.slice(0, 200),
      subject: c.subject,
      preheader: c.preheader,
      blocks: c.blocks,
      topic: c.topic,
      channels: c.channels,
      segmentId: c.segmentId,
      filter: c.filter,
      utm: c.utm,
      telegramText: c.telegramText,
      status: "draft",
      createdBy: isId(String(req.id || "")) ? req.id : null,
    });
    res.status(201).json({ campaign: view(copy.toObject()) });
  } catch (e) {
    handleError(res, e, "campaign → duplicate");
  }
};

// Поля з тіла (незбережені зміни редактора) поверх збереженої кампанії
function withDraft(c, body) {
  if (!body || typeof body !== "object" || !Object.keys(body).length) return c;
  const { value } = normalizeCampaignInput(body, { partial: true });
  return { ...c, ...Object.fromEntries(Object.entries(value).filter(([k]) => ["subject", "preheader", "blocks", "utm", "telegramText"].includes(k))) };
}

exports.preview = async (req, res) => {
  try {
    const c0 = await load(req, res);
    if (!c0) return;
    const c = withDraft(c0, req.body);
    const mail = await template().buildEmail({ subject: c.subject, preheader: c.preheader, blocks: c.blocks, utm: c.utm, contactId: null, mode: "preview" });
    const tg = worker().telegramPayload(c, { front: template().contactLinks(null).privacy.replace(/\/privacy$/, "") });
    res.json({ html: mail.html, text: mail.text, subject: mail.subject, telegram: tg });
  } catch (e) {
    handleError(res, e, "campaign → preview");
  }
};

// POST /:id/test {to} — тестовий лист: тема з [ТЕСТ], без обгортки кліків, не рахується у frequency cap
exports.test = async (req, res) => {
  try {
    const c0 = await load(req, res);
    if (!c0) return;
    const c = withDraft(c0, req.body);
    let to = str(req.body?.to, 254).toLowerCase();
    if (!to && isId(String(req.id || ""))) {
      const admin = await require("../models/adminModel").findById(req.id).select("email").lean();
      to = String(admin?.email || "").toLowerCase();
    }
    if (!EMAIL_RE.test(to)) return bad(res, "Вкажіть коректну адресу для тестового листа");
    if (!String(c.subject || "").trim()) return bad(res, "Вкажіть тему листа");
    if (!Array.isArray(c.blocks) || !c.blocks.length) return bad(res, "Додайте зміст листа");
    const r = await worker().sendTest(c, to);
    if (!r.ok) {
      if (r.reason === "not_configured") return bad(res, "Відправка e-mail не налаштована", { hint: r.hint });
      return res.status(502).json({ error: "Не вдалося надіслати тестовий лист", reason: String(r.reason || "").slice(0, 300) });
    }
    res.json({ ok: true, to, id: r.id });
  } catch (e) {
    handleError(res, e, "campaign → test");
  }
};

exports.estimate = async (req, res) => {
  try {
    const c = await load(req, res);
    if (!c) return;
    if (!c.segmentId && !c.filter) return bad(res, "Оберіть сегмент або задайте фільтр отримувачів");
    const settings = await mkSettings.load();
    const est = await worker().estimateCampaign(c, { settings });
    const warnings = [];
    if ((c.channels || []).includes("email") && !mailer().isConfigured(settings)) warnings.push(mailer().configHint(settings));
    if ((c.channels || []).includes("telegram") && !worker().tgConfigured()) warnings.push("Telegram-бот не налаштовано — канал Telegram пропускається.");
    res.json({ ...est, dailyLimit: settings.dailyLimit, warnings });
  } catch (e) {
    if (e.status === 400 || e.code === "INVALID_FILTER") return bad(res, e.message);
    handleError(res, e, "campaign → estimate");
  }
};

// POST /:id/send {scheduleAt?}
exports.send = async (req, res) => {
  try {
    const c = await load(req, res);
    if (!c) return;
    if (c.status !== "draft") return res.status(409).json({ error: "Надіслати можна лише чернетку" });
    const sch = parseSchedule(req.body?.scheduleAt);
    if (sch.error) return bad(res, sch.error);
    const settings = await mkSettings.load();
    let estimate = null;
    if (c.segmentId || c.filter) {
      try {
        estimate = await worker().estimateCampaign(c, { settings });
      } catch (e) {
        if (e.status === 400 || e.code === "INVALID_FILTER") return bad(res, e.message);
        throw e;
      }
    }
    const block = sendBlockers(c, {
      emailConfigured: mailer().isConfigured(settings),
      emailHint: mailer().configHint(settings),
      tgConfigured: worker().tgConfigured(),
      estimate,
    });
    if (block) return bad(res, block.error, { hint: block.hint, estimate });
    const out = await Campaign().findOneAndUpdate(
      { _id: c._id, status: "draft" },
      { $set: { status: "scheduled", scheduledAt: sch.at, lastError: "", "stats.recipients": estimate.eligible } },
      { new: true }
    ).lean();
    if (!out) return res.status(409).json({ error: "Статус розсилки змінився — оновіть сторінку" });
    res.json({ campaign: view(out), estimate });
  } catch (e) {
    handleError(res, e, "campaign → send");
  }
};

exports.cancel = async (req, res) => {
  try {
    const c = await load(req, res);
    if (!c) return;
    if (!["scheduled", "sending"].includes(c.status)) return res.status(409).json({ error: "Скасувати можна лише заплановану або активну розсилку" });
    const out = await Campaign().findOneAndUpdate(
      { _id: c._id, status: { $in: ["scheduled", "sending"] } },
      { $set: { status: "cancelled", finishedAt: new Date() } },
      { new: true }
    ).lean();
    if (!out) return res.status(409).json({ error: "Статус розсилки змінився — оновіть сторінку" });
    const r = await Message().updateMany({ campaignId: c._id, status: "queued" }, { $set: { status: "skipped", skipReason: null, error: "cancelled" } });
    res.json({ campaign: view(out), dequeued: r.modifiedCount });
  } catch (e) {
    handleError(res, e, "campaign → cancel");
  }
};

exports.report = async (req, res) => {
  try {
    const c = await load(req, res);
    if (!c) return;
    const M = Message();
    const match = { campaignId: c._id };
    const [byStatus, byDay, skipped, links, failures] = await Promise.all([
      M.aggregate([{ $match: match }, { $group: { _id: { s: "$status", ch: "$channel" }, n: { $sum: 1 }, clicks: { $sum: "$clicks" } } }]),
      M.aggregate([
        { $match: { ...match, status: "sent", sentAt: { $ne: null } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$sentAt", timezone: "Europe/Kyiv" } }, sent: { $sum: 1 }, clicks: { $sum: "$clicks" } } },
        { $sort: { _id: 1 } },
      ]),
      M.aggregate([{ $match: { ...match, status: "skipped" } }, { $group: { _id: { $ifNull: ["$skipReason", "cancelled"] }, n: { $sum: 1 } } }]),
      M.aggregate([
        { $match: { ...match, links: { $type: "object" } } },
        { $project: { l: { $objectToArray: "$links" } } },
        { $unwind: "$l" },
        { $group: { _id: "$l.k", n: { $sum: "$l.v" } } },
        { $sort: { n: -1 } },
        { $limit: 50 },
      ]),
      M.find({ ...match, status: "failed" }).sort({ queuedAt: -1 }).limit(50).select("contactId channel error attempts queuedAt").populate({ path: "contactId", select: "email name" }).lean(),
    ]);
    const counts = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    const byChannel = {};
    let clicks = 0;
    for (const g of byStatus) {
      counts[g._id.s] = (counts[g._id.s] || 0) + g.n;
      const bc = (byChannel[g._id.ch] ||= { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 });
      bc[g._id.s] = (bc[g._id.s] || 0) + g.n;
      clicks += g.clicks || 0;
    }
    const stats = { ...view(c).stats, ...counts, recipients: counts.sent + counts.failed + counts.queued + counts.sending, clicks: Math.max(clicks, c.stats?.clicks || 0) };
    res.json({
      campaign: { _id: c._id, name: c.name, subject: c.subject, status: c.status, channels: c.channels, startedAt: c.startedAt, finishedAt: c.finishedAt, scheduledAt: c.scheduledAt, lastError: c.lastError || "" },
      stats,
      ctr: stats.sent ? stats.clicks / stats.sent : 0,
      byChannel,
      byDay: byDay.map((d) => ({ date: d._id, sent: d.sent, clicks: d.clicks })),
      topLinks: topLinksFrom(links.map((l) => ({ k: l._id, n: l.n }))),
      skipped: Object.fromEntries(skipped.map((s) => [s._id, s.n])),
      failures: failures.map((f) => ({
        contactId: f.contactId?._id || f.contactId,
        email: f.contactId?.email || "",
        name: f.contactId?.name || "",
        channel: f.channel,
        error: f.error,
        attempts: f.attempts,
        at: f.queuedAt,
      })),
    });
  } catch (e) {
    handleError(res, e, "campaign → report");
  }
};

exports._pure = { normalizeCampaignInput, sendBlockers, parseSchedule, decodeLinkKey, topLinksFrom };
