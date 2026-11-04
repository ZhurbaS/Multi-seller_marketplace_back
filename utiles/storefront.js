// Налаштування вітрини: режим головної (компактний/повний), фон меню «Каталог»,
// показ посилання «Магазини». Чисті функції — без БД.
const { isImageUrl } = require("./storeLocation");

const MODES = ["auto", "compact", "full"];
const LINK_MODES = ["auto", "on", "off"];
const DEFAULTS = { mode: "auto", autoThreshold: 24, catalogBgUrl: "", showStoresLink: "auto" };
const MIN_T = 4;
const MAX_T = 200;

// М'яка нормалізація (для читання збереженого): некоректне → типове
function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const mode = MODES.includes(r.mode) ? r.mode : DEFAULTS.mode;
  const t = Number(r.autoThreshold);
  const autoThreshold =
    Number.isInteger(t) && t >= MIN_T && t <= MAX_T ? t : DEFAULTS.autoThreshold;
  const url = typeof r.catalogBgUrl === "string" ? r.catalogBgUrl.trim() : "";
  const catalogBgUrl = url && url.length <= 500 && isImageUrl(url) ? url : "";
  const showStoresLink = LINK_MODES.includes(r.showStoresLink)
    ? r.showStoresLink
    : DEFAULTS.showStoresLink;
  return { mode, autoThreshold, catalogBgUrl, showStoresLink };
}

// Сувора перевірка тіла запиту адміна: { value } або { error }
function sanitize(body) {
  const b = body && typeof body === "object" ? body : {};
  const mode = b.mode === undefined ? DEFAULTS.mode : b.mode;
  if (!MODES.includes(mode)) return { error: "Режим: auto, compact або full" };
  let autoThreshold = DEFAULTS.autoThreshold;
  if (b.autoThreshold !== undefined && b.autoThreshold !== "") {
    autoThreshold = Number(b.autoThreshold);
    if (!Number.isInteger(autoThreshold) || autoThreshold < MIN_T || autoThreshold > MAX_T) {
      return { error: `Поріг: ціле число від ${MIN_T} до ${MAX_T}` };
    }
  }
  const catalogBgUrl = typeof b.catalogBgUrl === "string" ? b.catalogBgUrl.trim() : "";
  if (b.catalogBgUrl != null && typeof b.catalogBgUrl !== "string") {
    return { error: "Фонове зображення: некоректне значення" };
  }
  if (catalogBgUrl.length > 500) return { error: "Фонове зображення: посилання до 500 символів" };
  if (catalogBgUrl && !isImageUrl(catalogBgUrl)) {
    return { error: "Фонове зображення: посилання http(s):// або відносний шлях /…" };
  }
  const showStoresLink = b.showStoresLink === undefined ? DEFAULTS.showStoresLink : b.showStoresLink;
  if (!LINK_MODES.includes(showStoresLink)) {
    return { error: "Посилання «Магазини»: auto, on або off" };
  }
  return { value: { mode, autoThreshold, catalogBgUrl, showStoresLink } };
}

function resolveCompact(sf, productCount) {
  const n = normalize(sf);
  if (n.mode === "compact") return true;
  if (n.mode === "full") return false;
  return (Number(productCount) || 0) < n.autoThreshold;
}

function resolveStoresLink(sf, storesCount) {
  const n = normalize(sf);
  if (n.showStoresLink === "on") return true;
  if (n.showStoresLink === "off") return false;
  return (Number(storesCount) || 0) > 0;
}

function resolve(sf, { productCount = 0, storesCount = 0 } = {}) {
  return {
    compact: resolveCompact(sf, productCount),
    showStoresLink: resolveStoresLink(sf, storesCount),
  };
}

module.exports = { DEFAULTS, MODES, LINK_MODES, normalize, sanitize, resolve, resolveCompact, resolveStoresLink };
