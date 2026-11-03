// Viber Business Messages (через офіційного партнера Viber: Infobip, Turbosms, Sinch тощо).
// Viber не дає надсилати довільним номерам через звичайний бот/Public Account — потрібен платний бізнес-канал.
// Адаптер працює з типовим REST-шлюзом партнера; точні назви полів і URL залежать від провайдера —
// після вибору провайдера їх достатньо підправити в buildPayload (один файл).
//
// .env:
//   VIBER_API_URL        адреса методу надсилання повідомлення у провайдера
//   VIBER_TOKEN          ключ API (передається як Bearer)
//   VIBER_SENDER         назва/ID відправника (Viber Business sender)
//   VIBER_WEBHOOK_SECRET спільний секрет для вебхука статусів (заголовок x-webhook-secret)
// Вебхук статусів: {PUBLIC_API_URL}/api/webhooks/viber

const isConfigured = () => !!process.env.VIBER_API_URL && !!process.env.VIBER_TOKEN && !!process.env.VIBER_SENDER;

const toViberNumber = (phone) => String(phone || "").replace(/\D/g, "");

// Чиста функція: повідомлення з кнопкою-посиланням на PDF
function buildPayload({ to, pdfUrl, filename, orderLabel, total, sender }) {
  return {
    sender,
    receiver: toViberNumber(to),
    type: "text_button",
    text: `Рахунок на оплату замовлення ${orderLabel} на суму ₴${total}. Файл: ${filename}`,
    button: { caption: "Відкрити рахунок (PDF)", url: pdfUrl },
  };
}

// → { ok, id?, error? }
async function sendInvoice({ to, pdfUrl, filename, orderLabel, total }) {
  if (!isConfigured()) return { ok: false, error: "Viber не налаштовано" };
  if (toViberNumber(to).length < 11) return { ok: false, error: "Некоректний номер телефону" };
  try {
    const res = await fetch(process.env.VIBER_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.VIBER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload({ to, pdfUrl, filename, orderLabel, total, sender: process.env.VIBER_SENDER })),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message || data?.message || `Viber ${res.status}` };
    return { ok: true, id: data?.message_id || data?.id || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function verifySecret(header, secret = process.env.VIBER_WEBHOOK_SECRET) {
  if (!secret || !header) return false;
  const crypto = require("crypto");
  const a = Buffer.from(String(secret));
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Тіло вебхука → [{ id, status, error }]; status: sent | delivered | read | failed
function parseStatuses(body) {
  const items = Array.isArray(body) ? body : body ? [body] : [];
  return items
    .filter((x) => x && (x.message_id || x.id))
    .map((x) => {
      const raw = String(x.status || x.event || "").toLowerCase();
      const status = ["delivered", "read", "failed", "sent"].includes(raw) ? raw : raw.includes("seen") ? "read" : raw.includes("fail") ? "failed" : "sent";
      return { id: String(x.message_id || x.id), status, error: x.error || null };
    });
}

module.exports = { isConfigured, toViberNumber, buildPayload, sendInvoice, verifySecret, parseStatuses };
