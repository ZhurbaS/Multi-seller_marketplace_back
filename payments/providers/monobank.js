// plata by mono (monobank) — інтернет-еквайринг.
// Документація: https://monobank.ua/api-docs/acquiring
// Тестовий токен (працює без ФОП): https://api.monobank.ua — заходиш у monobank-аплікацію,
// скануєш QR, отримуєш токен. Токен запиту — заголовок X-Token.

const crypto = require("crypto");
const { publicApiUrl, publicFrontUrl } = require("../config");

const API = "https://api.monobank.ua";

let cachedPubKey = null; // PEM, кешується; оновлюємо лише коли перевірка підпису не проходить

async function monoFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "X-Token": process.env.MONO_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    /* не JSON */
  }
  if (!res.ok) {
    const msg = json?.errText || json?.errCode || text || res.status;
    const err = new Error(`monobank API ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Ключ приходить як base64 від PEM.
async function fetchPubKey() {
  const json = await monoFetch("/api/merchant/pubkey");
  cachedPubKey = Buffer.from(json.key, "base64").toString("utf8");
  return cachedPubKey;
}

// Перевірка підпису вебхука: ECDSA + SHA-256 над СИРИМ тілом запиту, підпис у x-sign (base64, DER).
function verifyWithKey(pem, rawBody, signBase64) {
  try {
    const verifier = crypto.createVerify("SHA256");
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(pem, Buffer.from(signBase64, "base64"));
  } catch (_) {
    return false;
  }
}

async function verifyWebhook(rawBody, signBase64) {
  if (!rawBody || !signBase64) return false;
  if (!cachedPubKey) {
    try {
      await fetchPubKey();
    } catch (e) {
      console.error("monobank: не вдалося отримати публічний ключ:", e.message);
      return false;
    }
  }
  if (verifyWithKey(cachedPubKey, rawBody, signBase64)) return true;
  // Ключ міг змінитися — один раз оновлюємо й пробуємо знову.
  try {
    await fetchPubKey();
  } catch (_) {
    return false;
  }
  return verifyWithKey(cachedPubKey, rawBody, signBase64);
}

// Створення рахунку. amountUah — гривні (можуть бути з копійками), у API йде в копійках.
async function createInvoice({ order, amountUah }) {
  const reference = order._id.toString();
  const body = {
    amount: Math.round(amountUah * 100),
    ccy: 980,
    merchantPaymInfo: {
      reference,
      destination: `Оплата замовлення №${reference.slice(-8).toUpperCase()}`,
      basketOrder: (order.products || []).slice(0, 50).map((p) => {
        const unit = p.price - Math.floor((p.price * (p.discount || 0)) / 100);
        return {
          name: String(p.name).slice(0, 250),
          qty: p.quantity,
          sum: Math.round(unit * 100),
          code: String(p._id),
          unit: "шт.",
        };
      }),
    },
    redirectUrl: `${publicFrontUrl()}/order/confirm?orderId=${reference}`,
    webHookUrl: `${publicApiUrl()}/api/pay/webhook/monobank`,
    validity: 3600,
    paymentType: "debit",
  };
  const json = await monoFetch("/api/merchant/invoice/create", {
    method: "POST",
    body,
  });
  return { invoiceId: json.invoiceId, pageUrl: json.pageUrl };
}

async function getInvoiceStatus(invoiceId) {
  return monoFetch(
    `/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`
  );
}

// Статуси monobank: created | processing | hold | success | failure | reversed | expired
function normalizeStatus(status) {
  switch (status) {
    case "success":
      return "paid";
    case "failure":
    case "expired":
    case "reversed":
      return "failed";
    default:
      return "pending";
  }
}

module.exports = {
  name: "monobank",
  createInvoice,
  getInvoiceStatus,
  verifyWebhook,
  normalizeStatus,
  // для тестів
  _verifyWithKey: verifyWithKey,
  _setPubKey: (pem) => {
    cachedPubKey = pem;
  },
};
