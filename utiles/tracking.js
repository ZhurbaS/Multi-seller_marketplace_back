// Privacy-first трекінг переглядів товарів (DASHBOARD_SPEC.md §4). Без cookie/localStorage.
//  - Боти відсікаються за User-Agent.
//  - Унікальність: sha256(dailySalt + IP + UA), dailySalt = HMAC(SECRET, дата Києва) — міняється щодоби,
//    тож хеш неможливо зіставити між днями. Сирі IP/UA НЕ зберігаються і не логуються; множини хешів
//    живуть лише в пам'яті й очищаються при зміні доби (обмеження розміру).
//  - source = utm.source | host реферера (нормалізований, ≤60 символів, [a-z0-9.-]) | 'direct'.
// Верхня частина — чисті функції (тести), нижче — запис у БД.

const crypto = require("crypto");
const { kyivDateKey } = require("./sellerAnalytics");

const BOT_RE =
  /bot\b|bot[\/;)\s-]|crawl|spider|slurp|scrap|curl\/|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|java\/|okhttp|libwww|httpclient|node-fetch|axios\/|undici|headless|phantomjs|puppeteer|playwright|selenium|lighthouse|pagespeed|pingdom|uptime|monitor|statuscake|facebookexternalhit|facebot|embedly|preview|whatsapp|telegrambot|vkshare|skypeuripreview|bingpreview|yandex|baiduspider|duckduckbot|applebot|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|amazonbot/i;

const SOURCE_MAX = 60;
const MAX_UNIQUE_PER_DAY = 200000; // обмеження пам'яті для множини хешів

function isBot(ua) {
  const s = String(ua || "").trim();
  if (s.length < 10) return true; // порожній/підозріло короткий UA
  return BOT_RE.test(s);
}

// Довільний рядок → ключ джерела: lowercase, лише [a-z0-9.-], ≤60, без крапок/дефісів по краях
function cleanSource(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, SOURCE_MAX)
    .replace(/[.-]+$/g, "");
}

// ref: host або повний URL → host без www. (або "")
function refHost(ref) {
  const s = String(ref || "").trim().slice(0, 300);
  if (!s) return "";
  let host = s;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`).hostname;
  } catch {
    return "";
  }
  return cleanSource(host.replace(/^www\./i, ""));
}

// { utm, ref, ownHosts } → ключ джерела. Перехід зі свого сайту — 'internal'.
function normalizeSource({ utm, ref, ownHosts = [] } = {}) {
  const u = utm && typeof utm === "object" ? cleanSource(utm.source) : "";
  if (u) return u;
  const h = refHost(ref);
  if (!h) return "direct";
  const own = (ownHosts || []).map((x) => refHost(x)).filter(Boolean);
  if (own.some((o) => h === o || h.endsWith(`.${o}`))) return "internal";
  return h;
}

// Крапки в ключах Mongo створюють вкладені поля — кодуємо '.' як '_' ('_' у ключі джерела неможливий)
const encodeSourceKey = (s) => String(s).replace(/\./g, "_");
const decodeSourceKey = (s) => String(s).replace(/_/g, ".");

function dailySalt(secret, dateKey) {
  return crypto.createHmac("sha256", String(secret || "techscout-track")).update(String(dateKey)).digest("hex");
}

function visitorHash(salt, ip, ua) {
  return crypto.createHash("sha256").update(`${salt}|${ip || ""}|${ua || ""}`).digest("hex");
}

// Множина «бачили сьогодні» з автоочищенням при зміні доби та стелею розміру.
// seen(key, dateKey) → true, якщо вперше за цю добу (і додає ключ).
function createDailySet({ max = MAX_UNIQUE_PER_DAY } = {}) {
  let day = null;
  let set = new Set();
  return {
    seen(key, dateKey) {
      if (dateKey !== day) {
        day = dateKey;
        set = new Set();
      }
      if (set.has(key)) return false;
      if (set.size >= max) return false; // переповнення: не рахуємо як унікальний (консервативно)
      set.add(key);
      return true;
    },
    size: () => set.size,
    day: () => day,
  };
}

// Тіло запиту → { productId, ref, utm } або null. Обрізає довжини.
function parseTrackBody(body) {
  let b = body;
  if (typeof b === "string") {
    if (b.length > 1024) return null;
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  if (b.type !== undefined && b.type !== "view") return null;
  const productId = typeof b.productId === "string" ? b.productId.trim() : "";
  if (!/^[a-f\d]{24}$/i.test(productId)) return null;
  const ref = typeof b.ref === "string" ? b.ref.slice(0, 300) : "";
  let utm = null;
  if (b.utm && typeof b.utm === "object") {
    utm = {};
    for (const k of ["source", "medium", "campaign"]) if (typeof b.utm[k] === "string") utm[k] = b.utm[k].slice(0, 100);
  }
  return { productId, ref, utm };
}

// ======================= БД =======================

const uniques = createDailySet();
const sellerCache = new Map(); // productId → sellerId (обмежено)
const SELLER_CACHE_MAX = 5000;

async function sellerOf(productId) {
  if (sellerCache.has(productId)) return sellerCache.get(productId);
  const productModel = require("../models/productModel");
  const p = await productModel.findById(productId).select("sellerId").lean();
  const sid = p ? p.sellerId : null;
  if (sid) {
    if (sellerCache.size >= SELLER_CACHE_MAX) sellerCache.delete(sellerCache.keys().next().value);
    sellerCache.set(productId, sid);
  }
  return sid;
}

// Перегляд товару. Повертає true, якщо враховано.
async function recordView({ productId, ref, utm, ip, ua, ownHosts, now = new Date() }) {
  const sellerId = await sellerOf(productId);
  if (!sellerId) return false;
  const date = kyivDateKey(now);
  const salt = dailySalt(process.env.SECRET, date);
  const unique = uniques.seen(`${productId}:${visitorHash(salt, ip, ua)}`, date);
  const source = encodeSourceKey(normalizeSource({ utm, ref, ownHosts }));
  const Stats = require("../models/productDailyStatsModel");
  await Stats.updateOne(
    { date, productId },
    {
      $inc: { views: 1, uniqueViews: unique ? 1 : 0, [`sources.${source}`]: 1 },
      $setOnInsert: { sellerId },
    },
    { upsert: true, setDefaultsOnInsert: false }
  );
  return true;
}

// Додавання в кошик (викликається з cardController.add_to_card; помилки ловить викликач)
async function recordCart(product, now = new Date()) {
  if (!product?._id || !product?.sellerId) return;
  const Stats = require("../models/productDailyStatsModel");
  await Stats.updateOne(
    { date: kyivDateKey(now), productId: product._id },
    { $inc: { carts: 1 }, $setOnInsert: { sellerId: product.sellerId } },
    { upsert: true, setDefaultsOnInsert: false }
  );
}

module.exports = {
  BOT_RE,
  SOURCE_MAX,
  isBot,
  cleanSource,
  refHost,
  normalizeSource,
  encodeSourceKey,
  decodeSourceKey,
  dailySalt,
  visitorHash,
  createDailySet,
  parseTrackBody,
  recordView,
  recordCart,
};
