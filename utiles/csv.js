// CSV (RFC 4180) без залежностей: парсер і серіалізатор.
// parse: лапки, подвоєні лапки, переноси рядків усередині лапок, CRLF/LF/CR, BOM, автовизначення
// роздільника (, ; \t — Excel в українській локалі зберігає через «;»).
// stringify: екранування за RFC 4180 + захист від CSV/formula injection (=, +, -, @, таб, CR на початку).

const BOM = "﻿";
const CANDIDATES = [",", ";", "\t"];

// Роздільник за першим логічним рядком (поза лапками)
function detectDelimiter(text) {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQ = false;
  for (let i = 0; i < text.length && i < 64 * 1024; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQ && text[i + 1] === '"') i++;
      else inQ = !inQ;
    } else if (!inQ && (ch === "\n" || ch === "\r")) break;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  let best = ",";
  for (const d of CANDIDATES) if (counts[d] > counts[best]) best = d;
  return best;
}

// → string[][]; opts: { delimiter: ','|';'|'\t'|'auto', maxRows, maxFieldLength }
// Кидає Error з полем .code ('TOO_MANY_ROWS' | 'FIELD_TOO_LONG' | 'UNTERMINATED_QUOTE')
function parse(input, { delimiter = "auto", maxRows = Infinity, maxFieldLength = 10000, skipEmptyLines = true } = {}) {
  let text = String(input ?? "");
  if (text.startsWith(BOM)) text = text.slice(1);
  const d = delimiter === "auto" ? detectDelimiter(text) : delimiter;
  if (typeof d !== "string" || d.length !== 1 || d === '"' || d === "\n" || d === "\r") throw new Error("Некоректний роздільник");

  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  let quotedField = false;
  const fail = (code, msg) => {
    const e = new Error(msg);
    e.code = code;
    return e;
  };
  const pushField = () => {
    if (field.length > maxFieldLength) throw fail("FIELD_TOO_LONG", `Поле довше за ${maxFieldLength} символів (рядок ${rows.length + 1})`);
    row.push(field);
    field = "";
    quotedField = false;
  };
  const pushRow = () => {
    pushField();
    const empty = row.length === 1 && row[0] === "";
    if (!(skipEmptyLines && empty)) {
      if (rows.length >= maxRows) throw fail("TOO_MANY_ROWS", `Більше ${maxRows} рядків`);
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      // Лапка на початку поля відкриває quoted-поле; всередині неквотованого — звичайний символ
      if (field === "" && !quotedField) {
        inQ = true;
        quotedField = true;
      } else field += ch;
    } else if (ch === d) pushField();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
    } else if (ch === "\n") pushRow();
    else field += ch;
  }
  if (inQ) throw fail("UNTERMINATED_QUOTE", "Незакриті лапки в CSV");
  if (field !== "" || row.length) pushRow();
  return rows;
}

// Перший рядок — заголовки (trim, lowercase). aliases: { 'e-mail': 'email', ... }
// → { headers, records:[{ row (номер рядка у файлі, з 2), data:{header:value} }] }
function toObjects(rows, { aliases = {} } = {}) {
  if (!Array.isArray(rows) || !rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => {
    const k = String(h || "").trim().toLowerCase();
    return aliases[k] || k;
  });
  const records = rows.slice(1).map((r, i) => {
    const data = {};
    headers.forEach((h, j) => {
      if (h && !(h in data)) data[h] = typeof r[j] === "string" ? r[j].trim() : "";
    });
    return { row: i + 2, data };
  });
  return { headers, records };
}

// Захист від formula injection у Excel/LibreOffice
function safeCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  // Чисті числа/телефони (+380…, -12.5) — не формули, лишаємо як є
  if (/^[+-]?\d[\d\s().,]*$/.test(s)) return s;
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function cell(v, { delimiter = ",", guard = true } = {}) {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (guard) s = safeCell(s);
  const needs = s.includes('"') || s.includes(delimiter) || s.includes("\n") || s.includes("\r") || /^\s|\s$/.test(s);
  return needs ? `"${s.replace(/"/g, '""')}"` : s;
}

function stringifyRow(values, opts = {}) {
  const d = opts.delimiter || ",";
  return (values || []).map((v) => cell(v, { ...opts, delimiter: d })).join(d) + "\r\n";
}

// rows: масив масивів; opts.bom — додати BOM (для Excel)
function stringify(rows, { bom = false, ...opts } = {}) {
  return (bom ? BOM : "") + (rows || []).map((r) => stringifyRow(r, opts)).join("");
}

module.exports = { BOM, detectDelimiter, parse, toObjects, safeCell, cell, stringifyRow, stringify };
