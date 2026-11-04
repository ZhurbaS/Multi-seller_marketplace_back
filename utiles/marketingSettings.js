// Налаштування маркетингу (storeSettings.marketing): відправник, ліміти, вікно відправки,
// автоматизації (welcome / abandonedCart / winback) і тексти згоди. Див. MARKETING_SPEC.md §1, §2.
// normalize/defaults/normalizeBlocks — чисті функції; load/save — робота з БД.

const DEFAULT_BRAND = "TechScout";

const LIMITS = {
  frequencyMax: [1, 10],
  frequencyDays: [1, 30],
  dailyLimit: [10, 100000],
  batchSize: [1, 100],
  delayHours: [0, 720],
  afterHours: [1, 720],
  afterDays: [7, 1095],
  maxSteps: 5,
  maxBlocks: 50,
  maxProducts: 6,
};

const BLOCK_TYPES = ["heading", "text", "button", "image", "products", "banner", "divider", "spacer"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Число в межах [min,max]; некоректне → def
function clampInt(v, [min, max], def) {
  if (v === undefined || v === null || v === "") return def;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const bool = (v, def) => (typeof v === "boolean" ? v : def);

// Посилання в блоках: http(s)://… або відносний шлях /… (резолвиться від адреси фронту при рендері)
function safeUrl(v) {
  const s = str(v, 1000);
  if (!s) return "";
  if (/^https?:\/\/[^\s]+$/i.test(s)) return s;
  if (/^\/(?!\/)[^\s]*$/.test(s)) return s;
  return "";
}

const emailOrEmpty = (v) => {
  const s = str(v, 254).toLowerCase();
  return s && EMAIL_RE.test(s) ? s : "";
};

// Відправник «Назва <addr@x>» або просто адреса
function fromOrEmpty(v) {
  const s = str(v, 300);
  if (!s) return "";
  const m = s.match(/^(.*)<([^<>]+)>$/);
  const addr = (m ? m[2] : s).trim();
  return EMAIL_RE.test(addr) ? s : "";
}

function normalizeBlock(b) {
  if (!isObj(b) || !BLOCK_TYPES.includes(b.type)) return null;
  switch (b.type) {
    case "heading": {
      const text = str(b.text, 200);
      return text ? { type: "heading", text, level: Number(b.level) === 2 ? 2 : 1 } : null;
    }
    case "text": {
      const text = typeof b.text === "string" ? b.text.replace(/\r\n/g, "\n").slice(0, 5000).trim() : "";
      return text ? { type: "text", text } : null;
    }
    case "button": {
      const label = str(b.label, 80);
      const url = safeUrl(b.url);
      return label && url ? { type: "button", label, url } : null;
    }
    case "image": {
      const url = safeUrl(b.url);
      return url ? { type: "image", url, alt: str(b.alt, 200), href: safeUrl(b.href) } : null;
    }
    case "products": {
      const ids = Array.isArray(b.productIds) ? b.productIds : [];
      const productIds = [...new Set(ids.map(String).filter((id) => /^[a-f\d]{24}$/i.test(id)))].slice(
        0,
        LIMITS.maxProducts
      );
      return productIds.length ? { type: "products", productIds, title: str(b.title, 200) } : null;
    }
    case "banner": {
      const bannerId = str(b.bannerId, 24);
      return /^[a-f\d]{24}$/i.test(bannerId) ? { type: "banner", bannerId } : null;
    }
    default:
      return { type: b.type }; // divider, spacer
  }
}

// Масив блоків листа: невідомі/порожні відкидаються, не більше 50
function normalizeBlocks(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeBlock).filter(Boolean).slice(0, LIMITS.maxBlocks);
}

// ---- типові значення

function defaultAutomations(brand = DEFAULT_BRAND) {
  return {
    welcome: {
      enabled: true,
      steps: [
        {
          delayHours: 0,
          subject: `Вітаємо в ${brand}!`,
          blocks: [
            { type: "heading", text: "Дякуємо за підписку!", level: 1 },
            {
              type: "text",
              text: `Тепер ви першими дізнаватиметеся про новинки, акції та поповнення асортименту ${brand}.\n\nПишемо нечасто й лише по суті.`,
            },
            { type: "button", label: "Перейти до каталогу", url: "/" },
          ],
        },
        {
          delayHours: 72,
          subject: "Що варто знати про покупки у нас",
          blocks: [
            { type: "heading", text: "Кілька корисних порад", level: 2 },
            {
              type: "text",
              text: "**Доставка** — Новою Поштою по всій Україні.\n\n**Оплата** — карткою онлайн, при отриманні або за рахунком для юросіб.\n\nЯкщо маєте питання — просто відповідайте на цей лист.",
            },
            { type: "button", label: "Подивитися новинки", url: "/" },
          ],
        },
      ],
    },
    abandonedCart: {
      enabled: false,
      afterHours: 24,
      subject: "Ви залишили товари в кошику",
      blocks: [
        { type: "heading", text: "Ваш кошик чекає", level: 1 },
        { type: "text", text: "Товари, які ви обрали, ще в кошику. Завершіть замовлення, поки вони є в наявності." },
        { type: "button", label: "Повернутися до кошика", url: "/card" },
      ],
    },
    winback: {
      enabled: false,
      afterDays: 180,
      subject: "Давно не бачились!",
      blocks: [
        { type: "heading", text: "Ми сумуємо за вами", level: 1 },
        { type: "text", text: `За цей час у ${brand} з'явилося багато нового. Загляньте — можливо, знайдете щось корисне.` },
        { type: "button", label: "Подивитися новинки", url: "/" },
      ],
    },
  };
}

function defaultConsentText(brand = DEFAULT_BRAND) {
  return {
    footer: `Хочу отримувати новини та пропозиції від ${brand} на e-mail. Можна відписатися будь-коли.`,
    checkout: `Хочу отримувати новини, акції та персональні пропозиції від ${brand} на e-mail. Можна відписатися будь-коли.`,
    version: "v1",
  };
}

function defaults(brand = DEFAULT_BRAND) {
  return {
    senderName: brand,
    fromEmail: "",
    replyTo: "",
    frequencyCap: { max: 2, days: 7 },
    sendWindow: { from: "09:00", to: "20:00" },
    dailyLimit: 100,
    batchSize: 50,
    doubleOptInFooter: true,
    automations: defaultAutomations(brand),
    consentText: defaultConsentText(brand),
  };
}

const DEFAULTS = Object.freeze(defaults());

// ---- нормалізація

function normalizeStep(s, def) {
  const r = isObj(s) ? s : {};
  const blocks = normalizeBlocks(r.blocks);
  return {
    delayHours: clampInt(r.delayHours, LIMITS.delayHours, def?.delayHours ?? 0),
    subject: str(r.subject, 200) || def?.subject || "",
    blocks: blocks.length ? blocks : def?.blocks || [],
  };
}

function normalizeAutomations(input, brand) {
  const d = defaultAutomations(brand);
  const a = isObj(input) ? input : {};

  const w = isObj(a.welcome) ? a.welcome : {};
  let steps = Array.isArray(w.steps)
    ? w.steps.slice(0, LIMITS.maxSteps).map((s, i) => normalizeStep(s, d.welcome.steps[i] || d.welcome.steps.at(-1)))
    : d.welcome.steps;
  if (!steps.length) steps = d.welcome.steps;

  const one = (key, extraKey, range) => {
    const src = isObj(a[key]) ? a[key] : {};
    const blocks = normalizeBlocks(src.blocks);
    return {
      enabled: bool(src.enabled, d[key].enabled),
      [extraKey]: clampInt(src[extraKey], range, d[key][extraKey]),
      subject: str(src.subject, 200) || d[key].subject,
      blocks: blocks.length ? blocks : d[key].blocks,
    };
  };

  return {
    welcome: { enabled: bool(w.enabled, d.welcome.enabled), steps },
    abandonedCart: one("abandonedCart", "afterHours", LIMITS.afterHours),
    winback: one("winback", "afterDays", LIMITS.afterDays),
  };
}

function normalizeConsentText(input, brand) {
  const d = defaultConsentText(brand);
  const c = isObj(input) ? input : {};
  const version = str(c.version, 20);
  return {
    footer: str(c.footer, 1000) || d.footer,
    checkout: str(c.checkout, 1000) || d.checkout,
    version: /^[\w.-]+$/.test(version) ? version : d.version,
  };
}

function normalizeWindow(input) {
  const w = isObj(input) ? input : {};
  const from = HHMM.test(w.from) ? w.from : DEFAULTS.sendWindow.from;
  const to = HHMM.test(w.to) ? w.to : DEFAULTS.sendWindow.to;
  return { from, to };
}

// М'яка нормалізація: некоректне → типове, числа — у межах. opts.brand — для типових текстів
function normalize(input, { brand } = {}) {
  const b = str(brand, 100) || DEFAULT_BRAND;
  const d = defaults(b);
  const r = isObj(input) ? input : {};
  const fc = isObj(r.frequencyCap) ? r.frequencyCap : {};
  return {
    senderName: str(r.senderName, 100) || d.senderName,
    fromEmail: fromOrEmpty(r.fromEmail),
    replyTo: emailOrEmpty(r.replyTo),
    frequencyCap: {
      max: clampInt(fc.max, LIMITS.frequencyMax, d.frequencyCap.max),
      days: clampInt(fc.days, LIMITS.frequencyDays, d.frequencyCap.days),
    },
    sendWindow: normalizeWindow(r.sendWindow),
    dailyLimit: clampInt(r.dailyLimit, LIMITS.dailyLimit, d.dailyLimit),
    batchSize: clampInt(r.batchSize, LIMITS.batchSize, d.batchSize),
    doubleOptInFooter: bool(r.doubleOptInFooter, d.doubleOptInFooter),
    automations: normalizeAutomations(r.automations, b),
    consentText: normalizeConsentText(r.consentText, b),
  };
}

// Бренд — зі спільних полів юридичних документів (storeSettings.legal._vars.brand), інакше «TechScout»
function brandOf(raw) {
  const v = raw?.legal?._vars || raw?.legal?.oferta?.vars || {};
  return str(v.brand, 100) || DEFAULT_BRAND;
}

// ---- БД

const model = () => require("../models/storeSettingsModel");

async function load() {
  const raw = (await model().findOne({ key: "main" }).lean()) || {};
  return normalize(raw.marketing, { brand: brandOf(raw) });
}

// Часткове оновлення: невказані розділи беруться з поточних збережених
async function save(input) {
  const raw = (await model().findOne({ key: "main" }).lean()) || {};
  const brand = brandOf(raw);
  const current = normalize(raw.marketing, { brand });
  const patch = isObj(input) ? input : {};
  const merged = { ...current, ...patch };
  for (const k of ["frequencyCap", "sendWindow", "consentText"]) {
    if (isObj(patch[k])) merged[k] = { ...current[k], ...patch[k] };
  }
  if (isObj(patch.automations)) merged.automations = { ...current.automations, ...patch.automations };
  const value = normalize(merged, { brand });
  await model().findOneAndUpdate({ key: "main" }, { $set: { marketing: value } }, { upsert: true });
  return value;
}

module.exports = {
  DEFAULTS,
  DEFAULT_BRAND,
  LIMITS,
  BLOCK_TYPES,
  defaults,
  defaultAutomations,
  defaultConsentText,
  normalize,
  normalizeBlocks,
  brandOf,
  load,
  save,
};
