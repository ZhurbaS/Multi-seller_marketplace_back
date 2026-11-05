// Інсайти «Що варто зробити» для кабінету продавця (DASHBOARD_SPEC.md §3). ЧИСТІ функції:
// на вході — уже пораховані метрики, на виході — Insight[]:
//   { id, severity:'info'|'warning'|'critical'|'success', title, text, productId?, link? }
// Пороги — константи нижче. Відсоткові правила спрацьовують лише при достатніх знаменниках.

const T = {
  LOW_COVER_DAYS: 7, // low_stock: daysOfCover < 7 для товарів класу A
  DEAD_DAYS: 90, // dead_stock: 0 продажів за 90 днів при залишку > 0
  VIEWS_MIN: 200, // views_no_cart: переглядів ≥ 200 …
  VIEW_TO_CART_FACTOR: 0.5, // … і viewToCart < 0.5 × медіани продавця
  CARTS_MIN: 20, // cart_no_order: кошиків ≥ 20 …
  CART_TO_ORDER_MAX: 0.1, // … і cartToOrder < 10%
  NEG_RATING_MAX: 2, // negative_reviews: ≥2 відгуки ≤2★ за 14 днів
  NEG_COUNT_MIN: 2,
  NEG_WINDOW_DAYS: 14,
  WEAK_QUALITY: 60, // weak_card: якість картки < 60
  REVENUE_DROP_PCT: -20, // revenue_drop: −20% і більше
  REVENUE_GROWTH_PCT: 20, // revenue_growth: +20% і більше
  REVENUE_MIN_ORDERS: 10, // … при ≥10 замовлень (у попередньому періоді)
  LATE_RATE_MAX: 0.04, // late_shipping: частка прострочених відправлень > 4%
  LATE_MIN_SHIPPED: 20, // … при ≥20 відправлених/прострочених
  PENDING_OLD_HOURS: 48, // pending_orders_old: є pending > 48 год
  MAX_PER_RULE: 3, // більше — одним зведеним інсайтом
  MAX_TOTAL: 12,
};

const SEVERITY_RANK = { critical: 0, warning: 1, success: 2, info: 3 };

const LINKS = {
  inventory: "/seller/analytics/inventory",
  products: "/seller/analytics/products",
  funnel: "/seller/analytics/funnel",
  reviews: "/seller/analytics/reviews",
  quality: "/seller/analytics/quality",
  fulfillment: "/seller/analytics/fulfillment",
  sales: "/seller/analytics/sales",
  orders: "/seller/dashboard/orders",
  addProduct: "/seller/dashboard/add-product",
  products_list: "/seller/dashboard/products",
  editProduct: (id) => `/seller/dashboard/edit-product/${id}`,
};

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pct = (x) => `${Math.round(num(x) * 100)}%`;

function median(values) {
  const s = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Перетворює список товарів, що підпадають під правило, на 1..MAX_PER_RULE інсайтів або один зведений
function perProduct(list, { id, severity, title, text, summaryTitle, summaryText, link, productLink }) {
  if (!list.length) return [];
  if (list.length <= T.MAX_PER_RULE) {
    return list.map((p) => ({
      id: `${id}:${p.productId}`,
      severity,
      title: title(p),
      text: text(p),
      productId: String(p.productId),
      link: productLink ? productLink(p) : link,
    }));
  }
  return [{ id, severity, title: summaryTitle(list.length), text: summaryText(list), link }];
}

const names = (list, n = 3) =>
  list
    .slice(0, n)
    .map((p) => `«${p.name}»`)
    .join(", ") + (list.length > n ? ` та ще ${list.length - n}` : "");

// ---------- правила ----------

function ruleOutOfStock(products) {
  // Закінчився залишок у товару, який продавався (інакше це не «втрачені продажі»)
  const list = products.filter((p) => num(p.stock) <= 0 && num(p.units90) > 0).sort((a, b) => num(b.revenue) - num(a.revenue));
  return perProduct(list, {
    id: "out_of_stock",
    severity: "critical",
    title: (p) => `Закінчився товар «${p.name}»`,
    text: () => "Товар продавався, але залишок 0 — поповніть склад, щоб не втрачати замовлення.",
    summaryTitle: (n) => `Закінчились ${n} товарів, що продавались`,
    summaryText: (l) => `Поповніть залишок: ${names(l)}.`,
    link: LINKS.inventory,
    productLink: (p) => LINKS.editProduct(p.productId),
  });
}

function ruleLowStock(products) {
  const list = products
    .filter((p) => p.abc === "A" && num(p.stock) > 0 && p.daysOfCover !== null && p.daysOfCover !== undefined && num(p.daysOfCover) < T.LOW_COVER_DAYS)
    .sort((a, b) => num(a.daysOfCover) - num(b.daysOfCover));
  return perProduct(list, {
    id: "low_stock",
    severity: "warning",
    title: (p) => `Залишку «${p.name}» вистачить на ~${Math.max(1, Math.round(num(p.daysOfCover)))} дн.`,
    text: () => "Це один із ваших ключових товарів (клас A). Замовте поставку заздалегідь.",
    summaryTitle: (n) => `${n} ключових товарів скоро закінчаться`,
    summaryText: (l) => `Залишку вистачить менш ніж на ${T.LOW_COVER_DAYS} днів: ${names(l)}.`,
    link: LINKS.inventory,
    productLink: (p) => LINKS.editProduct(p.productId),
  });
}

function ruleDeadStock(products) {
  const list = products.filter((p) => p.deadStock === true).sort((a, b) => num(b.stock) - num(a.stock));
  if (!list.length) return [];
  return [
    {
      id: "dead_stock",
      severity: "info",
      title: list.length === 1 ? `«${list[0].name}» не продається ${T.DEAD_DAYS} днів` : `${list.length} товарів без продажів ${T.DEAD_DAYS} днів`,
      text: `Є залишок, але жодного продажу за ${T.DEAD_DAYS} днів: ${names(list)}. Спробуйте знижку, кращі фото чи опис.`,
      ...(list.length === 1 ? { productId: String(list[0].productId) } : {}),
      link: LINKS.inventory,
    },
  ];
}

function ruleViewsNoCart(products, sellerMedian) {
  if (!(num(sellerMedian) > 0)) return [];
  const limit = T.VIEW_TO_CART_FACTOR * sellerMedian;
  const list = products
    .filter((p) => num(p.views) >= T.VIEWS_MIN && p.viewToCart !== null && p.viewToCart !== undefined && num(p.viewToCart) < limit)
    .sort((a, b) => num(b.views) - num(a.views));
  return perProduct(list, {
    id: "views_no_cart",
    severity: "warning",
    title: (p) => `«${p.name}» дивляться, але не додають у кошик`,
    text: (p) => `${num(p.views)} переглядів, у кошик — ${pct(p.viewToCart)} (ваша медіана ${pct(sellerMedian)}). Перевірте ціну, фото й опис.`,
    summaryTitle: (n) => `${n} товарів мають низьку конверсію в кошик`,
    summaryText: (l) => `Багато переглядів, мало додавань у кошик: ${names(l)}.`,
    link: LINKS.funnel,
    productLink: () => LINKS.funnel,
  });
}

function ruleCartNoOrder(products) {
  const list = products
    .filter((p) => num(p.carts) >= T.CARTS_MIN && p.cartToOrder !== null && p.cartToOrder !== undefined && num(p.cartToOrder) < T.CART_TO_ORDER_MAX)
    .sort((a, b) => num(b.carts) - num(a.carts));
  return perProduct(list, {
    id: "cart_no_order",
    severity: "warning",
    title: (p) => `«${p.name}» додають у кошик, але не купують`,
    text: (p) => `${num(p.carts)} додавань у кошик, замовлень — ${pct(p.cartToOrder)}. Перевірте наявність, мінімальне замовлення й умови доставки.`,
    summaryTitle: (n) => `${n} товарів часто «застрягають» у кошику`,
    summaryText: (l) => `Додають у кошик, але не замовляють: ${names(l)}.`,
    link: LINKS.funnel,
    productLink: () => LINKS.funnel,
  });
}

function ruleNegativeReviews(negative) {
  // negative: [{productId, name, count}] — відгуки ≤2★ за останні 14 днів
  const list = (negative || []).filter((x) => num(x.count) >= T.NEG_COUNT_MIN).sort((a, b) => num(b.count) - num(a.count));
  return perProduct(list, {
    id: "negative_reviews",
    severity: "critical",
    title: (p) => `Негативні відгуки на «${p.name}»`,
    text: (p) => `${num(p.count)} відгуки з оцінкою ≤${T.NEG_RATING_MAX}★ за ${T.NEG_WINDOW_DAYS} днів. Перевірте якість товару й опис.`,
    summaryTitle: (n) => `Негативні відгуки на ${n} товарів`,
    summaryText: (l) => `За ${T.NEG_WINDOW_DAYS} днів кілька оцінок ≤${T.NEG_RATING_MAX}★: ${names(l)}.`,
    link: LINKS.reviews,
    productLink: () => LINKS.reviews,
  });
}

function ruleWeakCard(products) {
  const list = products
    .filter((p) => p.qualityScore !== null && p.qualityScore !== undefined && num(p.qualityScore) < T.WEAK_QUALITY)
    .sort((a, b) => num(a.qualityScore) - num(b.qualityScore));
  return perProduct(list, {
    id: "weak_card",
    severity: "info",
    title: (p) => `Покращіть картку «${p.name}» (${Math.round(num(p.qualityScore))}/100)`,
    text: () => "Більше фото, детальний опис і характеристики підвищують конверсію.",
    summaryTitle: (n) => `${n} карток товарів варто покращити`,
    summaryText: (l) => `Індекс якості нижче ${T.WEAK_QUALITY}: ${names(l)}.`,
    link: LINKS.quality,
    productLink: (p) => LINKS.editProduct(p.productId),
  });
}

function ruleRevenue({ revenue, orders } = {}) {
  if (!revenue || !orders) return [];
  const prevOrders = num(orders.prev);
  if (prevOrders < T.REVENUE_MIN_ORDERS || !(num(revenue.prev) > 0)) return [];
  const d = ((num(revenue.value) - num(revenue.prev)) / num(revenue.prev)) * 100;
  if (d <= T.REVENUE_DROP_PCT) {
    return [
      {
        id: "revenue_drop",
        severity: "critical",
        title: `Виручка впала на ${Math.abs(Math.round(d))}%`,
        text: "Порівняно з попереднім періодом. Перевірте залишки топ-товарів, ціни й відгуки.",
        link: LINKS.sales,
      },
    ];
  }
  if (d >= T.REVENUE_GROWTH_PCT) {
    return [
      {
        id: "revenue_growth",
        severity: "success",
        title: `Виручка зросла на ${Math.round(d)}%`,
        text: "Чудовий результат порівняно з попереднім періодом. Переконайтеся, що залишків вистачить.",
        link: LINKS.sales,
      },
    ];
  }
  return [];
}

function ruleLateShipping(fulfillment) {
  if (!fulfillment) return [];
  const base = num(fulfillment.shippedCount) + num(fulfillment.overdueCount);
  if (base < T.LATE_MIN_SHIPPED || fulfillment.lateRate === null || fulfillment.lateRate === undefined) return [];
  if (num(fulfillment.lateRate) <= T.LATE_RATE_MAX) return [];
  return [
    {
      id: "late_shipping",
      severity: "warning",
      title: `Затримки відправлення: ${pct(fulfillment.lateRate)}`,
      text: `Частка замовлень, відправлених пізніше ${fulfillment.slaHours || 48} год, перевищує ${Math.round(T.LATE_RATE_MAX * 100)}%.`,
      link: LINKS.fulfillment,
    },
  ];
}

function rulePendingOld(count) {
  const n = num(count);
  if (n <= 0) return [];
  return [
    {
      id: "pending_orders_old",
      severity: "critical",
      title: n === 1 ? "1 замовлення чекає понад 48 год" : `${n} замовлень чекають понад 48 год`,
      text: "Підтвердьте або відправте їх — покупці чекають.",
      link: LINKS.orders,
    },
  ];
}

// ctx: {
//   hasProducts, hasOrders,
//   products: [{productId,name,stock,abc,daysOfCover,units90,revenue,deadStock,views,carts,viewToCart,cartToOrder,qualityScore}],
//   negativeReviews: [{productId,name,count}],
//   kpi: { revenue:{value,prev}, orders:{value,prev} },
//   fulfillment: { lateRate, shippedCount, overdueCount, slaHours },
//   pendingOld: number
// }
function buildInsights(ctx = {}) {
  if (ctx.hasProducts === false) {
    return [
      {
        id: "no_products",
        severity: "info",
        title: "Додайте перший товар",
        text: "Після публікації товарів тут з'являться продажі, залишки й поради.",
        link: LINKS.addProduct,
      },
    ];
  }
  const products = Array.isArray(ctx.products) ? ctx.products : [];
  const out = [];
  if (ctx.hasOrders === false) {
    out.push({
      id: "no_orders_yet",
      severity: "info",
      title: "Поки що немає замовлень",
      text: "Перевірте, що товари мають фото, опис і залишок — це допомагає отримати перші продажі.",
      link: LINKS.products_list,
    });
  }
  const medianV2C = median(products.map((p) => p.viewToCart).filter((v) => v !== null && v !== undefined));
  out.push(
    ...rulePendingOld(ctx.pendingOld),
    ...ruleRevenue(ctx.kpi),
    ...ruleOutOfStock(products),
    ...ruleNegativeReviews(ctx.negativeReviews),
    ...ruleLowStock(products),
    ...ruleLateShipping(ctx.fulfillment),
    ...ruleViewsNoCart(products, medianV2C),
    ...ruleCartNoOrder(products),
    ...ruleWeakCard(products),
    ...ruleDeadStock(products)
  );
  // стабільне сортування за серйозністю (порядок правил усередині рівня зберігається)
  return out
    .map((x, i) => ({ x, i }))
    .sort((a, b) => SEVERITY_RANK[a.x.severity] - SEVERITY_RANK[b.x.severity] || a.i - b.i)
    .map((e) => e.x)
    .slice(0, T.MAX_TOTAL);
}

module.exports = {
  THRESHOLDS: T,
  SEVERITY_RANK,
  LINKS,
  median,
  ruleOutOfStock,
  ruleLowStock,
  ruleDeadStock,
  ruleViewsNoCart,
  ruleCartNoOrder,
  ruleNegativeReviews,
  ruleWeakCard,
  ruleRevenue,
  ruleLateShipping,
  rulePendingOld,
  buildInsights,
};
