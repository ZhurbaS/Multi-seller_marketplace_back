// RFM: бали, пороги (фіксовані й квінтилі), назви сегментів
const test = require("node:test");
const assert = require("node:assert/strict");
const rfm = require("../utiles/rfm");

const NOW = Date.parse("2026-06-01T00:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000);

test("score: межі й напрям", () => {
  assert.equal(rfm.score(10, rfm.FIXED.r, false), 5);
  assert.equal(rfm.score(30, rfm.FIXED.r, false), 5);
  assert.equal(rfm.score(31, rfm.FIXED.r, false), 4);
  assert.equal(rfm.score(300, rfm.FIXED.r, false), 1);
  assert.equal(rfm.score(1, rfm.FIXED.f), 1);
  assert.equal(rfm.score(2, rfm.FIXED.f), 2);
  assert.equal(rfm.score(5, rfm.FIXED.f), 4);
  assert.equal(rfm.score(6, rfm.FIXED.f), 5);
  assert.equal(rfm.score(50000, rfm.FIXED.m), 5);
  assert.equal(rfm.score(NaN, rfm.FIXED.m), 1);
});

test("segmentName за спекою", () => {
  assert.equal(rfm.segmentName(5, 5), "champions");
  assert.equal(rfm.segmentName(4, 4), "champions");
  assert.equal(rfm.segmentName(3, 3), "loyal");
  assert.equal(rfm.segmentName(5, 1), "new");
  assert.equal(rfm.segmentName(3, 2), "promising");
  assert.equal(rfm.segmentName(2, 4), "at_risk");
  assert.equal(rfm.segmentName(1, 1), "lost");
  assert.equal(rfm.segmentName(2, 2), "hibernating");
  for (let r = 1; r <= 5; r++) for (let f = 1; f <= 5; f++) assert.ok(rfm.SEGMENTS.includes(rfm.segmentName(r, f)));
});

test("computeScores: <10 — фіксовані пороги", () => {
  const out = rfm.computeScores(
    [
      { id: "a", lastOrderAt: ago(5), count: 6, sum: 50000 },
      { id: "b", lastOrderAt: ago(400), count: 1, sum: 500 },
      { id: "c", lastOrderAt: ago(10), count: 1, sum: 3000 },
      { id: "z", lastOrderAt: null, count: 0, sum: 0 },
    ],
    { now: NOW }
  );
  assert.equal(out.method, "fixed");
  assert.equal(out.items.length, 3, "без замовлень — пропускаємо");
  const by = Object.fromEntries(out.items.map((x) => [x.id, x]));
  assert.deepEqual([by.a.r, by.a.f, by.a.m, by.a.segment], [5, 5, 5, "champions"]);
  assert.deepEqual([by.b.r, by.b.f, by.b.segment], [1, 1, "lost"]);
  assert.equal(by.c.segment, "new");
  assert.equal(by.b.recencyDays, 400);
});

test("computeScores: ≥10 — квінтилі", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), lastOrderAt: ago(i * 10), count: i + 1, sum: (i + 1) * 1000 }));
  const out = rfm.computeScores(rows, { now: NOW });
  assert.equal(out.method, "quintiles");
  const best = out.items.find((x) => x.id === "0");
  const worst = out.items.find((x) => x.id === "19");
  assert.equal(best.r, 5);
  assert.equal(worst.r, 1);
  assert.equal(worst.f, 5);
  assert.equal(worst.segment, "at_risk");
  const counts = [1, 2, 3, 4, 5].map((s) => out.items.filter((x) => x.m === s).length);
  assert.deepEqual(counts, [4, 4, 4, 4, 4], "рівні квінтилі");
});

test("quantile/quintiles", () => {
  assert.equal(rfm.quantile([], 0.5), 0);
  assert.equal(rfm.quantile([1, 3], 0.5), 2);
  assert.deepEqual(rfm.quintiles([1, 2, 3, 4, 5, 6]), [2, 3, 4, 5]);
});
