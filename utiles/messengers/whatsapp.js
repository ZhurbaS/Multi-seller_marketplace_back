// WhatsApp Business Cloud API (Meta). Для першого повідомлення клієнту потрібен ЗАТВЕРДЖЕНИЙ шаблон
// (категорія Utility) із вкладенням-документом у заголовку та двома змінними в тексті:
//   {{1}} — номер замовлення, {{2}} — сума. Назва шаблону — WHATSAPP_TEMPLATE_INVOICE.
//
// .env:
//   WHATSAPP_TOKEN              постійний токен доступу (System User)
//   WHATSAPP_PHONE_ID           ID номера відправника (Phone number ID)
//   WHATSAPP_TEMPLATE_INVOICE   назва затвердженого шаблону
//   WHATSAPP_TEMPLATE_LANG      мова шаблону (за замовчуванням uk)
//   WHATSAPP_APP_SECRET         секрет застосунку — перевірка підпису вебхука
//   WHATSAPP_VERIFY_TOKEN       довільний рядок для підтвердження вебхука в Meta
// Вебхук у Meta: {PUBLIC_API_URL}/api/webhooks/whatsapp (події messages → statuses).

const API = "https://graph.facebook.com/v21.0";

const isConfigured = () =>
  !!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_PHONE_ID && !!process.env.WHATSAPP_TEMPLATE_INVOICE;

// +380501234567 → 380501234567 (формат Meta: лише цифри з кодом країни)
const toWaNumber = (phone) => String(phone || "").replace(/\D/g, "");

// Чиста функція: тіло запиту на надсилання шаблону з документом
function buildPayload({ to, pdfUrl, filename, orderLabel, total, template, lang = "uk" }) {
  return {
    messaging_product: "whatsapp",
    to: toWaNumber(to),
    type: "template",
    template: {
      name: template,
      language: { code: lang },
      components: [
        { type: "header", parameters: [{ type: "document", document: { link: pdfUrl, filename } }] },
        {
          type: "body",
          parameters: [
            { type: "text", text: String(orderLabel) },
            { type: "text", text: String(total) },
          ],
        },
      ],
    },
  };
}

// → { ok, id?, error? }
async function sendInvoice({ to, pdfUrl, filename, orderLabel, total }) {
  if (!isConfigured()) return { ok: false, error: "WhatsApp не налаштовано" };
  const num = toWaNumber(to);
  if (num.length < 11) return { ok: false, error: "Некоректний номер телефону" };
  try {
    const res = await fetch(`${API}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        buildPayload({
          to,
          pdfUrl,
          filename,
          orderLabel,
          total,
          template: process.env.WHATSAPP_TEMPLATE_INVOICE,
          lang: process.env.WHATSAPP_TEMPLATE_LANG || "uk",
        })
      ),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message || `WhatsApp ${res.status}` };
    return { ok: true, id: data?.messages?.[0]?.id || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Перевірка підпису вебхука Meta: заголовок X-Hub-Signature-256 = sha256=HMAC(app_secret, rawBody)
function verifySignature(rawBody, header, secret = process.env.WHATSAPP_APP_SECRET) {
  if (!secret || !header || !rawBody) return false;
  const crypto = require("crypto");
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Події статусів із вебхука → [{ id, status, error }]; status: sent | delivered | read | failed
function parseStatuses(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const ch of entry?.changes || []) {
      for (const s of ch?.value?.statuses || []) {
        out.push({ id: s.id, status: s.status, error: s.errors?.[0]?.title || null });
      }
    }
  }
  return out;
}

module.exports = { isConfigured, toWaNumber, buildPayload, sendInvoice, verifySignature, parseStatuses };
