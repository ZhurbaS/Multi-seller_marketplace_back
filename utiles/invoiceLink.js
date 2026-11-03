// Підписане тимчасове посилання на PDF рахунку — для месенджерів (WhatsApp/Viber отримують посилання на файл).
// Посилання діє обмежений час і прив'язане до замовлення; без підпису відкрити файл неможливо.

const crypto = require("crypto");

const TTL_MS = 14 * 24 * 60 * 60 * 1000;

const sig = (orderId, exp) =>
  crypto.createHmac("sha256", process.env.SECRET || "dev").update(`invoice:${orderId}:${exp}`).digest("hex").slice(0, 40);

function make(orderId, now = Date.now()) {
  const exp = now + TTL_MS;
  return { exp, sig: sig(orderId, exp) };
}

function verify(orderId, exp, signature, now = Date.now()) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < now) return false;
  const a = Buffer.from(sig(orderId, e));
  const b = Buffer.from(String(signature || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Повне посилання: base — публічна адреса бекенда (PUBLIC_API_URL)
function url(base, orderId, now = Date.now()) {
  const { exp, sig: s } = make(orderId, now);
  return `${String(base).replace(/\/+$/, "")}/api/invoice-file/${orderId}/${exp}/${s}.pdf`;
}

module.exports = { TTL_MS, make, verify, url };
