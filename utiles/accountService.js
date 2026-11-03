// Вхід без пароля: гостьовий (м'який) акаунт, одноразовий код на e-mail, вхід через Google.
// Чисті функції + невеликі допоміжні функції для контролерів; HTTP — controllers/home/accessController.js.

const bcrypt = require("bcrypt");
const crypto = require("crypto");
const customerModel = require("../models/customerModel");
const cardModel = require("../models/cardModel");
const { createToken } = require("./tokenCreate");
const ec = require("./emailChange");

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_MS = 45 * 1000;
const OTP_MAX_ATTEMPTS = 5;

const emailRe = (email) => new RegExp(`^${ec.escapeRe(email)}$`, "i");

async function findByEmail(email, select = "") {
  return customerModel.findOne({ email: emailRe(email) }).select(select);
}

async function issueSession(res, c) {
  const token = await createToken({
    id: c.id,
    role: "customer",
    name: c.name,
    email: c.email || "",
    phone: c.phone || "",
    method: c.method,
    guest: !!c.isGuest,
  });
  res.cookie("customerToken", token, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000,
  });
  return token;
}

// id гостя з поточного cookie (якщо є і це гостьовий акаунт)
async function guestIdFromRequest(req) {
  try {
    const t = req.cookies?.customerToken;
    if (!t) return null;
    const d = require("jsonwebtoken").verify(t, process.env.SECRET);
    const c = await customerModel.findById(d.id).select("isGuest").lean();
    return c?.isGuest ? String(c._id) : null;
  } catch {
    return null;
  }
}

// Кошик гостя переходить до акаунта, у який увійшли (без дублів: у разі збігу товару лишається кількість акаунта)
async function mergeGuestCart(fromId, toId) {
  if (!fromId || !toId || String(fromId) === String(toId)) return 0;
  const mine = new Set((await cardModel.find({ userId: toId }).select("productId").lean()).map((x) => String(x.productId)));
  const theirs = await cardModel.find({ userId: fromId }).lean();
  let moved = 0;
  for (const it of theirs) {
    if (mine.has(String(it.productId))) await cardModel.deleteOne({ _id: it._id });
    else {
      await cardModel.updateOne({ _id: it._id }, { $set: { userId: toId } });
      moved++;
    }
  }
  return moved;
}

// ---- одноразовий код
function newOtp(email) {
  const code = ec.makeCode();
  return {
    code,
    record: {
      codeHash: ec.hashCode(code, email),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      sentAt: new Date(),
      attempts: 0,
    },
  };
}

// → "" | текст помилки; p — запис otp з акаунта
function otpProblem(p, code, email) {
  if (!p?.codeHash) return "Спочатку запросіть код";
  if (new Date(p.expiresAt).getTime() < Date.now()) return "Строк дії коду минув. Запросіть новий";
  if ((p.attempts || 0) >= OTP_MAX_ATTEMPTS) return "Забагато невдалих спроб. Запросіть новий код";
  if (!ec.codesEqual(ec.hashCode(code, email), p.codeHash)) return "Невірний код";
  return "";
}

// ---- Google ID-токен (Google Identity Services). Перевіряємо на сервері Google (tokeninfo): підпис, строк, aud.
function validateGooglePayload(p, clientId) {
  if (!p || typeof p !== "object") return { error: "Некоректний токен Google" };
  if (!clientId) return { error: "Вхід через Google не налаштовано" };
  if (p.aud !== clientId) return { error: "Токен Google виданий для іншого застосунку" };
  if (!["accounts.google.com", "https://accounts.google.com"].includes(p.iss)) return { error: "Некоректний видавець токена" };
  if (Number(p.exp) * 1000 < Date.now()) return { error: "Строк дії токена Google минув" };
  if (!p.sub) return { error: "Некоректний токен Google" };
  if (!(p.email_verified === true || p.email_verified === "true") || !p.email) {
    return { error: "Адресу e-mail у Google не підтверджено" };
  }
  return { value: { sub: String(p.sub), email: String(p.email).toLowerCase(), name: String(p.name || "").slice(0, 100) } };
}

async function verifyGoogleCredential(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return { error: "Вхід через Google не налаштовано" };
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(String(credential || ""))}`);
    if (!r.ok) return { error: "Не вдалося підтвердити вхід через Google" };
    return validateGooglePayload(await r.json(), clientId);
  } catch (e) {
    console.error("💥 google tokeninfo:", e.message);
    return { error: "Не вдалося підтвердити вхід через Google" };
  }
}

// Випадковий (недоступний для входу) пароль-хеш не потрібен: акаунти без пароля мають password: undefined
const randomId = () => crypto.randomBytes(8).toString("hex");

module.exports = {
  OTP_TTL_MS,
  OTP_RESEND_MS,
  OTP_MAX_ATTEMPTS,
  emailRe,
  findByEmail,
  issueSession,
  guestIdFromRequest,
  mergeGuestCart,
  newOtp,
  otpProblem,
  validateGooglePayload,
  verifyGoogleCredential,
  randomId,
  bcrypt,
};
