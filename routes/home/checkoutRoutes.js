const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const { customerAuthMiddleware } = require("../../middleware/authMiddleware");
const customerModel = require("../../models/customerModel");
const np = require("../../utiles/novaPoshta");

// Підказки під час набору — частіші запити, ніж звичайні
const npLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Забагато запитів. Зачекайте хвилину" },
});

// Збережені отримувачі й організації покупця
router.get("/home/customer/checkout-data", customerAuthMiddleware, async (req, res) => {
  try {
    const c = await customerModel.findById(req.id).select("name phone savedRecipients savedCompanies savedAddresses").lean();
    res.json({
      profile: { name: c?.name || "", phone: c?.phone || "" },
      addresses: c?.savedAddresses || [],
      recipients: c?.savedRecipients || [],
      companies: c?.savedCompanies || [],
      novaPoshta: np.isEnabled(),
    });
  } catch (e) {
    console.error("💥 checkout-data:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
});

const removeSaved = (field) => async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Некоректний запис" });
    await customerModel.updateOne({ _id: req.id }, { $pull: { [field]: { _id: req.params.id } } });
    res.json({ ok: true });
  } catch (e) {
    console.error("💥 saved remove:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
};
router.delete("/home/customer/saved-address/:id", customerAuthMiddleware, removeSaved("savedAddresses"));

// Додати адресу вручну (з «Налаштувань»)
router.post("/home/customer/saved-address", customerAuthMiddleware, async (req, res) => {
  try {
    const { sanitizeAddress } = require("../../utiles/shipping");
    const { upsertAddress } = require("../../utiles/savedContacts");
    const a = sanitizeAddress(req.body);
    if (a.error) return res.status(400).json({ error: a.error });
    const c = await customerModel.findById(req.id).select("savedAddresses");
    c.savedAddresses = upsertAddress(c.savedAddresses.map((x) => x.toObject()), a.value);
    await c.save();
    res.json({ addresses: c.savedAddresses });
  } catch (e) {
    console.error("💥 saved-address:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
});

// Контактні дані профілю (ім'я, телефон)
router.put("/home/customer/profile", customerAuthMiddleware, async (req, res) => {
  try {
    // Часткове оновлення: передане поле змінюємо, відсутнє — лишаємо як було
    const $set = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
      if (name.length < 2) return res.status(400).json({ error: "Вкажіть ім'я" });
      $set.name = name;
    }
    if (req.body.phone !== undefined) {
      const phone = require("../../utiles/shipping").normalizePhone(req.body.phone);
      if (!phone) return res.status(400).json({ error: "Вкажіть коректний номер телефону, напр. +380501234567" });
      $set.phone = phone;
    }
    if (!Object.keys($set).length) return res.status(400).json({ error: "Немає що зберігати" });
    await customerModel.updateOne({ _id: req.id }, { $set });
    const c = await customerModel.findById(req.id).select("name phone").lean();
    res.json({ profile: { name: c.name, phone: c.phone }, message: "Дані збережено" });
  } catch (e) {
    console.error("💥 profile:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
});

// ---- Зміна e-mail (крок 1: пароль + нова адреса → код на нову адресу; крок 2: код → зміна)
const emailChange = require("../../utiles/emailChange");
const bcrypt = require("bcrypt");
const mailer = require("../../utiles/mailer");
const { createToken } = require("../../utiles/tokenCreate");
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Забагато спроб. Спробуйте пізніше" },
});

router.post("/home/customer/email/request", customerAuthMiddleware, emailLimiter, async (req, res) => {
  try {
    const n = emailChange.normalizeEmail(req.body?.email);
    if (n.error) return res.status(400).json({ error: n.error });
    const c = await customerModel.findById(req.id).select("+password +pendingEmail email method");
    if (!c) return res.status(404).json({ error: "Користувача не знайдено" });
    if (c.email.toLowerCase() === n.value) return res.status(400).json({ error: "Це вже ваша поточна адреса" });
    // Підтверджуємо власника акаунта паролем (для акаунтів зі входом через сторонній сервіс пароля немає)
    if (c.method === "manually") {
      const ok = await bcrypt.compare(String(req.body?.password ?? ""), c.password);
      if (!ok) return res.status(400).json({ error: "Невірний пароль" });
    }
    const taken = await customerModel.exists({ email: new RegExp(`^${emailChange.escapeRe(n.value)}$`, "i") });
    if (taken) return res.status(409).json({ error: "Ця адреса вже використовується іншим акаунтом" });

    const prev = c.pendingEmail;
    if (prev?.sentAt && Date.now() - new Date(prev.sentAt).getTime() < emailChange.RESEND_MS) {
      return res.status(429).json({ error: "Код уже надіслано. Повторити можна через хвилину" });
    }
    const code = emailChange.makeCode();
    await customerModel.updateOne(
      { _id: c._id },
      {
        $set: {
          pendingEmail: {
            email: n.value,
            codeHash: emailChange.hashCode(code, n.value),
            expiresAt: new Date(Date.now() + emailChange.CODE_TTL_MS),
            sentAt: new Date(),
            attempts: 0,
          },
        },
      }
    );
    const sent = await mailer.sendMail({
      to: n.value,
      subject: "Код підтвердження нової електронної адреси",
      text:
        `Ваш код підтвердження: ${code}\n\nВін діє 15 хвилин. Введіть його в налаштуваннях особистого кабінету, ` +
        `щоб змінити e-mail акаунта на цю адресу.\nЯкщо ви цього не робили — просто проігноруйте лист.`,
      footer: "plain",
    });
    // Без налаштованої пошти (dev) код видно в логах сервера — лише поза production
    if (!sent && process.env.NODE_ENV !== "production") console.log(`🔑 Код зміни e-mail для ${n.value}: ${code}`);
    res.json({ message: `Код надіслано на ${n.value}`, email: n.value, mailSent: !!sent });
  } catch (e) {
    console.error("💥 email/request:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
});

router.post("/home/customer/email/confirm", customerAuthMiddleware, emailLimiter, async (req, res) => {
  try {
    const code = String(req.body?.code ?? "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Введіть 6-значний код" });
    const c = await customerModel.findById(req.id).select("+pendingEmail name email phone method");
    const p = c?.pendingEmail;
    if (!c || !p?.email) return res.status(400).json({ error: "Спочатку запросіть код" });
    if (new Date(p.expiresAt).getTime() < Date.now()) {
      await customerModel.updateOne({ _id: c._id }, { $unset: { pendingEmail: 1 } });
      return res.status(400).json({ error: "Строк дії коду минув. Запросіть новий" });
    }
    if ((p.attempts || 0) >= emailChange.MAX_ATTEMPTS) {
      await customerModel.updateOne({ _id: c._id }, { $unset: { pendingEmail: 1 } });
      return res.status(429).json({ error: "Забагато невдалих спроб. Запросіть новий код" });
    }
    if (!emailChange.codesEqual(emailChange.hashCode(code, p.email), p.codeHash)) {
      await customerModel.updateOne({ _id: c._id }, { $inc: { "pendingEmail.attempts": 1 } });
      return res.status(400).json({ error: "Невірний код" });
    }
    // Адресу могли зайняти, поки чекали код
    const taken = await customerModel.exists({
      _id: { $ne: c._id },
      email: new RegExp(`^${emailChange.escapeRe(p.email)}$`, "i"),
    });
    if (taken) {
      await customerModel.updateOne({ _id: c._id }, { $unset: { pendingEmail: 1 } });
      return res.status(409).json({ error: "Ця адреса вже використовується іншим акаунтом" });
    }
    const oldEmail = c.email;
    await customerModel.updateOne({ _id: c._id }, { $set: { email: p.email }, $unset: { pendingEmail: 1 } });
    // CRM-контакт: нова адреса (злиття з наявним контактом цієї адреси); не кидає помилок
    require("../../utiles/contactStats").syncCustomerEmailSafe(c._id, p.email, { oldEmail });
    // Токен містить e-mail — видаємо новий
    const token = await createToken({
      id: c.id,
      role: "customer",
      name: c.name,
      email: p.email,
      phone: c.phone,
      method: c.method,
    });
    res.cookie("customerToken", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000,
    });
    // Сповіщення на стару адресу: якщо зміну зробили не ви — зверніться до магазину
    mailer
      .sendMail({
        to: oldEmail,
        subject: "Електронну адресу акаунта змінено",
        text: `E-mail вашого акаунта змінено на ${p.email}. Якщо це були не ви — негайно зв'яжіться з магазином.`,
        footer: "plain",
      })
      .catch(() => {});
    res.json({ token, email: p.email, message: "Електронну адресу змінено" });
  } catch (e) {
    console.error("💥 email/confirm:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
});

// Додати отримувача / організацію вручну (з «Налаштувань»)
router.post("/home/customer/saved-recipient", customerAuthMiddleware, async (req, res) => {
  try {
    const { sanitizeRecipient } = require("../../utiles/shipping");
    const { upsertRecipient } = require("../../utiles/savedContacts");
    const r = sanitizeRecipient(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const rec = r.value;
    const c = await customerModel.findById(req.id).select("savedRecipients");
    c.savedRecipients = upsertRecipient(c.savedRecipients.map((x) => x.toObject()), rec);
    await c.save();
    res.json({ recipients: c.savedRecipients });
  } catch (e) {
    console.error("💥 saved-recipient:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
});

router.post("/home/customer/saved-company", customerAuthMiddleware, async (req, res) => {
  try {
    const { sanitizeBuyer } = require("../../utiles/buyer");
    const { upsertCompany } = require("../../utiles/savedContacts");
    const b = sanitizeBuyer({ ...(req.body || {}), kind: "company" });
    if (b.error) return res.status(400).json({ error: b.error });
    const c = await customerModel.findById(req.id).select("savedCompanies");
    c.savedCompanies = upsertCompany(c.savedCompanies.map((x) => x.toObject()), b.value);
    await c.save();
    res.json({ companies: c.savedCompanies });
  } catch (e) {
    console.error("💥 saved-company:", e.message);
    res.status(500).json({ error: "Щось пішло не так" });
  }
});

router.delete("/home/customer/saved-recipient/:id", customerAuthMiddleware, removeSaved("savedRecipients"));
router.delete("/home/customer/saved-company/:id", customerAuthMiddleware, removeSaved("savedCompanies"));

// Нова пошта: підказки міст, відділень/поштоматів, вулиць. Збій API не ламає оформлення — фронт дає вводити вручну.
const npHandler = (fn) => async (req, res) => {
  if (!np.isEnabled()) return res.json({ enabled: false, items: [] });
  try {
    res.json({ enabled: true, items: await fn(req) });
  } catch (e) {
    console.error("💥 Нова пошта:", e.message);
    res.json({ enabled: false, items: [] });
  }
};
router.get("/np/cities", npLimiter, npHandler((req) => np.searchCities(req.query.q)));
router.get(
  "/np/warehouses",
  npLimiter,
  npHandler((req) => np.searchWarehouses(req.query.cityRef, req.query.q, req.query.type === "postomat" ? "postomat" : "warehouse"))
);
router.get("/np/streets", npLimiter, npHandler((req) => np.searchStreets(req.query.settlementRef, req.query.q)));

module.exports = router;
