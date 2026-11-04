// Черга й планувальник маркетингу (MARKETING_SPEC.md §8). Запуск: start() у server.js після підключення БД;
// MARKETING_WORKER=off — вимкнено. Кожні 30 с tick():
//  (а) кампанії scheduled → sending (коли настав час і відкрите вікно відправки): резолв отримувачів,
//      пачкові вставки CampaignMessage (queued або skipped зі skipReason);
//  (б) відправка queued: e-mail пачками через Resend batch (dailyLimit, вікно, ≤2 запити/с, ретраї),
//      Telegram — послідовно ≤25/с; перед кожною відправкою статус контакту перечитується з БД;
//  (в) автоматизації welcome / abandoned_cart / winback (раз на 5 хв);
//  (г) нічні задачі (після 03:00 за Києвом): RFM, протерміновані pending → cleaned, системні сегменти, лічильники.
// Верхня частина — чисті функції (тести без БД).

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const TZ = "Europe/Kyiv";
const TICK_MS = 30 * 1000;
const AUTOMATION_EVERY_MS = 5 * 60 * 1000;
const INSERT_CHUNK = 1000;
const TG_INTERVAL_MS = 40; // ≤ 25 повідомлень/с
const TG_PER_TICK = 200;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5 * 60 * 1000;
const PENDING_TTL_DAYS = 30;
const WELCOME_STALE_MS = 48 * HOUR;
const CART_DEDUP_DAYS = 14;
const WINBACK_DEDUP_DAYS = 90;
const STALE_SENDING_MS = 15 * 60 * 1000; // «зависле» sending після падіння/рестарту

const SUPPRESSED_EMAIL = ["unsubscribed", "bounced", "complained"];
const SUPPRESSED_TG = ["unsubscribed", "blocked"];
// Пріоритет причин пропуску (перша підходяща перемагає)
const SKIP_PRIORITY = ["suppressed", "no_address", "not_subscribed", "topic_off", "frequency_cap"];
const TOPICS = ["promo", "news", "restock", "tips"];
const AUTOMATION_TOPIC = { welcome: "all", abandoned_cart: "promo", winback: "promo" };

// ---------- Telegram: модуль з'являється паралельно; без нього — заглушка ----------
const TG_STUB = Object.freeze({
  isConfigured: () => false,
  sendMessage: async () => ({ ok: false, error: "not_configured" }),
  startLink: () => null,
});
function telegram() {
  try {
    const m = require("./telegramBot");
    return m && typeof m.sendMessage === "function" ? m : TG_STUB;
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND" && /telegramBot/.test(String(e.message))) return TG_STUB;
    throw e;
  }
}
const tgConfigured = () => {
  try {
    return !!telegram().isConfigured();
  } catch {
    return false;
  }
};

// ======================= чисті функції =======================

const toMs = (now) => (now instanceof Date ? now.getTime() : Number(now));

const kyivFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// Дата/час у Києві: { year, month, day, hour, minute, second }
function kyivParts(now = Date.now()) {
  const o = {};
  for (const p of kyivFmt.formatToParts(new Date(toMs(now)))) if (p.type !== "literal") o[p.type] = Number(p.value);
  if (o.hour === 24) o.hour = 0;
  return o;
}

const kyivDateKey = (now = Date.now()) => {
  const p = kyivParts(now);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

// Початок поточної доби за Києвом (UTC Date)
function kyivDayStart(now = Date.now()) {
  const t = toMs(now);
  const p = kyivParts(t);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = Math.round((wallAsUtc - Math.floor(t / 1000) * 1000) / 60000) * 60000;
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - offset);
}

const minutesOf = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// Вікно відправки {from:'09:00', to:'20:00'} за Києвом; from > to — вікно через північ; from == to — цілодобово
function inSendWindow(win = {}, now = Date.now()) {
  const from = minutesOf(win.from);
  const to = minutesOf(win.to);
  if (from === null || to === null || from === to) return true;
  const p = kyivParts(now);
  const cur = p.hour * 60 + p.minute;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

// Обмеження частоти для контакту: загальне + власний вибір (weekly — 1/7 днів, monthly — 1/30 днів)
function capsFor(contact, cap = { max: 2, days: 7 }) {
  const list = [{ max: Number(cap.max) || 2, days: Number(cap.days) || 7 }];
  const fr = contact?.channels?.email?.frequency;
  if (fr === "weekly") list.push({ max: 1, days: 7 });
  if (fr === "monthly") list.push({ max: 1, days: 30 });
  return list;
}

// Чи можна ще одне маркетингове повідомлення. Одна кампанія в кількох каналах рахується один раз;
// записи поточної кампанії (campaignId) не рахуються — щоб другий канал тієї ж розсилки не впирався в ліміт.
function capAllowed(contact, cap, now = Date.now(), { campaignId = null } = {}) {
  const t = toMs(now);
  const log = Array.isArray(contact?.marketingSentLog) ? contact.marketingSentLog : [];
  const cid = campaignId ? String(campaignId) : null;
  return capsFor(contact, cap).every(({ max, days }) => {
    const since = t - days * DAY;
    const keys = new Set();
    for (const e of log) {
      const at = new Date(e?.at).getTime();
      if (!Number.isFinite(at) || at <= since || at > t) continue;
      const k = e.campaignId ? `c:${e.campaignId}` : `a:${e.automation || ""}:${at}`;
      if (cid && k === `c:${cid}`) continue;
      keys.add(k);
    }
    return keys.size < max;
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const topicOn = (topics, topic) => (!topic || topic === "all" ? TOPICS.some((k) => topics?.[k] === true) : topics?.[topic] === true);

// Причина пропуску для каналу або null (можна слати). Пріоритет: SKIP_PRIORITY
function resolveSkipReason(contact, { channel = "email", topic = "all", cap, now = Date.now(), campaignId = null, checkCap = true } = {}) {
  if (!contact) return "no_address";
  if (channel === "telegram") {
    const ch = contact.channels?.telegram || {};
    if (contact.anonymized || SUPPRESSED_TG.includes(ch.status)) return "suppressed";
    if (!ch.chatId) return "no_address";
    if (ch.status !== "subscribed") return "not_subscribed";
    if (!topicOn(ch.topics, topic)) return "topic_off";
  } else {
    const ch = contact.channels?.email || {};
    if (contact.anonymized || SUPPRESSED_EMAIL.includes(ch.status)) return "suppressed";
    if (!contact.email || !EMAIL_RE.test(String(contact.email))) return "no_address";
    if (ch.status !== "subscribed") return "not_subscribed";
    if (!topicOn(ch.topics, topic)) return "topic_off";
  }
  if (checkCap && cap && !capAllowed(contact, cap, now, { campaignId })) return "frequency_cap";
  return null;
}

// Причина для контакту з кількома каналами: null, якщо доступний хоч один; інакше — найпріоритетніша
function pickReason(reasons) {
  const list = (reasons || []).filter((r) => r !== undefined);
  if (!list.length || list.some((r) => r === null)) return null;
  // «немає адреси» в одному каналі (напр. не прив'язаний Telegram) — шум, якщо інший канал має змістовну причину
  const informative = list.filter((r) => r !== "no_address");
  const pool = informative.length ? informative : list;
  return SKIP_PRIORITY.find((p) => pool.includes(p)) || pool[0];
}

// Групи з агрегації estimate [{ e, t, n }] → підсумок
function summarizeEstimate(groups, { channels = ["email"], dailyLimit = 100 } = {}) {
  const excluded = { not_subscribed: 0, topic_off: 0, suppressed: 0, frequency_cap: 0, no_address: 0 };
  const byChannel = { email: 0, telegram: 0 };
  let total = 0;
  let eligible = 0;
  const useE = channels.includes("email");
  const useT = channels.includes("telegram");
  for (const g of groups || []) {
    const n = Number(g.n) || 0;
    total += n;
    const e = useE ? (g.e === "ok" ? null : g.e) : undefined;
    const t = useT ? (g.t === "ok" ? null : g.t) : undefined;
    if (e === null) byChannel.email += n;
    if (t === null) byChannel.telegram += n;
    const r = pickReason([e, t]);
    if (r === null) eligible += n;
    else if (r in excluded) excluded[r] += n;
  }
  const limit = Math.max(1, Number(dailyLimit) || 100);
  const estimatedDays = byChannel.email > 0 ? Math.ceil(byChannel.email / limit) : eligible > 0 ? 1 : 0;
  return { total, eligible, excluded, byChannel, estimatedDays };
}

// Розмітка блоку тексту → простий текст
const plainText = (s) =>
  String(s || "")
    .replace(/\*\*([^*]+?)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .trim();

// Текст і кнопки для Telegram: telegramText, інакше заголовок + перший текст + перша кнопка
function telegramPayload({ telegramText, blocks, subject } = {}, { front = "", wrap = null } = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const heading = list.find((b) => b?.type === "heading")?.text;
  const firstText = list.find((b) => b?.type === "text")?.text;
  const btn = list.find((b) => b?.type === "button" && b.label && b.url);
  let text = String(telegramText || "").trim();
  if (!text) text = [heading || subject, plainText(firstText)].filter(Boolean).join("\n\n");
  text = text.slice(0, 3900);
  const buttons = [];
  if (btn) {
    let url = String(btn.url);
    if (/^\/(?!\/)/.test(url) && front) url = `${String(front).replace(/\/+$/, "")}${url}`;
    if (/^https?:\/\//i.test(url)) buttons.push({ text: String(btn.label).slice(0, 60), url: wrap ? wrap(url) : url });
  }
  return { text: `${text}\n\nРеклама · Відписатися: /stop`, buttons };
}

// Результат telegramBot.sendMessage (або помилка) → { ok, blocked, retryable, error }
function normalizeTgResult(res, err) {
  const src = err || res;
  if (!err && (res === true || res?.ok === true)) return { ok: true, id: res?.result?.message_id || res?.messageId || res?.id || "" };
  const code = Number(src?.error_code ?? src?.status ?? src?.code ?? src?.statusCode) || 0;
  const msg = String(src?.description || src?.error || src?.message || "telegram_error").slice(0, 300);
  const blocked = src?.blocked === true || code === 403 || /blocked|deactivated|kicked|forbidden/i.test(msg);
  if (blocked) return { ok: false, blocked: true, retryable: false, error: msg };
  if (msg === "not_configured") return { ok: false, retryable: true, error: msg, notConfigured: true };
  return { ok: false, blocked: false, retryable: code === 429 || code >= 500 || code === 0, error: msg };
}

// Помилка insertMany(ordered:false), де всі збої — дублікати ключа (E11000) → їх можна ігнорувати
function isDupOnly(e) {
  if (!e) return false;
  const errs = e.writeErrors || e.result?.writeErrors || e.errorResponse?.writeErrors;
  if (Array.isArray(errs) && errs.length) return errs.every((w) => (w?.code ?? w?.err?.code) === 11000);
  return e.code === 11000;
}

// Запис журналу частоти в пам'яті (щоб кілька повідомлень одному контакту в одній пачці не обійшли cap)
function noteSent(contact, { at, channel, campaignId, automation }) {
  if (!contact) return;
  const log = Array.isArray(contact.marketingSentLog) ? contact.marketingSentLog : [];
  contact.marketingSentLog = [...log, { at: new Date(at), channel, campaignId: campaignId || null, automation: automation || null }];
}

// Чи настав час нічних задач (після 03:00 за Києвом, раз на добу)
function nightlyDue(lastKey, now = Date.now()) {
  const p = kyivParts(now);
  return p.hour >= 3 && lastKey !== kyivDateKey(now);
}

// ======================= БД =======================

const M = {
  Contact: () => require("../models/contactModel"),
  Campaign: () => require("../models/campaignModel"),
  Message: () => require("../models/campaignMessageModel"),
  Segment: () => require("../models/segmentModel"),
};
const settingsLib = () => require("./marketingSettings");
const mailer = () => require("./marketingMailer");
const template = () => require("./emailTemplate");
const engine = () => require("./segmentEngine");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Умова Mongo для аудиторії кампанії (сегмент або ad-hoc фільтр). Без аудиторії → Error
async function audienceQuery(campaign, { now = Date.now() } = {}) {
  let filter = null;
  if (campaign.segmentId) {
    const seg = await M.Segment().findById(campaign.segmentId).lean();
    if (!seg) {
      const e = new Error("Сегмент не знайдено");
      e.status = 400;
      throw e;
    }
    filter = seg.filter;
  } else if (campaign.filter) filter = campaign.filter;
  else {
    const e = new Error("Оберіть сегмент або задайте фільтр отримувачів");
    e.status = 400;
    throw e;
  }
  return engine().toMongoQuery(filter, { now });
}

// Вираз агрегації: кількість записів журналу за days днів (без поточної кампанії)
function recentExpr(days, now, campaignId) {
  const since = new Date(toMs(now) - days * DAY);
  const conds = [{ $gt: ["$$x.at", since] }];
  if (campaignId) conds.push({ $ne: ["$$x.campaignId", campaignId] });
  return { $size: { $filter: { input: { $ifNull: ["$marketingSentLog", []] }, as: "x", cond: { $and: conds } } } };
}

function topicExpr(prefix, topic) {
  if (!topic || topic === "all") return { $or: TOPICS.map((k) => ({ $eq: [`${prefix}.topics.${k}`, true] })) };
  return { $eq: [`${prefix}.topics.${topic}`, true] };
}

function capExpr(cap, now, campaignId) {
  return {
    $or: [
      { $gte: [recentExpr(Number(cap.days) || 7, now, campaignId), Number(cap.max) || 2] },
      { $and: [{ $eq: ["$channels.email.frequency", "weekly"] }, { $gte: [recentExpr(7, now, campaignId), 1] }] },
      { $and: [{ $eq: ["$channels.email.frequency", "monthly"] }, { $gte: [recentExpr(30, now, campaignId), 1] }] },
    ],
  };
}

// Той самий порядок, що й resolveSkipReason
function reasonExpr(channel, topic, cap, now, campaignId) {
  const tg = channel === "telegram";
  const p = tg ? "$channels.telegram" : "$channels.email";
  return {
    $switch: {
      branches: [
        { case: { $or: [{ $eq: ["$anonymized", true] }, { $in: [`${p}.status`, tg ? SUPPRESSED_TG : SUPPRESSED_EMAIL] }] }, then: "suppressed" },
        { case: { $in: [{ $ifNull: [tg ? "$channels.telegram.chatId" : "$email", ""] }, [""]] }, then: "no_address" },
        { case: { $ne: [`${p}.status`, "subscribed"] }, then: "not_subscribed" },
        { case: { $not: [topicExpr(p, topic)] }, then: "topic_off" },
        { case: capExpr(cap, now, campaignId), then: "frequency_cap" },
      ],
      default: "ok",
    },
  };
}

// Оцінка аудиторії кампанії (одна агрегація по індексованому $match)
async function estimateCampaign(campaign, { settings, now = Date.now() } = {}) {
  const s = settings || (await settingsLib().load());
  const q = await audienceQuery(campaign, { now });
  const channels = (campaign.channels || ["email"]).filter((c) => c !== "telegram" || tgConfigured());
  const cid = campaign._id || null;
  const groups = await M.Contact().aggregate([
    { $match: q },
    {
      $project: {
        _id: 0,
        e: reasonExpr("email", campaign.topic, s.frequencyCap, now, cid),
        t: reasonExpr("telegram", campaign.topic, s.frequencyCap, now, cid),
      },
    },
    { $group: { _id: { e: "$e", t: "$t" }, n: { $sum: 1 } } },
  ]);
  const res = summarizeEstimate(
    groups.map((g) => ({ e: g._id.e, t: g._id.t, n: g.n })),
    { channels: channels.length ? channels : ["email"], dailyLimit: s.dailyLimit }
  );
  if (!channels.length) {
    res.excluded.no_address += res.eligible;
    res.eligible = 0;
    res.byChannel = { email: 0, telegram: 0 };
  }
  return res;
}

// Резолв отримувачів кампанії → пачкові вставки CampaignMessage. Ідемпотентний (наявні контакти пропускає)
async function resolveCampaign(campaign, { settings, now = Date.now() } = {}) {
  const Message = M.Message();
  const s = settings || (await settingsLib().load());
  const q = await audienceQuery(campaign, { now });
  const channels = (campaign.channels || ["email"]).filter((c) => c === "email" || (c === "telegram" && tgConfigured()));
  const existing = new Set();
  if (await Message.exists({ campaignId: campaign._id })) {
    for (const id of await Message.distinct("contactId", { campaignId: campaign._id })) existing.add(String(id));
  }
  const at = new Date(toMs(now));
  let buf = [];
  const counts = { queued: 0, skipped: 0 };
  const flush = async () => {
    if (!buf.length) return;
    const docs = buf;
    buf = [];
    try {
      await Message.insertMany(docs, { ordered: false });
    } catch (e) {
      if (!isDupOnly(e)) throw e; // паралельний резолв (інший інстанс) — дублікати відкинуто унікальним індексом
    }
  };
  const cursor = M.Contact().find(q).select("email anonymized channels marketingSentLog").lean().cursor({ batchSize: INSERT_CHUNK });
  for await (const c of cursor) {
    if (existing.has(String(c._id))) continue;
    for (const ch of channels) {
      const reason = resolveSkipReason(c, { channel: ch, topic: campaign.topic, cap: s.frequencyCap, now, campaignId: campaign._id });
      // Telegram без chatId — не створюємо запис-«шум» для контактів, що й не мали Telegram
      if (ch === "telegram" && reason === "no_address" && channels.length > 1) continue;
      buf.push({
        campaignId: campaign._id,
        contactId: c._id,
        channel: ch,
        status: reason ? "skipped" : "queued",
        skipReason: reason || null,
        queuedAt: at,
      });
      counts[reason ? "skipped" : "queued"]++;
    }
    if (buf.length >= INSERT_CHUNK) await flush();
  }
  await flush();
  return counts;
}

// Перерахунок stats кампанії з повідомлень (індекс campaignId+status)
async function recountCampaign(campaignId) {
  const groups = await M.Message().aggregate([{ $match: { campaignId } }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
  const by = Object.fromEntries(groups.map((g) => [g._id, g.n]));
  const set = {
    "stats.sent": by.sent || 0,
    "stats.failed": by.failed || 0,
    "stats.skipped": by.skipped || 0,
    "stats.recipients": (by.sent || 0) + (by.failed || 0) + (by.queued || 0) + (by.sending || 0),
  };
  await M.Campaign().updateOne({ _id: campaignId }, { $set: set });
  return { ...by };
}

const resolvedOnce = new Set();

// (а) запуск запланованих кампаній
async function startDueCampaigns(settings, now) {
  const Campaign = M.Campaign();
  const due = await Campaign.find({ status: "scheduled", scheduledAt: { $lte: new Date(now) } }).sort({ scheduledAt: 1 }).limit(5).lean();
  if (!due.length) return 0;
  if (!inSendWindow(settings.sendWindow, now)) return 0;
  let started = 0;
  for (const c of due) {
    const needsEmail = (c.channels || []).includes("email");
    const onlyTg = !needsEmail;
    if (needsEmail && !mailer().isConfigured(settings)) {
      const hint = mailer().configHint(settings);
      if (c.lastError !== hint) await Campaign.updateOne({ _id: c._id }, { $set: { lastError: hint } });
      continue;
    }
    if (onlyTg && !tgConfigured()) {
      await Campaign.updateOne({ _id: c._id }, { $set: { lastError: "Telegram-бот не налаштовано (TELEGRAM_BOT_TOKEN)" } });
      continue;
    }
    const claimed = await Campaign.findOneAndUpdate(
      { _id: c._id, status: "scheduled" },
      { $set: { status: "sending", startedAt: new Date(now), lastError: "" } },
      { new: true }
    ).lean();
    if (!claimed) continue;
    try {
      await resolveCampaign(claimed, { settings, now });
      resolvedOnce.add(String(claimed._id));
      await recountCampaign(claimed._id);
      started++;
    } catch (e) {
      console.error("💥 marketing resolve:", e.message);
      await Campaign.updateOne({ _id: claimed._id }, { $set: { status: "failed", lastError: String(e.message).slice(0, 500), finishedAt: new Date() } });
    }
  }
  return started;
}

// Кампанії в sending: доробити резолв після перезапуску, завершити, коли черга порожня
async function finalizeCampaigns(settings, now) {
  const Campaign = M.Campaign();
  const list = await Campaign.find({ status: "sending" }).select("_id channels topic segmentId filter").lean();
  for (const c of list) {
    const id = String(c._id);
    if (!resolvedOnce.has(id)) {
      try {
        await resolveCampaign(c, { settings, now });
        resolvedOnce.add(id);
      } catch (e) {
        console.error("💥 marketing re-resolve:", e.message);
        continue;
      }
    }
    const by = await recountCampaign(c._id);
    if (!by.queued && !by.sending) {
      await Campaign.updateOne({ _id: c._id, status: "sending" }, { $set: { status: "sent", finishedAt: new Date(now) } });
      resolvedOnce.delete(id);
    }
  }
}

// Зміст повідомлення: кампанія або крок автоматизації
function contentFor(msg, campaigns, settings) {
  if (msg.campaignId) {
    const c = campaigns.get(String(msg.campaignId));
    if (!c) return null;
    return { key: `c:${c._id}`, subject: c.subject, preheader: c.preheader, blocks: c.blocks, topic: c.topic, utm: c.utm, telegramText: c.telegramText, campaign: c };
  }
  const a = settings.automations || {};
  if (msg.automation === "welcome") {
    const step = a.welcome?.steps?.[Number(msg.step) || 0];
    if (!a.welcome?.enabled || !step) return null;
    return { key: `a:welcome:${msg.step || 0}`, subject: step.subject, preheader: "", blocks: step.blocks, topic: "all", utm: { source: "email", medium: "automation", campaign: "welcome" } };
  }
  const map = { abandoned_cart: "abandonedCart", winback: "winback" };
  const cfg = a[map[msg.automation]];
  if (!cfg || !cfg.enabled) return null;
  return { key: `a:${msg.automation}`, subject: cfg.subject, preheader: "", blocks: cfg.blocks, topic: AUTOMATION_TOPIC[msg.automation], utm: { source: "email", medium: "automation", campaign: msg.automation } };
}

async function loadCampaignsFor(msgs) {
  const ids = [...new Set(msgs.filter((m) => m.campaignId).map((m) => String(m.campaignId)))];
  const map = new Map();
  if (!ids.length) return map;
  for (const c of await M.Campaign().find({ _id: { $in: ids } }).lean()) map.set(String(c._id), c);
  return map;
}

async function markSkipped(ids, reason, error = "") {
  if (!ids.length) return;
  await M.Message().updateMany(
    { _id: { $in: ids }, status: { $in: ["queued", "sending"] } },
    { $set: { status: "skipped", skipReason: reason || null, error }, $unset: { lockId: "", claimedAt: "", sendStartedAt: "" } }
  );
}

async function logSent(entries) {
  if (!entries.length) return;
  await M.Contact().bulkWrite(
    entries.map((e) => ({
      updateOne: {
        filter: { _id: e.contactId },
        update: {
          $push: { marketingSentLog: { $each: [{ at: e.at, channel: e.channel, campaignId: e.campaignId || null, automation: e.automation || null }], $slice: -30 } },
        },
      },
    })),
    { ordered: false }
  );
}

async function sentTodayCount(now = Date.now()) {
  return M.Message().countDocuments({ status: "sent", channel: "email", sentAt: { $gte: kyivDayStart(now) } });
}

// Атомарне захоплення: queued → sending з унікальним lockId. Повертає лише ті, що захопив саме цей виклик
async function claimQueued(ids, now = Date.now()) {
  if (!ids.length) return [];
  const Message = M.Message();
  const lockId = require("crypto").randomUUID();
  await Message.updateMany({ _id: { $in: ids }, status: "queued" }, { $set: { status: "sending", lockId, claimedAt: new Date(toMs(now)) } });
  const list = await Message.find({ lockId, status: "sending" }).sort({ queuedAt: 1 }).lean();
  return list;
}

// Повернути захоплені, але ще не відправлені, назад у чергу
async function releaseClaimed(ids, lockId, { queuedAt } = {}) {
  if (!ids.length) return;
  await M.Message().updateMany(
    { _id: { $in: ids }, status: "sending", lockId },
    { $set: { status: "queued", ...(queuedAt ? { queuedAt } : {}) }, $unset: { lockId: "", claimedAt: "", sendStartedAt: "" } }
  );
}

// Після падіння/рестарту: «sending» без початої відправки → назад у queued; з початою — failed
// (могло бути надіслано; повтор порушив би ідемпотентність)
async function recoverStale(now = Date.now()) {
  const Message = M.Message();
  const before = new Date(toMs(now) - STALE_SENDING_MS);
  const back = await Message.updateMany(
    { status: "sending", claimedAt: { $lt: before }, sendStartedAt: { $exists: false } },
    { $set: { status: "queued" }, $unset: { lockId: "", claimedAt: "" } }
  );
  const lost = await Message.updateMany(
    { status: "sending", claimedAt: { $lt: before }, sendStartedAt: { $exists: true } },
    { $set: { status: "failed", error: "interrupted: невідомо, чи надіслано (перезапуск під час відправки)" }, $unset: { lockId: "" } }
  );
  return { requeued: back.modifiedCount || 0, failed: lost.modifiedCount || 0 };
}

// Розібрати чергу: перевірка статусу/кампанії/частоти → { ready:[{msg, contact, content}], skips }
async function prepareQueue(msgs, settings, now) {
  const campaigns = await loadCampaignsFor(msgs);
  const contacts = new Map();
  for (const c of await M.Contact().find({ _id: { $in: msgs.map((m) => m.contactId) } }).select("email anonymized channels marketingSentLog").lean()) {
    contacts.set(String(c._id), c);
  }
  const ready = [];
  const skips = new Map(); // reason → [ids]
  const cancelled = [];
  for (const m of msgs) {
    const camp = m.campaignId ? campaigns.get(String(m.campaignId)) : null;
    if (m.campaignId && (!camp || camp.status !== "sending")) {
      cancelled.push(m._id);
      continue;
    }
    const content = contentFor(m, campaigns, settings);
    if (!content || (m.channel === "email" && !String(content.subject || "").trim())) {
      cancelled.push(m._id);
      continue;
    }
    const contact = contacts.get(String(m.contactId));
    const reason = resolveSkipReason(contact, { channel: m.channel, topic: content.topic, cap: settings.frequencyCap, now, campaignId: m.campaignId });
    if (reason) {
      if (!skips.has(reason)) skips.set(reason, []);
      skips.get(reason).push(m._id);
      continue;
    }
    ready.push({ msg: m, contact, content });
    noteSent(contact, { at: now, channel: m.channel, campaignId: m.campaignId, automation: m.automation });
  }
  await markSkipped(cancelled, null, "cancelled");
  for (const [reason, ids] of skips) await markSkipped(ids, reason);
  return ready;
}

// (б1) e-mail
async function sendEmailQueue(settings, now) {
  if (!inSendWindow(settings.sendWindow, now)) return { sent: 0, reason: "outside_window" };
  if (!mailer().isConfigured(settings)) return { sent: 0, reason: "not_configured" };
  const remaining = settings.dailyLimit - (await sentTodayCount(now));
  if (remaining <= 0) return { sent: 0, reason: "daily_limit" };
  const limit = Math.max(1, Math.min(settings.batchSize, remaining, mailer().MAX_PER_REQUEST));
  const Message = M.Message();
  const candidates = await Message.find({ status: "queued", channel: "email", queuedAt: { $lte: new Date(now) } }).sort({ queuedAt: 1 }).limit(limit).select("_id").lean();
  if (!candidates.length) return { sent: 0 };
  const msgs = await claimQueued(candidates.map((m) => m._id), now);
  if (!msgs.length) return { sent: 0 };
  const lockId = msgs[0].lockId;
  const ready = await prepareQueue(msgs, settings, now);
  if (!ready.length) return { sent: 0 };

  const tpl = template();
  const ctxCache = new Map();
  const prepared = [];
  for (const r of ready) {
    if (!ctxCache.has(r.content.key)) ctxCache.set(r.content.key, await tpl.loadContext(r.content.blocks));
    const mail = await tpl.buildEmail(
      { ...r.content, contactId: r.contact._id, messageId: r.msg._id, campaignId: r.msg.campaignId, mode: "send" },
      ctxCache.get(r.content.key)
    );
    prepared.push({
      to: r.contact.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      unsubscribeUrl: mail.links.oneClick,
      idempotencyKey: String(r.msg._id),
      tags: [r.msg.campaignId ? { name: "campaign", value: String(r.msg.campaignId) } : { name: "automation", value: String(r.msg.automation || "") }],
    });
  }
  const readyIds = ready.map((r) => r.msg._id);
  await Message.updateMany({ _id: { $in: readyIds }, status: "sending", lockId }, { $set: { sendStartedAt: new Date() } });
  const res = await mailer().sendBatch(prepared, { settings });
  if (res.reason === "not_configured") {
    await releaseClaimed(readyIds, lockId);
    return { sent: 0, reason: "not_configured" };
  }

  const ops = [];
  const logs = [];
  const at = new Date();
  let sent = 0;
  res.results.forEach((x, i) => {
    const { msg, contact } = ready[i];
    if (x && x.id) {
      sent++;
      ops.push({
        updateOne: {
          filter: { _id: msg._id, status: "sending", lockId },
          update: { $set: { status: "sent", providerId: x.id, sentAt: at, error: "" }, $inc: { attempts: 1 }, $unset: { lockId: "", claimedAt: "", sendStartedAt: "" } },
        },
      });
      logs.push({ contactId: contact._id, at, channel: "email", campaignId: msg.campaignId, automation: msg.automation });
    } else {
      const attempts = (msg.attempts || 0) + 1;
      const final = !x?.retryable || attempts >= MAX_ATTEMPTS;
      ops.push({
        updateOne: {
          filter: { _id: msg._id, status: "sending", lockId },
          update: final
            ? { $set: { status: "failed", error: String(x?.error || "error").slice(0, 500), attempts }, $unset: { lockId: "" } }
            : {
                $set: { status: "queued", error: String(x?.error || "error").slice(0, 500), attempts, queuedAt: new Date(Date.now() + RETRY_BACKOFF_MS) },
                $unset: { lockId: "", claimedAt: "", sendStartedAt: "" },
              },
        },
      });
    }
  });
  if (ops.length) await Message.bulkWrite(ops, { ordered: false });
  await logSent(logs);
  return { sent, failed: res.results.length - sent };
}

// (б2) Telegram — послідовно, ≤25/с
async function sendTelegramQueue(settings, now) {
  if (!tgConfigured()) return { sent: 0, reason: "not_configured" };
  if (!inSendWindow(settings.sendWindow, now)) return { sent: 0, reason: "outside_window" };
  const Message = M.Message();
  const candidates = await Message.find({ status: "queued", channel: "telegram", queuedAt: { $lte: new Date(now) } }).sort({ queuedAt: 1 }).limit(TG_PER_TICK).select("_id").lean();
  if (!candidates.length) return { sent: 0 };
  const msgs = await claimQueued(candidates.map((m) => m._id), now);
  if (!msgs.length) return { sent: 0 };
  const lockId = msgs[0].lockId;
  const ready = await prepareQueue(msgs, settings, now);
  const tg = telegram();
  const front = template().contactLinks(null).privacy.replace(/\/privacy$/, "");
  let sent = 0;
  for (const r of ready) {
    const wrap = template().clickWrapper({ messageId: r.msg._id, campaignId: r.msg.campaignId });
    const p = telegramPayload(r.content, { front, wrap });
    const mine = { _id: r.msg._id, status: "sending", lockId };
    await Message.updateOne(mine, { $set: { sendStartedAt: new Date() } });
    let out;
    try {
      out = normalizeTgResult(await tg.sendMessage(r.contact.channels.telegram.chatId, p.text, { buttons: p.buttons }));
    } catch (e) {
      out = normalizeTgResult(null, e);
    }
    if (out.notConfigured) {
      await releaseClaimed(ready.map((x) => x.msg._id), lockId);
      break;
    }
    const at = new Date();
    if (out.ok) {
      sent++;
      await Message.updateOne(mine, { $set: { status: "sent", sentAt: at, providerId: String(out.id || "") }, $inc: { attempts: 1 }, $unset: { lockId: "", claimedAt: "", sendStartedAt: "" } });
      await logSent([{ contactId: r.contact._id, at, channel: "telegram", campaignId: r.msg.campaignId, automation: r.msg.automation }]);
    } else {
      const attempts = (r.msg.attempts || 0) + 1;
      const final = out.blocked || !out.retryable || attempts >= MAX_ATTEMPTS;
      await Message.updateOne(
        mine,
        final
          ? { $set: { status: "failed", error: out.error, attempts }, $unset: { lockId: "" } }
          : { $set: { status: "queued", error: out.error, attempts, queuedAt: new Date(Date.now() + RETRY_BACKOFF_MS) }, $unset: { lockId: "", claimedAt: "", sendStartedAt: "" } }
      );
      if (out.blocked) {
        await M.Contact().updateOne(
          { _id: r.contact._id, "channels.telegram.status": { $ne: "blocked" } },
          { $set: { "channels.telegram.status": "blocked", "channels.telegram.unsubscribedAt": at } }
        );
        try {
          await require("./contactService").logConsent({ contactId: r.contact._id, channel: "telegram", action: "telegram_stop", source: "telegram_blocked", meta: { error: out.error } });
        } catch (e) {
          console.error("💥 marketing tg log:", e.message);
        }
      }
    }
    await sleep(TG_INTERVAL_MS);
  }
  return { sent };
}

// ---------- (в) автоматизації ----------

async function existingKeys(automation, contactIds, extra = {}) {
  const list = await M.Message().find({ automation, contactId: { $in: contactIds }, ...extra }).select("contactId step").lean();
  return new Set(list.map((m) => `${m.contactId}:${m.step ?? ""}`));
}

async function insertQueued(docs) {
  for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
    try {
      await M.Message().insertMany(docs.slice(i, i + INSERT_CHUNK), { ordered: false });
    } catch (e) {
      if (!isDupOnly(e)) throw e; // крок welcome уже поставлено (унікальний індекс)
    }
  }
  return docs.length;
}

// Welcome: щойно підтверджені/підписані; кроки за delayHours від subscribedAt; протерміновані (>48 год) — не шлемо
async function runWelcome(settings, now) {
  const w = settings.automations?.welcome;
  if (!w?.enabled || !w.steps?.length) return 0;
  const maxDelay = Math.max(...w.steps.map((s) => Number(s.delayHours) || 0)) * HOUR;
  const since = new Date(now - maxDelay - WELCOME_STALE_MS);
  const contacts = await M.Contact().find({ "channels.email.status": "subscribed", "channels.email.subscribedAt": { $gte: since }, anonymized: { $ne: true } })
    .select("_id channels.email.subscribedAt")
    .limit(5000)
    .lean();
  if (!contacts.length) return 0;
  const have = await existingKeys("welcome", contacts.map((c) => c._id));
  const docs = [];
  for (const c of contacts) {
    const base = new Date(c.channels?.email?.subscribedAt).getTime();
    if (!Number.isFinite(base)) continue;
    w.steps.forEach((s, i) => {
      const due = base + (Number(s.delayHours) || 0) * HOUR;
      if (now - due > WELCOME_STALE_MS || have.has(`${c._id}:${i}`)) return;
      docs.push({ automation: "welcome", step: i, contactId: c._id, channel: "email", status: "queued", queuedAt: new Date(Math.max(due, now - 1000)) });
    });
  }
  return insertQueued(docs);
}

// Покинутий кошик: позиції старші afterHours (до 14 днів), без замовлень після; раз на 14 днів
async function runAbandonedCart(settings, now) {
  const cfg = settings.automations?.abandonedCart;
  if (!cfg?.enabled) return 0;
  const cardModel = require("../models/cardModel");
  const carts = await cardModel.aggregate([
    { $match: { updatedAt: { $lte: new Date(now - cfg.afterHours * HOUR), $gte: new Date(now - CART_DEDUP_DAYS * DAY) } } },
    { $group: { _id: "$userId", last: { $max: "$updatedAt" } } },
    { $limit: 2000 },
  ]);
  if (!carts.length) return 0;
  const lastBy = new Map(carts.map((c) => [String(c._id), c.last]));
  const contacts = await M.Contact().find({
    customerId: { $in: carts.map((c) => c._id) },
    "channels.email.status": "subscribed",
    "channels.email.topics.promo": true,
    anonymized: { $ne: true },
  })
    .select("_id customerId")
    .lean();
  if (!contacts.length) return 0;
  const minLast = new Date(Math.min(...carts.map((c) => new Date(c.last).getTime())));
  const orders = await require("../models/customerOrderModel")
    .find({ customerId: { $in: contacts.map((c) => c.customerId) }, createdAt: { $gt: minLast } })
    .select("customerId createdAt")
    .lean();
  const lastOrder = new Map();
  for (const o of orders) {
    const k = String(o.customerId);
    if (!lastOrder.has(k) || lastOrder.get(k) < o.createdAt) lastOrder.set(k, o.createdAt);
  }
  const recent = await M.Message().find({ automation: "abandoned_cart", contactId: { $in: contacts.map((c) => c._id) }, queuedAt: { $gte: new Date(now - CART_DEDUP_DAYS * DAY) } })
    .select("contactId")
    .lean();
  const skip = new Set(recent.map((m) => String(m.contactId)));
  const docs = [];
  for (const c of contacts) {
    const cart = lastBy.get(String(c.customerId));
    const ord = lastOrder.get(String(c.customerId));
    if (!cart || skip.has(String(c._id)) || (ord && ord > cart)) continue;
    docs.push({ automation: "abandoned_cart", contactId: c._id, channel: "email", status: "queued", queuedAt: new Date(now) });
  }
  return insertQueued(docs);
}

// Winback: не купували afterDays; раз на 90 днів
async function runWinback(settings, now) {
  const cfg = settings.automations?.winback;
  if (!cfg?.enabled) return 0;
  const contacts = await M.Contact().find({
    "stats.lastOrderAt": { $lte: new Date(now - cfg.afterDays * DAY) },
    "channels.email.status": "subscribed",
    "channels.email.topics.promo": true,
    anonymized: { $ne: true },
  })
    .select("_id")
    .limit(1000)
    .lean();
  if (!contacts.length) return 0;
  const recent = await M.Message().find({ automation: "winback", contactId: { $in: contacts.map((c) => c._id) }, queuedAt: { $gte: new Date(now - WINBACK_DEDUP_DAYS * DAY) } })
    .select("contactId")
    .lean();
  const skip = new Set(recent.map((m) => String(m.contactId)));
  const docs = contacts.filter((c) => !skip.has(String(c._id))).map((c) => ({ automation: "winback", contactId: c._id, channel: "email", status: "queued", queuedAt: new Date(now) }));
  return insertQueued(docs);
}

// Для публічного підтвердження (агент/контролер підписки може викликати одразу, не чекаючи 5 хв)
async function enqueueWelcome(contactId) {
  const settings = await settingsLib().load();
  const w = settings.automations?.welcome;
  if (!w?.enabled || !w.steps?.length || !contactId) return 0;
  const c = await M.Contact().findById(contactId).select("_id channels.email").lean();
  if (!c || c.channels?.email?.status !== "subscribed") return 0;
  const now = Date.now();
  const have = await existingKeys("welcome", [c._id]);
  const base = new Date(c.channels.email.subscribedAt || now).getTime();
  const docs = [];
  w.steps.forEach((s, i) => {
    if (have.has(`${c._id}:${i}`)) return;
    docs.push({ automation: "welcome", step: i, contactId: c._id, channel: "email", status: "queued", queuedAt: new Date(Math.max(base + (Number(s.delayHours) || 0) * HOUR, now - 1000)) });
  });
  return insertQueued(docs);
}

// ---------- (г) нічні ----------
async function runNightly(now) {
  const out = {};
  try {
    out.rfm = await require("./rfm").recomputeAll({ now });
  } catch (e) {
    console.error("💥 marketing rfm:", e.message);
  }
  try {
    const r = await M.Contact().updateMany(
      { "channels.email.status": "pending", "channels.email.pendingSince": { $lt: new Date(now - PENDING_TTL_DAYS * DAY) } },
      { $set: { "channels.email.status": "cleaned" }, $unset: { "channels.email.pendingSince": "" } }
    );
    out.cleaned = r.modifiedCount || 0;
  } catch (e) {
    console.error("💥 marketing cleanup:", e.message);
  }
  try {
    await engine().ensureSystemSegments();
    const segs = await M.Segment().find({}).select("_id filter").lean();
    for (const s of segs) {
      try {
        const n = await M.Contact().countDocuments(engine().toMongoQuery(s.filter, { now }));
        await M.Segment().updateOne({ _id: s._id }, { $set: { cachedCount: n, cachedAt: new Date(now) } });
      } catch {
        /* некоректний фільтр — пропускаємо */
      }
    }
  } catch (e) {
    console.error("💥 marketing segments:", e.message);
  }
  return out;
}

// ---------- тестовий лист ----------
// Не рахується у frequency cap, без обгортки кліків, тема з [ТЕСТ]
async function sendTest(campaign, to, { settings } = {}) {
  const s = settings || (await settingsLib().load());
  if (!mailer().isConfigured(s)) return { ok: false, reason: "not_configured", hint: mailer().configHint(s) };
  const contact = await M.Contact().findOne({ email: String(to).toLowerCase() }).select("_id").lean();
  const mail = await template().buildEmail({
    subject: campaign.subject,
    preheader: campaign.preheader,
    blocks: campaign.blocks,
    utm: campaign.utm,
    contactId: contact?._id || null,
    mode: "test",
  });
  const r = await mailer().sendBatch(
    [{ to, subject: mail.subject, html: mail.html, text: mail.text, unsubscribeUrl: mail.links.oneClick || undefined, tags: [{ name: "test", value: "1" }] }],
    { settings: s }
  );
  const x = r.results[0] || {};
  return x.id ? { ok: true, id: x.id } : { ok: false, reason: x.error || r.reason || "error" };
}

// ---------- цикл ----------
const state = { timer: null, busy: false, lastAutomationAt: 0, nightlyKey: null, lastTickAt: null, lastError: "", lastResult: null };

async function tick(now = Date.now()) {
  if (state.busy) return { skipped: "busy" };
  state.busy = true;
  const out = {};
  try {
    const settings = await settingsLib().load();
    out.recovered = await recoverStale(now);
    out.started = await startDueCampaigns(settings, now);
    if (now - state.lastAutomationAt >= AUTOMATION_EVERY_MS) {
      state.lastAutomationAt = now;
      for (const [k, fn] of [
        ["welcome", runWelcome],
        ["abandonedCart", runAbandonedCart],
        ["winback", runWinback],
      ]) {
        try {
          out[k] = await fn(settings, now);
        } catch (e) {
          console.error(`💥 marketing ${k}:`, e.message);
        }
      }
    }
    out.email = await sendEmailQueue(settings, now);
    out.telegram = await sendTelegramQueue(settings, now);
    await finalizeCampaigns(settings, now);
    if (nightlyDue(state.nightlyKey, now)) {
      state.nightlyKey = kyivDateKey(now);
      out.nightly = await runNightly(now);
    }
    state.lastError = "";
  } catch (e) {
    state.lastError = e.message;
    console.error("💥 marketingWorker:", e.message);
  } finally {
    state.busy = false;
    state.lastTickAt = new Date();
    state.lastResult = out;
  }
  return out;
}

const enabled = () => String(process.env.MARKETING_WORKER || "").toLowerCase() !== "off";

function start() {
  if (state.timer) return false;
  if (!enabled()) {
    console.log("✉️  Маркетинговий воркер вимкнено (MARKETING_WORKER=off)");
    return false;
  }
  const run = () => tick().catch((e) => console.error("💥 marketingWorker:", e.message));
  state.timer = setInterval(run, TICK_MS);
  state.timer.unref();
  setTimeout(run, 5000).unref();
  return true;
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

const status = () => ({ enabled: enabled(), running: !!state.timer, lastTickAt: state.lastTickAt, lastError: state.lastError });

module.exports = {
  TZ,
  SKIP_PRIORITY,
  // чисті
  kyivParts,
  kyivDateKey,
  kyivDayStart,
  inSendWindow,
  capsFor,
  capAllowed,
  resolveSkipReason,
  pickReason,
  summarizeEstimate,
  telegramPayload,
  normalizeTgResult,
  nightlyDue,
  isDupOnly,
  noteSent,
  // БД
  claimQueued,
  recoverStale,
  prepareQueue,
  audienceQuery,
  estimateCampaign,
  resolveCampaign,
  recountCampaign,
  sentTodayCount,
  enqueueWelcome,
  sendTest,
  runNightly,
  tgConfigured,
  telegram,
  // цикл
  tick,
  start,
  stop,
  status,
  _models: M, // для тестів (підміна моделей)
};
