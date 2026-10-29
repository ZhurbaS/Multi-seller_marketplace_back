// Єдине місце, де рахуються ціни, знижки й перевіряється кількість.
// Чисті функції без доступу до БД — легко тестуються. УСІ суми, що йдуть
// у замовлення й оплату, рахуються тут, на сервері (клієнту не довіряємо).

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Ціна за 1 шт після знижки самого товару (як і раніше).
function baseUnitPrice(p) {
  const price = num(p.price);
  return price - Math.floor((price * num(p.discount)) / 100);
}

// Найбільша знижка за кількість, що підходить під qty.
function tierPercent(tiers, qty) {
  let best = 0;
  for (const t of tiers || []) {
    if (qty >= t.minQty && t.percent > best) best = t.percent;
  }
  return best;
}

// Остаточна ціна за 1 шт при замовленні qty шт.
function unitPrice(p, qty) {
  const base = baseUnitPrice(p);
  const pct = tierPercent(p.priceTiers, qty);
  return base - Math.floor((base * pct) / 100);
}

// Перевірка кількості на мінімум і кратність. Повертає текст помилки або null.
function validateQuantity(p, qty) {
  const min = Math.max(1, num(p.minOrderQty, 1));
  const step = Math.max(1, num(p.orderStep, 1));
  if (!Number.isInteger(qty) || qty < 1) return "Некоректна кількість товару";
  if (qty < min) return `Мінімальне замовлення — ${min} шт`;
  if ((qty - min) % step !== 0) {
    return `Кількість має бути кратною ${step} (від ${min} шт)`;
  }
  return null;
}

// Чи можна замовити qty шт: { ok, preorder, error }.
function availability(p, qty) {
  const invalid = validateQuantity(p, qty);
  if (invalid) return { ok: false, preorder: false, error: invalid };
  const stock = num(p.stock);
  if (stock > 0) {
    return qty <= stock
      ? { ok: true, preorder: false, error: null }
      : { ok: false, preorder: false, error: `Доступно лише ${stock} шт на складі` };
  }
  if (p.allowPreorder) return { ok: true, preorder: true, error: null };
  return { ok: false, preorder: false, error: "Товару немає в наявності" };
}

// Найближча допустима кількість (для автокорекції кошика, якщо продавець змінив умови).
function nearestValidQuantity(p, qty) {
  const min = Math.max(1, num(p.minOrderQty, 1));
  const step = Math.max(1, num(p.orderStep, 1));
  if (qty <= min) return min;
  return min + Math.ceil((qty - min) / step) * step;
}

// Знижка за сумою замовлення (налаштовується адміном для всього магазину).
// tiers: [{minTotal, percent}]. Повертає { percent, amount }.
function orderDiscount(tiers, subtotal) {
  let percent = 0;
  for (const t of tiers || []) {
    if (subtotal >= t.minTotal && t.percent > percent) percent = t.percent;
  }
  return { percent, amount: Math.floor((subtotal * percent) / 100) };
}

// Підказка «додайте ще на ₴X — отримайте -Y%»; null, якщо вищого порога немає.
function nextOrderDiscount(tiers, subtotal) {
  const higher = (tiers || [])
    .filter((t) => t.minTotal > subtotal)
    .sort((a, b) => a.minTotal - b.minTotal)[0];
  return higher
    ? { minTotal: higher.minTotal, percent: higher.percent, remaining: higher.minTotal - subtotal }
    : null;
}

// ----- Комісія магазину -----

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const isPercent = (v) => typeof v === "number" && Number.isFinite(v);

// Ставка: індивідуальна ставка продавця (навіть 0 — власний магазин) → ставка категорії → типова.
function resolveCommissionPercent({ sellerPercent, categoryPercent, defaultPercent }) {
  if (isPercent(sellerPercent)) return sellerPercent;
  if (isPercent(categoryPercent)) return categoryPercent;
  return isPercent(defaultPercent) ? defaultPercent : 0;
}

// Комісія з суми товару (після знижок продавця). Знижку, яку фінансує магазин
// (за сумою замовлення, купони), у базу комісії не входить.
function commissionAmount(lineTotal, percent) {
  return round2((num(lineTotal) * num(percent)) / 100);
}

// Ціна для покупця, при якій продавець отримає net після комісії: net / (1 − c).
// Це НЕ net × (1 + c): так магазин недоотримав би частину комісії.
function grossUpPrice(net, percent) {
  const c = num(percent) / 100;
  if (c >= 1) return NaN;
  return Math.ceil(num(net) / (1 - c));
}

// Валідація налаштувань комісії від адміна → { value } або { error }
function sanitizeCommissionSettings(body) {
  const pct = (v, label) => {
    const n = Number(v);
    if (v === "" || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > 50) {
      return { error: `${label}: відсоток має бути від 0 до 50` };
    }
    return { value: n };
  };
  const def = pct(body?.defaultCommissionPercent, "Типова комісія");
  if (def.error) return def;
  const hold = Number(body?.payoutHoldDays);
  if (!Number.isInteger(hold) || hold < 0 || hold > 90) {
    return { error: "Утримання виплат: ціле число днів від 0 до 90" };
  }
  const cats = [];
  const seen = new Set();
  for (const c of body?.categoryCommissions || []) {
    if (c?.percent === "" || c?.percent === null || c?.percent === undefined) continue; // порожньо = типова
    const p = pct(c.percent, "Комісія категорії");
    if (p.error) return p;
    if (!/^[a-f\d]{24}$/i.test(String(c.categoryId))) return { error: "Некоректна категорія" };
    if (seen.has(String(c.categoryId))) return { error: "Категорія вказана двічі" };
    seen.add(String(c.categoryId));
    cats.push({ categoryId: c.categoryId, percent: p.value });
  }
  return {
    value: { defaultCommissionPercent: def.value, payoutHoldDays: hold, categoryCommissions: cats },
  };
}

// ----- Валідація даних від продавця/адміна -----

// priceTiers від продавця → очищений масив або { error }
function sanitizePriceTiers(input) {
  if (input === undefined || input === null || input === "") return { value: [] };
  if (!Array.isArray(input)) return { error: "Некоректний формат знижок за кількість" };
  const out = [];
  for (const t of input) {
    const minQty = Number(t?.minQty);
    const percent = Number(t?.percent);
    if (t?.minQty === "" && t?.percent === "") continue; // порожній рядок форми
    if (!Number.isInteger(minQty) || minQty < 2) {
      return { error: "Знижка за кількість: «від, шт» має бути цілим числом від 2" };
    }
    if (!Number.isFinite(percent) || percent < 1 || percent > 90) {
      return { error: "Знижка за кількість: відсоток має бути від 1 до 90" };
    }
    out.push({ minQty, percent });
  }
  out.sort((a, b) => a.minQty - b.minQty);
  for (let i = 1; i < out.length; i++) {
    if (out[i].minQty === out[i - 1].minQty) {
      return { error: "Знижка за кількість: однакові пороги «від, шт»" };
    }
    if (out[i].percent <= out[i - 1].percent) {
      return { error: "Знижка за кількість: відсоток має зростати разом з кількістю" };
    }
  }
  return { value: out };
}

// Пороги знижки за сумою → очищений масив або { error }
function sanitizeOrderTiers(input) {
  if (!Array.isArray(input)) return { error: "Некоректний формат знижок" };
  const out = [];
  for (const t of input) {
    if (t?.minTotal === "" && t?.percent === "") continue;
    const minTotal = Number(t?.minTotal);
    const percent = Number(t?.percent);
    if (!Number.isFinite(minTotal) || minTotal <= 0) {
      return { error: "Сума замовлення для знижки має бути більшою за 0" };
    }
    if (!Number.isFinite(percent) || percent < 1 || percent > 50) {
      return { error: "Відсоток знижки за сумою має бути від 1 до 50" };
    }
    out.push({ minTotal: Math.round(minTotal), percent });
  }
  out.sort((a, b) => a.minTotal - b.minTotal);
  for (let i = 1; i < out.length; i++) {
    if (out[i].minTotal === out[i - 1].minTotal) {
      return { error: "Однакові порогові суми" };
    }
    if (out[i].percent <= out[i - 1].percent) {
      return { error: "Відсоток має зростати разом із сумою" };
    }
  }
  return { value: out };
}

// Мінімум/крок/терміни з форми продавця → { value } або { error }
function sanitizeSaleRules(src) {
  const toInt = (v, d) => (v === undefined || v === "" || v === null ? d : Number(v));
  const minOrderQty = toInt(src.minOrderQty, 1);
  const orderStep = toInt(src.orderStep, 1);
  if (!Number.isInteger(minOrderQty) || minOrderQty < 1) {
    return { error: "Мінімальне замовлення має бути цілим числом від 1" };
  }
  if (!Number.isInteger(orderStep) || orderStep < 1) {
    return { error: "Крок кратності має бути цілим числом від 1" };
  }
  const dMin = src.restockDaysMin === "" || src.restockDaysMin == null ? null : Number(src.restockDaysMin);
  const dMax = src.restockDaysMax === "" || src.restockDaysMax == null ? null : Number(src.restockDaysMax);
  for (const d of [dMin, dMax]) {
    if (d !== null && (!Number.isInteger(d) || d < 1 || d > 365)) {
      return { error: "Термін поставки — ціле число днів від 1 до 365" };
    }
  }
  if (dMin !== null && dMax !== null && dMax < dMin) {
    return { error: "Термін поставки: «до» не може бути меншим за «від»" };
  }
  const allowPreorder = src.allowPreorder === true || src.allowPreorder === "true";
  const tiers = sanitizePriceTiers(
    typeof src.priceTiers === "string" && src.priceTiers
      ? safeJson(src.priceTiers)
      : src.priceTiers
  );
  if (tiers.error) return { error: tiers.error };
  const lastMin = tiers.value.at(-1)?.minQty;
  return {
    value: {
      minOrderQty,
      orderStep,
      packLabel: String(src.packLabel || "").trim().slice(0, 60),
      priceTiers: tiers.value,
      restockDaysMin: dMin,
      restockDaysMax: dMax,
      allowPreorder,
    },
    lastMin,
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return "__invalid__";
  }
}

module.exports = {
  baseUnitPrice,
  tierPercent,
  unitPrice,
  validateQuantity,
  availability,
  nearestValidQuantity,
  orderDiscount,
  nextOrderDiscount,
  round2,
  resolveCommissionPercent,
  commissionAmount,
  grossUpPrice,
  sanitizeCommissionSettings,
  sanitizePriceTiers,
  sanitizeOrderTiers,
  sanitizeSaleRules,
};
