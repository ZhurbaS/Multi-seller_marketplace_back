// Підписані HMAC токени маркетингу (без зберігання в БД): відписка, налаштування, підтвердження,
// прив'язка Telegram, редірект кліків. Формат: base64url(JSON{c,p,e}).hexSig, де
// c — contactId (для click — {m,k,h}, h — відбиток url), p — purpose, e — час закінчення (ms) або 0 (безстроковий).

const crypto = require("crypto");

const PURPOSES = ["unsub", "pref", "confirm", "tg", "click"];
const DAY = 24 * 60 * 60 * 1000;
// Типові TTL: confirm — 7 днів (спека §0.8), tg — 30 днів, інші — без строку дії
const DEFAULT_TTL = { confirm: 7 * DAY, tg: 30 * DAY };

// Без SECRET у production токени можна було б підробити (ключ "dev") → відмовляємо явно
function secretKey() {
  const s = process.env.SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("SECRET не задано — маркетингові токени вимкнено");
  return "dev";
}
const hmac = (data) => crypto.createHmac("sha256", secretKey()).update(`mkt:${data}`).digest("hex");
const OID = /^[a-f\d]{24}$/i;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url").toString("utf8");

function encode(payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}

// → payload | null (підпис/формат); перевірку purpose/exp робить викликач
function decode(token) {
  if (typeof token !== "string" || token.length > 2000) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[a-f0-9]{64}$/.test(sig)) return null;
  const a = Buffer.from(hmac(body), "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(unb64(body));
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

function expOf(purpose, ttlMs, now) {
  const ttl = ttlMs === undefined ? DEFAULT_TTL[purpose] : ttlMs;
  return Number.isFinite(ttl) && ttl > 0 ? now + ttl : 0;
}

// campaignId (необов'язково) — для токена відписки з листа кампанії: дозволяє врахувати stats.unsubscribed
function sign(purpose, contactId, { ttlMs, now = Date.now(), campaignId } = {}) {
  if (!PURPOSES.includes(purpose)) throw new Error(`Невідомий purpose токена: ${purpose}`);
  const c = String(contactId ?? "");
  if (!c) throw new Error("contactId обов'язковий");
  const k = campaignId ? String(campaignId) : "";
  return encode({ c, p: purpose, e: expOf(purpose, ttlMs, now), ...(OID.test(k) ? { k } : {}) });
}

// → { ok:true, contactId, exp, campaignId } | { ok:false, error:'invalid'|'purpose'|'expired' }
function verify(token, purpose, { now = Date.now() } = {}) {
  const p = decode(token);
  if (!p || typeof p.c !== "string" || !p.c) return { ok: false, error: "invalid" };
  if (!PURPOSES.includes(purpose) || p.p !== purpose) return { ok: false, error: "purpose" };
  const exp = Number(p.e) || 0;
  if (exp && exp < now) return { ok: false, error: "expired", contactId: p.c, exp };
  return { ok: true, contactId: p.c, exp, campaignId: typeof p.k === "string" && OID.test(p.k) ? p.k : null };
}

// Короткий відбиток цільового URL (sha256, перші 16 байт base64url) — вшивається в підписаний payload,
// щоб /api/r/:token?u= не можна було використати як open-redirect на довільну адресу
function urlHash(url) {
  return crypto.createHash("sha256").update(String(url ?? ""), "utf8").digest("base64url").slice(0, 22);
}

// Токен кліку: прив'язаний до CampaignMessage (і кампанії) та до конкретного url; безстроковий, якщо не задано ttlMs
function signClick({ messageId, campaignId = null, url } = {}, { ttlMs, now = Date.now() } = {}) {
  const m = String(messageId ?? "");
  if (!m) throw new Error("messageId обов'язковий");
  if (typeof url !== "string" || !url) throw new Error("url обов'язковий");
  return encode({ c: { m, k: campaignId ? String(campaignId) : null, h: urlHash(url) }, p: "click", e: expOf("click", ttlMs, now) });
}

// → { ok:true, messageId, campaignId, urlHash, exp } | { ok:false, error }
function verifyClick(token, { now = Date.now() } = {}) {
  const p = decode(token);
  if (!p || !p.c || typeof p.c !== "object" || typeof p.c.m !== "string" || !p.c.m) {
    return { ok: false, error: "invalid" };
  }
  if (p.p !== "click") return { ok: false, error: "purpose" };
  if (typeof p.c.h !== "string" || !p.c.h) return { ok: false, error: "invalid" };
  const exp = Number(p.e) || 0;
  if (exp && exp < now) return { ok: false, error: "expired" };
  return { ok: true, messageId: p.c.m, campaignId: p.c.k || null, urlHash: p.c.h, exp };
}

// Чи відповідає url відбитку з токена (порівняння за сталий час)
function clickUrlMatches(v, url) {
  if (!v || typeof v.urlHash !== "string" || typeof url !== "string") return false;
  const a = Buffer.from(urlHash(url));
  const b = Buffer.from(v.urlHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { PURPOSES, DEFAULT_TTL, secretKey, sign, verify, urlHash, signClick, verifyClick, clickUrlMatches };
