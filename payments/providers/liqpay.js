// LiqPay — Checkout (хостинг-сторінка оплати).
// Документація: https://www.liqpay.ua/doc/api/internet_acquiring/checkout
// Sandbox: параметр sandbox=1 у запиті; тестова картка 4242 4242 4242 4242, будь-які дата/CVV.
// Без ФОП публічні ключі LiqPay отримати неможливо — тому цей провайдер вмикається,
// щойно в .env з'являються LIQPAY_PUBLIC_KEY / LIQPAY_PRIVATE_KEY.

const crypto = require("crypto");
const { publicApiUrl, publicFrontUrl, isProduction } = require("../config");

const CHECKOUT_URL = "https://www.liqpay.ua/api/3/checkout";
const API_URL = "https://www.liqpay.ua/api/request";

// Офіційний SDK (liqpay/sdk-nodejs) підписує так: base64(sha1(private + data + private)).
// У новій документації згадується sha3-256, тому при ПЕРЕВІРЦІ вхідного callback приймаємо обидва
// варіанти (обидва потребують приватного ключа), а підписуємо за LIQPAY_SIGN_ALGO (за замовчуванням sha1).
function sign(data, privateKey, algo) {
  return crypto
    .createHash(algo || process.env.LIQPAY_SIGN_ALGO || "sha1")
    .update(privateKey + data + privateKey)
    .digest("base64");
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verifyCallback(data, signature, privateKey = process.env.LIQPAY_PRIVATE_KEY) {
  if (!data || !signature || !privateKey) return false;
  return ["sha1", "sha3-256"].some((algo) =>
    safeEqual(sign(data, privateKey, algo), signature)
  );
}

function decodeData(data) {
  return JSON.parse(Buffer.from(data, "base64").toString("utf8"));
}

// Повертає поля форми для POST на LiqPay Checkout. Фронт автоматично відправляє форму.
function createCheckout({ order, amountUah }) {
  const orderId = order._id.toString();
  const params = {
    public_key: process.env.LIQPAY_PUBLIC_KEY,
    version: 3,
    action: "pay",
    amount: Number(amountUah.toFixed(2)),
    currency: "UAH",
    description: `Оплата замовлення №${orderId.slice(-8).toUpperCase()}`,
    order_id: orderId,
    language: "uk",
    result_url: `${publicFrontUrl()}/order/confirm?orderId=${orderId}`,
    server_url: `${publicApiUrl()}/api/pay/webhook/liqpay`,
    // У sandbox-режимі гроші не списуються. У production його ніколи не вмикаємо.
    ...(isProduction() || process.env.LIQPAY_SANDBOX === "false"
      ? {}
      : { sandbox: 1 }),
  };
  const data = Buffer.from(JSON.stringify(params)).toString("base64");
  return {
    url: CHECKOUT_URL,
    fields: { data, signature: sign(data, process.env.LIQPAY_PRIVATE_KEY) },
  };
}

// Серверний запит статусу (verify-on-return, на випадок якщо callback затримується).
async function getStatus(orderId) {
  const params = {
    public_key: process.env.LIQPAY_PUBLIC_KEY,
    version: 3,
    action: "status",
    order_id: orderId,
  };
  const data = Buffer.from(JSON.stringify(params)).toString("base64");
  const body = new URLSearchParams({
    data,
    signature: sign(data, process.env.LIQPAY_PRIVATE_KEY),
  });
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`LiqPay API ${res.status}`);
  return res.json();
}

// success/sandbox → оплачено; failure/error/reversed → невдача; решта — очікування
// (wait_accept, wait_secure, processing, 3ds_verify тощо).
function normalizeStatus(status) {
  switch (status) {
    case "success":
    case "sandbox":
      return "paid";
    case "failure":
    case "error":
    case "reversed":
      return "failed";
    default:
      return "pending";
  }
}

module.exports = {
  name: "liqpay",
  sign,
  verifyCallback,
  decodeData,
  createCheckout,
  getStatus,
  normalizeStatus,
};
