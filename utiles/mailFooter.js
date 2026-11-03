// Підпис у листах покупцям: «З повагою…», контакти магазину і (за бажанням) блок «Вам може бути цікаво»
// з кількома товарами (акційні, далі — новинки). Контакти беремо з реквізитів магазину, назву — з поля
// «Бренд» публічної оферти (інакше — назва з реквізитів). Усе без HTML — лише текст.

const MAX_PRODUCTS = 3;
const CACHE_MS = 10 * 60 * 1000;

const front = () => (process.env.PUBLIC_FRONT_URL || "").replace(/\/+$/, "");

const money = (n) => `₴${Math.round(Number(n) * 100) / 100}`;
const priceOf = (p) => {
  const d = Number(p.discount) || 0;
  return d > 0 ? Math.round(Number(p.price) * (1 - d / 100) * 100) / 100 : Number(p.price);
};

let cache = { at: 0, items: [] };

async function pickProducts() {
  if (Date.now() - cache.at < CACHE_MS) return cache.items;
  let items = [];
  try {
    const productModel = require("../models/productModel");
    const base = { stock: { $gt: 0 }, slug: { $exists: true, $ne: "" } };
    const sale = await productModel
      .find({ ...base, discount: { $gt: 0 } })
      .sort({ discount: -1, updatedAt: -1 })
      .limit(MAX_PRODUCTS)
      .select("name slug price discount")
      .lean();
    items = sale.map((p) => ({ ...p, tag: `−${p.discount}%` }));
    if (items.length < MAX_PRODUCTS) {
      const have = new Set(items.map((p) => String(p._id)));
      const fresh = await productModel
        .find({ ...base, _id: { $nin: [...have] } })
        .sort({ createdAt: -1 })
        .limit(MAX_PRODUCTS - items.length)
        .select("name slug price discount")
        .lean();
      items = items.concat(fresh.map((p) => ({ ...p, tag: "новинка" })));
    }
  } catch (e) {
    console.error("📧 mailFooter products:", e.message);
  }
  cache = { at: Date.now(), items };
  return items;
}

// Чисті функції (тестуються без БД)
function formatFooter({ name, phone, email, site, products = [], withProducts }) {
  const out = ["", "—", "З повагою,", `${name || "команда магазину"}`];
  const contacts = [phone && `Тел.: ${phone}`, email && `E-mail: ${email}`, site && `Сайт: ${site}`].filter(Boolean);
  if (contacts.length) out.push(...contacts);
  if (withProducts && products.length && site) {
    out.push("", "Вам може бути цікаво:");
    for (const p of products) {
      out.push(`• ${p.name} — ${money(priceOf(p))}${p.tag ? ` (${p.tag})` : ""}`, `  ${site}/product/details/${p.slug}`);
    }
  }
  return out.join("\n");
}

// mode: "full" (підпис + товари) | "plain" (лише підпис і контакти)
async function buildFooter(mode = "full") {
  try {
    const storeSettingsModel = require("../models/storeSettingsModel");
    const invoiceLib = require("./invoice");
    const raw = (await storeSettingsModel.findOne({ key: "main" }).lean()) || {};
    const company = invoiceLib.normalizeCompany(raw.company);
    const vars = raw.legal?.oferta?.vars || {};
    const domain = vars.domain ? `https://${vars.domain}` : "";
    const site = front() || domain;
    const products = mode === "full" ? await pickProducts() : [];
    return formatFooter({
      name: vars.brand || company.name,
      phone: company.phone,
      email: company.email || vars.claimsEmail,
      site,
      products,
      withProducts: mode === "full",
    });
  } catch (e) {
    console.error("📧 mailFooter:", e.message);
    return "\n—\nЗ повагою,\nкоманда магазину";
  }
}

module.exports = { buildFooter, formatFooter, priceOf };
