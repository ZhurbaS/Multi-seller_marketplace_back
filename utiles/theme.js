// Тема магазину: пресети кольорів, автовиведення похідних токенів,
// перевірка контрасту (WCAG) і побудова CSS. CSS будується ЛИШЕ з валідних hex.
const crypto = require("crypto");

const HEX = /^#[0-9a-fA-F]{6}$/;
const EDITABLE = ["brand", "cta", "sale", "headerBg", "footerBg"];

const PRESETS = {
  "tech-blue": {
    label: "Tech Blue",
    brand: "#1f5fd6", cta: "#ff7a1a", sale: "#e0234e", headerBg: "#0d1b36", footerBg: "#eef2f7",
  },
  "graphite-cyan": {
    label: "Graphite + Cyan",
    brand: "#0e7490", cta: "#22d3ee", sale: "#e0234e", headerBg: "#16191d", footerBg: "#eceff1",
  },
  "classic-green": {
    label: "Classic Green",
    brand: "#047e62", cta: "#058164", sale: "#d61f2b", headerBg: "#caddff", footerBg: "#f3f6fa",
  },
};
const DEFAULT_PRESET = "tech-blue";
const INK = "#0f172a";
const WHITE = "#ffffff";
const DARK_TEXT = "#111827";

const toRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (rgb) =>
  "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
function lum(h) {
  const [r, g, b] = toRgb(h).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
const mix = (a, b, t) => {
  const A = toRgb(a), B = toRgb(b);
  return toHex(A.map((v, i) => v * (1 - t) + B[i] * t));
};
const bestOn = (bg, light = WHITE, dark = DARK_TEXT) =>
  contrast(bg, light) >= contrast(bg, dark) ? light : dark;
function darken(h, step = 0.08) {
  return mix(h, "#000000", step);
}
// Темніший відтінок бренду, доки текст на білому не стане ≥ 4.5
function brandInk(h) {
  let c = h;
  for (let i = 0; i < 12 && contrast(c, WHITE) < 4.5; i++) c = darken(c, 0.1);
  return c;
}

function resolve(theme) {
  const preset = PRESETS[theme?.preset] ? theme.preset : DEFAULT_PRESET;
  const base = PRESETS[preset];
  const o = theme?.overrides || {};
  const v = {};
  for (const k of EDITABLE) v[k] = HEX.test(o[k] || "") && theme?.preset === "custom" ? o[k].toLowerCase() : base[k];
  return { preset: theme?.preset === "custom" ? "custom" : preset, values: v };
}

function derive(v) {
  const onHeader = bestOn(v.headerBg, "#e8edf6", INK);
  return {
    brand: v.brand,
    "brand-hover": darken(v.brand),
    "brand-soft": mix(WHITE, v.brand, 0.1),
    "brand-ink": brandInk(v.brand),
    "on-brand": bestOn(v.brand, WHITE, DARK_TEXT),
    cta: v.cta,
    "cta-hover": darken(v.cta, 0.07),
    "on-cta": bestOn(v.cta, WHITE, DARK_TEXT),
    "cta-disabled": mix(v.cta, WHITE, 0.6),
    sale: v.sale,
    "on-sale": bestOn(v.sale, WHITE, DARK_TEXT),
    "header-bg": v.headerBg,
    "header-bg-2": mix(v.headerBg, bestOn(v.headerBg, WHITE, "#000000"), 0.08),
    "on-header": onHeader,
    "on-header-2": mix(onHeader, v.headerBg, 0.3),
    "on-header-3": mix(onHeader, v.headerBg, 0.6),
    "footer-bg": v.footerBg,
    "on-footer": bestOn(v.footerBg, "#4a5568", WHITE) === "#4a5568" && contrast(v.footerBg, "#4a5568") >= 4.5
      ? "#4a5568"
      : bestOn(v.footerBg, INK, WHITE),
  };
}

function validate(theme) {
  const errors = [];
  const warnings = [];
  const o = theme?.overrides || {};
  if (theme?.preset === "custom") {
    for (const k of EDITABLE) {
      if (o[k] != null && o[k] !== "" && !HEX.test(o[k])) errors.push(`Колір «${k}» має бути у форматі #RRGGBB`);
    }
  } else if (theme?.preset && !PRESETS[theme.preset]) {
    errors.push("Невідомий пресет");
  }
  if (errors.length) return { errors, warnings };
  const d = derive(resolve(theme).values);
  if (contrast(d.brand, d["on-brand"]) < 3) errors.push("Основний колір: текст на ньому нечитабельний (контраст < 3:1)");
  if (contrast(d.cta, d["on-cta"]) < 3) errors.push("Колір кнопки «Купити»: текст на ньому нечитабельний (контраст < 3:1)");
  if (contrast(d.sale, d["on-sale"]) < 3) warnings.push("Колір знижки: бейдж має низький контраст");
  if (contrast(d["header-bg"], d["on-header"]) < 4.5) warnings.push("Шапка: текст має контраст нижче 4.5:1");
  if (contrast(d["footer-bg"], d["on-footer"]) < 4.5) warnings.push("Підвал: текст має контраст нижче 4.5:1");
  if (contrast(d.cta, "#ffffff") < 1.1 && contrast(d.cta, "#f3f5f9") < 1.5) warnings.push("Колір кнопки майже зливається зі сторінкою");
  return { errors, warnings };
}

function buildCss(theme) {
  const { values } = resolve(theme);
  const d = derive(values);
  const body = Object.entries(d).map(([k, val]) => `--${k}:${val};`).join("");
  const price = ""; // ціна лишається --ink (чорна), акцент — колір знижки/CTA
  return `:root{${body}${price}}`;
}

function build(theme) {
  const css = buildCss(theme);
  const hash = crypto.createHash("sha1").update(css).digest("hex").slice(0, 12);
  return { css, hash };
}

function normalize(input) {
  const preset = input?.preset === "custom" || PRESETS[input?.preset] ? input.preset : DEFAULT_PRESET;
  const overrides = {};
  if (preset === "custom") {
    for (const k of EDITABLE) if (HEX.test(input?.overrides?.[k] || "")) overrides[k] = input.overrides[k].toLowerCase();
    // відсутні поля беремо з дефолтного пресету, щоб кастом був повним
    for (const k of EDITABLE) if (!overrides[k]) overrides[k] = PRESETS[DEFAULT_PRESET][k];
  }
  return { preset, overrides };
}

module.exports = { PRESETS, DEFAULT_PRESET, EDITABLE, HEX, contrast, derive, resolve, validate, buildCss, build, normalize, brandInk, bestOn };
