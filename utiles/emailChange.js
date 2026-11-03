// Зміна e-mail покупця з підтвердженням кодом (одноразовий 6-значний код на НОВУ адресу).
// Чисті функції без БД — логіка маршруту в routes/home/checkoutRoutes.js.

const crypto = require("crypto");

const CODE_TTL_MS = 15 * 60 * 1000; // код діє 15 хвилин
const RESEND_MS = 60 * 1000; // повторне надсилання не частіше ніж раз на хвилину
const MAX_ATTEMPTS = 5; // спроб введення коду

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// → { value } | { error }
function normalizeEmail(raw) {
  const e = String(raw ?? "").trim().toLowerCase();
  if (e.length > 120 || !EMAIL_RE.test(e)) return { error: "Вкажіть коректну електронну адресу" };
  return { value: e };
}

const makeCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");

// Код зберігаємо лише у вигляді HMAC (прив'язаний до пошти й секрету сервера)
const hashCode = (code, email) =>
  crypto.createHmac("sha256", process.env.SECRET || "dev").update(`${email}:${code}`).digest("hex");

function codesEqual(a, b) {
  const x = Buffer.from(String(a), "hex");
  const y = Buffer.from(String(b), "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = { CODE_TTL_MS, RESEND_MS, MAX_ATTEMPTS, normalizeEmail, makeCode, hashCode, codesEqual, escapeRe };
