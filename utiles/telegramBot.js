// Telegram-бот розсилок (MARKETING_SPEC.md §5). Вимкнений, якщо немає TELEGRAM_BOT_TOKEN.
// Підписка лише за явною дією: перехід за підписаним посиланням «Підписатися в Telegram» (/start <token>)
// або натискання кнопки «Так, підписати». Кожна зміна статусу — запис у ConsentLog.
//
// Токен прив'язки: deep-link Telegram приймає ≤64 символів [A-Za-z0-9_-], тому замість загального
// формату marketingTokens (base64url(JSON).hex — задовгий) тут компактний: <contactId>_<exp36>_<sig>,
// sig = base64url(HMAC-SHA256(SECRET, "mkt:tg:<id>:<exp>")) перші 22 символи. TTL — як у marketingTokens (tg).

const crypto = require("crypto");
const { DEFAULT_TTL, secretKey } = require("./marketingTokens");

const TOPICS = ["promo", "news", "restock", "tips"];
const TOPIC_LABELS = { promo: "Акції", news: "Новинки", restock: "Поповнення", tips: "Поради" };
const CONSENT_TEXT = "Натиснув кнопку «Так, підписати» в Telegram-боті: згода на новини та пропозиції магазину в Telegram";

const token = () => (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const isConfigured = () => !!token();
const botUsername = () => (process.env.TELEGRAM_BOT_USERNAME || "").trim().replace(/^@/, "");

// ======================= чисті функції =======================

const sigOf = (id, exp) =>
  crypto
    .createHmac("sha256", secretKey())
    .update(`mkt:tg:${id}:${exp}`)
    .digest("base64url")
    .slice(0, 22);

function signStart(contactId, { now = Date.now(), ttlMs = DEFAULT_TTL.tg } = {}) {
  const id = String(contactId || "");
  if (!/^[a-f\d]{24}$/i.test(id)) throw new Error("Некоректний contactId");
  const exp = Math.floor((now + ttlMs) / 1000).toString(36);
  return `${id.toLowerCase()}_${exp}_${sigOf(id.toLowerCase(), exp)}`;
}

// → { ok:true, contactId } | { ok:false, error:'invalid'|'expired' }
function verifyStart(payload, { now = Date.now() } = {}) {
  const m = /^([a-f\d]{24})_([a-z\d]{1,10})_([A-Za-z\d_-]{22})$/.exec(String(payload || ""));
  if (!m) return { ok: false, error: "invalid" };
  const [, id, exp, sig] = m;
  const a = Buffer.from(sigOf(id, exp));
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: "invalid" };
  if (parseInt(exp, 36) * 1000 < now) return { ok: false, error: "expired" };
  return { ok: true, contactId: id };
}

// '/start@MyBot  abc' → { cmd:'start', arg:'abc' }; не команда → null
function parseCommand(text) {
  if (typeof text !== "string") return null;
  const m = /^\/([a-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const bot = botUsername();
  if (m[2] && bot && m[2].toLowerCase() !== bot.toLowerCase()) return null; // команда іншому боту
  return { cmd: m[1].toLowerCase(), arg: (m[3] || "").trim() };
}

// callback_data: 'sub:yes' | 'sub:no' | 't:<topic>' → { action, topic? } | null
function parseCallback(data) {
  const s = String(data || "");
  if (s === "sub:yes") return { action: "subscribe" };
  if (s === "sub:no") return { action: "decline" };
  const m = /^t:([a-z]+)$/.exec(s);
  if (m && TOPICS.includes(m[1])) return { action: "toggle", topic: m[1] };
  return null;
}

function topicsKeyboard(topics = {}) {
  const btn = (k) => ({ text: `${topics[k] === true ? "☑" : "☐"} ${TOPIC_LABELS[k]}`, data: `t:${k}` });
  return [
    [btn("promo"), btn("news")],
    [btn("restock"), btn("tips")],
  ];
}

const subscribeKeyboard = () => [[{ text: "Так, підписати", data: "sub:yes" }, { text: "Ні, дякую", data: "sub:no" }]];

// [[{text, data|url}]] → reply_markup Telegram
function toMarkup(buttons) {
  if (!Array.isArray(buttons) || !buttons.length) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      (Array.isArray(row) ? row : [row]).map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))
    ),
  };
}

function startLink(contact) {
  const bot = botUsername();
  if (!isConfigured() || !bot || !contact?._id) return null;
  try {
    return `https://t.me/${bot}?start=${signStart(contact._id)}`;
  } catch {
    return null;
  }
}

// ======================= мережа =======================

async function api(method, body = {}) {
  if (!isConfigured()) return { ok: false, description: "not_configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!json || typeof json !== "object") return { ok: false, error_code: res.status };
    if (json.ok === undefined) json.ok = res.ok;
    if (!json.ok && json.error_code === undefined) json.error_code = res.status;
    return json;
  } catch (e) {
    return { ok: false, description: e.message };
  }
}

function sendMessage(chatId, text, { buttons, parseMode, disablePreview = true } = {}) {
  return api("sendMessage", {
    chat_id: chatId,
    text: String(text || "").slice(0, 4096),
    ...(parseMode ? { parse_mode: parseMode } : {}),
    link_preview_options: { is_disabled: !!disablePreview },
    ...(toMarkup(buttons) ? { reply_markup: toMarkup(buttons) } : {}),
  });
}

// Допоміжне: зареєструвати вебхук (url — повна адреса …/api/webhooks/telegram)
function setWebhook(url) {
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  return api("setWebhook", {
    url,
    ...(secret ? { secret_token: secret } : {}),
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    drop_pending_updates: false,
  });
}

// ======================= обробка оновлень (БД) =======================

const Contact = () => require("../models/contactModel");
const cs = () => require("./contactService");

const tgTopics = (doc) => {
  const t = doc.get ? doc.get("channels.telegram.topics") : doc.channels?.telegram?.topics;
  const src = t && typeof t.toObject === "function" ? t.toObject() : t || {};
  const out = {};
  for (const k of TOPICS) out[k] = src[k] === true;
  return out;
};
const anyOn = (t) => TOPICS.some((k) => t[k]);

async function findByChat(chatId) {
  return Contact().findOne({ "channels.telegram.chatId": String(chatId) });
}

// Анонімний контакт для чату (без email/телефону); статус 'none' до явної згоди
async function findOrCreateByChat(chatId, username) {
  let doc = await findByChat(chatId);
  if (!doc) {
    doc = await Contact().create({
      source: "telegram",
      lastActivityAt: new Date(),
      channels: { telegram: { status: "none", chatId: String(chatId), username: username || "" } },
    });
  } else if (username && doc.get("channels.telegram.username") !== username) {
    doc.set("channels.telegram.username", username);
    await doc.save();
  }
  return doc;
}

async function subscribeChat(doc, { chatId, username, source }) {
  const now = new Date();
  doc.set("channels.telegram.chatId", String(chatId));
  if (username) doc.set("channels.telegram.username", username);
  const wasSubscribed = doc.get("channels.telegram.status") === "subscribed";
  doc.set("channels.telegram.status", "subscribed");
  if (!wasSubscribed) doc.set("channels.telegram.subscribedAt", now);
  doc.set("channels.telegram.unsubscribedAt", undefined);
  if (!anyOn(tgTopics(doc))) doc.set("channels.telegram.topics", cs().defaultTopics());
  doc.lastActivityAt = now;
  await doc.save();
  await cs().logConsent({ contactId: doc._id, channel: "telegram", action: "telegram_start", source, text: CONSENT_TEXT, textVersion: "tg-v1", meta: { chatId: String(chatId) } });
  return doc;
}

async function stopChat(doc, { reason = "stop" } = {}) {
  const prev = doc.get("channels.telegram.status") || "none";
  const next = reason === "blocked" ? "blocked" : "unsubscribed";
  if (prev === next) return doc;
  doc.set("channels.telegram.status", next);
  doc.set("channels.telegram.unsubscribedAt", new Date());
  await doc.save();
  await cs().logConsent({ contactId: doc._id, channel: "telegram", action: "telegram_stop", source: reason === "blocked" ? "telegram_blocked" : "telegram", meta: { previous: prev } });
  return doc;
}

const welcomeText = (name) =>
  `${name ? `${name}, в` : "В"}и підписані на новини магазину в Telegram.\n\nОберіть теми, які вам цікаві (натисніть, щоб увімкнути/вимкнути). Відписатися — команда /stop.`;

async function onStart(chatId, username, arg) {
  if (arg) {
    const v = verifyStart(arg);
    const target = v.ok ? await Contact().findById(v.contactId) : null;
    if (!target || target.anonymized) {
      await sendMessage(chatId, v.error === "expired" ? "Посилання застаріло. Відкрийте налаштування підписки на сайті й натисніть «Підписатися в Telegram» ще раз." : "Посилання недійсне.");
      return "start_invalid";
    }
    // Чат міг уже належати іншому (анонімному) контакту — переносимо або звільняємо
    const other = await Contact().findOne({ "channels.telegram.chatId": String(chatId), _id: { $ne: target._id } });
    if (other) {
      if (!other.email && !other.phone && !other.customerId) {
        await Contact().deleteOne({ _id: other._id });
      } else {
        other.set("channels.telegram.chatId", undefined);
        other.set("channels.telegram.status", "none");
        await other.save();
      }
    }
    await subscribeChat(target, { chatId, username, source: "telegram_link" });
    await sendMessage(chatId, welcomeText(target.name), { buttons: topicsKeyboard(tgTopics(target)) });
    return "linked";
  }
  const doc = await findOrCreateByChat(chatId, username);
  if (doc.get("channels.telegram.status") === "subscribed") {
    await sendMessage(chatId, "Ви вже підписані. Ваші теми:", { buttons: topicsKeyboard(tgTopics(doc)) });
    return "already";
  }
  await sendMessage(chatId, "Вітаємо! Підписатися на новини, акції та поповнення асортименту магазину в Telegram?\nПишемо нечасто; відписатися можна будь-коли командою /stop.", {
    buttons: subscribeKeyboard(),
  });
  return "ask";
}

async function onMessage(msg) {
  const chatId = msg.chat?.id;
  if (chatId === undefined || msg.chat?.type !== "private") return "ignored";
  const username = msg.from?.username || "";
  const c = parseCommand(msg.text);
  if (c?.cmd === "start") return onStart(chatId, username, c.arg);
  if (c?.cmd === "stop") {
    const doc = await findByChat(chatId);
    if (doc) await stopChat(doc);
    await sendMessage(chatId, "Ви відписалися від розсилки. Повернутися — команда /start.");
    return "stopped";
  }
  if (c?.cmd === "topics") {
    const doc = await findByChat(chatId);
    if (!doc || doc.get("channels.telegram.status") !== "subscribed") {
      await sendMessage(chatId, "Ви ще не підписані. Підписатися?", { buttons: subscribeKeyboard() });
      return "ask";
    }
    await sendMessage(chatId, "Ваші теми (натисніть, щоб змінити):", { buttons: topicsKeyboard(tgTopics(doc)) });
    return "topics";
  }
  await sendMessage(chatId, "Команди: /start — підписатися, /topics — теми розсилки, /stop — відписатися.");
  return "help";
}

async function onCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const act = parseCallback(cq.data);
  const answer = (text) => api("answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text } : {}) });
  if (chatId === undefined || !act) {
    await answer();
    return "ignored";
  }
  const username = cq.from?.username || "";
  if (act.action === "decline") {
    await answer("Добре, без підписки");
    return "declined";
  }
  if (act.action === "subscribe") {
    const doc = await findOrCreateByChat(chatId, username);
    await subscribeChat(doc, { chatId, username, source: "telegram_button" });
    await answer("Підписку оформлено");
    await sendMessage(chatId, welcomeText(doc.name), { buttons: topicsKeyboard(tgTopics(doc)) });
    return "subscribed";
  }
  // toggle
  const doc = await findByChat(chatId);
  if (!doc || doc.get("channels.telegram.status") !== "subscribed") {
    await answer("Спершу підпишіться: /start");
    return "not_subscribed";
  }
  const cur = tgTopics(doc);
  const updated = await cs().setTopics(doc, "telegram", { [act.topic]: !cur[act.topic] }, { source: "telegram" });
  await answer(`${TOPIC_LABELS[act.topic]}: ${!cur[act.topic] ? "увімкнено" : "вимкнено"}`);
  if (cq.message?.message_id) {
    await api("editMessageReplyMarkup", { chat_id: chatId, message_id: cq.message.message_id, reply_markup: toMarkup(topicsKeyboard(tgTopics(updated))) });
  }
  return "toggled";
}

async function onChatMember(m) {
  const chatId = m.chat?.id;
  const st = m.new_chat_member?.status;
  if (chatId === undefined || m.chat?.type !== "private") return "ignored";
  if (st === "kicked") {
    const doc = await findByChat(chatId);
    if (doc) await stopChat(doc, { reason: "blocked" });
    return "blocked";
  }
  return "ignored";
}

// Обробка одного оновлення Telegram → короткий код результату (для логів/тестів)
async function handleUpdate(update) {
  if (!isConfigured() || !update || typeof update !== "object") return "disabled";
  if (update.message) return onMessage(update.message);
  if (update.callback_query) return onCallback(update.callback_query);
  if (update.my_chat_member) return onChatMember(update.my_chat_member);
  return "ignored";
}

module.exports = {
  TOPIC_LABELS,
  isConfigured,
  botUsername,
  signStart,
  verifyStart,
  parseCommand,
  parseCallback,
  topicsKeyboard,
  toMarkup,
  startLink,
  api,
  sendMessage,
  setWebhook,
  handleUpdate,
};
