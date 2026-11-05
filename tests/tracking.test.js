// Трекінг переглядів: bot-фільтр, нормалізація джерела, добова сіль і sha256, унікальність за добу, тіло запиту
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../utiles/tracking");

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("isBot: боти, скрипти, порожній UA — так; браузери — ні", () => {
  for (const ua of [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0)",
    "facebookexternalhit/1.1",
    "curl/8.4.0",
    "python-requests/2.31",
    "Mozilla/5.0 HeadlessChrome/120.0",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0)",
    "TelegramBot (like TwitterBot)",
    "",
    "abc",
  ]) {
    assert.equal(T.isBot(ua), true, ua);
  }
  assert.equal(T.isBot(CHROME), false);
  assert.equal(T.isBot(IPHONE), false);
});

test("cleanSource / refHost / normalizeSource", () => {
  assert.equal(T.cleanSource(" Instagram Stories! "), "instagram-stories");
  assert.equal(T.cleanSource("..a..b.."), "a.b");
  assert.equal(T.cleanSource("x".repeat(100)).length, 60);
  assert.equal(T.refHost("https://www.Google.com/search?q=1"), "google.com");
  assert.equal(T.refHost("m.facebook.com"), "m.facebook.com");
  assert.equal(T.refHost("not a url ::"), "");
  assert.equal(T.normalizeSource({ utm: { source: "Newsletter_Nov" }, ref: "google.com" }), "newsletternov");
  assert.equal(T.normalizeSource({ ref: "https://www.google.com.ua/" }), "google.com.ua");
  assert.equal(T.normalizeSource({}), "direct");
  assert.equal(T.normalizeSource({ utm: { source: "!!!" } }), "direct");
  assert.equal(T.normalizeSource({ ref: "https://shop.example.ua/catalog", ownHosts: ["https://shop.example.ua"] }), "internal");
  assert.equal(T.normalizeSource({ ref: "evil-shop.example.ua.attacker.com", ownHosts: ["shop.example.ua"] }), "evil-shop.example.ua.attacker.com");
  assert.match(T.normalizeSource({ ref: "https://" + "a".repeat(200) + ".com" }), /^[a-z0-9.-]{1,60}$/);
});

test("encode/decodeSourceKey: крапки не створюють вкладених полів Mongo", () => {
  const k = T.encodeSourceKey("google.com.ua");
  assert.equal(k, "google_com_ua");
  assert.ok(!k.includes("."));
  assert.equal(T.decodeSourceKey(k), "google.com.ua");
});

test("dailySalt: HMAC від дати — різна щодоби; visitorHash — sha256 hex", () => {
  const s1 = T.dailySalt("secret", "2026-11-04");
  const s2 = T.dailySalt("secret", "2026-11-05");
  assert.match(s1, /^[a-f0-9]{64}$/);
  assert.notEqual(s1, s2);
  assert.equal(s1, T.dailySalt("secret", "2026-11-04"));
  assert.notEqual(s1, T.dailySalt("other", "2026-11-04"));
  const h1 = T.visitorHash(s1, "1.2.3.4", CHROME);
  assert.match(h1, /^[a-f0-9]{64}$/);
  assert.ok(!h1.includes("1.2.3.4"));
  assert.notEqual(h1, T.visitorHash(s2, "1.2.3.4", CHROME), "між днями хеші не зіставляються");
  assert.notEqual(h1, T.visitorHash(s1, "1.2.3.5", CHROME));
});

test("createDailySet: унікальність у межах доби, скидання з новою добою, стеля розміру", () => {
  const s = T.createDailySet({ max: 2 });
  assert.equal(s.seen("a", "d1"), true);
  assert.equal(s.seen("a", "d1"), false);
  assert.equal(s.seen("b", "d1"), true);
  assert.equal(s.seen("c", "d1"), false, "переповнення — не унікальний");
  assert.equal(s.seen("a", "d2"), true, "нова доба — множина очищена");
  assert.equal(s.size(), 1);
  assert.equal(s.day(), "d2");
});

test("parseTrackBody: валідація productId, тип, обрізання, текст (sendBeacon)", () => {
  const id = "65a1b2c3d4e5f60718293a4b";
  assert.deepEqual(T.parseTrackBody({ type: "view", productId: id }), { productId: id, ref: "", utm: null });
  assert.equal(T.parseTrackBody({ type: "view", productId: "x" }), null);
  assert.equal(T.parseTrackBody({ type: "click", productId: id }), null);
  assert.equal(T.parseTrackBody(null), null);
  assert.equal(T.parseTrackBody([id]), null);
  assert.equal(T.parseTrackBody("{bad json"), null);
  assert.equal(T.parseTrackBody("x".repeat(2000)), null);
  const r = T.parseTrackBody(JSON.stringify({ productId: id, ref: "r".repeat(500), utm: { source: "s".repeat(300), medium: 5, campaign: "c" } }));
  assert.equal(r.ref.length, 300);
  assert.equal(r.utm.source.length, 100);
  assert.equal(r.utm.medium, undefined);
  assert.equal(r.utm.campaign, "c");
});
