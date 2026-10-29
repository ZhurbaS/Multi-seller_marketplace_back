// Політика повернень: типові значення, перевірка налаштувань адміна і визначення,
// чи можна повернути конкретне замовлення. Чисті функції без доступу до БД.
//
// Усе налаштовується адміном (Дашборд → «Повернення» → «Умови повернення»).
// Типові значення відповідають Закону «Про захист прав споживачів» для фізичних осіб
// (відмова від договору на відстані — 14 днів, зворотну доставку оплачує продавець)
// і більш обмеженим умовам для юридичних осіб (споживче право на них не поширюється).

const DEFAULT_POLICY_TEXT = [
  "Фізичні особи можуть відмовитися від товару, придбаного дистанційно, протягом 14 днів після отримання (крім товарів, що виготовлені на замовлення, та інших випадків, передбачених законом). Товар має бути в незміненому стані; огляд і перевірка товару не позбавляють права на повернення.",
  "У разі браку або невідповідності товару замовленню повернення можливе протягом строку, вказаного в умовах нижче; зворотну доставку оплачує продавець.",
  "Кошти повертаються тим самим способом, яким було здійснено оплату, не пізніше ніж протягом 30 днів з моменту звернення.",
  "Для юридичних осіб діють умови, зазначені в договорі та в розділі «Умови повернення для юридичних осіб» цієї сторінки.",
].join("\n\n");

const PAYERS = ["seller", "store", "customer"];

function defaultPolicy() {
  return {
    // Приймаємо нові заявки й показуємо кнопки «Повернути» в кабінеті покупця
    enabled: true,
    // Показувати покупцеві розділ «Мої повернення» та його заявки в кабінеті
    cabinetVisible: true,
    refundDeadlineDays: 30,
    returnAddress: "",
    contactInfo: "",
    policyText: DEFAULT_POLICY_TEXT,
    // Назви категорій, для яких відмова від договору («передумав») не пропонується
    nonReturnableCategories: [],
    individual: {
      withdrawalAllowed: true,
      withdrawalDays: 14,
      defectAllowed: true,
      defectDays: 365,
      shippingPayerWithdrawal: "seller",
      shippingPayerDefect: "seller",
    },
    company: {
      withdrawalAllowed: false,
      withdrawalDays: 0,
      defectAllowed: true,
      defectDays: 14,
      shippingPayerWithdrawal: "customer",
      shippingPayerDefect: "seller",
    },
  };
}

const bool = (v, d) => (typeof v === "boolean" ? v : d);
const int = (v, d, min, max) => {
  const n = Number(v);
  if (v === "" || v === null || v === undefined || !Number.isInteger(n)) return d;
  return Math.min(max, Math.max(min, n));
};
const payer = (v, d) => (PAYERS.includes(v) ? v : d);

function mergeBuyer(src, def) {
  const s = src || {};
  return {
    withdrawalAllowed: bool(s.withdrawalAllowed, def.withdrawalAllowed),
    withdrawalDays: int(s.withdrawalDays, def.withdrawalDays, 0, 365),
    defectAllowed: bool(s.defectAllowed, def.defectAllowed),
    defectDays: int(s.defectDays, def.defectDays, 0, 3650),
    shippingPayerWithdrawal: payer(s.shippingPayerWithdrawal, def.shippingPayerWithdrawal),
    shippingPayerDefect: payer(s.shippingPayerDefect, def.shippingPayerDefect),
  };
}

// Зберігає лише відомі поля й підставляє типові значення для відсутніх.
function normalizePolicy(raw) {
  const def = defaultPolicy();
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: bool(s.enabled, def.enabled),
    cabinetVisible: bool(s.cabinetVisible, def.cabinetVisible),
    refundDeadlineDays: int(s.refundDeadlineDays, def.refundDeadlineDays, 1, 90),
    returnAddress: String(s.returnAddress ?? def.returnAddress).slice(0, 500),
    contactInfo: String(s.contactInfo ?? def.contactInfo).slice(0, 500),
    policyText: String(s.policyText ?? def.policyText).slice(0, 10000),
    nonReturnableCategories: Array.isArray(s.nonReturnableCategories)
      ? [...new Set(s.nonReturnableCategories.map((c) => String(c).trim()).filter(Boolean))].slice(0, 200)
      : def.nonReturnableCategories,
    individual: mergeBuyer(s.individual, def.individual),
    company: mergeBuyer(s.company, def.company),
  };
}

// Валідація від адміна: на відміну від normalize, помилки не «ховаємо» — повертаємо повідомлення.
// → { value } | { error }
function sanitizePolicy(body) {
  if (!body || typeof body !== "object") return { error: "Некоректні налаштування" };
  for (const kind of ["individual", "company"]) {
    const b = body[kind] || {};
    for (const f of ["withdrawalDays", "defectDays"]) {
      if (b[f] !== undefined && b[f] !== "" && !Number.isInteger(Number(b[f]))) {
        return { error: "Строки повернення — цілі числа днів" };
      }
      if (b[f] !== undefined && Number(b[f]) < 0) {
        return { error: "Строки повернення не можуть бути від'ємними" };
      }
    }
    for (const f of ["shippingPayerWithdrawal", "shippingPayerDefect"]) {
      if (b[f] !== undefined && !PAYERS.includes(b[f])) {
        return { error: "Некоректний платник зворотної доставки" };
      }
    }
  }
  if (
    body.refundDeadlineDays !== undefined &&
    (!Number.isInteger(Number(body.refundDeadlineDays)) ||
      Number(body.refundDeadlineDays) < 1 ||
      Number(body.refundDeadlineDays) > 90)
  ) {
    return { error: "Строк повернення коштів: від 1 до 90 днів" };
  }
  return { value: normalizePolicy(body) };
}

// Попередження для адміна про потенційні розбіжності із законодавством (не блокують збереження).
function policyWarnings(policy) {
  const w = [];
  const i = policy.individual;
  if (!i.withdrawalAllowed || i.withdrawalDays < 14) {
    w.push(
      "Для фізичних осіб право відмовитися від товару, придбаного дистанційно, — 14 днів після отримання (ст. 13 Закону «Про захист прав споживачів»). Менший строк або заборона можуть суперечити закону."
    );
  }
  if (i.shippingPayerWithdrawal !== "seller" && i.shippingPayerWithdrawal !== "store") {
    w.push(
      "Для фізичних осіб витрати на зворотну доставку при відмові від договору за законом несе продавець (ст. 12 ч. 5, застосовується через ст. 13 ч. 7)."
    );
  }
  if (policy.refundDeadlineDays > 30) {
    w.push("За законом кошти мають бути повернені не пізніше 30 днів з моменту повідомлення про відмову від договору.");
  }
  return w;
}

const PRE_SHIPMENT = ["pending", "placed", "processing", "packing"];

// Чи можна скасувати / повернути замовлення. returnedQty — { productId: скільки вже в активних заявках }.
// Повертає { enabled, message, canCancel, canReturn, reasons[], items[] }.
function checkEligibility({ order, policy, now = new Date(), returnedQty = {}, hasActiveCancellation = false }) {
  const pol = normalizePolicy(policy);
  const override = order.returnOverride || "default";
  const allow = override === "allow";
  const out = {
    enabled: true,
    message: "",
    canCancel: false,
    canReturn: false,
    reasons: [],
    items: [],
  };

  if (override === "deny" || (!pol.enabled && !allow)) {
    return { ...out, enabled: false, message: "Оформити повернення онлайн зараз неможливо. Зверніться до підтримки магазину." };
  }
  const status = order.delivery_status;
  if (status === "cancelled") {
    return { ...out, message: "Замовлення скасовано." };
  }

  // До відправки: можна скасувати замовлення
  if (PRE_SHIPMENT.includes(status) && order.refund_status !== "full") {
    out.canCancel = !hasActiveCancellation;
    if (hasActiveCancellation) out.message = "Заявка на скасування вже подана.";
    return out;
  }

  if (status !== "delivered") {
    out.message = "Повернення стане доступним після отримання замовлення.";
    return out;
  }

  const cfg = pol[order.buyer?.kind === "company" ? "company" : "individual"];
  const deliveredAt = new Date(order.deliveredAt || order.updatedAt || now);
  const elapsedMs = now.getTime() - deliveredAt.getTime();
  const within = (days) => allow || elapsedMs <= days * 24 * 60 * 60 * 1000;
  const until = (days) => new Date(deliveredAt.getTime() + days * 24 * 60 * 60 * 1000);

  const wOk = (allow || cfg.withdrawalAllowed) && within(cfg.withdrawalDays);
  const dOk = (allow || cfg.defectAllowed) && within(cfg.defectDays);
  out.reasons = [
    { reason: "withdrawal", allowed: wOk, until: allow ? null : until(cfg.withdrawalDays) },
    { reason: "defect", allowed: dOk, until: allow ? null : until(cfg.defectDays) },
    { reason: "wrong_item", allowed: dOk, until: allow ? null : until(cfg.defectDays) },
  ];

  const blocked = new Set(pol.nonReturnableCategories);
  out.items = (order.products || []).map((p) => {
    const id = String(p._id);
    const ordered = Number(p.quantity) || 0;
    const left = Math.max(0, ordered - (Number(returnedQty[id]) || 0));
    return {
      productId: id,
      name: p.name,
      image: p.images?.[0] || "",
      orderedQuantity: ordered,
      availableQuantity: left,
      unitPrice: p.unitPrice ?? p.price,
      withdrawalBlocked: !!p.category && blocked.has(p.category),
    };
  });

  const anyLeft = out.items.some((i) => i.availableQuantity > 0);
  out.canReturn = anyLeft && out.reasons.some((r) => r.allowed);
  if (!out.canReturn) {
    out.message = anyLeft
      ? "Строк повернення для цього замовлення минув. Зверніться до підтримки."
      : "Усі товари цього замовлення вже в заявках на повернення.";
  }
  return out;
}

// Хто платить за зворотну доставку за замовчуванням (залежно від типу покупця й причини)
function defaultShippingPayer(policy, buyerKind, reason) {
  const pol = normalizePolicy(policy);
  const cfg = pol[buyerKind === "company" ? "company" : "individual"];
  return reason === "withdrawal" || reason === "refused"
    ? cfg.shippingPayerWithdrawal
    : cfg.shippingPayerDefect;
}

module.exports = {
  PRE_SHIPMENT,
  DEFAULT_POLICY_TEXT,
  defaultPolicy,
  normalizePolicy,
  sanitizePolicy,
  policyWarnings,
  checkEligibility,
  defaultShippingPayer,
};
