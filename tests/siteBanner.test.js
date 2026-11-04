const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../utiles/siteBanner");
const { PLACEMENTS, getPlacement } = require("../utiles/bannerPlacements");

const PID = "64b7f0c2a1b2c3d4e5f60718";
const img = (url = "https://res.cloudinary.com/x/image/upload/a.jpg") => ({ url, publicId: "a", width: 1600, height: 533 });
const baseImage = (o = {}) => ({ name: "Весняний розпродаж", placement: "home_hero", alt: "Знижки до 30%", ...o });
const ok = (raw, opts = { hasDesktopImage: true }) => {
  const r = lib.validateInput(raw, opts);
  assert.equal(r.error, undefined, r.error);
  return r.value;
};
const bad = (raw, re, opts = { hasDesktopImage: true }) => {
  const r = lib.validateInput(raw, opts);
  assert.ok(r.error, "очікувалась помилка");
  if (re) assert.match(r.error, re);
};

test("реєстр плейсментів", () => {
  assert.deepEqual(
    PLACEMENTS.map((p) => [p.id, p.kind, p.max]),
    [
      ["announcement", "text", 1],
      ["home_hero", "image", 6],
      ["home_mid", "image", 2],
      ["catalog_top", "image", 1],
      ["product_promo", "image", 1],
      ["cart_promo", "image", 1],
    ]
  );
  assert.deepEqual(getPlacement("home_hero").desktop, { width: 1600, height: 533, ratio: "3:1" });
  assert.equal(getPlacement("nope"), null);
});

test("validateInput: позитивні випадки й нормалізація", () => {
  const v = ok({ ...baseImage(), name: "  Весняний   розпродаж ", active: "1", sort: "3", device: "mobile" });
  assert.equal(v.name, "Весняний розпродаж");
  assert.equal(v.kind, "image");
  assert.equal(v.active, true);
  assert.equal(v.sort, 3);
  assert.equal(v.device, "mobile");
  assert.equal(v.linkType, "none");
  assert.equal(v.newTab, false);
  assert.deepEqual(v.categories, []);

  const u = ok(baseImage({ linkType: "url", url: "https://partner.ua/promo?x=1" }));
  assert.equal(u.newTab, true, "для url за замовчуванням нова вкладка");
  assert.equal(ok(baseImage({ linkType: "url", url: "https://a.ua", newTab: "false" })).newTab, false);

  const p = ok(baseImage({ linkType: "page", pagePath: "/delivery" }));
  assert.equal(p.pagePath, "/delivery");
  assert.equal(ok(baseImage({ linkType: "page", pagePath: "/products?category=Ноутбуки" })).pagePath, "/products?category=Ноутбуки");
  assert.equal(ok(baseImage({ linkType: "product", productId: PID })).productId, PID);
  assert.equal(ok(baseImage({ linkType: "category", categoryName: "Ноутбуки" })).categoryName, "Ноутбуки");

  const t = ok({ name: "Оголошення", placement: "announcement", headline: "Безкоштовна доставка від 2000 ₴", bgColor: "#FFAA00", textColor: "#111111" }, {});
  assert.equal(t.kind, "text");
  assert.equal(t.bgColor, "#ffaa00");

  const c = ok(baseImage({ placement: "catalog_top", categories: '["Ноутбуки","ноутбуки"," Монітори "]' }));
  assert.deepEqual(c.categories, ["Ноутбуки", "Монітори"]);
  assert.deepEqual(ok(baseImage({ placement: "catalog_top", categories: "A, B" })).categories, ["A", "B"]);
  assert.deepEqual(ok(baseImage({ categories: "A" })).categories, [], "категорії лише для catalog_top");

  const d = ok(baseImage({ startAt: "2026-11-01T00:00:00Z", endAt: "2026-11-30T00:00:00Z" }));
  assert.ok(d.startAt instanceof Date && d.endAt instanceof Date);
  assert.equal(ok(baseImage({ startAt: "", endAt: "null" })).startAt, null);
});

test("validateInput: негативні випадки", () => {
  bad(baseImage({ linkType: "url", url: "javascript:alert(1)" }), /https/);
  bad(baseImage({ linkType: "url", url: "http://a.ua" }), /https/);
  bad(baseImage({ linkType: "url", url: "https://user:pw@a.ua" }));
  bad(baseImage({ linkType: "page", pagePath: "//evil.com" }), /«\/»/);
  bad(baseImage({ linkType: "page", pagePath: "https://evil.com" }));
  bad(baseImage({ linkType: "page", pagePath: "/a\\b" }));
  bad(baseImage({ linkType: "page", pagePath: "/<script>" }));
  bad(baseImage({ bgColor: "red" }), /#rrggbb/);
  bad(baseImage({ textColor: "#12345" }), /#rrggbb/);
  bad(baseImage({ startAt: "2026-12-01", endAt: "2026-11-01" }), /пізніше/);
  bad(baseImage({ startAt: "2026-12-01", endAt: "2026-12-01" }), /пізніше/);
  bad(baseImage({ startAt: "не дата" }), /дата/);
  bad(baseImage({ alt: "" }), /alt/);
  bad(baseImage(), /ПК/, { hasDesktopImage: false });
  bad(baseImage({ kind: "text", headline: "x" }), /зображення/);
  bad({ name: "x", placement: "announcement", kind: "image", headline: "x" }, /текстові/, {});
  bad({ name: "x", placement: "announcement" }, /текст/, {});
  bad(baseImage({ placement: "sidebar" }), /місце показу/);
  bad(baseImage({ name: "" }), /назву/);
  bad(baseImage({ name: "a".repeat(81) }), /80/);
  bad(baseImage({ alt: "a".repeat(161) }), /160/);
  bad(baseImage({ ctaLabel: "a".repeat(31) }), /30/);
  bad(baseImage({ device: "tv" }));
  bad(baseImage({ audience: "vip" }));
  bad(baseImage({ linkType: "ftp" }));
  bad(baseImage({ linkType: "product" }), /товар/);
  bad(baseImage({ linkType: "product", productId: "123" }), /товар/);
  bad(baseImage({ linkType: "category" }), /категорію/);
  bad(baseImage({ active: "maybe" }));
  bad(baseImage({ sort: "-1" }));
  bad(baseImage({ placement: "catalog_top", categories: "[bad json" }));
});

test("validateInput: часткове оновлення поверх існуючого", () => {
  const existing = {
    ...lib.DEFAULTS,
    name: "Старий",
    placement: "home_hero",
    kind: "image",
    alt: "Опис",
    linkType: "product",
    productId: PID,
    productSlug: "noutbuk-1",
    imageDesktop: img(),
  };
  const v = ok({ headline: "Новий заголовок" }, { existing, hasDesktopImage: true });
  assert.equal(v.name, "Старий");
  assert.equal(v.headline, "Новий заголовок");
  assert.equal(v.productSlug, "noutbuk-1", "slug зберігається, якщо товар не змінено");
  const v2 = ok({ productId: "64b7f0c2a1b2c3d4e5f60719" }, { existing, hasDesktopImage: true });
  assert.equal(v2.productSlug, "", "новий товар → slug підставить контролер");
  const v3 = ok({ linkType: "none" }, { existing, hasDesktopImage: true });
  assert.equal(v3.productId, null);
  assert.equal(v3.productSlug, "");
  bad({ alt: "" }, /alt/, { existing, hasDesktopImage: true });
});

test("validateImageFile", () => {
  assert.equal(lib.validateImageFile({ filepath: "/tmp/a", mimetype: "image/webp", size: 1000 }), null);
  assert.equal(lib.validateImageFile({ filepath: "/tmp/a", mimetype: "image/avif", size: 2 * 1024 * 1024 }), null);
  assert.match(lib.validateImageFile({ filepath: "/tmp/a", mimetype: "image/gif", size: 10 }), /JPG/);
  assert.match(lib.validateImageFile({ filepath: "/tmp/a", mimetype: "image/svg+xml", size: 10 }), /JPG/);
  assert.match(lib.validateImageFile({ filepath: "/tmp/a", mimetype: "image/png", size: 2 * 1024 * 1024 + 1 }), /2 МБ/);
  assert.ok(lib.validateImageFile(null));
  assert.equal(lib.tooNarrow(599), true);
  assert.equal(lib.tooNarrow(600), false);
  assert.equal(lib.tooNarrow(0), false, "без метаданих не блокуємо");
});

test("computeStatus", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  assert.equal(lib.computeStatus({ active: false }, now), "paused");
  assert.equal(lib.computeStatus({ active: false, startAt: "2027-01-01" }, now), "paused");
  assert.equal(lib.computeStatus({ active: true }, now), "live");
  assert.equal(lib.computeStatus({ active: true, startAt: "2026-11-05T00:00:00Z" }, now), "scheduled");
  assert.equal(lib.computeStatus({ active: true, endAt: "2026-11-04T11:59:59Z" }, now), "expired");
  assert.equal(
    lib.computeStatus({ active: true, startAt: "2026-11-01T00:00:00Z", endAt: "2026-11-30T00:00:00Z" }, now),
    "live"
  );
});

test("resolveHref для всіх linkType", () => {
  assert.deepEqual(lib.resolveHref({ linkType: "none" }), { href: null, external: false });
  assert.deepEqual(lib.resolveHref({ linkType: "product", productSlug: "noutbuk-1" }), {
    href: "/product/details/noutbuk-1",
    external: false,
  });
  assert.deepEqual(lib.resolveHref({ linkType: "product", productSlug: "" }), { href: null, external: false });
  assert.deepEqual(lib.resolveHref({ linkType: "category", categoryName: "Ноутбуки і ПК" }), {
    href: "/products?category=" + encodeURIComponent("Ноутбуки і ПК"),
    external: false,
  });
  assert.deepEqual(lib.resolveHref({ linkType: "page", pagePath: "/warranty" }), { href: "/warranty", external: false });
  assert.deepEqual(lib.resolveHref({ linkType: "page", pagePath: "//evil.com" }), { href: null, external: false });
  assert.deepEqual(lib.resolveHref({ linkType: "url", url: "https://a.ua/x" }), { href: "https://a.ua/x", external: true });
  assert.deepEqual(lib.resolveHref({ linkType: "url", url: "javascript:alert(1)" }), { href: null, external: false });
});

test("toPublic / legacyToPublic / toAdmin / ctr", () => {
  const b = {
    _id: "x1",
    kind: "image",
    placement: "home_hero",
    imageDesktop: img(),
    imageMobile: { url: "", publicId: "" },
    alt: "Опис",
    linkType: "url",
    url: "https://a.ua",
    newTab: true,
    device: "all",
    impressions: 200,
    clicks: 7,
    active: true,
    name: "Внутрішня",
  };
  const p = lib.toPublic(b);
  assert.deepEqual(Object.keys(p).sort(), [
    "_id", "alt", "bgColor", "ctaLabel", "device", "external", "headline", "href",
    "imageDesktop", "imageMobile", "kind", "newTab", "subline", "textColor",
  ]);
  assert.deepEqual(p.imageDesktop, { url: img().url, width: 1600, height: 533 });
  assert.equal(p.imageMobile, null);
  assert.equal(p.href, "https://a.ua");
  assert.equal(p.external, true);
  assert.equal(p.newTab, true);
  assert.equal(p.name, undefined, "внутрішня назва не публікується");
  assert.equal(lib.toPublic({ ...b, linkType: "none" }).newTab, false);

  const l = lib.legacyToPublic({ _id: "L", banner: "https://c/x.jpg", link: "noutbuk-1" });
  assert.equal(l.href, "/product/details/noutbuk-1");
  assert.equal(l.alt, "");
  assert.equal(l.imageDesktop.url, "https://c/x.jpg");

  assert.equal(lib.ctr(b), 3.5);
  assert.equal(lib.ctr({ impressions: 0, clicks: 3 }), 0);
  const a = lib.toAdmin(b, new Date());
  assert.equal(a.status, "live");
  assert.equal(a.ctr, 3.5);
  assert.equal(a.name, "Внутрішня");
});

test("pickForPlacement: дати, аудиторія, ліміт, сортування", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const mk = (id, o = {}) => ({
    _id: id,
    placement: "home_hero",
    kind: "image",
    active: true,
    imageDesktop: img(),
    audience: "all",
    sort: 0,
    createdAt: "2026-10-01T00:00:00Z",
    ...o,
  });
  const list = [
    mk("off", { active: false }),
    mk("future", { startAt: "2026-12-01" }),
    mk("past", { endAt: "2026-11-01" }),
    mk("cust", { audience: "customer", sort: 1 }),
    mk("guest", { audience: "guest", sort: 1 }),
    mk("noimg", { imageDesktop: null }),
    mk("other", { placement: "home_mid" }),
    mk("s2", { sort: 2 }),
    mk("s0old", { sort: 0, createdAt: "2026-09-01T00:00:00Z" }),
    mk("s0new", { sort: 0, createdAt: "2026-10-15T00:00:00Z" }),
  ];
  const ids = (r) => r.map((b) => b._id);
  assert.deepEqual(ids(lib.pickForPlacement(list, { placement: "home_hero", audience: "guest", now })), [
    "s0new", "s0old", "guest", "s2",
  ]);
  assert.deepEqual(ids(lib.pickForPlacement(list, { placement: "home_hero", audience: "customer", now })), [
    "s0new", "s0old", "cust", "s2",
  ]);
  assert.deepEqual(ids(lib.pickForPlacement(list, { placement: "home_hero", now })), ["s0new", "s0old", "guest", "s2"]);

  const many = Array.from({ length: 9 }, (_, i) => mk("h" + i, { sort: 9 - i }));
  const r = lib.pickForPlacement(many, { placement: "home_hero", now });
  assert.equal(r.length, 6, "ліміт home_hero = 6");
  assert.equal(r[0]._id, "h8");
  const mid = Array.from({ length: 4 }, (_, i) => mk("m" + i, { placement: "home_mid" }));
  assert.equal(lib.pickForPlacement(mid, { placement: "home_mid", now }).length, 2);
  assert.deepEqual(lib.pickForPlacement(list, { placement: "unknown", now }), []);

  const ann = [
    { _id: "a1", placement: "announcement", kind: "text", active: true, headline: "x", sort: 1 },
    { _id: "a2", placement: "announcement", kind: "text", active: true, headline: "y", sort: 0 },
  ];
  assert.deepEqual(ids(lib.pickForPlacement(ann, { placement: "announcement", now })), ["a2"]);
});

test("pickForPlacement: catalog_top — категорія пріоритетніша за загальний", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const mk = (id, categories, sort = 0) => ({
    _id: id, placement: "catalog_top", kind: "image", active: true, imageDesktop: img(), categories, sort,
  });
  const list = [mk("general", [], 0), mk("laptops", ["Ноутбуки"], 5), mk("phones", ["Смартфони"], 0)];
  const pick = (category) => lib.pickForPlacement(list, { placement: "catalog_top", category, now }).map((b) => b._id);
  assert.deepEqual(pick("ноутбуки"), ["laptops"]);
  assert.deepEqual(pick("Смартфони"), ["phones"]);
  assert.deepEqual(pick("Монітори"), ["general"]);
  assert.deepEqual(pick(""), ["general"]);
  assert.deepEqual(lib.pickForPlacement([mk("only", ["Ноутбуки"])], { placement: "catalog_top", category: "", now }), []);
});

test("normalizeSettings: clamp 3..15 і типові", () => {
  const D = { home_hero: { autoplay: true, intervalSec: 6 }, announcement: { dismissible: true } };
  assert.deepEqual(lib.normalizeSettings(undefined), D);
  assert.deepEqual(lib.normalizeSettings("x"), D);
  assert.equal(lib.normalizeSettings({ home_hero: { intervalSec: 1 } }).home_hero.intervalSec, 3);
  assert.equal(lib.normalizeSettings({ home_hero: { intervalSec: 99 } }).home_hero.intervalSec, 15);
  assert.equal(lib.normalizeSettings({ home_hero: { intervalSec: "7.6" } }).home_hero.intervalSec, 8);
  assert.equal(lib.normalizeSettings({ home_hero: { intervalSec: "abc" } }).home_hero.intervalSec, 6);
  assert.equal(lib.normalizeSettings({ home_hero: { autoplay: false } }).home_hero.autoplay, false);
  assert.equal(lib.normalizeSettings({ home_hero: { autoplay: "0" } }).home_hero.autoplay, false);
  assert.equal(lib.normalizeSettings({ announcement: { dismissible: false } }).announcement.dismissible, false);
  assert.deepEqual(lib.publicSettings({ home_hero: { autoplay: false, intervalSec: 4 } }, "home_hero"), {
    autoplay: false,
    intervalSec: 4,
  });
  assert.equal(lib.publicSettings({}, "announcement").dismissible, true);
});

test("createThrottle: ≤1 подія/с на ключ", () => {
  const allow = lib.createThrottle({ windowMs: 1000 });
  assert.equal(allow("ip|b1", 1000), true);
  assert.equal(allow("ip|b1", 1500), false);
  assert.equal(allow("ip|b2", 1500), true);
  assert.equal(allow("ip|b1", 2000), true);
});

test("flattenFields (formidable v3)", () => {
  assert.deepEqual(lib.flattenFields({ name: ["A"], categories: ["x", "y"], alt: "z" }), {
    name: "A",
    categories: ["x", "y"],
    alt: "z",
  });
});

// Смоук маршрутів без БД: невідомий плейсмент → 404, адмінка без cookie → 409, порядок маршрутів
test("маршрути: смоук без БД", async () => {
  const express = require("express");
  const cookieParser = require("cookie-parser");
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", require("../routes/settingsRoutes"));
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    let res = await fetch(`${base}/home/banners/sidebar`);
    assert.equal(res.status, 404);
    res = await fetch(`${base}/home/banners/not-an-id/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "view" }),
    });
    assert.equal(res.status, 400);
    for (const [m, p] of [
      ["GET", "/admin/banners/meta"],
      ["GET", "/admin/banners"],
      ["PUT", "/admin/banners/reorder"],
      ["GET", "/admin/banners/legacy"],
      ["PUT", "/admin/settings/banners"],
    ]) {
      res = await fetch(base + p, { method: m });
      assert.equal(res.status, 409, `${m} ${p} вимагає входу`);
    }
    const stack = require("../routes/settingsRoutes").stack.map((l) => l.route && l.route.path).filter(Boolean);
    const idx = (p) => stack.indexOf(p);
    for (const p of ["/admin/banners/meta", "/admin/banners/reorder", "/admin/banners/legacy", "/admin/banners/product-search"]) {
      assert.ok(idx(p) >= 0 && idx(p) < idx("/admin/banners/:id"), `${p} до /:id`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
