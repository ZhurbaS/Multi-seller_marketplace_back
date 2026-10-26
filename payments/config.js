// Налаштування платіжного шару. Усе береться з .env (див. .env.example і SETUP.md).

const isProduction = () => process.env.NODE_ENV === "production";
const trimSlash = (v) => (v || "").trim().replace(/\/+$/, "");

// Публічна адреса БЕКА — на неї платіжні системи надсилають вебхуки (callback).
// Локально (localhost) вебхуки недосяжні: у Codespaces це адреса порту 5000.
const publicApiUrl = () =>
  trimSlash(process.env.PUBLIC_API_URL) ||
  `http://localhost:${process.env.PORT || 5000}`;

// Адреса сайту покупців — куди повертаємо людину після оплати.
const publicFrontUrl = () =>
  trimSlash(process.env.PUBLIC_FRONT_URL) || "http://localhost:5173";

const isPlaceholder = (v) => !v || /^(dummy|changeme|your_.*)$/i.test(v.trim());

const monobankEnabled = () => !isPlaceholder(process.env.MONO_TOKEN);

const liqpayEnabled = () =>
  !isPlaceholder(process.env.LIQPAY_PUBLIC_KEY) &&
  !isPlaceholder(process.env.LIQPAY_PRIVATE_KEY);

// Тестовий «провайдер» без реальних грошей. У production вимкнений завжди.
const mockEnabled = () =>
  !isProduction() && process.env.PAYMENTS_MOCK !== "false";

// Оплата при отриманні (накладений платіж / оплата кур'єру) — працює без еквайрингу.
const codEnabled = () => process.env.PAYMENTS_COD !== "false";

module.exports = {
  isProduction,
  publicApiUrl,
  publicFrontUrl,
  monobankEnabled,
  liqpayEnabled,
  mockEnabled,
  codEnabled,
};
