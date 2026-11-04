const test = require("node:test");
const assert = require("node:assert/strict");
const sf = require("../utiles/storefront");
const sl = require("../utiles/storeLocation");

test("вітрина: нормалізація з типовими значеннями", () => {
  assert.deepEqual(sf.normalize(undefined), { mode: "auto", autoThreshold: 24, catalogBgUrl: "", showStoresLink: "auto" });
  assert.deepEqual(
    sf.normalize({ mode: "x", autoThreshold: 3, catalogBgUrl: "javascript:alert(1)", showStoresLink: "maybe" }),
    sf.DEFAULTS
  );
  const n = sf.normalize({ mode: "full", autoThreshold: 50, catalogBgUrl: "/img/bg.webp", showStoresLink: "off" });
  assert.deepEqual(n, { mode: "full", autoThreshold: 50, catalogBgUrl: "/img/bg.webp", showStoresLink: "off" });
  assert.equal(sf.normalize({ autoThreshold: 201 }).autoThreshold, 24);
  assert.equal(sf.normalize({ autoThreshold: 4.5 }).autoThreshold, 24);
});

test("вітрина: резолв compact", () => {
  assert.equal(sf.resolveCompact({ mode: "auto" }, 23), true);
  assert.equal(sf.resolveCompact({ mode: "auto" }, 24), false);
  assert.equal(sf.resolveCompact({ mode: "auto", autoThreshold: 10 }, 9), true);
  assert.equal(sf.resolveCompact({ mode: "compact" }, 1000), true);
  assert.equal(sf.resolveCompact({ mode: "full" }, 0), false);
  assert.equal(sf.resolveCompact({}, 0), true);
});

test("вітрина: резолв посилання «Магазини»", () => {
  assert.equal(sf.resolveStoresLink({}, 0), false);
  assert.equal(sf.resolveStoresLink({}, 2), true);
  assert.equal(sf.resolveStoresLink({ showStoresLink: "on" }, 0), true);
  assert.equal(sf.resolveStoresLink({ showStoresLink: "off" }, 5), false);
  assert.deepEqual(sf.resolve({ mode: "auto" }, { productCount: 30, storesCount: 1 }), { compact: false, showStoresLink: true });
});

test("вітрина: сувора валідація тіла запиту", () => {
  assert.ok(sf.sanitize({ mode: "big" }).error);
  assert.ok(sf.sanitize({ autoThreshold: 3 }).error);
  assert.ok(sf.sanitize({ autoThreshold: 201 }).error);
  assert.ok(sf.sanitize({ autoThreshold: "abc" }).error);
  assert.ok(sf.sanitize({ catalogBgUrl: "ftp://x/y.jpg" }).error);
  assert.ok(sf.sanitize({ catalogBgUrl: "//evil.com/a.jpg" }).error);
  assert.ok(sf.sanitize({ catalogBgUrl: "https://x.ua/" + "a".repeat(500) }).error);
  assert.ok(sf.sanitize({ showStoresLink: "yes" }).error);
  assert.deepEqual(sf.sanitize({}).value, sf.DEFAULTS);
  assert.deepEqual(
    sf.sanitize({ mode: "compact", autoThreshold: "12", catalogBgUrl: " https://cdn.x.ua/bg.webp ", showStoresLink: "on" }).value,
    { mode: "compact", autoThreshold: 12, catalogBgUrl: "https://cdn.x.ua/bg.webp", showStoresLink: "on" }
  );
});

const base = () => ({ name: " Магазин  на Хрещатику ", city: "Київ", address: "вул. Хрещатик, 1" });

test("магазин: обов'язкові поля", () => {
  assert.match(sl.sanitizeStore({}).error, /назву/);
  assert.match(sl.sanitizeStore({ name: "A" }).error, /місто/);
  assert.match(sl.sanitizeStore({ name: "A", city: "B" }).error, /адресу/);
  const r = sl.sanitizeStore(base());
  assert.equal(r.value.name, "Магазин на Хрещатику");
  assert.equal(r.value.pickup, false);
  assert.equal(r.value.lat, null);
  assert.equal(r.value.active, undefined);
});

test("магазин: URL карти й фото", () => {
  assert.ok(sl.sanitizeStore({ ...base(), mapUrl: "javascript:alert(1)" }).error);
  assert.ok(sl.sanitizeStore({ ...base(), mapUrl: "maps.app.goo.gl/abc" }).error);
  assert.equal(sl.sanitizeStore({ ...base(), mapUrl: "https://maps.app.goo.gl/abc" }).value.mapUrl, "https://maps.app.goo.gl/abc");
  assert.ok(sl.sanitizeStore({ ...base(), photo: "data:image/png;base64,xx" }).error);
  assert.ok(sl.sanitizeStore({ ...base(), photo: "//evil.com/x.jpg" }).error);
  assert.equal(sl.sanitizeStore({ ...base(), photo: "/images/shop.jpg" }).value.photo, "/images/shop.jpg");
  assert.equal(sl.sanitizeStore({ ...base(), photo: "http://x.ua/a.jpg" }).value.photo, "http://x.ua/a.jpg");
});

test("магазин: телефон, e-mail, довжини, графік", () => {
  assert.ok(sl.sanitizeStore({ ...base(), phone: "1".repeat(31) }).error);
  assert.ok(sl.sanitizeStore({ ...base(), phone: "<script>" }).error);
  assert.equal(sl.sanitizeStore({ ...base(), phone: "+38 (044) 123-45-67" }).value.phone, "+38 (044) 123-45-67");
  assert.ok(sl.sanitizeStore({ ...base(), email: "bad@" }).error);
  assert.ok(sl.sanitizeStore({ ...base(), name: "a".repeat(121) }).error);
  const h = sl.sanitizeStore({ ...base(), hours: "Пн–Пт 10:00–19:00\r\nСб  10:00–16:00\n\n\n\nНд вихідний" }).value.hours;
  assert.equal(h, "Пн–Пт 10:00–19:00\nСб 10:00–16:00\n\nНд вихідний");
  assert.equal(sl.sanitizeStore({ ...base(), pickup: "true" }).value.pickup, true);
});

test("магазин: координати", () => {
  assert.ok(sl.sanitizeStore({ ...base(), lat: 91, lng: 30 }).error);
  assert.ok(sl.sanitizeStore({ ...base(), lat: 50, lng: -181 }).error);
  assert.ok(sl.sanitizeStore({ ...base(), lat: 50 }).error);
  assert.ok(sl.sanitizeStore({ ...base(), lat: "abc", lng: 1 }).error);
  const v = sl.sanitizeStore({ ...base(), lat: "50,4501", lng: 30.5234 }).value;
  assert.equal(v.lat, 50.4501);
  assert.equal(v.lng, 30.5234);
});

test("магазин: перестановка й публічне представлення", () => {
  assert.ok(sl.sanitizeIds([]).error);
  assert.ok(sl.sanitizeIds(["x"]).error);
  const id = "a".repeat(24);
  assert.ok(sl.sanitizeIds([id, id]).error);
  assert.deepEqual(sl.sanitizeIds([id, "b".repeat(24)]).value, [id, "b".repeat(24)]);
  const p = sl.publicStore({ _id: id, name: "N", city: "C", address: "A", active: true, sort: 3, __v: 0, createdAt: new Date() });
  assert.equal(p.id, id);
  assert.equal("active" in p || "sort" in p || "__v" in p || "createdAt" in p, false);
});
