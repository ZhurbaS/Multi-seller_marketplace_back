// Фізичні магазини (точки продажу/самовивозу): чиста санітизація й валідація полів.
const HTTP_URL = /^https?:\/\/[^\s<>"']+$/i;
const REL_URL = /^\/(?!\/)[^\s<>"']*$/;

const LIMITS = {
  name: 120,
  city: 80,
  address: 250,
  phone: 30,
  email: 120,
  hours: 500,
  description: 2000,
  mapUrl: 1000,
  photo: 500,
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Телефон — вільний формат, але лише «телефонні» символи
const PHONE = /^[0-9+()\-.\s]*$/;

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
// Прибираємо керівні символи (крім переносу рядка для багаторядкових полів)
const clean = (v, multiline = false) => {
  let s = str(v).replace(/\r\n?/g, "\n");
  s = multiline
    ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
    : s.replace(/[\u0000-\u001F\u007F]/g, " ");
  s = multiline
    ? s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n")
    : s.replace(/\s+/g, " ");
  return s.trim();
};

const isHttpUrl = (u) => HTTP_URL.test(u);
const isImageUrl = (u) => HTTP_URL.test(u) || REL_URL.test(u);

function parseCoord(v, min, max, label) {
  if (v === null || v === undefined || v === "") return { value: null };
  const n = Number(typeof v === "string" ? v.replace(",", ".").trim() : v);
  if (!Number.isFinite(n) || n < min || n > max) {
    return { error: `${label}: число від ${min} до ${max}` };
  }
  return { value: Math.round(n * 1e6) / 1e6 };
}

const toBool = (v) => v === true || v === "true" || v === 1 || v === "1" || v === "on";

// Повертає { value } або { error }. Поле active/sort тут не задаються (окремі дії),
// але якщо передані — приймаються.
function sanitizeStore(body) {
  const b = body && typeof body === "object" ? body : {};
  const v = {
    name: clean(b.name),
    city: clean(b.city),
    address: clean(b.address),
    phone: clean(b.phone),
    email: clean(b.email).toLowerCase(),
    hours: clean(b.hours, true),
    description: clean(b.description, true),
    mapUrl: clean(b.mapUrl),
    photo: clean(b.photo),
    pickup: toBool(b.pickup),
  };
  if (!v.name) return { error: "Вкажіть назву магазину" };
  if (!v.city) return { error: "Вкажіть місто" };
  if (!v.address) return { error: "Вкажіть адресу" };
  const labels = {
    name: "Назва", city: "Місто", address: "Адреса", phone: "Телефон", email: "E-mail",
    hours: "Графік роботи", description: "Опис", mapUrl: "Посилання на карту", photo: "Фото",
  };
  for (const k of Object.keys(LIMITS)) {
    if (v[k].length > LIMITS[k]) return { error: `${labels[k]}: не довше ${LIMITS[k]} символів` };
  }
  if (v.phone && !PHONE.test(v.phone)) {
    return { error: "Телефон: лише цифри, пробіли, +, -, ( )" };
  }
  if (v.email && !EMAIL.test(v.email)) return { error: "Некоректний e-mail" };
  if (v.mapUrl && !isHttpUrl(v.mapUrl)) {
    return { error: "Посилання на карту має починатися з http:// або https://" };
  }
  if (v.photo && !isImageUrl(v.photo)) {
    return { error: "Фото: посилання http(s):// або відносний шлях /…" };
  }
  const lat = parseCoord(b.lat, -90, 90, "Широта");
  if (lat.error) return lat;
  const lng = parseCoord(b.lng, -180, 180, "Довгота");
  if (lng.error) return lng;
  if ((lat.value === null) !== (lng.value === null)) {
    return { error: "Вкажіть обидві координати (широту й довготу) або жодної" };
  }
  v.lat = lat.value;
  v.lng = lng.value;
  if (b.active !== undefined) v.active = toBool(b.active);
  if (b.sort !== undefined && b.sort !== "") {
    const s = Number(b.sort);
    if (!Number.isInteger(s) || s < 0 || s > 100000) return { error: "Порядок: ціле число ≥ 0" };
    v.sort = s;
  }
  return { value: v };
}

// Перевірка списку id для перестановки: унікальні 24-символьні hex
function sanitizeIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return { error: "Передайте список магазинів" };
  if (ids.length > 500) return { error: "Забагато елементів" };
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const s = str(id);
    if (!/^[0-9a-fA-F]{24}$/.test(s)) return { error: "Некоректний ідентифікатор" };
    if (seen.has(s)) return { error: "Ідентифікатори повторюються" };
    seen.add(s);
    out.push(s);
  }
  return { value: out };
}

// Публічне представлення без службових полів
function publicStore(s) {
  return {
    id: String(s._id),
    name: s.name,
    city: s.city,
    address: s.address,
    phone: s.phone || "",
    email: s.email || "",
    hours: s.hours || "",
    description: s.description || "",
    mapUrl: s.mapUrl || "",
    lat: typeof s.lat === "number" ? s.lat : null,
    lng: typeof s.lng === "number" ? s.lng : null,
    pickup: !!s.pickup,
    photo: s.photo || "",
  };
}

module.exports = { sanitizeStore, sanitizeIds, publicStore, isHttpUrl, isImageUrl, LIMITS };
