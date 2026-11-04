// Єдиний реєстр плейсментів банерів (див. BANNERS_SPEC.md). Віддається адмінці через
// GET /api/admin/banners/meta. Чисті дані — без БД.

const PLACEMENTS = [
  {
    id: "announcement",
    name: "Стрічка оголошення",
    where: "Над шапкою на всіх сторінках, закривається (запам'ятовується за id)",
    kind: "text",
    desktop: null,
    mobile: null,
    max: 1,
    categories: false,
  },
  {
    id: "home_hero",
    name: "Головна карусель",
    where: "Верх головної, під шапкою",
    kind: "image",
    desktop: { width: 1600, height: 533, ratio: "3:1" },
    mobile: { width: 800, height: 400, ratio: "2:1" },
    max: 6,
    categories: false,
  },
  {
    id: "home_mid",
    name: "Широкий банер на головній",
    where: "Між блоками товарів на головній (на ПК 2 банери — у 2 колонки по 800×400)",
    kind: "image",
    desktop: { width: 1600, height: 400, ratio: "4:1" },
    mobile: { width: 800, height: 400, ratio: "2:1" },
    max: 2,
    categories: false,
  },
  {
    id: "catalog_top",
    name: "Банер над каталогом",
    where: "Над сіткою товарів у каталозі/пошуку/категорії; може бути прив'язаний до категорій (порожньо = усі)",
    kind: "image",
    desktop: { width: 1600, height: 320, ratio: "5:1" },
    mobile: { width: 800, height: 320, ratio: "2.5:1" },
    max: 1,
    categories: true,
  },
  {
    id: "product_promo",
    name: "Банер на сторінці товару",
    where: "Під блоком купівлі (праворуч/під кнопками)",
    kind: "image",
    desktop: { width: 800, height: 400, ratio: "2:1" },
    mobile: { width: 800, height: 400, ratio: "2:1" },
    max: 1,
    categories: false,
  },
  {
    id: "cart_promo",
    name: "Банер у кошику",
    where: "Над списком товарів кошика",
    kind: "image",
    desktop: { width: 1200, height: 240, ratio: "5:1" },
    mobile: { width: 800, height: 320, ratio: "2.5:1" },
    max: 1,
    categories: false,
  },
];

const PLACEMENT_IDS = PLACEMENTS.map((p) => p.id);
const getPlacement = (id) => PLACEMENTS.find((p) => p.id === id) || null;

const LIMITS = { maxImageMB: 2, minImageWidth: 600 };

module.exports = { PLACEMENTS, PLACEMENT_IDS, getPlacement, LIMITS };
