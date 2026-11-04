// HTML-шаблон маркетингового листа з блоків (MARKETING_SPEC.md §2) + текстова версія.
// Таблична верстка 600px, лише inline-стилі, кольори з теми магазину (utiles/theme.js).
// Футер: «Реклама», реквізити продавця (storeSettings.company), відписка, налаштування, політика.
// Безпека: увесь текст екранується; у href/src потрапляють лише http(s) (+ mailto/tel для посилань);
// відносні шляхи «/…» резолвляться від адреси фронту. Кліки обгортаються підписаним редіректом.
//
// Чисті: escapeHtml, safeUrl, inlineMarkup, renderBlocks, renderEmail, contextFromSettings, productView.
// БД: loadContext, loadProducts, loadBanners, buildEmail.

const theme = require("./theme");

const WIDTH = 600;
const FONT = "Arial,Helvetica,sans-serif";
const MAX_PRODUCTS = 6;

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

const trimSlash = (v) => String(v || "").trim().replace(/\/+$/, "");
const frontUrl = () => trimSlash(process.env.PUBLIC_FRONT_URL) || "http://localhost:5173";
const apiUrl = () => {
  try {
    return require("../payments/config").publicApiUrl();
  } catch {
    return trimSlash(process.env.PUBLIC_API_URL) || `http://localhost:${process.env.PORT || 5000}`;
  }
};

// Дозволені схеми. kind: 'link' (http/https/mailto/tel) | 'image' (лише http/https)
function safeUrl(raw, { front = frontUrl(), kind = "link" } = {}) {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  if (!s || s.length > 2000 || /[\s<>"'`\\]/.test(s) || /[\u0000-\u001f\u007f]/.test(s)) return "";
  if (/^\/(?!\/)/.test(s)) return front ? `${trimSlash(front)}${s}` : "";
  let u;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  const proto = u.protocol.toLowerCase();
  if (proto === "http:" || proto === "https:") return u.host ? s : "";
  if (kind === "link" && (proto === "mailto:" || proto === "tel:")) return s;
  return "";
}

const isHttp = (u) => /^https?:\/\//i.test(u);

// UTM лише для посилань на власний сайт
function addUtm(url, utm, front = frontUrl()) {
  if (!utm || !isHttp(url) || !front) return url;
  try {
    const u = new URL(url);
    const f = new URL(front);
    if (u.host !== f.host) return url;
    const map = { utm_source: utm.source, utm_medium: utm.medium, utm_campaign: utm.campaign };
    for (const [k, v] of Object.entries(map)) if (v && !u.searchParams.has(k)) u.searchParams.set(k, String(v).slice(0, 100));
    return u.toString();
  } catch {
    return url;
  }
}

// Посилання в листі → кінцевий href (з UTM і обгорткою кліку, якщо задано ctx.wrap)
function linkHref(raw, ctx, kind = "link") {
  const url = safeUrl(raw, { front: ctx.front, kind });
  if (!url) return "";
  const withUtm = addUtm(url, ctx.utm, ctx.front);
  return ctx.wrap && isHttp(withUtm) ? ctx.wrap(withUtm) : withUtm;
}

// Проста розмітка: **жирний**, [текст](url). → { html, text } для одного абзацу
const INLINE_RE = /\*\*([^*]+?)\*\*|\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/g;
function inlineMarkup(src, ctx) {
  const s = String(src ?? "");
  let html = "";
  let text = "";
  let last = 0;
  const linkColor = ctx.colors?.link || "#1f5fd6";
  for (const m of s.matchAll(INLINE_RE)) {
    const chunk = s.slice(last, m.index);
    html += escapeHtml(chunk);
    text += chunk;
    if (m[1] !== undefined) {
      html += `<strong>${escapeHtml(m[1])}</strong>`;
      text += m[1];
    } else {
      const href = linkHref(m[3], ctx);
      if (href) {
        html += `<a href="${escapeHtml(href)}" style="color:${linkColor};text-decoration:underline;">${escapeHtml(m[2])}</a>`;
        text += `${m[2]} (${href})`;
      } else {
        html += escapeHtml(m[2]);
        text += m[2];
      }
    }
    last = m.index + m[0].length;
  }
  html += escapeHtml(s.slice(last));
  text += s.slice(last);
  return { html: html.replace(/\n/g, "<br>"), text };
}

const money = (n) => {
  const v = Math.round(Number(n) || 0);
  return `${String(v).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₴`;
};

const td = (inner, style = "") => `<tr><td style="padding:0 32px;${style}">${inner}</td></tr>`;

function buttonHtml(label, href, colors) {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px;"><tr>` +
    `<td align="center" bgcolor="${colors.cta}" style="border-radius:8px;background:${colors.cta};">` +
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:bold;color:${colors.onCta};text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

function productCell(p, ctx) {
  const href = linkHref(p.url, ctx);
  const img = safeUrl(p.image || "", { front: ctx.front, kind: "image" });
  const c = ctx.colors;
  const pic = img
    ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(p.name)}" width="220" style="display:block;width:100%;max-width:220px;height:auto;border:0;">`
    : "";
  const imgTag = href && pic ? `<a href="${escapeHtml(href)}">${pic}</a>` : pic;
  const old = p.oldPrice && p.oldPrice > p.price ? `<span style="color:#6b7280;text-decoration:line-through;font-size:13px;margin-left:6px;">${money(p.oldPrice)}</span>` : "";
  return (
    `<td width="50%" valign="top" style="padding:8px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:8px;">` +
    (img ? `<tr><td align="center" style="padding:12px;">${imgTag}</td></tr>` : "") +
    `<tr><td style="padding:0 12px 4px;font-family:${FONT};font-size:14px;line-height:20px;color:#111827;">${escapeHtml(p.name)}</td></tr>` +
    `<tr><td style="padding:0 12px 8px;font-family:${FONT};font-size:16px;font-weight:bold;color:#111827;">${money(p.price)}${old}</td></tr>` +
    (href
      ? `<tr><td style="padding:0 12px 12px;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 16px;background:${c.cta};color:${c.onCta};font-family:${FONT};font-size:14px;font-weight:bold;text-decoration:none;border-radius:6px;">Купити</a></td></tr>`
      : "") +
    `</table></td>`
  );
}

// blocks → { html (рядки <tr> основної таблиці), text }
function renderBlocks(blocks, ctx) {
  const c = ctx.colors;
  const html = [];
  const text = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== "object") continue;
    switch (b.type) {
      case "heading": {
        const t = String(b.text || "").trim();
        if (!t) break;
        const lvl = Number(b.level) === 2 ? 2 : 1;
        const size = lvl === 1 ? 26 : 20;
        html.push(
          td(`<h${lvl} style="margin:0;font-family:${FONT};font-size:${size}px;line-height:1.3;color:${c.heading};">${escapeHtml(t)}</h${lvl}>`, "padding-top:16px;padding-bottom:8px;")
        );
        text.push(lvl === 1 ? t.toUpperCase() : t, "");
        break;
      }
      case "text": {
        const paras = String(b.text || "")
          .replace(/\r\n/g, "\n")
          .split(/\n\s*\n/)
          .map((p) => p.trim())
          .filter(Boolean);
        for (const p of paras) {
          const r = inlineMarkup(p, ctx);
          html.push(td(`<p style="margin:0 0 12px;font-family:${FONT};font-size:16px;line-height:24px;color:#1f2937;">${r.html}</p>`));
          text.push(r.text, "");
        }
        break;
      }
      case "button": {
        const href = linkHref(b.url, ctx);
        const label = String(b.label || "").trim();
        if (!href || !label) break;
        html.push(td(buttonHtml(label, href, c)));
        text.push(`${label}: ${href}`, "");
        break;
      }
      case "image": {
        const src = safeUrl(b.url, { front: ctx.front, kind: "image" });
        if (!src) break;
        const href = b.href ? linkHref(b.href, ctx) : "";
        const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(b.alt || "")}" width="${WIDTH - 64}" style="display:block;width:100%;max-width:${WIDTH - 64}px;height:auto;border:0;border-radius:8px;">`;
        html.push(td(href ? `<a href="${escapeHtml(href)}">${img}</a>` : img, "padding-top:8px;padding-bottom:16px;"));
        if (b.alt || href) text.push([b.alt, href].filter(Boolean).join(": "), "");
        break;
      }
      case "products": {
        const ids = Array.isArray(b.productIds) ? b.productIds.map(String) : [];
        const list = ids.map((id) => ctx.products?.get?.(id)).filter(Boolean).slice(0, MAX_PRODUCTS);
        if (!list.length) break;
        if (b.title) {
          html.push(td(`<h2 style="margin:0;font-family:${FONT};font-size:20px;color:${c.heading};">${escapeHtml(b.title)}</h2>`, "padding-top:16px;padding-bottom:4px;"));
          text.push(String(b.title), "");
        }
        const rows = [];
        for (let i = 0; i < list.length; i += 2) {
          rows.push(`<tr>${productCell(list[i], ctx)}${list[i + 1] ? productCell(list[i + 1], ctx) : '<td width="50%" style="padding:8px;"></td>'}</tr>`);
        }
        html.push(
          `<tr><td style="padding:0 24px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join("")}</table></td></tr>`
        );
        for (const p of list) {
          const href = linkHref(p.url, ctx);
          text.push(`• ${p.name} — ${money(p.price)}${href ? `\n  ${href}` : ""}`);
        }
        text.push("");
        break;
      }
      case "banner": {
        const bn = ctx.banners?.get?.(String(b.bannerId || ""));
        if (!bn) break;
        const src = safeUrl(bn.image || "", { front: ctx.front, kind: "image" });
        if (!src) break;
        const href = bn.href ? linkHref(bn.href, ctx) : "";
        const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(bn.alt || "")}" width="${WIDTH - 64}" style="display:block;width:100%;max-width:${WIDTH - 64}px;height:auto;border:0;border-radius:8px;">`;
        html.push(td(href ? `<a href="${escapeHtml(href)}">${img}</a>` : img, "padding-top:8px;padding-bottom:16px;"));
        if (href) text.push(`${bn.alt || "Банер"}: ${href}`, "");
        break;
      }
      case "divider":
        html.push(td(`<div style="border-top:1px solid #e5e7eb;height:1px;line-height:1px;font-size:1px;">&nbsp;</div>`, "padding-top:16px;padding-bottom:16px;"));
        text.push("----------", "");
        break;
      case "spacer":
        html.push(`<tr><td style="height:24px;line-height:24px;font-size:1px;">&nbsp;</td></tr>`);
        break;
      default:
        break;
    }
  }
  return { html: html.join("\n"), text: text.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

// Реквізити продавця одним/кількома рядками
function companyLines(company = {}, brand = "") {
  const lines = [];
  const name = company.name || brand;
  if (name) lines.push(name);
  const codes = [];
  if (company.edrpou) codes.push(`${company.edrpou.length === 10 ? "РНОКПП" : "ЄДРПОУ"} ${company.edrpou}`);
  if (company.ipn) codes.push(`ІПН ${company.ipn}`);
  if (codes.length) lines.push(codes.join(", "));
  if (company.address) lines.push(company.address);
  const contacts = [company.phone && `тел. ${company.phone}`, company.email].filter(Boolean);
  if (contacts.length) lines.push(contacts.join(", "));
  return lines;
}

// Повний лист. opts: { subject, preheader, blocks, ctx, links:{unsubscribe, preferences, privacy}, test }
function renderEmail({ subject = "", preheader = "", blocks = [], ctx, links = {}, test = false } = {}) {
  const c = ctx.colors;
  const brand = ctx.brand || "Магазин";
  const body = renderBlocks(blocks, ctx);
  const home = ctx.front ? linkHref(`${ctx.front}/`, ctx) : "";
  const unsub = safeUrl(links.unsubscribe || "", { front: ctx.front });
  const prefs = safeUrl(links.preferences || "", { front: ctx.front });
  const privacy = safeUrl(links.privacy || (ctx.front ? `${ctx.front}/privacy` : ""), { front: ctx.front });
  const company = companyLines(ctx.company, brand);
  const fLink = (href, label) => (href ? `<a href="${escapeHtml(href)}" style="color:${c.onFooter};text-decoration:underline;">${escapeHtml(label)}</a>` : "");
  const footerLinks = [fLink(unsub, "Відписатися"), fLink(prefs, "Налаштування підписки"), fLink(privacy, "Політика конфіденційності")].filter(Boolean).join(" &nbsp;·&nbsp; ");

  const brandHtml = home
    ? `<a href="${escapeHtml(home)}" style="color:${c.onHeader};text-decoration:none;">${escapeHtml(brand)}</a>`
    : escapeHtml(brand);

  const html = `<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f9;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}&#8203;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f5f9;"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${WIDTH}px;background:#ffffff;border-radius:12px;overflow:hidden;">
${test ? `<tr><td style="padding:8px 32px;background:#fef3c7;font-family:${FONT};font-size:13px;color:#92400e;">ТЕСТОВИЙ ЛИСТ — посилання не відстежуються</td></tr>` : ""}
<tr><td style="padding:20px 32px;background:${c.headerBg};font-family:${FONT};font-size:22px;font-weight:bold;color:${c.onHeader};">${brandHtml}</td></tr>
<tr><td style="padding:12px 32px 0;font-family:${FONT};font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#6b7280;">Реклама</td></tr>
${body.html}
<tr><td style="height:16px;line-height:16px;font-size:1px;">&nbsp;</td></tr>
<tr><td style="padding:20px 32px;background:${c.footerBg};font-family:${FONT};font-size:12px;line-height:18px;color:${c.onFooter};">
<p style="margin:0 0 8px;"><strong>Реклама.</strong> Ви отримали цей лист, бо підписалися на розсилку ${escapeHtml(brand)}.</p>
${company.length ? `<p style="margin:0 0 8px;">${company.map(escapeHtml).join("<br>")}</p>` : ""}
<p style="margin:0;">${footerLinks}</p>
</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    brand,
    "Реклама",
    "",
    body.text,
    "",
    "—",
    `Реклама. Ви отримали цей лист, бо підписалися на розсилку ${brand}.`,
    ...company,
    unsub && `Відписатися: ${unsub}`,
    prefs && `Налаштування підписки: ${prefs}`,
    privacy && `Політика конфіденційності: ${privacy}`,
  ]
    .filter((x) => x !== false && x !== undefined && x !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return { html, text };
}

// storeSettings (сирий документ) → контекст рендеру
function contextFromSettings(raw = {}, { front = frontUrl() } = {}) {
  const invoice = require("./invoice");
  const v = theme.derive(theme.resolve(raw.theme || {}).values);
  const vars = raw.legal?._vars || raw.legal?.oferta?.vars || {};
  const company = invoice.normalizeCompany(raw.company);
  return {
    front: trimSlash(front),
    brand: String(vars.brand || "").trim() || company.name || "TechScout",
    company,
    colors: {
      heading: v["brand-ink"],
      link: v["brand-ink"],
      cta: v.cta,
      onCta: v["on-cta"],
      headerBg: v["header-bg"],
      onHeader: v["on-header"],
      footerBg: v["footer-bg"],
      onFooter: v["on-footer"],
    },
    products: new Map(),
    banners: new Map(),
  };
}

// Товар з БД → дані картки (ціна після знижки товару — utiles/pricing.js)
function productView(p) {
  const { baseUnitPrice } = require("./pricing");
  const price = baseUnitPrice(p);
  const img = Array.isArray(p.images) ? p.images.find((x) => typeof x === "string") || p.images[0]?.url || "" : "";
  return {
    _id: String(p._id),
    name: String(p.name || ""),
    slug: String(p.slug || ""),
    price,
    oldPrice: Number(p.discount) > 0 ? Number(p.price) : 0,
    image: typeof img === "string" ? img : "",
    url: p.slug ? `/product/details/${encodeURIComponent(p.slug)}` : "",
  };
}

// ======================= БД =======================

async function loadProducts(blocks) {
  const ids = [];
  for (const b of blocks || []) if (b?.type === "products" && Array.isArray(b.productIds)) ids.push(...b.productIds.map(String));
  const valid = [...new Set(ids)].filter((id) => /^[a-f\d]{24}$/i.test(id));
  const map = new Map();
  if (!valid.length) return map;
  const productModel = require("../models/productModel");
  const list = await productModel.find({ _id: { $in: valid } }).select("name slug price discount images").lean();
  for (const p of list) map.set(String(p._id), productView(p));
  return map;
}

function bannerHref(bn) {
  switch (bn.linkType) {
    case "product":
      return bn.productSlug ? `/product/details/${encodeURIComponent(bn.productSlug)}` : "";
    case "category":
      return bn.categoryName ? `/products?category=${encodeURIComponent(bn.categoryName)}` : "";
    case "page":
      return bn.pagePath || "";
    case "url":
      return bn.url || "";
    default:
      return "";
  }
}

async function loadBanners(blocks) {
  const ids = (blocks || []).filter((b) => b?.type === "banner" && /^[a-f\d]{24}$/i.test(String(b.bannerId || ""))).map((b) => String(b.bannerId));
  const map = new Map();
  if (!ids.length) return map;
  try {
    const siteBannerModel = require("../models/siteBannerModel");
    const list = await siteBannerModel.find({ _id: { $in: ids } }).lean();
    for (const bn of list) {
      map.set(String(bn._id), { image: bn.imageDesktop?.url || bn.imageMobile?.url || "", alt: bn.alt || bn.headline || "", href: bannerHref(bn) });
    }
  } catch (e) {
    console.error("📧 emailTemplate banners:", e.message);
  }
  return map;
}

// Базовий контекст (тема, реквізити, бренд) + товари/банери для блоків
async function loadContext(blocks = []) {
  const storeSettingsModel = require("../models/storeSettingsModel");
  const raw = (await storeSettingsModel.findOne({ key: "main" }).lean()) || {};
  const ctx = contextFromSettings(raw);
  ctx.products = await loadProducts(blocks);
  ctx.banners = await loadBanners(blocks);
  return ctx;
}

// Посилання футера для контакту (токени HMAC)
// campaignId — вшивається в токен відписки (облік Campaign.stats.unsubscribed)
function contactLinks(contactId, { front, api = apiUrl(), campaignId } = {}) {
  const tokens = require("./marketingTokens");
  const f = trimSlash(front || frontUrl());
  if (!contactId) return { unsubscribe: `${f}/unsubscribe`, preferences: `${f}/preferences`, privacy: `${f}/privacy`, oneClick: "" };
  const unsub = tokens.sign("unsub", String(contactId), campaignId ? { campaignId } : {});
  const pref = tokens.sign("pref", String(contactId));
  return {
    unsubscribe: `${f}/unsubscribe?t=${encodeURIComponent(unsub)}`,
    preferences: `${f}/preferences?t=${encodeURIComponent(pref)}`,
    privacy: `${f}/privacy`,
    oneClick: `${trimSlash(api)}/api/home/unsubscribe?t=${encodeURIComponent(unsub)}`,
  };
}

// Обгортка кліків: ${PUBLIC_API_URL}/api/r/<token>?u=<encoded>
function clickWrapper({ messageId, campaignId, api = apiUrl() }) {
  if (!messageId) return null;
  const tokens = require("./marketingTokens");
  const base = `${trimSlash(api)}/api/r/`;
  const m = String(messageId);
  const k = campaignId ? String(campaignId) : null;
  // Окремий токен на кожен url: у підписі — відбиток url (захист від open-redirect)
  return (url) => `${base}${tokens.signClick({ messageId: m, campaignId: k, url })}?u=${encodeURIComponent(url)}`;
}

// Готовий лист для контакту. mode: 'send' (з обгорткою кліків) | 'preview' | 'test'
// ctx — можна передати заздалегідь (loadContext) для пачки листів
async function buildEmail({ subject, preheader, blocks, utm, contactId, messageId, campaignId, mode = "send" }, ctx) {
  const c = ctx || (await loadContext(blocks));
  const local = { ...c, utm: utm || null, wrap: mode === "send" ? clickWrapper({ messageId, campaignId }) : null };
  const links = contactLinks(contactId, { front: c.front, campaignId: mode === "send" ? campaignId : null });
  const r = renderEmail({ subject, preheader, blocks, ctx: local, links, test: mode === "test" });
  return { ...r, subject: mode === "test" ? `[ТЕСТ] ${subject}` : subject, links };
}

module.exports = {
  WIDTH,
  escapeHtml,
  safeUrl,
  addUtm,
  inlineMarkup,
  renderBlocks,
  renderEmail,
  companyLines,
  contextFromSettings,
  productView,
  contactLinks,
  clickWrapper,
  loadProducts,
  loadBanners,
  loadContext,
  buildEmail,
  money,
};
