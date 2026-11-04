// Вебхуки маркетингу: Resend (bounce/complaint/suppressed, підпис Svix) і Telegram-бот.
// Див. MARKETING_SPEC.md §5. Сире тіло для перевірки підпису — req.rawBody (server.js, bodyParser.json verify)
// або Buffer від express.raw на маршруті (routes/webhookRoutes.js), якщо Content-Type не JSON.

const crypto = require("crypto");

const TOLERANCE_SEC = 5 * 60;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

// ======================= Svix (чисті функції) =======================

function secretBytes(secret) {
  const s = String(secret || "").trim();
  if (!s) return null;
  const b64 = s.startsWith("whsec_") ? s.slice(6) : s;
  const buf = Buffer.from(b64, "base64");
  return buf.length ? buf : null;
}

function svixSign(secret, id, timestamp, body) {
  const key = secretBytes(secret);
  return crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${Buffer.isBuffer(body) ? body.toString("utf8") : String(body)}`).digest("base64");
}

// → { ok:true } | { ok:false, error:'missing'|'timestamp'|'signature'|'secret' }
function verifySvix({ secret, id, timestamp, signature, body, now = Date.now() }) {
  const key = secretBytes(secret);
  if (!key) return { ok: false, error: "secret" };
  if (!id || !timestamp || !signature || body === undefined || body === null) return { ok: false, error: "missing" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || !/^\d{1,12}$/.test(String(timestamp))) return { ok: false, error: "timestamp" };
  if (Math.abs(Math.floor(now / 1000) - ts) > TOLERANCE_SEC) return { ok: false, error: "timestamp" };
  const expected = Buffer.from(svixSign(secret, id, timestamp, body));
  // Заголовок: «v1,<base64> v1,<base64>» (кілька підписів під час ротації секрету)
  for (const part of String(signature).split(" ")) {
    const [ver, sig] = part.split(",");
    if (ver !== "v1" || !sig) continue;
    const got = Buffer.from(sig);
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, error: "signature" };
}

// Дедуплікація svix-id: true — уперше (і запам'ятовує), false — повтор
function makeDeduper(ttlMs = DEDUP_TTL_MS) {
  const seen = new Map();
  let last = 0;
  const first = (id, now = Date.now()) => {
    if (now - last > 60 * 1000) {
      for (const [k, t] of seen) if (now - t > ttlMs) seen.delete(k);
      last = now;
    }
    const t = seen.get(id);
    if (t !== undefined && now - t <= ttlMs) return false;
    seen.set(id, now);
    return true;
  };
  return { first, forget: (id) => seen.delete(id) };
}
const dedup = makeDeduper();

// Подія Resend → { kind:'bounce'|'complaint'|null, email, providerId, messageId, hard }
function parseResendEvent(evt) {
  const type = evt?.type;
  const d = evt?.data || {};
  const to = Array.isArray(d.to) ? d.to[0] : d.to;
  let messageId = null;
  const tags = d.tags;
  const pick = (k) => ["messageId", "message_id", "cmid", "campaign_message_id"].includes(k);
  if (Array.isArray(tags)) messageId = tags.find((t) => pick(t?.name))?.value || null;
  else if (tags && typeof tags === "object") messageId = Object.entries(tags).find(([k]) => pick(k))?.[1] || null;
  const base = { email: typeof to === "string" ? to : "", providerId: d.email_id ? String(d.email_id) : "", messageId: messageId ? String(messageId) : null };
  if (type === "email.complained") return { kind: "complaint", ...base, hard: true };
  if (type === "email.suppressed") return { kind: "bounce", ...base, hard: true };
  if (type === "email.bounced") {
    const bt = String(d.bounce?.type || "").toLowerCase();
    return { kind: "bounce", ...base, hard: bt !== "transient" };
  }
  return { kind: null, ...base, hard: false };
}

// ======================= Resend (БД) =======================

async function applyResendEvent(evt) {
  const p = parseResendEvent(evt);
  if (!p.kind) return "ignored";
  const cs = require("../utiles/contactService");
  const Contact = require("../models/contactModel");
  const CampaignMessage = require("../models/campaignMessageModel");
  const Campaign = require("../models/campaignModel");
  const mongoose = require("mongoose");

  let msg = null;
  if (p.messageId && mongoose.Types.ObjectId.isValid(p.messageId)) msg = await CampaignMessage.findById(p.messageId);
  if (!msg && p.providerId) msg = await CampaignMessage.findOne({ providerId: p.providerId });

  let contact = msg ? await Contact.findById(msg.contactId) : null;
  if (!contact) {
    const e = cs.normalizeEmail(p.email);
    if (e) contact = await Contact.findOne({ email: e });
  }
  const meta = { event: evt.type, providerId: p.providerId || undefined, messageId: msg ? String(msg._id) : undefined, hard: p.hard };
  if (contact) {
    if (p.kind === "complaint") await cs.markComplained(contact, { source: "resend", meta });
    else if (p.hard) await cs.markBounced(contact, { source: "resend", meta });
  }
  // Разово на повідомлення (повтори/інші svix-id тієї ж події не роздувають статистику)
  if (msg?.campaignId && (p.kind === "complaint" || p.hard)) {
    await cs.creditCampaign({ messageId: msg._id, field: p.kind === "complaint" ? "complained" : "bounced" }, { Message: CampaignMessage, Campaign });
  }
  return contact ? p.kind : "no_contact";
}

async function resend(req, res) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: "RESEND_WEBHOOK_SECRET не задано — вебхук Resend вимкнено" });
  const raw = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : null);
  const id = req.get("svix-id");
  const v = verifySvix({ secret, id, timestamp: req.get("svix-timestamp"), signature: req.get("svix-signature"), body: raw });
  if (!v.ok) return res.status(v.error === "missing" ? 400 : 401).json({ error: "Недійсний підпис вебхука" });
  if (!dedup.first(id)) return res.status(200).json({ ok: true, duplicate: true });
  let evt;
  try {
    evt = JSON.parse(raw.toString("utf8"));
  } catch {
    dedup.forget(id);
    return res.status(400).json({ error: "Некоректне тіло" });
  }
  try {
    const result = await applyResendEvent(evt);
    return res.status(200).json({ ok: true, result });
  } catch (e) {
    console.error("💥 webhook resend:", e.message);
    dedup.forget(id); // повтор від Svix має бути оброблений
    return res.status(500).json({ error: "Помилка обробки" }); // Svix повторить
  }
}

// ======================= Telegram =======================

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

async function telegram(req, res) {
  const bot = require("../utiles/telegramBot");
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (!bot.isConfigured() || !secret) return res.status(503).json({ error: "Telegram-бот не налаштовано (TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET)" });
  if (!safeEqual(req.get("x-telegram-bot-api-secret-token"), secret)) return res.status(401).json({ error: "Недійсний секрет" });
  try {
    await bot.handleUpdate(req.body);
  } catch (e) {
    // 200 навмисно: інакше Telegram повторюватиме те саме оновлення
    console.error("💥 webhook telegram:", e.message);
  }
  return res.status(200).json({ ok: true });
}

module.exports = { verifySvix, svixSign, makeDeduper, parseResendEvent, applyResendEvent, resend, telegram, TOLERANCE_SEC };
