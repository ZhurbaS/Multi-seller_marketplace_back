// Аналітика продавця: період (Київ), дельти, бакети, ABC/XYZ, daysOfCover, статуси залишку,
// якість картки, приватність (мінімальна група, короткі імена), кеш, CSV
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../utiles/sellerAnalytics");

test("kyivStartOfDay: зимовий (+02) і літній (+03) час, перехід DST", () => {
  assert.equal(A.kyivStartOfDay("2026-01-15").toISOString(), "2026-01-14T22:00:00.000Z");
  assert.equal(A.kyivStartOfDay("2026-07-01").toISOString(), "2026-06-30T21:00:00.000Z");
  // 29.03.2026 — перехід на літній час (03:00 → 04:00), північ ще за +02
  assert.equal(A.kyivStartOfDay("2026-03-29").toISOString(), "2026-03-28T22:00:00.000Z");
  assert.equal(A.kyivStartOfDay("2026-03-30").toISOString(), "2026-03-29T21:00:00.000Z");
  assert.equal(A.kyivStartOfDay("2026-10-25").toISOString(), "2026-10-24T21:00:00.000Z");
  assert.equal(A.kyivStartOfDay("2026-10-26").toISOString(), "2026-10-25T22:00:00.000Z");
});

test("kyivDateKey: момент UTC → дата за Києвом", () => {
  assert.equal(A.kyivDateKey(new Date("2026-01-14T22:30:00Z")), "2026-01-15");
  assert.equal(A.kyivDateKey(new Date("2026-01-14T21:59:00Z")), "2026-01-14");
  assert.equal(A.kyivDateKey("bad"), null);
});

test("isValidYmd / addDays / minusYear / weekStart", () => {
  assert.ok(A.isValidYmd("2024-02-29"));
  assert.ok(!A.isValidYmd("2025-02-29"));
  assert.ok(!A.isValidYmd("2025-1-01"));
  assert.equal(A.addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(A.addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(A.minusYear("2024-02-29"), "2023-02-28");
  assert.equal(A.weekStart("2026-11-04"), "2026-11-02"); // середа → понеділок
  assert.equal(A.weekStart("2026-11-08"), "2026-11-02"); // неділя → той самий понеділок
});

test("parseRange: типовий період, порівняння prev/yoy/none, granularity auto", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  const r = A.parseRange({}, now);
  assert.equal(r.to, "2026-11-04");
  assert.equal(r.from, "2026-10-06");
  assert.equal(r.days, 30);
  assert.equal(r.compare, "prev");
  assert.equal(r.prevTo, "2026-10-05");
  assert.equal(r.prevFrom, "2026-09-06");
  assert.equal(r.granularity, "day");
  assert.equal(r.end.toISOString(), "2026-11-04T22:00:00.000Z");

  const y = A.parseRange({ from: "2026-01-01", to: "2026-03-31", compare: "yoy" }, now);
  assert.equal(y.prevFrom, "2025-01-01");
  assert.equal(y.prevTo, "2025-03-31");
  assert.equal(y.granularity, "week");

  const n = A.parseRange({ from: "2025-01-01", to: "2026-01-01", compare: "none", granularity: "day" }, now);
  assert.equal(n.prevFrom, null);
  assert.equal(n.prevStart, null);
  assert.equal(n.granularity, "day");
  assert.equal(A.parseRange({ from: "2025-01-01", to: "2026-01-01" }, now).granularity, "month");

  // переставлені межі й сміття
  const s = A.parseRange({ from: "2026-02-10", to: "2026-02-01", compare: "x", granularity: "year" }, now);
  assert.equal(s.from, "2026-02-01");
  assert.equal(s.to, "2026-02-10");
  assert.equal(s.compare, "prev");
  assert.equal(s.granularity, "day");
  // занадто довгий період обрізається
  assert.ok(A.parseRange({ from: "2000-01-01", to: "2026-01-01" }, now).days <= 731);
});

test("autoGranularity: ≤31 дн → day, ≤6 міс → week, інакше month", () => {
  assert.equal(A.autoGranularity(1), "day");
  assert.equal(A.autoGranularity(31), "day");
  assert.equal(A.autoGranularity(32), "week");
  assert.equal(A.autoGranularity(184), "week");
  assert.equal(A.autoGranularity(185), "month");
});

test("bucketKeys + fillSeries: пропущені бакети — нулі", () => {
  assert.deepEqual(A.bucketKeys("2026-11-01", "2026-11-03", "day"), ["2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.deepEqual(A.bucketKeys("2026-11-04", "2026-11-17", "week"), ["2026-11-02", "2026-11-09", "2026-11-16"]);
  assert.deepEqual(A.bucketKeys("2026-11-15", "2027-01-02", "month"), ["2026-11-01", "2026-12-01", "2027-01-01"]);
  assert.deepEqual(A.bucketKeys("2026-11-05", "2026-11-01"), []);
  const s = A.fillSeries([{ date: "2026-11-02", revenue: 100.456, orders: 2 }], ["2026-11-01", "2026-11-02"], ["revenue", "orders"]);
  assert.deepEqual(s, [
    { date: "2026-11-01", revenue: 0, orders: 0 },
    { date: "2026-11-02", revenue: 100.46, orders: 2 },
  ]);
});

test("deltaPct / kpi: null при prev=0 або без порівняння", () => {
  assert.equal(A.deltaPct(120, 100), 20);
  assert.equal(A.deltaPct(80, 100), -20);
  assert.equal(A.deltaPct(5, 0), null);
  assert.equal(A.deltaPct(5, null), null);
  assert.equal(A.deltaPct(1, 3), -66.7);
  assert.deepEqual(A.kpi(10, 0), { value: 10, prev: 0, deltaPct: null });
  assert.deepEqual(A.kpi(10, null), { value: 10, prev: null, deltaPct: null });
  assert.deepEqual(A.kpi(null, 5), { value: null, prev: 5, deltaPct: null });
});

test("safeRate: частка лише при знаменнику ≥ 30", () => {
  assert.equal(A.safeRate(3, 29), null);
  assert.equal(A.safeRate(3, 30), 0.1);
  assert.equal(A.safeRate(1, 0), null);
  assert.equal(A.safeRate(1, 4, 1), 0.25);
});

test("checkBuckets: межі <1000, 1000–5000, 5000–20000, >20000", () => {
  assert.equal(A.checkBucketIndex(999.99), 0);
  assert.equal(A.checkBucketIndex(1000), 1);
  assert.equal(A.checkBucketIndex(4999), 1);
  assert.equal(A.checkBucketIndex(5000), 2);
  assert.equal(A.checkBucketIndex(20000), 3);
  assert.equal(A.checkBucketIndex(-5), 0);
  const b = A.checkBuckets([10, 1500, 2500, 7000, 30000, 20000]);
  assert.deepEqual(b.map((x) => x.count), [1, 2, 1, 2]);
  assert.deepEqual(b[3], { label: ">20000", from: 20000, to: null, count: 2 });
});

test("percentile / median", () => {
  assert.equal(A.median([5, 1, 3]), 3);
  assert.equal(A.median([1, 2, 3, 4]), 2.5);
  assert.equal(A.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
  assert.equal(A.median([]), null);
});

test("fillHeatmap / fillWeekdays / sortStatuses", () => {
  const h = A.fillHeatmap([{ dow: 1, hour: 10, orders: 3 }]);
  assert.equal(h.length, 7 * 24);
  assert.equal(h.find((x) => x.dow === 1 && x.hour === 10).orders, 3);
  assert.equal(h.find((x) => x.dow === 7 && x.hour === 23).orders, 0);
  const w = A.fillWeekdays([{ dow: 3, revenue: 10, orders: 1 }]);
  assert.equal(w.length, 7);
  assert.deepEqual(w[2], { dow: 3, revenue: 10, orders: 1 });
  assert.deepEqual(
    A.sortStatuses([{ status: "delivered", count: 1 }, { status: "pending", count: 2 }, { status: "zzz", count: 1 }]).map((s) => s.status),
    ["pending", "delivered", "zzz"]
  );
});

test("abcClassify: 80/95% кумулятивної виручки, без продажів — '-'", () => {
  const { classes, summary } = A.abcClassify([
    { id: "a", revenue: 700 },
    { id: "b", revenue: 200 },
    { id: "c", revenue: 60 },
    { id: "d", revenue: 40 },
    { id: "e", revenue: 0 },
  ]);
  assert.equal(classes.get("a"), "A");
  assert.equal(classes.get("b"), "A"); // до b накопичено 70% < 80%
  assert.equal(classes.get("c"), "B"); // до c — 90%
  assert.equal(classes.get("d"), "C"); // до d — 96%
  assert.equal(classes.get("e"), "-");
  assert.equal(summary.A.count, 2);
  assert.equal(summary.A.share, 0.9);
  assert.equal(summary.C.share, 0.04);
  const one = A.abcClassify([{ id: "x", revenue: 5 }]);
  assert.equal(one.classes.get("x"), "A");
  assert.equal(A.abcClassify([]).summary.A.count, 0);
});

test("xyzClass: стабільні X, змінні Y, хаотичні Z, мало даних '-'", () => {
  assert.equal(A.xyzClass([10, 10, 11, 9, 10, 10]), "X");
  assert.equal(A.xyzClass([5, 15, 5, 15, 2, 18]), "Y");
  assert.equal(A.xyzClass([0, 0, 0, 0, 0, 30]), "Z");
  assert.equal(A.xyzClass([0, 0, 0, 0]), "-");
  assert.equal(A.xyzClass([1, 2, 3]), "-");
});

test("daysOfCover / inventoryStatus", () => {
  assert.equal(A.daysOfCover(10, 2), 5);
  assert.equal(A.daysOfCover(10, 0), null);
  assert.equal(A.daysOfCover(0, 2), 0);
  assert.equal(A.daysOfCover(7, 3), 2.3);
  assert.equal(A.inventoryStatus({ stock: 0, avgDaily28: 1, units90: 5 }), "out");
  assert.equal(A.inventoryStatus({ stock: 5, avgDaily28: 1, units90: 30, ageDays: 200 }), "low");
  assert.equal(A.inventoryStatus({ stock: 50, avgDaily28: 1, units90: 30, ageDays: 200 }), "ok");
  assert.equal(A.inventoryStatus({ stock: 5, avgDaily28: 0, units90: 0, ageDays: 120 }), "dead");
  assert.equal(A.inventoryStatus({ stock: 5, avgDaily28: 0, units90: 0, ageDays: 10 }), "ok", "новий товар не «мертвий»");
  assert.equal(A.inventoryStatus({ stock: 5, avgDaily28: 0, units90: 2, ageDays: 120 }), "ok");
});

test("qualityScore: ідеальна картка 100, порожня — з переліком проблем", () => {
  const full = A.qualityScore(
    {
      name: "Ноутбук Lenovo IdeaPad 5 15ARE05",
      brand: "Lenovo",
      images: ["1", "2", "3", "4", "5"],
      description: "x".repeat(300),
      specifications: [
        { key: "Екран", value: "15.6" },
        { key: "Модель", value: "15ARE05" },
        { key: "Гарантія", value: "12 міс" },
      ],
    },
    { reviews: 2 }
  );
  assert.equal(full.score, 100);
  assert.deepEqual(full.issues, []);
  const empty = A.qualityScore({ name: "Ноут", brand: "", images: [], description: "<p>коротко</p>", specifications: [] });
  assert.equal(empty.score, 0);
  assert.ok(empty.issues.length >= 6);
  const mid = A.qualityScore({ name: "X", brand: "B", images: ["1", "2", "3"], description: "y".repeat(150), specifications: [{ key: "a", value: "b" }] });
  assert.equal(mid.score, 10 + 7 + 12 + 5);
});

test("lineRevenue: unitPrice × qty, у старих — price зі знижкою", () => {
  assert.equal(A.lineRevenue({ unitPrice: 90, quantity: 3 }), 270);
  assert.equal(A.lineRevenue({ price: 1000, discount: 15, quantity: 2 }), 1700);
  assert.equal(A.lineRevenue({ price: 99, discount: 10, quantity: 1 }), 90); // floor(9.9)=9
});

test("shortName: лише ім'я та ініціал прізвища", () => {
  assert.equal(A.shortName("Олена Коваленко"), "Олена К.");
  assert.equal(A.shortName("  іван   петренко  інше "), "іван П.");
  assert.equal(A.shortName("Марія"), "Марія");
  assert.equal(A.shortName(""), "Покупець");
});

test("suppressSmallGroups: групи < 5 покупців → «Інші», якщо й «Інші» < 5 — hidden", () => {
  const rows = [
    { region: "Київська", buyers: 10, orders: 12, revenue: 1000 },
    { region: "Львівська", buyers: 3, orders: 3, revenue: 300 },
    { region: "Одеська", buyers: 2, orders: 2, revenue: 200 },
  ];
  const out = A.suppressSmallGroups(rows, { labelKey: "region", fields: ["orders", "revenue"] });
  assert.deepEqual(out, [
    { region: "Київська", orders: 12, revenue: 1000 },
    { region: "Інші", orders: 5, revenue: 500 },
  ]);
  assert.ok(out.every((r) => !("buyers" in r)), "кількість покупців не віддаємо");
  const hidden = A.suppressSmallGroups([{ region: "Волинська", buyers: 2, orders: 4, revenue: 50 }], { labelKey: "region", fields: ["orders", "revenue"] });
  assert.deepEqual(hidden, [{ region: "Інші", hidden: true, orders: null, revenue: null }]);
  assert.deepEqual(A.suppressSmallGroups([], { fields: ["x"] }), []);
});

test("newVsRepeat: нові — перше замовлення в періоді, повторні — до періоду", () => {
  const start = new Date("2026-10-01T00:00:00Z");
  const r = A.newVsRepeat(
    [
      { firstAt: new Date("2026-10-05"), count: 1 },
      { firstAt: new Date("2026-10-06"), count: 2 },
      { firstAt: new Date("2026-08-01"), count: 3 },
      { firstAt: new Date("2026-09-30"), count: 1 },
    ],
    start
  );
  assert.deepEqual(r, { new: 2, repeat: 2, repeatRate: 0.5 });
  assert.deepEqual(A.newVsRepeat([], start), { new: 0, repeat: 0, repeatRate: null });
});

test("createCache: TTL і обмеження розміру (LRU)", () => {
  let t = 0;
  const c = A.createCache({ ttlMs: 1000, max: 2, now: () => t });
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1); // a — свіжий
  c.set("c", 3); // витісняє b
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  t = 1001;
  assert.equal(c.get("a"), undefined);
  assert.ok(c.size() <= 2);
});

test("toCsv: BOM, роздільник «;», CRLF, захист від формул", () => {
  const s = A.toCsv(["Товар", "Сума"], [["=HYPERLINK()", 10], ["a;b", 1.5]]);
  assert.ok(s.startsWith("﻿"));
  assert.equal(s, "﻿Товар;Сума\r\n'=HYPERLINK();10\r\n\"a;b\";1.5\r\n");
});

test("escapeRegex", () => {
  assert.equal(A.escapeRegex("a.b*(c)"), "a\\.b\\*\\(c\\)");
  assert.ok(new RegExp(A.escapeRegex("[x]")).test("[x]"));
});
