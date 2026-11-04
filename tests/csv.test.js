// CSV: парсер RFC 4180, автороздільник, BOM, ліміти, серіалізація й захист від formula injection
const test = require("node:test");
const assert = require("node:assert/strict");
const csv = require("../utiles/csv");

test("parse: лапки, подвоєні лапки, переноси всередині, CRLF/LF/CR", () => {
  const rows = csv.parse('a,b,c\r\n"x, y","він сказав ""так""","рядок1\nрядок2"\n1,2,3\r4,5,6');
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["x, y", 'він сказав "так"', "рядок1\nрядок2"],
    ["1", "2", "3"],
    ["4", "5", "6"],
  ]);
});

test("parse: BOM, автовизначення ; і таб, порожні рядки пропускаються", () => {
  assert.deepEqual(csv.parse(csv.BOM + "email;name\na@b.ua;Іван\n\n"), [["email", "name"], ["a@b.ua", "Іван"]]);
  assert.equal(csv.detectDelimiter("a\tb\tc\n1,2"), "\t");
  assert.equal(csv.detectDelimiter('"a;b",c,d'), ",", "роздільник у лапках не рахується");
  assert.deepEqual(csv.parse("a,b\n,\n"), [["a", "b"], ["", ""]]);
});

test("parse: помилки й ліміти", () => {
  assert.throws(() => csv.parse('a,"b'), (e) => e.code === "UNTERMINATED_QUOTE");
  assert.throws(() => csv.parse("a\nb\nc", { maxRows: 2 }), (e) => e.code === "TOO_MANY_ROWS");
  assert.throws(() => csv.parse("x".repeat(20), { maxFieldLength: 10 }), (e) => e.code === "FIELD_TOO_LONG");
  assert.throws(() => csv.parse("a", { delimiter: '"' }));
  assert.deepEqual(csv.parse(""), []);
  assert.deepEqual(csv.parse(null), []);
});

test("toObjects: заголовки lowercase, аліаси, номери рядків", () => {
  const { headers, records } = csv.toObjects(csv.parse("E-mail, Ім'я ,Теги\n a@b.ua ,Іван,vip\nc@d.ua"), { aliases: { "e-mail": "email", "ім'я": "name" } });
  assert.deepEqual(headers, ["email", "name", "теги"]);
  assert.deepEqual(records[0], { row: 2, data: { email: "a@b.ua", name: "Іван", теги: "vip" } });
  assert.deepEqual(records[1], { row: 3, data: { email: "c@d.ua", name: "", теги: "" } });
  assert.deepEqual(csv.toObjects([]), { headers: [], records: [] });
});

test("stringify: екранування, BOM, CRLF, захист від формул", () => {
  assert.equal(csv.stringifyRow(["a", 'b"c', "d,e", "f\ng", null, 5]), 'a,"b""c","d,e","f\ng",,5\r\n');
  assert.equal(csv.stringify([["x"]], { bom: true }), csv.BOM + "x\r\n");
  assert.equal(csv.cell("=HYPERLINK(\"http://evil\")"), `"'=HYPERLINK(""http://evil"")"`);
  for (const s of ["+cmd", "-2+3", "@SUM(A1)", "\tx"]) assert.ok(csv.cell(s).replace(/^"/, "").startsWith("'"), s);
  assert.equal(csv.cell("+380501234567"), "+380501234567", "телефон не псуємо");
  assert.equal(csv.cell("-12.5"), "-12.5");
  assert.equal(csv.cell(new Date("2026-01-02T03:04:05Z")), "2026-01-02T03:04:05.000Z");
  assert.equal(csv.cell(" пробіл"), '" пробіл"');
  // round-trip
  const data = [["email", "name"], ["a@b.ua", 'Іван "Ваня", ТОВ']];
  assert.deepEqual(csv.parse(csv.stringify(data, { bom: true })), data);
});
