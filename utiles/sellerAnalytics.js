// Аналітика продавця (DASHBOARD_SPEC.md §3): ЧИСТІ функції без доступу до БД — період і
// часовий пояс Europe/Kyiv, дельти, бакети чеків, ABC/XYZ, daysOfCover, статус залишку,
// індекс якості картки, мінімальна група (приватність), кеш відповідей, CSV.
// Робота з БД — controllers/seller/analyticsController.js.

const TZ = "Europe/Kyiv";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 731; // не більше ~2 років за запит
const DEFAULT_RANGE_DAYS = 30;
const MIN_DENOM = 30; // частки (конверсії) показуємо лише при знаменнику ≥ 30
const MIN_GROUP = 5; // групи покупців < 5 не показуємо (приватність)

const CHECK_BUCKETS = [
  { label: "<1000", from: 0, to: 1000 },
  { label: "1000–5000", from: 1000, to: 5000 },
  { label: "5000–20000", from: 5000, to: 20000 },
  { label: ">20000", from: 20000, to: null },
];

// Порядок статусів підзамовлення (orderController STATUSES + початковий pending)
const STATUS_ORDER = ["pending", "placed", "processing", "packing", "shipped", "delivered", "cancelled"];

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round = (n, digits = 2) => {
  const k = 10 ** digits;
  return Math.round(num(n) * k) / k;
};

// ======================= дати / часовий пояс =======================

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// 'YYYY-MM-DD' (Київ) для моменту часу
function kyivDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  return keyFmt.format(d);
}

// Зсув Києва від UTC у мс для моменту t
function tzOffsetMs(t) {
  const p = {};
  for (const x of partsFmt.formatToParts(new Date(t))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

function isValidYmd(s) {
  const m = YMD_RE.exec(String(s || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// Початок доби ymd у Києві → Date (UTC-момент). Враховує перехід на літній/зимовий час.
function kyivStartOfDay(ymd) {
  const m = YMD_RE.exec(ymd);
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const off = tzOffsetMs(t);
  let r = t - off;
  const off2 = tzOffsetMs(r);
  if (off2 !== off) r = t - off2;
  return new Date(r);
}

// Арифметика над 'YYYY-MM-DD' (календарні дні, без часових поясів)
function addDays(ymd, n) {
  const m = YMD_RE.exec(ymd);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + n * DAY_MS);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromYmd, toYmd) {
  const a = YMD_RE.exec(fromYmd);
  const b = YMD_RE.exec(toYmd);
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / DAY_MS);
}

function minusYear(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate(); // 29.02 → 28.02
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

// ISO-тиждень починається з понеділка: понеділок тижня, що містить ymd
function weekStart(ymd) {
  const m = YMD_RE.exec(ymd);
  const dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(); // 0=нд
  return addDays(ymd, -((dow + 6) % 7));
}

const monthStart = (ymd) => `${ymd.slice(0, 7)}-01`;

function autoGranularity(days) {
  if (days <= 31) return "day";
  if (days <= 184) return "week"; // ≤ 6 міс
  return "month";
}

// query → нормалізований період. Невалідні значення — замінюються типовими, а не помилка.
// { from, to, days, start, end (виключно), compare, prevFrom, prevTo, prevStart, prevEnd, granularity }
function parseRange(query = {}, now = new Date()) {
  const today = kyivDateKey(now);
  let to = isValidYmd(query.to) ? query.to : today;
  let from = isValidYmd(query.from) ? query.from : addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from > to) [from, to] = [to, from];
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) from = addDays(to, -(MAX_RANGE_DAYS - 1));
  const days = daysBetween(from, to) + 1;

  const compare = ["prev", "yoy", "none"].includes(query.compare) ? query.compare : "prev";
  let prevFrom = null;
  let prevTo = null;
  if (compare === "prev") {
    prevTo = addDays(from, -1);
    prevFrom = addDays(prevTo, -(days - 1));
  } else if (compare === "yoy") {
    prevFrom = minusYear(from);
    prevTo = minusYear(to);
  }
  const g = ["day", "week", "month"].includes(query.granularity) ? query.granularity : autoGranularity(days);
  return {
    from,
    to,
    days,
    start: kyivStartOfDay(from),
    end: kyivStartOfDay(addDays(to, 1)),
    compare,
    prevFrom,
    prevTo,
    prevStart: prevFrom ? kyivStartOfDay(prevFrom) : null,
    prevEnd: prevTo ? kyivStartOfDay(addDays(prevTo, 1)) : null,
    granularity: g,
  };
}

// Ключі бакетів періоду (як їх повертає $dateTrunc + $dateToString у Києві)
function bucketKeys(from, to, granularity = "day") {
  const out = [];
  if (!isValidYmd(from) || !isValidYmd(to) || from > to) return out;
  if (granularity === "month") {
    let k = monthStart(from);
    while (k <= to) {
      out.push(k);
      const [y, m] = k.split("-").map(Number);
      k = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    }
    return out;
  }
  const step = granularity === "week" ? 7 : 1;
  let k = granularity === "week" ? weekStart(from) : from;
  while (k <= to) {
    out.push(k);
    k = addDays(k, step);
  }
  return out;
}

// rows [{date, ...}] → повний ряд по keys, пропуски — нулі за полями fields
function fillSeries(rows, keys, fields) {
  const by = new Map((rows || []).map((r) => [r.date, r]));
  return keys.map((date) => {
    const r = by.get(date) || {};
    const o = { date };
    for (const f of fields) o[f] = round(num(r[f]));
    return o;
  });
}

// ======================= KPI / дельти =======================

// Δ% до попереднього періоду; null, якщо prev = 0 / немає порівняння
function deltaPct(value, prev) {
  const v = Number(value);
  const p = Number(prev);
  if (value === null || value === undefined || prev === null || prev === undefined || !Number.isFinite(p) || p === 0 || !Number.isFinite(v)) return null;
  return round(((v - p) / Math.abs(p)) * 100, 1);
}

const kpi = (value, prev) => ({
  value: value === null || value === undefined ? null : round(value),
  prev: prev === null || prev === undefined ? null : round(prev),
  deltaPct: deltaPct(value, prev),
});

// Частка з мінімальним знаменником (інакше null)
function safeRate(numerator, denominator, minDenom = MIN_DENOM) {
  const d = num(denominator);
  if (d <= 0 || d < minDenom) return null;
  return round(num(numerator) / d, 4);
}

// Частка без мінімуму (0 при порожньому знаменнику)
const ratio = (a, b) => (num(b) > 0 ? round(num(a) / num(b), 4) : 0);

// ======================= бакети / статистика =======================

function checkBucketIndex(amount) {
  const a = num(amount);
  for (let i = 0; i < CHECK_BUCKETS.length; i++) {
    const b = CHECK_BUCKETS[i];
    if (a >= b.from && (b.to === null || a < b.to)) return i;
  }
  return 0; // від'ємні — у перший
}

function checkBuckets(amounts) {
  const counts = CHECK_BUCKETS.map(() => 0);
  for (const a of amounts || []) counts[checkBucketIndex(a)]++;
  return CHECK_BUCKETS.map((b, i) => ({ label: b.label, from: b.from, to: b.to, count: counts[i] }));
}

function percentile(values, q) {
  const s = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const median = (values) => percentile(values, 0.5);

// Теплова карта 7×24 (dow 1=пн … 7=нд, hour 0–23) з нулями
function fillHeatmap(rows) {
  const by = new Map((rows || []).map((r) => [`${r.dow}:${r.hour}`, num(r.orders)]));
  const out = [];
  for (let dow = 1; dow <= 7; dow++) for (let hour = 0; hour < 24; hour++) out.push({ dow, hour, orders: by.get(`${dow}:${hour}`) || 0 });
  return out;
}

function fillWeekdays(rows) {
  const by = new Map((rows || []).map((r) => [Number(r.dow), r]));
  const out = [];
  for (let dow = 1; dow <= 7; dow++) {
    const r = by.get(dow) || {};
    out.push({ dow, revenue: round(num(r.revenue)), orders: num(r.orders) });
  }
  return out;
}

function sortStatuses(rows) {
  const idx = (s) => {
    const i = STATUS_ORDER.indexOf(s);
    return i < 0 ? STATUS_ORDER.length : i;
  };
  return (rows || []).map((r) => ({ status: r.status || "unknown", count: num(r.count) })).sort((a, b) => idx(a.status) - idx(b.status) || a.status.localeCompare(b.status));
}

// ======================= ABC / XYZ / залишки =======================

const ABC_A = 0.8; // кумулятивна частка виручки
const ABC_B = 0.95;

// items [{id, revenue}] → { classes: Map id→'A'|'B'|'C'|'-', summary:{A:{count,share},B,C} }
function abcClassify(items) {
  const list = (items || []).map((x) => ({ id: String(x.id), revenue: Math.max(0, num(x.revenue)) }));
  const total = list.reduce((s, x) => s + x.revenue, 0);
  const classes = new Map();
  const summary = { A: { count: 0, share: 0 }, B: { count: 0, share: 0 }, C: { count: 0, share: 0 } };
  const sorted = list.filter((x) => x.revenue > 0).sort((a, b) => b.revenue - a.revenue || a.id.localeCompare(b.id));
  let cum = 0;
  for (const x of sorted) {
    // клас визначає частка ДО цього товару: перший товар завжди A
    const before = total ? cum / total : 0;
    const cls = before < ABC_A ? "A" : before < ABC_B ? "B" : "C";
    cum += x.revenue;
    classes.set(x.id, cls);
    summary[cls].count++;
    summary[cls].share += total ? x.revenue / total : 0;
  }
  for (const x of list) if (!classes.has(x.id)) classes.set(x.id, "-");
  for (const k of ["A", "B", "C"]) summary[k].share = round(summary[k].share, 4);
  return { classes, summary };
}

const XYZ_X = 0.5; // коефіцієнт варіації тижневих продажів
const XYZ_Y = 1.0;
const XYZ_MIN_WEEKS = 4;

// weekly: масив тижневих продажів (шт) за однакову кількість тижнів → 'X'|'Y'|'Z'|'-'
function xyzClass(weekly) {
  const w = (weekly || []).map((v) => Math.max(0, num(v)));
  if (w.length < XYZ_MIN_WEEKS) return "-";
  const mean = w.reduce((s, v) => s + v, 0) / w.length;
  if (mean <= 0) return "-";
  const variance = w.reduce((s, v) => s + (v - mean) ** 2, 0) / w.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv <= XYZ_X) return "X";
  if (cv <= XYZ_Y) return "Y";
  return "Z";
}

// На скільки днів вистачить залишку при середніх продажах; null — продажів немає (нескінченно)
function daysOfCover(stock, avgDaily) {
  const s = Math.max(0, num(stock));
  const a = num(avgDaily);
  if (s === 0) return 0;
  if (a <= 0) return null;
  return round(s / a, 1);
}

const LOW_COVER_DAYS = 7;
const DEAD_DAYS = 90;

// { stock, avgDaily28, units90, ageDays } → 'ok'|'low'|'out'|'dead'
function inventoryStatus({ stock, avgDaily28, units90, ageDays }) {
  const s = num(stock);
  if (s <= 0) return "out";
  // «мертвий» — є залишок, 0 продажів за 90 днів (товари, молодші за 90 днів, не позначаємо)
  if (num(units90) === 0 && (ageDays === undefined || ageDays === null || num(ageDays) >= DEAD_DAYS)) return "dead";
  const doc = daysOfCover(s, avgDaily28);
  if (doc !== null && doc < LOW_COVER_DAYS && num(avgDaily28) > 0) return "low";
  return "ok";
}

// ======================= якість картки =======================

const stripHtml = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const ARTICLE_RE = /артикул|sku|mpn|part ?n|код товару|модель|model/i;
const WARRANTY_RE = /гаранті|warranty/i;

// Індекс якості 0–100 (ваги з DASHBOARD_SPEC §3, адаптовано до полів productModel)
function qualityScore(p = {}, { reviews = 0 } = {}) {
  const issues = [];
  let score = 0;
  const images = Array.isArray(p.images) ? p.images.filter(Boolean).length : 0;
  if (images >= 5) score += 20;
  else {
    if (images >= 3) score += 10;
    issues.push(`Додайте фото: зараз ${images}, рекомендовано ≥5`);
  }
  const desc = stripHtml(p.description).length;
  if (desc >= 300) score += 15;
  else {
    if (desc >= 100) score += 7;
    issues.push(`Розширте опис: ${desc} символів, рекомендовано ≥300`);
  }
  const specs = Array.isArray(p.specifications) ? p.specifications.filter((s) => s && s.key && s.value) : [];
  if (specs.length >= 3) score += 25;
  else {
    if (specs.length > 0) score += 12;
    issues.push("Заповніть характеристики (≥3)");
  }
  const name = String(p.name || "").trim();
  const brand = String(p.brand || "").trim();
  if (name.length >= 20 && brand && name.toLowerCase().includes(brand.toLowerCase())) score += 10;
  else issues.push("Назва: ≥20 символів і бренд у назві");
  let meta = 0;
  if (brand) meta += 5;
  else issues.push("Вкажіть бренд");
  if (specs.some((s) => ARTICLE_RE.test(s.key))) meta += 5;
  else issues.push("Додайте артикул/модель у характеристики");
  if (specs.some((s) => WARRANTY_RE.test(s.key) || WARRANTY_RE.test(s.value))) meta += 5;
  else issues.push("Вкажіть гарантію в характеристиках");
  score += meta;
  if (num(reviews) > 0) score += 15;
  else issues.push("Ще немає відгуків");
  return { score: Math.min(100, score), issues };
}

// Ціна рядка підзамовлення (знімок у authOrder.products): unitPrice × qty, у старих — price з discount
function lineRevenue(item) {
  const q = Math.max(0, num(item?.quantity, 1));
  if (Number.isFinite(Number(item?.unitPrice))) return num(item.unitPrice) * q;
  const price = num(item?.price);
  return (price - Math.floor((price * num(item?.discount)) / 100)) * q;
}

// ======================= приватність =======================

// Ім'я для публічного показу: "Олена Коваленко" → "Олена К."
function shortName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Покупець";
  const first = parts[0].slice(0, 30);
  return parts[1] ? `${first} ${parts[1][0].toUpperCase()}.` : first;
}

// Групи з buyers < min об'єднуються в «Інші»; якщо й «Інші» < min — hidden:true без чисел.
// rows [{<labelKey>, buyers, ...numFields}] → [{<labelKey>, ...numFields}] (buyers не віддаємо)
function suppressSmallGroups(rows, { labelKey = "label", fields = [], min = MIN_GROUP, otherLabel = "Інші" } = {}) {
  const keep = [];
  const other = { buyers: 0 };
  for (const f of fields) other[f] = 0;
  for (const r of rows || []) {
    if (num(r.buyers) >= min) {
      const o = { [labelKey]: r[labelKey] };
      for (const f of fields) o[f] = round(num(r[f]));
      keep.push(o);
    } else {
      other.buyers += num(r.buyers);
      for (const f of fields) other[f] += num(r[f]);
    }
  }
  if (other.buyers > 0) {
    if (other.buyers >= min) {
      const o = { [labelKey]: otherLabel };
      for (const f of fields) o[f] = round(other[f]);
      keep.push(o);
    } else {
      const o = { [labelKey]: otherLabel, hidden: true };
      for (const f of fields) o[f] = null;
      keep.push(o);
    }
  }
  return keep;
}

// Нові/повторні: buyers [{firstAt, count}] (історія з продавцем до кінця періоду), start — початок періоду.
// new — перше замовлення в періоді; repeat — перше замовлення до періоду (повернувся);
// repeatRate — частка покупців періоду з ≥2 замовленнями за всю історію.
function newVsRepeat(buyers, start) {
  const s = start instanceof Date ? start.getTime() : new Date(start).getTime();
  let nw = 0;
  let rep = 0;
  let multi = 0;
  for (const b of buyers || []) {
    const f = new Date(b.firstAt).getTime();
    if (f >= s) nw++;
    else rep++;
    if (num(b.count) >= 2) multi++;
  }
  const total = nw + rep;
  return { new: nw, repeat: rep, repeatRate: total ? round(multi / total, 4) : null };
}

// ======================= кеш =======================

// Простий TTL + LRU кеш у пам'яті процесу
function createCache({ ttlMs = 60 * 1000, max = 500, now = () => Date.now() } = {}) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.exp <= now()) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, e); // LRU: свіжий — у кінець
      return e.value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, { value, exp: now() + ttlMs });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    size: () => map.size,
    clear: () => map.clear(),
  };
}

// ======================= CSV =======================

// rows масив масивів → CSV з BOM і «;» (Excel uk-UA)
function toCsv(header, rows) {
  const csv = require("./csv");
  return csv.stringify([header, ...(rows || [])], { bom: true, delimiter: ";" });
}

// Безпечний регулярний вираз для пошуку за назвою
const escapeRegex = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = {
  TZ,
  DAY_MS,
  MIN_DENOM,
  MIN_GROUP,
  CHECK_BUCKETS,
  STATUS_ORDER,
  LOW_COVER_DAYS,
  DEAD_DAYS,
  ABC_A,
  ABC_B,
  XYZ_X,
  XYZ_Y,
  round,
  kyivDateKey,
  kyivStartOfDay,
  isValidYmd,
  addDays,
  daysBetween,
  minusYear,
  weekStart,
  autoGranularity,
  parseRange,
  bucketKeys,
  fillSeries,
  deltaPct,
  kpi,
  safeRate,
  ratio,
  checkBucketIndex,
  checkBuckets,
  percentile,
  median,
  fillHeatmap,
  fillWeekdays,
  sortStatuses,
  abcClassify,
  xyzClass,
  daysOfCover,
  inventoryStatus,
  qualityScore,
  lineRevenue,
  shortName,
  suppressSmallGroups,
  newVsRepeat,
  createCache,
  toCsv,
  escapeRegex,
};
