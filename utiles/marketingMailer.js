// Мейлер маркетингових розсилок (MARKETING_SPEC.md §8): Resend `/emails/batch` (до 100 листів на запит)
// з окремого відправника MARKETING_MAIL_FROM (піддомен). Кожен лист має List-Unsubscribe (+ One-Click, RFC 8058).
// Транзакційна пошта лишається в utiles/mailer.js. Без налаштувань — { ok:false, reason:'not_configured' }.

const BATCH_URL = "https://api.resend.com/emails/batch";
const MAX_PER_REQUEST = 100;
const MIN_INTERVAL_MS = 500; // ≤ 2 запити/с
const MAX_ATTEMPTS = 3;

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

// Відправник: налаштування (fromEmail) → env MARKETING_MAIL_FROM. Без назви — «senderName <addr>»
function resolveFrom({ fromEmail, senderName } = {}) {
  const raw = String(fromEmail || process.env.MARKETING_MAIL_FROM || "").trim();
  if (!raw) return "";
  if (/<[^<>]+@[^<>]+>\s*$/.test(raw)) return raw;
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(raw)) return "";
  const name = String(senderName || "").replace(/[<>"\r\n]/g, "").trim();
  return name ? `${name} <${raw}>` : raw;
}

const hasApiKey = () => !!String(process.env.RESEND_API_KEY || "").trim();

function isConfigured(settings = {}) {
  return hasApiKey() && !!resolveFrom(settings);
}

// Пояснення для адмінки, якщо не налаштовано (null — усе гаразд)
function configHint(settings = {}) {
  if (!hasApiKey()) return "Не задано RESEND_API_KEY у .env бека — масові листи надсилати неможливо.";
  if (!resolveFrom(settings))
    return "Не задано відправника розсилок: MARKETING_MAIL_FROM у .env (напр. «TechScout <news@news.ваш-домен.ua>») або «Відправник» у налаштуваннях маркетингу. Домен має бути підтверджений у Resend (SPF/DKIM/DMARC).";
  return null;
}

const clean = (s, max) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

// Один лист → об'єкт Resend
function buildPayload(msg, { from, replyTo } = {}) {
  const headers = { ...(msg.headers || {}) };
  const unsubs = [msg.unsubscribeUrl && `<${msg.unsubscribeUrl}>`, msg.unsubscribeMailto && `<mailto:${msg.unsubscribeMailto}>`].filter(Boolean);
  if (unsubs.length) headers["List-Unsubscribe"] = unsubs.join(", ");
  if (msg.unsubscribeUrl) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  const p = {
    from,
    to: [String(msg.to)],
    subject: clean(msg.subject, 300),
    html: msg.html,
    text: msg.text,
    headers,
  };
  const rt = msg.replyTo || replyTo;
  if (rt) p.reply_to = rt;
  if (Array.isArray(msg.tags) && msg.tags.length) {
    p.tags = msg.tags
      .map((t) => ({ name: String(t.name || "").replace(/[^\w-]/g, "_").slice(0, 256), value: String(t.value ?? "").replace(/[^\w-]/g, "_").slice(0, 256) }))
      .filter((t) => t.name && t.value);
  }
  return p;
}

const retryable = (status) => status === 429 || status >= 500;

function retryDelay(res, attempt) {
  const ra = Number(res?.headers?.get?.("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 30000);
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

// Один запит /emails/batch з ретраями 5xx/429/мережа. → { ids:[...]} | { error, status, retryable }
async function postChunk(payloads, { fetchImpl, sleep, idempotencyKey }) {
  let last = { error: "unknown", status: 0, retryable: true };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      const headers = { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" };
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      res = await fetchImpl(BATCH_URL, { method: "POST", headers, body: JSON.stringify(payloads) });
    } catch (e) {
      last = { error: `network: ${e.message}`, status: 0, retryable: true };
      if (attempt < MAX_ATTEMPTS) await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
      continue;
    }
    if (res.ok) {
      let body = {};
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      const data = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
      return { ids: payloads.map((_, i) => (data[i] && data[i].id) || null), errors: Array.isArray(body?.errors) ? body.errors : [] };
    }
    let msg = "";
    try {
      msg = (await res.text()).slice(0, 500);
    } catch {
      msg = "";
    }
    last = { error: `resend ${res.status}${msg ? `: ${msg}` : ""}`, status: res.status, retryable: retryable(res.status) };
    if (!last.retryable) break;
    if (attempt < MAX_ATTEMPTS) await sleep(retryDelay(res, attempt));
  }
  return last;
}

// messages: [{ to, subject, html, text, unsubscribeUrl, unsubscribeMailto?, replyTo?, headers?, tags?, idempotencyKey? }]
// → { ok, reason?, results:[{ id } | { error, status, retryable }] } (results у тому ж порядку)
async function sendBatch(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const settings = opts.settings || {};
  const from = opts.from || resolveFrom(settings);
  if (!hasApiKey() || !from) {
    return { ok: false, reason: "not_configured", results: list.map(() => ({ error: "not_configured", retryable: true })) };
  }
  if (!list.length) return { ok: true, results: [] };
  const fetchImpl = opts.fetch || globalThis.fetch;
  const sleep = opts.sleep || sleepDefault;
  const replyTo = opts.replyTo || settings.replyTo || "";
  const results = new Array(list.length);
  let lastAt = 0;

  for (let i = 0; i < list.length; i += MAX_PER_REQUEST) {
    const chunk = list.slice(i, i + MAX_PER_REQUEST);
    // Без адреси/теми — помилка конкретного листа, решту відправляємо
    const valid = [];
    chunk.forEach((m, j) => {
      if (!m || !m.to || !String(m.subject || "").trim() || (!m.html && !m.text)) results[i + j] = { error: "invalid_message", retryable: false };
      else valid.push(j);
    });
    if (!valid.length) continue;
    const wait = lastAt + MIN_INTERVAL_MS - Date.now();
    if (lastAt && wait > 0) await sleep(wait);
    const keyParts = valid.map((j) => chunk[j].idempotencyKey).filter(Boolean);
    const r = await postChunk(
      valid.map((j) => buildPayload(chunk[j], { from, replyTo })),
      { fetchImpl, sleep, idempotencyKey: keyParts.length === valid.length ? `mkt-${hashKey(keyParts.join(","))}` : undefined }
    );
    lastAt = Date.now();
    valid.forEach((j, k) => {
      if (r.ids) results[i + j] = r.ids[k] ? { id: r.ids[k] } : { error: "no_id", retryable: false };
      else results[i + j] = { error: r.error, status: r.status, retryable: r.retryable };
    });
  }
  return { ok: results.every((x) => x && x.id), results };
}

function hashKey(s) {
  return require("crypto").createHash("sha256").update(s).digest("hex").slice(0, 48);
}

module.exports = { BATCH_URL, MAX_PER_REQUEST, MAX_ATTEMPTS, resolveFrom, isConfigured, configHint, buildPayload, sendBatch };
