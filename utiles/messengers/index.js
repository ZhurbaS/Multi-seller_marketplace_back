// Месенджери для рахунків: перелік каналів, відправка PDF, налаштування адміна.
// Канал показується покупцю лише коли адмін його ввімкнув (за замовчуванням — тільки e-mail);
// автоматична відправка працює, лише коли в .env налаштовано ключі провайдера.

const storeSettingsModel = require("../../models/storeSettingsModel");
const invoiceLink = require("../invoiceLink");
const { publicApiUrl } = require("../../payments/config");
const wa = require("./whatsapp");
const vb = require("./viber");

const ADAPTERS = { whatsapp: wa, viber: vb };
const IDS = Object.keys(ADAPTERS);

const isConfigured = (id) => !!ADAPTERS[id]?.isConfigured();

async function loadFlags() {
  const s = (await storeSettingsModel.findOne({ key: "main" }).lean()) || {};
  return { viber: s.messengers?.viber === true, whatsapp: s.messengers?.whatsapp === true };
}

// Для адмінки: що увімкнено й що налаштовано в .env
async function adminState() {
  const f = await loadFlags();
  return Object.fromEntries(IDS.map((id) => [id, { enabled: f[id], configured: isConfigured(id) }]));
}

async function save(body) {
  const next = {};
  for (const id of IDS) next[id] = body?.[id] === true;
  await storeSettingsModel.findOneAndUpdate({ key: "main" }, { $set: { messengers: next } }, { upsert: true });
  return adminState();
}

// Для покупця: канали, які показуємо на оформленні (e-mail є завжди)
async function publicChannels() {
  const f = await loadFlags();
  return ["email", ...IDS.filter((id) => f[id])];
}

// Автоматична відправка PDF. → { ok, id?, error?, skipped? } ; skipped — месенджер не налаштований (надсилає адмін вручну)
async function sendInvoice(channel, { order, filename }) {
  const ad = ADAPTERS[channel];
  if (!ad) return { ok: false, error: "Невідомий канал" };
  if (!ad.isConfigured()) return { ok: false, skipped: true, error: "Месенджер не налаштований" };
  const base = publicApiUrl();
  if (!base || /localhost/.test(base)) return { ok: false, error: "Не задано PUBLIC_API_URL — месенджер не зможе завантажити PDF" };
  const { orderLabel } = require("../orderNumber");
  return ad.sendInvoice({
    to: order.invoice?.contact || order.shippingInfo?.phone,
    pdfUrl: invoiceLink.url(base, String(order._id)),
    filename,
    orderLabel: orderLabel(order),
    total: order.price,
  });
}

module.exports = { IDS, isConfigured, adminState, save, publicChannels, sendInvoice, loadFlags };
