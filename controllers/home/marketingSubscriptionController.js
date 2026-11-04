// Публічні ендпойнти маркетингової підписки (MARKETING_SPEC.md §5, §9): footer-підписка (double opt-in),
// підтвердження, налаштування за токеном, відписка (у т.ч. one-click RFC 8058), редірект кліків,
// конфіг для фронту, «Підписки» в особистому кабінеті.
// (controllers/home/subscriptionController.js — інше: підписка на появу товару в наявності.)

const mongoose = require("mongoose");
const cs = require("../../utiles/contactService");
const tokens = require("../../utiles/marketingTokens");
const settings = require("../../utiles/marketingSettings");
const mail = require("../../utiles/subscriptionMail");
const bot = require("../../utiles/telegramBot");

const GENERIC = { ok: true, message: "Перевірте пошту — надіслали посилання для підтвердження" };
const FREQUENCIES = ["normal", "weekly", "monthly"];

const Contact = () => require("../../models/contactModel");
const meta = (req, source) => ({ ip: req.ip || "", userAgent: String(req.get("user-agent") || "").slice(0, 500), source });
const fail = (res, e, where) => {
  console.error(`💥 marketingSubscription.${where}:`, e.message);
  res.status(500).json({ error: "Щось пішло не так" });
};

async function loadSettings() {
  try {
    return await settings.load();
  } catch {
    return settings.DEFAULTS;
  }
}

// Токен → контакт. purposes — дозволені призначення. → { doc } | { error, status }
async function contactByToken(t, purposes) {
  for (const p of purposes) {
    const v = tokens.verify(String(t || ""), p);
    if (v.ok) {
      if (!mongoose.Types.ObjectId.isValid(v.contactId)) break;
      const doc = await Contact().findById(v.contactId);
      if (!doc || doc.anonymized) return { error: "Підписку не знайдено", status: 404 };
      return { doc, campaignId: v.campaignId || null };
    }
    if (v.error === "expired") return { error: "Строк дії посилання минув. Підпишіться ще раз", status: 400 };
  }
  return { error: "Посилання недійсне", status: 400 };
}

const plainTopics = (t) => {
  const src = t && typeof t.toObject === "function" ? t.toObject() : t || {};
  return { promo: src.promo === true, news: src.news === true, restock: src.restock === true, tips: src.tips === true };
};

// Форма відповіді для фронту (без ідентифікаторів чату та інших внутрішніх полів)
function channelsView(doc) {
  const e = doc.channels?.email || {};
  const t = doc.channels?.telegram || {};
  return {
    email: { status: e.status || "none", topics: plainTopics(e.topics), frequency: e.frequency || "normal" },
    telegram: { status: t.status || "none", username: t.username || "" },
  };
}
const telegramLinkFor = (doc) => (doc.channels?.telegram?.status === "subscribed" ? null : bot.startLink(doc));

// Повторна підписка e-mail: за токеном — лише з unsubscribed (явна дія власника адреси);
// в кабінеті (автентифікований покупець) — також із none/cleaned/pending. bounced/complained — ніколи.
const RESUB_TOKEN = ["unsubscribed"];
const RESUB_ACCOUNT = ["unsubscribed", "none", "cleaned", "pending"];

// Відписка контакту, що була «subscribed», зараховується кампанії (cid з токена або останній лист ≤7 днів)
function creditUnsub(doc, before, campaignId) {
  if (before !== "subscribed" || doc.channels?.email?.status !== "unsubscribed") return;
  cs.creditCampaign({ contactId: doc._id, campaignId, field: "unsubscribed" }).catch((e) => console.error("⚠️ unsub stats:", e.message));
}

// Спільна логіка змін (сторінка налаштувань за токеном і кабінет покупця)
async function applyPreferences(doc, body, m, consent, { resubscribeFrom = RESUB_TOKEN } = {}) {
  const ch = body.channel === "telegram" ? "telegram" : "email";
  if (body.unsubscribeAll === true) {
    doc = await cs.unsubscribe(doc, { channel: ch, ...m });
    return doc;
  }
  if (body.resubscribe === true || body.subscribe === true) {
    if (ch === "email") {
      if (!doc.email || !cs.canResubscribe(doc.channels?.email?.status, resubscribeFrom)) return doc;
      doc = await cs.grantExplicit(doc, { ...m, text: consent.text, textVersion: consent.version });
    } else if (doc.channels?.telegram?.chatId && doc.channels.telegram.status === "unsubscribed") {
      const now = new Date();
      doc.set("channels.telegram.status", "subscribed");
      doc.set("channels.telegram.subscribedAt", now);
      doc.set("channels.telegram.unsubscribedAt", undefined);
      if (!Object.values(plainTopics(doc.channels.telegram.topics)).some(Boolean)) doc.set("channels.telegram.topics", cs.defaultTopics());
      await doc.save();
      await cs.logConsent({ contactId: doc._id, channel: "telegram", action: "telegram_start", ...m, text: consent.text, textVersion: consent.version });
    }
  }
  if (body.topics && typeof body.topics === "object") doc = await cs.setTopics(doc, ch, body.topics, m);
  if (ch === "email" && FREQUENCIES.includes(body.frequency) && doc.channels?.email?.frequency !== body.frequency) {
    const before = doc.channels?.email?.frequency || "normal";
    doc.set("channels.email.frequency", body.frequency);
    await doc.save();
    await cs.logConsent({ contactId: doc._id, channel: "email", action: "topic_change", ...m, meta: { frequency: { before, after: body.frequency } } });
  }
  return doc;
}

class marketingSubscriptionController {
  // POST /api/home/subscribe — footer-форма. Відповідь однакова незалежно від того, чи є адреса в базі
  async subscribe(req, res, next, { emailLimiter } = {}) {
    try {
      const b = req.body || {};
      if (typeof b.website === "string" && b.website.trim()) return res.status(200).json(GENERIC); // honeypot
      const email = cs.normalizeEmail(b.email || "");
      if (!email) return res.status(400).json({ error: "Вкажіть коректний e-mail" });
      if (b.consent !== true) return res.status(400).json({ error: "Підтвердіть згоду на отримання розсилки" });
      if (emailLimiter && !emailLimiter.hit(email).ok) return res.status(200).json(GENERIC);
      if (await cs.isHashSuppressed(email)) return res.status(200).json(GENERIC);

      const s = await loadSettings();
      const m = meta(req, "footer");
      const doc = await cs.upsertContact({ email, source: "footer" });
      const status = doc.channels?.email?.status || "none";
      if (status === "subscribed") {
        mail.sendAlreadySubscribed(doc).catch(() => {});
      } else if (status === "bounced" || status === "complained") {
        // адреса недоступна / була скарга — нічого не надсилаємо
      } else if (s.doubleOptInFooter === false && status !== "unsubscribed") {
        // без double opt-in; відписану адресу повторно підписуємо лише через підтвердження власником
        await cs.grantExplicit(doc, { ...m, text: s.consentText.footer, textVersion: s.consentText.version, topics: b.topics });
      } else {
        await cs.requestOptIn(doc, { ...m, text: s.consentText.footer, textVersion: s.consentText.version, topics: b.topics });
        mail.sendConfirm(doc).catch(() => {});
      }
      return res.status(200).json(GENERIC);
    } catch (e) {
      fail(res, e, "subscribe");
    }
  }

  // POST /api/home/subscribe/confirm {t}
  async confirm(req, res) {
    try {
      const r = await contactByToken(req.body?.t, ["confirm"]);
      if (r.error) return res.status(r.status === 404 ? 400 : r.status).json({ error: r.error });
      let doc = r.doc;
      const st = doc.channels?.email?.status;
      if (st === "bounced" || st === "complained") return res.status(400).json({ error: "Цю адресу не можна підписати. Зверніться до магазину" });
      if (!doc.email) return res.status(400).json({ error: "Посилання недійсне" });
      doc = await cs.confirmOptIn(doc, meta(req, "confirm_link"));
      if (doc.channels?.email?.status !== "subscribed") return res.status(400).json({ error: "Посилання недійсне або вже використане. Підпишіться ще раз" });
      return res.status(200).json({
        ok: true,
        email: cs.maskEmail(doc.email),
        prefToken: tokens.sign("pref", doc._id),
        telegramLink: telegramLinkFor(doc),
      });
    } catch (e) {
      fail(res, e, "confirm");
    }
  }

  // GET /api/home/preferences?t=
  async getPreferences(req, res) {
    try {
      const r = await contactByToken(req.query?.t, ["pref", "unsub"]);
      if (r.error) return res.status(r.status).json({ error: r.error });
      const doc = r.doc;
      return res.status(200).json({ email: cs.maskEmail(doc.email || ""), name: doc.name || "", channels: channelsView(doc), telegramLink: telegramLinkFor(doc) });
    } catch (e) {
      fail(res, e, "getPreferences");
    }
  }

  // PUT /api/home/preferences {t, topics?, frequency?, channel?, unsubscribeAll?, resubscribe?}
  async putPreferences(req, res) {
    try {
      const b = req.body || {};
      const r = await contactByToken(b.t, ["pref", "unsub"]);
      if (r.error) return res.status(r.status).json({ error: r.error });
      const s = await loadSettings();
      const before = r.doc.channels?.email?.status;
      const doc = await applyPreferences(r.doc, b, meta(req, "preferences"), { text: s.consentText.footer, version: s.consentText.version }, { resubscribeFrom: RESUB_TOKEN });
      if (b.unsubscribeAll === true && b.channel !== "telegram") creditUnsub(doc, before, r.campaignId);
      return res.status(200).json({ ok: true, email: cs.maskEmail(doc.email || ""), name: doc.name || "", channels: channelsView(doc), telegramLink: telegramLinkFor(doc) });
    } catch (e) {
      fail(res, e, "putPreferences");
    }
  }

  // POST /api/home/preferences/erase {t} — запит на видалення даних; підтверджує адмін (анонімізація)
  async erase(req, res) {
    try {
      const r = await contactByToken(req.body?.t, ["pref", "unsub"]);
      if (r.error) return res.status(r.status).json({ error: r.error });
      let doc = r.doc;
      const m = meta(req, "preferences");
      if (!doc.erasureRequested) {
        doc.erasureRequested = true;
        doc.erasureRequestedAt = new Date();
        await doc.save();
        await cs.logConsent({ contactId: doc._id, channel: "email", action: "erasure_request", ...m });
      }
      // До рішення адміна маркетинг не надсилаємо
      doc = await cs.unsubscribe(doc, { channel: "email", ...m, reason: "erasure_request" });
      if (doc.channels?.telegram?.chatId) await cs.unsubscribe(doc, { channel: "telegram", ...m, reason: "erasure_request" });
      return res.status(200).json({ ok: true, message: "Запит на видалення даних отримано. Ми опрацюємо його найближчим часом" });
    } catch (e) {
      fail(res, e, "erase");
    }
  }

  // GET|POST /api/home/unsubscribe?t= — відписка від усього e-mail маркетингу
  async unsubscribe(req, res) {
    try {
      const t = req.query?.t || req.body?.t;
      const r = await contactByToken(t, ["unsub", "pref"]);
      if (r.error) return res.status(r.status === 404 ? 200 : r.status).json(r.status === 404 ? { ok: true } : { error: r.error });
      const oneClick = req.method === "POST" && String(req.body?.["List-Unsubscribe"] || "").toLowerCase() === "one-click";
      const before = r.doc.channels?.email?.status;
      const doc = await cs.unsubscribe(r.doc, { channel: "email", ...meta(req, oneClick ? "one_click" : "link") });
      creditUnsub(doc, before, r.campaignId);
      return res.status(200).json({ ok: true, email: cs.maskEmail(doc.email || ""), prefToken: tokens.sign("pref", doc._id) });
    } catch (e) {
      fail(res, e, "unsubscribe");
    }
  }

  // GET /api/r/:msgToken?u= — облік кліку і 302 на u (лише http/https)
  async click(req, res) {
    let target;
    const rawU = typeof req.query?.u === "string" ? req.query.u : "";
    try {
      const u = new URL(rawU);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
      target = u.toString();
    } catch {
      return res.status(400).json({ error: "Некоректне посилання" });
    }
    const v = tokens.verifyClick(req.params.msgToken);
    if (!v.ok) return res.status(400).json({ error: "Посилання недійсне" });
    // Захист від open-redirect: u має збігатися з url, підписаним у токені
    if (!tokens.clickUrlMatches(v, rawU)) return res.status(400).json({ error: "Посилання недійсне" });
    try {
      if (mongoose.Types.ObjectId.isValid(v.messageId)) {
        const CampaignMessage = require("../../models/campaignMessageModel");
        const linkKey = `links.${encodeURIComponent(target.slice(0, 500)).replace(/\./g, "%2E")}`;
        const msg = await CampaignMessage.findOneAndUpdate({ _id: v.messageId }, { $inc: { clicks: 1, [linkKey]: 1 } }, { new: false, projection: { campaignId: 1, contactId: 1 } });
        const campaignId = msg?.campaignId || (v.campaignId && mongoose.Types.ObjectId.isValid(v.campaignId) ? v.campaignId : null);
        if (msg && campaignId) await require("../../models/campaignModel").updateOne({ _id: campaignId }, { $inc: { "stats.clicks": 1 } });
        if (msg?.contactId) await Contact().updateOne({ _id: msg.contactId }, { $set: { lastActivityAt: new Date() } });
      }
    } catch (e) {
      console.error("⚠️ click:", e.message); // облік не повинен ламати перехід
    }
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    return res.redirect(302, target);
  }

  // GET /api/home/marketing-config
  async config(req, res) {
    try {
      const s = await loadSettings();
      const username = bot.isConfigured() ? bot.botUsername() || null : null;
      return res.status(200).json({ telegramBot: username, consentText: s.consentText });
    } catch (e) {
      fail(res, e, "config");
    }
  }

  // ---- особистий кабінет (customerAuthMiddleware → req.id)

  async customerContact(req, { create } = {}) {
    const customer = await require("../../models/customerModel").findById(req.id).select("name email phone isGuest savedCompanies").lean();
    if (!customer) return { customer: null, doc: null };
    let doc = await Contact().findOne({ customerId: customer._id });
    const e = cs.normalizeEmail(customer.email || "");
    if (!doc && e) doc = await Contact().findOne({ email: e });
    if (!doc && create && e) doc = await cs.upsertFromCustomer({ customer, source: "customer", explicit: false });
    else if (doc && !doc.customerId) {
      doc.customerId = customer._id;
      await doc.save();
    }
    return { customer, doc };
  }

  async getCustomerSubscriptions(req, res) {
    try {
      const { customer, doc } = await this.customerContact(req);
      if (!customer) return res.status(404).json({ error: "Користувача не знайдено" });
      if (!doc) {
        return res.status(200).json({
          email: { status: "none", topics: plainTopics(null), frequency: "normal" },
          telegram: { status: "none", username: "" },
          telegramLink: null,
        });
      }
      return res.status(200).json({ ...channelsView(doc), telegramLink: telegramLinkFor(doc) });
    } catch (e) {
      fail(res, e, "getCustomerSubscriptions");
    }
  }

  // PUT {channel?, topics?, frequency?, subscribe?|resubscribe?, unsubscribeAll?}
  async putCustomerSubscriptions(req, res) {
    try {
      const { customer, doc } = await this.customerContact(req, { create: true });
      if (!customer) return res.status(404).json({ error: "Користувача не знайдено" });
      if (!doc) return res.status(400).json({ error: "Вкажіть e-mail у профілі, щоб керувати підписками" });
      const s = await loadSettings();
      const next = await applyPreferences(doc, req.body || {}, meta(req, "account"), { text: s.consentText.checkout, version: s.consentText.version }, { resubscribeFrom: RESUB_ACCOUNT });
      return res.status(200).json({ ...channelsView(next), telegramLink: telegramLinkFor(next) });
    } catch (e) {
      fail(res, e, "putCustomerSubscriptions");
    }
  }
}

const ctrl = new marketingSubscriptionController();
for (const k of Object.getOwnPropertyNames(marketingSubscriptionController.prototype)) {
  if (k !== "constructor") ctrl[k] = ctrl[k].bind(ctrl);
}
ctrl.channelsView = channelsView;
ctrl.applyPreferences = applyPreferences;
module.exports = ctrl;
