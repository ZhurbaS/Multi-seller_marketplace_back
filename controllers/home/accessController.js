// Вхід без пароля й оформлення без реєстрації: гостьова сесія, код на e-mail, Google.
const customerModel = require("../../models/customerModel");
const sellerCustomerModel = require("../../models/chat/sellerCustomerModel");
const jwt = require("jsonwebtoken");
const mailer = require("../../utiles/mailer");
const ec = require("../../utiles/emailChange");
const acc = require("../../utiles/accountService");
const legal = require("../../utiles/legalService");
const { normalizePhone } = require("../../utiles/shipping");
const { responseReturn } = require("../../utiles/response");

const fail = (res, e, where) => {
  console.error(`💥 accessController.${where}:`, e.message);
  responseReturn(res, 500, { error: "Щось пішло не так" });
};

class accessController {
  // Що доступно на цьому сайті (для сторінок входу)
  config(req, res) {
    responseReturn(res, 200, {
      google: process.env.GOOGLE_CLIENT_ID ? { clientId: process.env.GOOGLE_CLIENT_ID } : null,
      otp: true,
    });
  }

  // Гостьова сесія: дозволяє користуватись кошиком без реєстрації. Контакти вказуються при оформленні.
  async guest_session(req, res) {
    try {
      const existing = req.cookies?.customerToken;
      if (existing) {
        try {
          const d = jwt.verify(existing, process.env.SECRET);
          if (await customerModel.exists({ _id: d.id })) return responseReturn(res, 200, { token: existing, existing: true });
        } catch {
          /* недійсний токен — створимо нову сесію */
        }
      }
      const c = await customerModel.create({
        name: "Гість",
        isGuest: true,
        method: "guest",
        guestExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      await sellerCustomerModel.create({ myId: c.id });
      const token = await acc.issueSession(res, c);
      responseReturn(res, 200, { token });
    } catch (e) {
      fail(res, e, "guest_session");
    }
  }

  // Гість указує e-mail, ім'я, телефон (при оформленні) і приймає умови
  async guest_claim(req, res) {
    try {
      const c = await customerModel.findById(req.id);
      if (!c) return responseReturn(res, 404, { error: "Користувача не знайдено" });
      if (!c.isGuest) return responseReturn(res, 400, { error: "Ви вже увійшли в обліковий запис" });
      const n = ec.normalizeEmail(req.body?.email);
      if (n.error) return responseReturn(res, 400, { error: n.error });
      const name = String(req.body?.name ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
      if (name.length < 2) return responseReturn(res, 400, { error: "Вкажіть ім'я" });
      const phone = normalizePhone(req.body?.phone);
      if (!phone) return responseReturn(res, 400, { error: "Вкажіть коректний номер телефону, напр. +380501234567" });

      const taken = await customerModel.exists({ _id: { $ne: c._id }, email: acc.emailRe(n.value) });
      if (taken) {
        return responseReturn(res, 409, {
          code: "EMAIL_EXISTS",
          error: "Цей e-mail уже зареєстровано. Увійдіть за кодом з листа — ваші замовлення й дані будуть у кабінеті",
        });
      }
      const consent = await legal.consentFor({ accepted: req.body?.acceptLegal === true, marketing: req.body?.marketing === true, method: "guest_checkout" });
      if (!consent.ok) return responseReturn(res, 400, { error: consent.error });

      c.email = n.value;
      c.name = name;
      c.phone = phone;
      c.guestExpiresAt = undefined;
      c.consents = [...(c.consents || []), ...consent.records];
      c.marketing = consent.marketing;
      await c.save();
      const token = await acc.issueSession(res, c);
      responseReturn(res, 200, { token, message: "Дані збережено" });
    } catch (e) {
      fail(res, e, "guest_claim");
    }
  }

  // Код входу на e-mail (для існуючих акаунтів). Відповідь однакова — щоб не розкривати, чи є такий e-mail.
  async otp_request(req, res) {
    try {
      const n = ec.normalizeEmail(req.body?.email);
      if (n.error) return responseReturn(res, 400, { error: n.error });
      const generic = { message: "Якщо такий акаунт існує, ми надіслали код на цю адресу. Він діє 10 хвилин" };
      const c = await acc.findByEmail(n.value, "+otp email");
      if (!c) return responseReturn(res, 200, generic);
      if (c.otp?.sentAt && Date.now() - new Date(c.otp.sentAt).getTime() < acc.OTP_RESEND_MS) {
        return responseReturn(res, 429, { error: "Код уже надіслано. Повторити можна через хвилину" });
      }
      const { code, record } = acc.newOtp(c.email);
      await customerModel.updateOne({ _id: c._id }, { $set: { otp: record } });
      const sent = await mailer.sendMail({
        to: c.email,
        subject: "Код для входу",
        text: `Ваш код для входу: ${code}\n\nВін діє 10 хвилин. Якщо ви не запитували код — просто проігноруйте лист.`,
        footer: "plain",
      });
      if (!sent && process.env.NODE_ENV !== "production") console.log(`🔑 Код входу для ${c.email}: ${code}`);
      responseReturn(res, 200, generic);
    } catch (e) {
      fail(res, e, "otp_request");
    }
  }

  async otp_verify(req, res) {
    try {
      const n = ec.normalizeEmail(req.body?.email);
      const code = String(req.body?.code ?? "").replace(/\s+/g, "");
      if (n.error || !/^\d{6}$/.test(code)) return responseReturn(res, 400, { error: "Введіть e-mail і 6-значний код" });
      const c = await acc.findByEmail(n.value, "+otp +password name email phone method isGuest");
      if (!c) return responseReturn(res, 400, { error: "Невірний код" });
      const problem = acc.otpProblem(c.otp, code, c.email);
      if (problem) {
        if (problem === "Невірний код") await customerModel.updateOne({ _id: c._id }, { $inc: { "otp.attempts": 1 } });
        else await customerModel.updateOne({ _id: c._id }, { $unset: { otp: 1 } });
        return responseReturn(res, 400, { error: problem });
      }
      const guestId = await acc.guestIdFromRequest(req);
      await customerModel.updateOne({ _id: c._id }, { $set: { emailVerified: true }, $unset: { otp: 1 } });
      if (guestId) await acc.mergeGuestCart(guestId, c._id);
      const token = await acc.issueSession(res, c);
      responseReturn(res, 200, { token, message: "Вхід виконано успішно" });
    } catch (e) {
      fail(res, e, "otp_verify");
    }
  }

  // Вхід або реєстрація через Google (ID-токен від Google Identity Services)
  async google(req, res) {
    try {
      const g = await acc.verifyGoogleCredential(req.body?.credential);
      if (g.error) return responseReturn(res, 400, { error: g.error });
      const v = g.value;
      let c = await customerModel.findOne({ googleId: v.sub });
      if (!c) c = await acc.findByEmail(v.email);
      if (!c) {
        const consent = await legal.consentFor({ accepted: req.body?.acceptLegal === true, marketing: req.body?.marketing === true, method: "google" });
        if (!consent.ok) return responseReturn(res, 400, { code: "CONSENT_REQUIRED", error: consent.error });
        c = await customerModel.create({
          name: v.name || v.email.split("@")[0],
          email: v.email,
          emailVerified: true,
          method: "google",
          googleId: v.sub,
          consents: consent.records,
          marketing: consent.marketing,
        });
        await sellerCustomerModel.create({ myId: c.id });
      } else if (!c.googleId) {
        // Існуючий акаунт із тим самим підтвердженим Google e-mail — прив'язуємо Google
        await customerModel.updateOne({ _id: c._id }, { $set: { googleId: v.sub, emailVerified: true } });
      }
      const guestId = await acc.guestIdFromRequest(req);
      if (guestId) await acc.mergeGuestCart(guestId, c._id);
      const token = await acc.issueSession(res, c);
      responseReturn(res, 200, { token, message: "Вхід виконано успішно" });
    } catch (e) {
      fail(res, e, "google");
    }
  }
}

module.exports = new accessController();
