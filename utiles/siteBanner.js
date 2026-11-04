// Банери сайту (sitebanners): чисті функції — валідація/нормалізація введення адміна,
// статус, посилання, публічна форма, вибір для плейсменту, налаштування, CTR.
// Жодної БД і мережі — усе тестується в tests/siteBanner.test.js.
const { getPlacement, PLACEMENT_IDS, LIMITS } = require("./bannerPlacements");

const LINK_TYPES = ["none", "product", "category", "page", "url"];
const DEVICES = ["all", "desktop", "mobile"];
const AUDIENCES = ["all", "guest", "customer"];
const STATUSES = ["live", "scheduled", "expired", "paused"];
const PAGE_WHITELIST = [
  "/shops",
  "/stores",
  "/delivery",
  "/returns",
  "/warranty",
  "/oferta",
  "/privacy",
  "/cookies",
  "/returns-policy",
];
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
const MAX_IMAGE_BYTES = LIMITS.maxImageMB * 1024 * 1024;

const MAX = {
  name: 80,
  alt: 160,
  headline: 80,
  subline: 160,
  ctaLabel: 30,
  categoryName: 80,
  pagePath: 200,
  url: 500,
  categories: 20,
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

const DEFAULTS = Object.freeze({
  name: "",
  placement: "",
  kind: "image",
  alt: "",
  headline: "",
  subline: "",
  ctaLabel: "",
  bgColor: "",
  textColor: "",
  linkType: "none",
  productId: null,
  productSlug: "",
  categoryName: "",
  pagePath: "",
  url: "",
  newTab: false,
  active: false,
  startAt: null,
  endAt: null,
  sort: 0,
  device: "all",
  audience: "all",
  categories: [],
});

const SETTINGS_DEFAULTS = Object.freeze({
  home_hero: { autoplay: true, intervalSec: 6 },
  announcement: { dismissible: true },
});

// ---------- примітиви ----------
const str = (v) => (v == null ? "" : String(v).replace(CONTROL_RE, " ").trim());

function parseBool(v) {
  if (v === true || v === 1 || v === "1" || v === "true" || v === "on") return true;
  if (v === false || v === 0 || v === "0" || v === "false" || v === "off" || v === "") return false;
  return undefined;
}

function parseDate(v) {
  if (v === null || v === undefined || v === "" || v === "null") return { value: null };
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return { error: true };
  return { value: d };
}

const isHex = (v) => typeof v === "string" && HEX_RE.test(v);

function isHttpsUrl(v) {
  if (typeof v !== "string" || !v || v.length > MAX.url || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

// Відносний шлях сайту: з білого списку або будь-який "/…" без "//", "\" і пробілів
function isPagePath(v) {
  if (typeof v !== "string" || !v || v.length > MAX.pagePath) return false;
  if (PAGE_WHITELIST.includes(v)) return true;
  if (!v.startsWith("/") || v.startsWith("//")) return false;
  if (/[\\\s<>"'`]/.test(v)) return false;
  if (/^\/[^/?#]*:/.test(v)) return false;
  return /^\/[\p{L}\p{N}\-._~/?#=&%+]*$/u.test(v);
}

function parseCategories(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) {
      try {
        const j = JSON.parse(s);
        if (Array.isArray(j)) arr = j;
        else return { error: true };
      } catch {
        return { error: true };
      }
    } else if (s) arr = s.split(",");
  } else if (v != null) return { error: true };
  const out = [];
  for (const c of arr) {
    const s = str(c);
    if (!s) continue;
    if (s.length > MAX.categoryName) return { error: true };
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  if (out.length > MAX.categories) return { error: true };
  return { value: out };
}

// formidable v3 повертає поля масивами — беремо перше значення
function flattenFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (k === "categories" && Array.isArray(v) && v.length > 1) out[k] = v;
    else out[k] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

function plainExisting(existing) {
  if (!existing) return null;
  const e = typeof existing.toObject === "function" ? existing.toObject() : existing;
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (e[k] !== undefined) out[k] = e[k];
  }
  if (out.productId != null) out.productId = String(out.productId);
  if (Array.isArray(out.categories)) out.categories = [...out.categories];
  return out;
}

// ---------- sanitize: приведення типів лише для переданих полів ----------
// Повертає { value } (часткові поля) або { error }.
function sanitize(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const v = {};
  const has = (k) => b[k] !== undefined;

  for (const k of ["name", "alt", "headline", "subline", "ctaLabel", "categoryName"]) {
    if (!has(k)) continue;
    const s = str(b[k]).replace(/\s+/g, " ");
    if (s.length > MAX[k]) return { error: `Поле «${k}»: до ${MAX[k]} символів` };
    v[k] = s;
  }
  for (const k of ["placement", "kind", "linkType", "device", "audience"]) {
    if (has(k)) v[k] = str(b[k]);
  }
  for (const k of ["bgColor", "textColor"]) {
    if (!has(k)) continue;
    const s = str(b[k]).toLowerCase();
    if (s && !isHex(s)) return { error: `Колір «${k}»: формат #rrggbb` };
    v[k] = s;
  }
  if (has("pagePath")) v.pagePath = str(b.pagePath);
  if (has("url")) v.url = str(b.url);
  if (has("productId")) {
    const s = str(b.productId);
    if (s && !OBJECT_ID_RE.test(s)) return { error: "Некоректний товар" };
    v.productId = s || null;
  }
  for (const k of ["newTab", "active"]) {
    if (!has(k)) continue;
    const p = parseBool(b[k]);
    if (p === undefined) return { error: `Поле «${k}»: очікується так/ні` };
    v[k] = p;
  }
  for (const k of ["startAt", "endAt"]) {
    if (!has(k)) continue;
    const d = parseDate(b[k]);
    if (d.error) return { error: k === "startAt" ? "Некоректна дата початку" : "Некоректна дата завершення" };
    v[k] = d.value;
  }
  if (has("sort")) {
    const n = Number(b.sort);
    if (!Number.isInteger(n) || n < 0 || n > 100000) return { error: "Порядок: ціле число ≥ 0" };
    v.sort = n;
  }
  if (has("categories")) {
    const c = parseCategories(b.categories);
    if (c.error) return { error: `Категорії: до ${MAX.categories} назв по ${MAX.categoryName} символів` };
    v.categories = c.value;
  }
  return { value: v };
}

// ---------- validateInput: повна перевірка (створення або часткове оновлення) ----------
// opts.existing — поточний документ (для PUT); opts.hasDesktopImage — чи буде desktop-зображення
// після операції (новий файл або вже збережене). Повертає { value } (усі поля даних) або { error }.
function validateInput(raw, { existing = null, hasDesktopImage = false } = {}) {
  const s = sanitize(raw);
  if (s.error) return s;
  const inp = s.value;
  const prev = plainExisting(existing);
  const m = { ...DEFAULTS, ...(prev || {}), ...inp };
  m.categories = Array.isArray(m.categories) ? m.categories : [];

  if (!m.name) return { error: "Вкажіть внутрішню назву банера" };
  const pl = getPlacement(m.placement);
  if (!pl) return { error: `Невідоме місце показу. Допустимі: ${PLACEMENT_IDS.join(", ")}` };
  if (inp.kind !== undefined && inp.kind !== pl.kind) {
    return {
      error:
        pl.kind === "image"
          ? "Це місце показу приймає лише банери-зображення"
          : "Це місце показу приймає лише текстові банери",
    };
  }
  m.kind = pl.kind;

  if (!DEVICES.includes(m.device)) return { error: "Пристрій: all, desktop або mobile" };
  if (!AUDIENCES.includes(m.audience)) return { error: "Аудиторія: all, guest або customer" };

  if (m.kind === "image") {
    if (!m.alt) return { error: "Вкажіть альтернативний текст (alt) зображення" };
    if (!hasDesktopImage) return { error: "Завантажте зображення для ПК" };
  } else if (!m.headline) {
    return { error: "Вкажіть текст оголошення" };
  }

  if (!LINK_TYPES.includes(m.linkType)) return { error: "Тип посилання: none, product, category, page або url" };
  const linkChanged = !prev || prev.linkType !== m.linkType;
  if (m.linkType !== "product") {
    m.productId = null;
    m.productSlug = "";
  } else if (prev && inp.productId !== undefined && String(prev.productId) !== String(inp.productId)) {
    m.productSlug = ""; // slug підставить контролер із БД
  }
  if (m.linkType !== "category") m.categoryName = "";
  if (m.linkType !== "page") m.pagePath = "";
  if (m.linkType !== "url") m.url = "";
  if (m.linkType === "product" && !m.productId) return { error: "Оберіть товар для посилання" };
  if (m.linkType === "category" && !m.categoryName) return { error: "Оберіть категорію для посилання" };
  if (m.linkType === "page" && !isPagePath(m.pagePath)) {
    return { error: "Сторінка: відносний шлях, що починається з «/» (без «//»)" };
  }
  if (m.linkType === "url" && !isHttpsUrl(m.url)) return { error: "Посилання: лише https://…" };
  if (inp.newTab === undefined && linkChanged) m.newTab = m.linkType === "url";
  if (m.linkType === "none") m.newTab = false;

  if (m.startAt && m.endAt && !(new Date(m.endAt) > new Date(m.startAt))) {
    return { error: "Дата завершення має бути пізніше за дату початку" };
  }
  if (!pl.categories) m.categories = [];

  return { value: m };
}

// Файл зображення від formidable: { mimetype, size, filepath }
function validateImageFile(file) {
  if (!file || !file.filepath) return "Некоректний файл зображення";
  if (!IMAGE_MIMES.includes(String(file.mimetype || "").toLowerCase())) {
    return "Формат зображення: JPG, PNG, WebP або AVIF";
  }
  if (!(file.size > 0) || file.size > MAX_IMAGE_BYTES) {
    return `Розмір зображення — до ${LIMITS.maxImageMB} МБ`;
  }
  return null;
}

// Ширина з метаданих Cloudinary: блокуємо лише якщо вона відома і замала
const tooNarrow = (width) => Number(width) > 0 && Number(width) < LIMITS.minImageWidth;

// ---------- статус / посилання / форми ----------
function computeStatus(b, now = new Date()) {
  if (!b || !b.active) return "paused";
  const t = new Date(now).getTime();
  if (b.startAt && new Date(b.startAt).getTime() > t) return "scheduled";
  if (b.endAt && new Date(b.endAt).getTime() < t) return "expired";
  return "live";
}

function resolveHref(b) {
  if (!b) return { href: null, external: false };
  switch (b.linkType) {
    case "product":
      return b.productSlug
        ? { href: `/product/details/${encodeURIComponent(b.productSlug)}`, external: false }
        : { href: null, external: false };
    case "category":
      return b.categoryName
        ? { href: `/products?category=${encodeURIComponent(b.categoryName)}`, external: false }
        : { href: null, external: false };
    case "page":
      return isPagePath(b.pagePath) ? { href: b.pagePath, external: false } : { href: null, external: false };
    case "url":
      return isHttpsUrl(b.url) ? { href: b.url, external: true } : { href: null, external: false };
    default:
      return { href: null, external: false };
  }
}

const pubImage = (img) =>
  img && img.url ? { url: img.url, width: Number(img.width) || 0, height: Number(img.height) || 0 } : null;

function toPublic(b) {
  const { href, external } = resolveHref(b);
  const isText = b.kind === "text";
  return {
    _id: String(b._id),
    kind: b.kind || "image",
    imageDesktop: isText ? null : pubImage(b.imageDesktop),
    imageMobile: isText ? null : pubImage(b.imageMobile),
    alt: b.alt || "",
    headline: b.headline || "",
    subline: b.subline || "",
    ctaLabel: b.ctaLabel || "",
    bgColor: b.bgColor || "",
    textColor: b.textColor || "",
    href,
    external,
    newTab: href ? !!b.newTab : false,
    device: DEVICES.includes(b.device) ? b.device : "all",
  };
}

// Старий seller-банер (bannerModel) → PublicBanner (запасний варіант для home_hero)
function legacyToPublic(l) {
  return {
    _id: String(l._id),
    kind: "image",
    imageDesktop: l.banner ? { url: l.banner, width: 0, height: 0 } : null,
    imageMobile: null,
    alt: "",
    headline: "",
    subline: "",
    ctaLabel: "",
    bgColor: "",
    textColor: "",
    href: l.link ? `/product/details/${encodeURIComponent(l.link)}` : null,
    external: false,
    newTab: false,
    device: "all",
  };
}

function ctr(b) {
  const i = Number(b && b.impressions) || 0;
  const c = Number(b && b.clicks) || 0;
  if (i <= 0) return 0;
  return Math.round((c / i) * 10000) / 100; // відсотки, 2 знаки
}

function toAdmin(b, now = new Date()) {
  const o = b && typeof b.toObject === "function" ? b.toObject() : { ...b };
  return { ...o, status: computeStatus(o, now), ctr: ctr(o) };
}

const byOrder = (a, b) =>
  (Number(a.sort) || 0) - (Number(b.sort) || 0) ||
  new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();

// Вибір банерів для показу: активні в межах дат, аудиторія, категорія (catalog_top), ліміт.
function pickForPlacement(list, { placement, category = "", audience = "guest", now = new Date() } = {}) {
  const pl = getPlacement(placement);
  if (!pl) return [];
  const aud = AUDIENCES.includes(audience) && audience !== "all" ? audience : "guest";
  const live = (Array.isArray(list) ? list : []).filter(
    (b) =>
      b &&
      (b.placement === undefined || b.placement === placement) &&
      computeStatus(b, now) === "live" &&
      (!b.audience || b.audience === "all" || b.audience === aud) &&
      (pl.kind !== "image" || (b.imageDesktop && b.imageDesktop.url))
  );
  let out;
  if (pl.categories) {
    const cat = str(category).toLowerCase();
    const cats = (b) => (Array.isArray(b.categories) ? b.categories : []);
    const matched = cat
      ? live.filter((b) => cats(b).some((c) => String(c).toLowerCase() === cat)).sort(byOrder)
      : [];
    const general = live.filter((b) => cats(b).length === 0).sort(byOrder);
    out = [...matched, ...general];
  } else {
    out = live.sort(byOrder);
  }
  return out.slice(0, pl.max);
}

// ---------- налаштування ----------
function normalizeSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const h = r.home_hero && typeof r.home_hero === "object" ? r.home_hero : {};
  const a = r.announcement && typeof r.announcement === "object" ? r.announcement : {};
  const ap = parseBool(h.autoplay);
  const n = Number(h.intervalSec);
  const intervalSec =
    h.intervalSec === "" || h.intervalSec == null || !Number.isFinite(n)
      ? SETTINGS_DEFAULTS.home_hero.intervalSec
      : Math.min(15, Math.max(3, Math.round(n)));
  const ds = parseBool(a.dismissible);
  return {
    home_hero: { autoplay: ap === undefined ? true : ap, intervalSec },
    announcement: { dismissible: ds === undefined ? true : ds },
  };
}

// Налаштування для публічної відповіді плейсменту
function publicSettings(norm, placement) {
  const s = normalizeSettings(norm);
  const out = { autoplay: s.home_hero.autoplay, intervalSec: s.home_hero.intervalSec };
  if (placement === "announcement") out.dismissible = s.announcement.dismissible;
  return out;
}

// ---------- захист лічильників: ≤1 подія/с з IP на банер ----------
function createThrottle({ windowMs = 1000, maxKeys = 20000 } = {}) {
  const seen = new Map();
  return function allow(key, now = Date.now()) {
    const last = seen.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    if (seen.size >= maxKeys) {
      for (const [k, t] of seen) if (now - t >= windowMs) seen.delete(k);
      if (seen.size >= maxKeys) seen.clear();
    }
    seen.set(key, now);
    return true;
  };
}

module.exports = {
  LINK_TYPES,
  DEVICES,
  AUDIENCES,
  STATUSES,
  PAGE_WHITELIST,
  IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  MAX,
  DEFAULTS,
  SETTINGS_DEFAULTS,
  isHex,
  isHttpsUrl,
  isPagePath,
  parseBool,
  flattenFields,
  sanitize,
  validateInput,
  validateImageFile,
  tooNarrow,
  computeStatus,
  resolveHref,
  toPublic,
  legacyToPublic,
  toAdmin,
  ctr,
  pickForPlacement,
  normalizeSettings,
  publicSettings,
  createThrottle,
};
