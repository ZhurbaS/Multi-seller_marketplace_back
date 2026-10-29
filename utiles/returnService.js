// Заявки на повернення й скасування: створення, рішення адміна, повернення коштів, листи.
//
// Принципи:
//  - усі переходи статусів атомарні (findOneAndUpdate зі списком дозволених попередніх статусів),
//    тому подвійний клік/повторний запит нічого не зламає;
//  - суми повернення рахує сервер (returnMath), клієнту й адміну довіряємо лише утримання/вартість доставки;
//  - повернення коштів ідемпотентне (стабільний extRef), загальна сума повернень не може
//    перевищити оплаченого (атомарна перевірка на замовленні);
//  - записи в журнал виплат (ledger) робляться рівно один раз — після успішного повернення.

const ReturnRequest = require("../models/returnRequestModel");
const customerOrderModel = require("../models/customerOrderModel");
const authorOrderModel = require("../models/authorOrderModel");
const customerModel = require("../models/customerModel");
const productModel = require("../models/productModel");
const ledger = require("./ledger");
const paymentService = require("../payments/paymentService");
const policyLib = require("./returnPolicy");
const math = require("./returnMath");
const mailer = require("./mailer");
const orderLifecycle = require("./orderLifecycle");
const { publicFrontUrl } = require("../payments/config");

class ReturnError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const OPEN_STATUSES = ["requested", "approved", "shipped", "received", "refund_pending"];
const NOT_COUNTED = ["rejected", "cancelled"]; // такі заявки не «займають» товари
const CUSTOMER_REASONS = ["withdrawal", "defect", "wrong_item"];
const DAY = 24 * 60 * 60 * 1000;

const ev = (by, action, note = "") => ({ at: new Date(), by, action, note });
const toMoney = (v, label) => {
  if (v === "" || v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new ReturnError(`${label}: некоректна сума`);
  return math.round2(n);
};
const shortId = (id) => String(id).slice(-6).toUpperCase();

async function loadPolicy() {
  // require тут, щоб не створювати цикл залежностей
  const { loadSettings } = require("../controllers/settingsController");
  return policyLib.normalizePolicy((await loadSettings()).returns);
}

// ---------------------------------------------------------------------------
// Допоміжні вибірки й розрахунки
// ---------------------------------------------------------------------------

// Скільки одиниць кожного товару вже «зайнято»: заявками на повернення/скасування
// і підзамовленнями, які скасував продавець (їх товар покупцю не передавався).
async function activeQuantities(orderId) {
  const list = await ReturnRequest.find({
    orderId,
    status: { $nin: NOT_COUNTED },
  });
  const out = {};
  for (const r of list) {
    for (const it of r.items) {
      const k = String(it.productId);
      out[k] = (out[k] || 0) + (it.quantity || 0);
    }
  }
  // Скасовані підзамовлення, за які ще немає заявки на скасування (напр. не оплачені)
  const cancelledAuth = await authorOrderModel.find({ orderId, delivery_status: "cancelled" });
  const covered = new Set(
    list.filter((r) => r.kind === "cancellation").flatMap((r) => r.items.map((i) => String(i.productId)))
  );
  for (const ao of cancelledAuth) {
    for (const p of ao.products || []) {
      const k = String(p._id);
      if (!covered.has(k)) out[k] = (out[k] || 0) + (p.quantity || 0);
    }
  }
  return out;
}

// Захист від гонки: дві одночасні заявки не мають «забрати» одні й ті самі одиниці товару.
// Якщо після збереження кількість перевищено, а раніше створена заявка існує — ця скасовується.
async function guardOversubscription(rr, order) {
  const list = await ReturnRequest.find({ orderId: order._id, status: { $nin: NOT_COUNTED } });
  const sum = {};
  for (const r of list) for (const it of r.items) sum[String(it.productId)] = (sum[String(it.productId)] || 0) + it.quantity;
  const ordered = new Map((order.products || []).map((p) => [String(p._id), p.quantity]));
  const over = Object.keys(sum).some((k) => sum[k] > (ordered.get(k) || 0));
  if (!over) return;
  const older = list.some((r) => String(r._id) < String(rr._id));
  if (older) {
    await ReturnRequest.deleteOne({ _id: rr._id });
    throw new ReturnError("На ці товари вже подано заявку. Оновіть сторінку й спробуйте ще раз", 409);
  }
}

// Скільки вже повернено/повертається коштів за замовленням (без урахування заявки excludeId)
async function committedFor(orderId, excludeId) {
  const filter = { orderId, "refund.status": { $in: ["processing", "success"] } };
  if (excludeId) filter._id = { $ne: excludeId };
  const list = await ReturnRequest.find(filter);
  return list.reduce(
    (acc, r) => ({
      refunded: acc.refunded + (r.refund?.goodsAmount || 0),
      goods: acc.goods + (r.itemsValue || 0),
    }),
    { refunded: 0, goods: 0 }
  );
}

function unitPriceOf(p) {
  return p.unitPrice ?? p.price - Math.floor((p.price * (p.discount || 0)) / 100);
}

// Позиції заявки з частками комісії. selection: [{ productId, quantity }]
function buildItems(order, authOrders, selection) {
  const byProduct = new Map((order.products || []).map((p) => [String(p._id), p]));
  const authByProduct = new Map();
  for (const ao of authOrders) {
    for (const p of ao.products || []) authByProduct.set(String(p._id), ao);
  }
  return selection.map((sel) => {
    const p = byProduct.get(String(sel.productId));
    if (!p) throw new ReturnError("Товару немає в цьому замовленні");
    const ao = authByProduct.get(String(p._id));
    const unit = unitPriceOf(p);
    const qty = sel.quantity;
    return {
      productId: p._id,
      name: p.name,
      image: p.images?.[0] || "",
      quantity: qty,
      orderedQuantity: p.quantity,
      unitPrice: unit,
      value: math.round2(unit * qty),
      sellerId: ao?.sellerId || p.sellerId,
      authOrderId: ao?._id,
      commissionPercent: typeof p.commissionPercent === "number" ? p.commissionPercent : null,
      commission: math.commissionShare(p.commission, p.quantity, qty),
    };
  });
}

const sumItems = (items) => math.round2(items.reduce((s, i) => s + i.value, 0));

// ---------------------------------------------------------------------------
// Листи
// ---------------------------------------------------------------------------
async function customerContact(customerId) {
  const c = await customerModel.findById(customerId).select("email name").lean();
  return c || {};
}

function orderLabel(order) {
  return `№${String(order._id).slice(-8).toUpperCase()}`;
}

const TEXTS = {
  created: (rr, ctx) => ({
    subject: `Заявку ${rr.number} прийнято`,
    text: `Ми отримали вашу заявку ${rr.number} щодо замовлення ${ctx.label}. Розглянемо її найближчим часом і повідомимо про рішення.\n\nСтатус заявки можна переглянути в особистому кабінеті: ${publicFrontUrl()}/dashboard/returns`,
  }),
  approved: (rr, ctx) => ({
    subject: `Заявку ${rr.number} схвалено`,
    text:
      `Заявку ${rr.number} щодо замовлення ${ctx.label} схвалено.\n\n` +
      (rr.kind === "return"
        ? `Надішліть товар за адресою:\n${ctx.policy.returnAddress || "(адресу уточніть у підтримки)"}\n` +
          `Після відправлення вкажіть номер накладної в особистому кабінеті: ${publicFrontUrl()}/dashboard/returns\n` +
          `Товар має бути в незміненому стані та в комплекті.\n`
        : "") +
      (rr.decision?.note ? `\nКоментар магазину: ${rr.decision.note}\n` : ""),
  }),
  rejected: (rr, ctx) => ({
    subject: `Заявку ${rr.number} відхилено`,
    text: `На жаль, заявку ${rr.number} щодо замовлення ${ctx.label} відхилено.\nПричина: ${rr.decision?.rejectReason || "не вказана"}.\n${
      ctx.policy.contactInfo ? `Контакти: ${ctx.policy.contactInfo}\n` : ""
    }`,
  }),
  received: (rr, ctx) => ({
    subject: `Товар за заявкою ${rr.number} отримано`,
    text: `Ми отримали повернутий товар за заявкою ${rr.number}. Перевіряємо його й найближчим часом приймемо рішення.`,
  }),
  refunded: (rr, ctx) => ({
    subject: `Кошти за заявкою ${rr.number} повернено`,
    text:
      `Повернення за заявкою ${rr.number} (замовлення ${ctx.label}) виконано: ₴${rr.refund.amount}.\n` +
      (rr.refund.provider === "manual"
        ? "Кошти надіслано переказом; якщо вони ще не надійшли — зверніться до підтримки.\n"
        : "Кошти повернено на картку, з якої здійснювалась оплата. Зарахування банком може тривати до кількох робочих днів.\n") +
      (rr.refund.deduction > 0
        ? `\nУтримано ₴${rr.refund.deduction}: ${rr.refund.deductionReason || "—"}.\n`
        : "") +
      (rr.refund.shippingPayer === "customer" && rr.refund.shippingCost > 0
        ? `\nВитрати на зворотну доставку ₴${rr.refund.shippingCost} утримано із суми повернення.\n`
        : ""),
  }),
  cancelled_refund: (rr, ctx) => ({
    subject: `Замовлення ${ctx.label} скасовано`,
    text: `Замовлення ${ctx.label} скасовано. Кошти ₴${rr.refund.amount} буде повернено тим самим способом, яким здійснювалась оплата.`,
  }),
  exchanged: (rr, ctx) => ({
    subject: `Обмін за заявкою ${rr.number}`,
    text: `Заявку ${rr.number} опрацьовано як обмін товару. Подробиці уточнить менеджер${rr.decision?.note ? `.\nКоментар: ${rr.decision.note}` : "."}`,
  }),
};

async function notifyCustomer(event, rr) {
  try {
    const [policy, order, customer] = await Promise.all([
      loadPolicy(),
      customerOrderModel.findById(rr.orderId).select("_id").lean(),
      customerContact(rr.customerId),
    ]);
    if (!customer.email || !order) return;
    const { subject, text } = TEXTS[event](rr, { policy, label: orderLabel(order) });
    await mailer.sendMail({ to: customer.email, subject, text });
  } catch (e) {
    console.error("📧 notifyCustomer:", e.message);
  }
}

async function notifyAdmin(subject, text) {
  if (!process.env.ADMIN_EMAIL) return;
  try {
    await mailer.sendMail({ to: process.env.ADMIN_EMAIL, subject, text });
  } catch (e) {
    console.error("📧 notifyAdmin:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Створення заявок
// ---------------------------------------------------------------------------

async function eligibilityFor(order) {
  const [policy, returnedQty, activeCancel] = await Promise.all([
    loadPolicy(),
    activeQuantities(order._id),
    ReturnRequest.exists({
      orderId: order._id,
      kind: "cancellation",
      status: { $in: ["requested", "approved", "refund_pending"] },
    }),
  ]);
  return {
    policy,
    eligibility: policyLib.checkEligibility({
      order,
      policy,
      returnedQty,
      hasActiveCancellation: !!activeCancel,
    }),
  };
}

async function newRequestDoc(order, fields, policy) {
  const rr = new ReturnRequest({
    orderId: order._id,
    customerId: order.customerId,
    buyerKind: order.buyer?.kind === "company" ? "company" : "individual",
    refundDueAt: new Date(Date.now() + policy.refundDeadlineDays * DAY),
    ...fields,
  });
  rr.number = `R-${shortId(rr._id)}`;
  rr.itemsValue = sumItems(rr.items);
  return rr;
}

// Покупець подає заявку. input: { reason, items:[{productId, quantity}], comment, resolution }
async function createByCustomer(order, input) {
  const { policy, eligibility } = await eligibilityFor(order);
  if (!eligibility.enabled) throw new ReturnError(eligibility.message, 403);

  const reason = String(input.reason || "");
  const comment = String(input.comment || "").trim().slice(0, 2000);
  const authOrders = await authorOrderModel.find({ orderId: order._id });

  // --- скасування до відправки ---
  if (reason === "cancel_unshipped") {
    if (!eligibility.canCancel) {
      throw new ReturnError(eligibility.message || "Замовлення вже не можна скасувати");
    }
    const blocker = await orderLifecycle.cancelBlocker(order._id);
    if (blocker) throw new ReturnError(blocker, 409);
    // Позиції, які вже скасовано (напр. продавець скасував свою частину) чи включено в інші заявки, не беремо
    const used = await activeQuantities(order._id);
    const selection = (order.products || [])
      .map((p) => ({ productId: p._id, quantity: p.quantity - (used[String(p._id)] || 0) }))
      .filter((x) => x.quantity > 0);
    if (selection.length === 0) throw new ReturnError("Нічого скасовувати — усі товари вже в заявках або скасовані", 409);
    const items = buildItems(order, authOrders, selection);
    const rr = await newRequestDoc(
      order,
      {
        kind: "cancellation",
        reason,
        resolution: "refund",
        comment,
        createdBy: "customer",
        items,
        timeline: [ev("customer", "Заявку на скасування подано", comment)],
      },
      policy
    );
    await rr.save();
    notifyCustomer("created", rr);
    notifyAdmin(
      `Нова заявка на скасування ${rr.number}`,
      `Покупець просить скасувати замовлення ${orderLabel(order)}. Відкрийте дашборд → Повернення.`
    );
    return rr;
  }

  // --- повернення товару ---
  if (!CUSTOMER_REASONS.includes(reason)) throw new ReturnError("Оберіть причину повернення");
  if (!eligibility.canReturn) {
    throw new ReturnError(eligibility.message || "Повернення для цього замовлення недоступне");
  }
  const rule = eligibility.reasons.find((r) => r.reason === reason);
  if (!rule || !rule.allowed) {
    throw new ReturnError(
      reason === "withdrawal"
        ? "Відмова від товару за бажанням покупця для цього замовлення недоступна (строк минув або не передбачена умовами)"
        : "Строк подання заявки з цієї причини минув"
    );
  }
  if ((reason === "defect" || reason === "wrong_item") && comment.length < 10) {
    throw new ReturnError("Опишіть проблему (щонайменше 10 символів)");
  }
  const resolution = input.resolution === "exchange" ? "exchange" : "refund";

  const selection = Array.isArray(input.items) ? input.items : [];
  if (selection.length === 0) throw new ReturnError("Оберіть товари для повернення");
  const seen = new Set();
  const normalized = [];
  for (const sel of selection) {
    const id = String(sel?.productId || "");
    const qty = Number(sel?.quantity);
    const line = eligibility.items.find((i) => i.productId === id);
    if (!line) throw new ReturnError("Товару немає в цьому замовленні");
    if (seen.has(id)) throw new ReturnError("Товар вказано двічі");
    seen.add(id);
    if (!Number.isInteger(qty) || qty < 1 || qty > line.availableQuantity) {
      throw new ReturnError(`«${line.name}»: можна повернути від 1 до ${line.availableQuantity} шт`);
    }
    if (reason === "withdrawal" && line.withdrawalBlocked) {
      throw new ReturnError(`«${line.name}» не підлягає поверненню за бажанням покупця`);
    }
    normalized.push({ productId: id, quantity: qty });
  }

  const items = buildItems(order, authOrders, normalized);
  const rr = await newRequestDoc(
    order,
    {
      kind: "return",
      reason,
      resolution,
      comment,
      createdBy: "customer",
      items,
      timeline: [ev("customer", "Заявку подано", comment)],
    },
    policy
  );
  await rr.save();
  await guardOversubscription(rr, order);
  notifyCustomer("created", rr);
  notifyAdmin(
    `Нова заявка на повернення ${rr.number}`,
    `Замовлення ${orderLabel(order)}, причина: ${reason}. Відкрийте дашборд → Повернення.`
  );
  return rr;
}

// Адмін створює заявку за покупця (напр. відмова від отримання на пошті).
// reason: refused | withdrawal | defect | wrong_item | other. Якщо items не вказано — усі залишки замовлення.
async function createByAdmin(order, input, adminId) {
  const policy = await loadPolicy();
  const reason = String(input.reason || "");
  if (!["refused", "withdrawal", "defect", "wrong_item", "other"].includes(reason)) {
    throw new ReturnError("Оберіть причину");
  }
  if (order.delivery_status === "cancelled") throw new ReturnError("Замовлення скасовано");
  if (order.payment_status !== "paid") {
    throw new ReturnError(
      "Замовлення не оплачене — повертати нічого. Для відмови від неоплаченого замовлення (в т.ч. при оплаті при отриманні) просто скасуйте його."
    );
  }
  const returnedQty = await activeQuantities(order._id);
  const authOrders = await authorOrderModel.find({ orderId: order._id });

  let selection = Array.isArray(input.items) ? input.items : null;
  if (!selection || selection.length === 0) {
    selection = (order.products || [])
      .map((p) => ({ productId: p._id, quantity: p.quantity - (returnedQty[String(p._id)] || 0) }))
      .filter((s) => s.quantity > 0);
  }
  if (selection.length === 0) throw new ReturnError("Усі товари замовлення вже в заявках");
  for (const sel of selection) {
    const p = (order.products || []).find((x) => String(x._id) === String(sel.productId));
    const left = p ? p.quantity - (returnedQty[String(p._id)] || 0) : 0;
    const qty = Number(sel.quantity);
    if (!p || !Number.isInteger(qty) || qty < 1 || qty > left) {
      throw new ReturnError("Некоректна кількість для повернення");
    }
  }
  const items = buildItems(order, authOrders, selection);
  // Відмова від отримання: товар уже їде назад — одразу «в дорозі»
  const status = reason === "refused" ? "shipped" : "approved";
  const rr = await newRequestDoc(
    order,
    {
      kind: "return",
      reason,
      resolution: "refund",
      comment: String(input.comment || "").trim().slice(0, 2000),
      createdBy: "admin",
      status,
      items,
      timeline: [ev("admin", "Заявку створено адміном", String(adminId || ""))],
    },
    policy
  );
  if (status === "shipped") rr.shipment.shippedAt = new Date();
  await rr.save();
  await guardOversubscription(rr, order);
  notifyCustomer("created", rr);
  return rr;
}

// ---------------------------------------------------------------------------
// Переходи статусів
// ---------------------------------------------------------------------------

async function transition(id, fromStatuses, patch, timelineEvent) {
  const rr = await ReturnRequest.findOneAndUpdate(
    { _id: id, status: { $in: fromStatuses } },
    { $set: patch, $push: { timeline: timelineEvent } },
    { new: true }
  );
  return rr;
}

async function getOrThrow(id) {
  const rr = await ReturnRequest.findById(id);
  if (!rr) throw new ReturnError("Заявку не знайдено", 404);
  return rr;
}

const wrongState = () => new ReturnError("Цю дію не можна виконати в поточному статусі заявки", 409);

async function approve(id, { note = "" } = {}, by = "admin") {
  const rr0 = await getOrThrow(id);
  if (rr0.kind === "cancellation") return approveCancellation(id, { note }, by);
  const rr = await transition(
    id,
    ["requested"],
    { status: "approved", "decision.note": String(note).slice(0, 1000), "decision.at": new Date() },
    ev(by, "Схвалено", note)
  );
  if (!rr) throw wrongState();
  notifyCustomer("approved", rr);
  return rr;
}

async function reject(id, { reason }, by = "admin") {
  const text = String(reason || "").trim();
  if (text.length < 3) throw new ReturnError("Вкажіть причину відмови");
  const rr = await transition(
    id,
    ["requested", "approved", "shipped", "received"],
    { status: "rejected", "decision.rejectReason": text.slice(0, 1000), "decision.at": new Date() },
    ev(by, "Відхилено", text)
  );
  if (!rr) throw wrongState();
  // Якщо товар уже повернули на склад при отриманні, а заявку відхилили — прибираємо його зі складу
  if (rr.inspection?.restocked) {
    const order = await customerOrderModel.findById(rr.orderId).select("products").lean();
    for (const it of rr.items) {
      const line = (order?.products || []).find((p) => String(p._id) === String(it.productId));
      if (line?.preorder) continue;
      await productModel.updateOne({ _id: it.productId }, { $inc: { stock: -it.quantity } });
    }
    await ReturnRequest.updateOne({ _id: rr._id }, { $set: { "inspection.restocked": false } });
  }
  notifyCustomer("rejected", rr);
  return rr;
}

async function cancelByCustomer(id, customerId) {
  const rr = await ReturnRequest.findOneAndUpdate(
    { _id: id, customerId, visibleToCustomer: true, status: { $in: ["requested", "approved"] } },
    { $set: { status: "cancelled" }, $push: { timeline: ev("customer", "Покупець відкликав заявку") } },
    { new: true }
  );
  if (!rr) throw wrongState();
  return rr;
}

// Покупець (або адмін) вказує накладну зворотної відправки
async function setShipment(id, { carrier, ttn }, by = "customer", customerId = null) {
  const number = String(ttn || "").replace(/\s+/g, "");
  if (!/^[0-9A-Za-z-]{5,40}$/.test(number)) throw new ReturnError("Вкажіть коректний номер накладної");
  const filter = { _id: id, kind: "return", status: { $in: by === "admin" ? ["requested", "approved", "shipped"] : ["approved"] } };
  if (customerId) {
    filter.customerId = customerId;
    filter.visibleToCustomer = true; // приховану адміном заявку покупець змінювати не може
  }
  const rr = await ReturnRequest.findOneAndUpdate(
    filter,
    {
      $set: {
        status: "shipped",
        "shipment.carrier": String(carrier || "Нова пошта").slice(0, 50),
        "shipment.ttn": number,
        "shipment.shippedAt": new Date(),
      },
      $push: { timeline: ev(by, "Вказано накладну", number) },
    },
    { new: true }
  );
  if (!rr) throw wrongState();
  return rr;
}

// Товар отримано на склад. input: { result: ok|damaged|mismatch, note, shippingCost, shippingPayer, restock }
async function receive(id, input = {}, by = "admin") {
  const rr0 = await getOrThrow(id);
  if (rr0.kind !== "return") throw wrongState();
  const policy = await loadPolicy();
  const result = ["ok", "damaged", "mismatch"].includes(input.result) ? input.result : "ok";
  const shippingCost = toMoney(input.shippingCost, "Вартість зворотної доставки");
  const payer = ["seller", "store", "customer"].includes(input.shippingPayer)
    ? input.shippingPayer
    : policyLib.defaultShippingPayer(policy, rr0.buyerKind, rr0.reason);

  const rr = await transition(
    id,
    ["requested", "approved", "shipped"],
    {
      status: "received",
      "shipment.receivedAt": new Date(),
      "inspection.result": result,
      "inspection.note": String(input.note || "").slice(0, 1000),
      "inspection.at": new Date(),
      "inspection.restocked": !!(input.restock && result === "ok"),
      "refund.shippingCost": shippingCost,
      "refund.shippingPayer": payer,
    },
    ev(by, "Товар отримано", `${result}${input.note ? `: ${input.note}` : ""}`)
  );
  if (!rr) throw wrongState();

  // Придатний товар повертаємо на склад (крім позицій передзамовлення — їх зі складу не віднімали)
  if (input.restock && result === "ok") {
    const order = await customerOrderModel.findById(rr.orderId).select("products").lean();
    for (const it of rr.items) {
      const line = (order?.products || []).find((p) => String(p._id) === String(it.productId));
      if (line?.preorder) continue;
      await productModel.updateOne({ _id: it.productId }, { $inc: { stock: it.quantity } });
    }
  }
  notifyCustomer("received", rr);
  return rr;
}

async function exchange(id, { note = "" } = {}, by = "admin") {
  const rr = await transition(
    id,
    ["received"],
    { status: "exchanged", "decision.note": String(note).slice(0, 1000), "decision.at": new Date() },
    ev(by, "Обмін на інший товар", note)
  );
  if (!rr) throw wrongState();
  notifyCustomer("exchanged", rr);
  return rr;
}

// ---------------------------------------------------------------------------
// Повернення коштів
// ---------------------------------------------------------------------------

// Фіксує суми й виконує повернення. input: { deduction, deductionReason, shippingCost, shippingPayer, manual, manualNote }
async function decideRefund(id, input = {}, by = "admin") {
  const rr0 = await getOrThrow(id);
  const editable =
    (rr0.status === "received" && rr0.kind === "return") ||
    (rr0.status === "refund_pending" && ["pending", "failed", "none"].includes(rr0.refund?.status));
  if (!editable) throw wrongState();
  if (rr0.resolution === "exchange" && rr0.status === "received" && input.confirmRefund !== true) {
    throw new ReturnError("Покупець просив обмін. Оформіть обмін або підтвердіть повернення коштів");
  }

  const order = await customerOrderModel.findById(rr0.orderId);
  if (!order) throw new ReturnError("Замовлення не знайдено", 404);
  if (order.payment_status !== "paid") throw new ReturnError("Замовлення не оплачене — повертати кошти нема з чого");

  const deduction = toMoney(input.deduction, "Утримання");
  const shippingCost = input.shippingCost === undefined ? rr0.refund.shippingCost : toMoney(input.shippingCost, "Вартість доставки");
  const payer = ["seller", "store", "customer"].includes(input.shippingPayer)
    ? input.shippingPayer
    : rr0.refund.shippingPayer;
  if (deduction > 0 && String(input.deductionReason || "").trim().length < 3) {
    throw new ReturnError("Вкажіть причину утримання");
  }

  const committed = await committedFor(order._id, rr0._id);
  const calc = math.refundForItems(
    { goodsTotal: order.goods_total, price: order.price },
    committed,
    rr0.itemsValue
  );
  if (calc.goodsAmount <= 0) throw new ReturnError("За цим замовленням уже все повернено");
  if (deduction > calc.goodsAmount) throw new ReturnError("Утримання не може перевищувати вартість товарів");
  const amount = math.finalRefund({ goodsAmount: calc.goodsAmount, deduction, shippingCost, shippingPayer: payer });
  if (rr0.refund?.attempts > 0 && math.round2(rr0.refund.amount) !== amount) {
    throw new ReturnError(
      "Після спроби повернення суму змінювати не можна — повторіть спробу з тією самою сумою або підтвердіть повернення вручну"
    );
  }

  const rr = await ReturnRequest.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { status: "received" },
        { status: "refund_pending", "refund.status": { $in: ["pending", "failed", "none"] } },
      ],
    },
    {
      $set: {
        status: "refund_pending",
        "refund.status": "pending",
        "refund.amount": amount,
        "refund.goodsAmount": calc.goodsAmount,
        "refund.discountShare": calc.discountShare,
        "refund.deduction": deduction,
        "refund.deductionReason": String(input.deductionReason || "").slice(0, 500),
        "refund.shippingCost": shippingCost,
        "refund.shippingPayer": payer,
        "refund.provider": order.payment?.provider || null,
        "refund.extRef": rr0.refund.extRef || `rr-${rr0._id}`,
        "refund.error": "",
        "decision.at": new Date(),
      },
      $push: { timeline: ev(by, "Рішення: повернути кошти", `₴${amount}`) },
    },
    { new: true }
  );
  if (!rr) throw wrongState();

  if (input.manual === true) return markManualRefunded(id, { note: input.manualNote }, by);
  return executeRefund(id, by);
}

// Робить запит у банк. Безпечно викликати повторно (після помилки).
async function executeRefund(id, by = "admin") {
  const rr = await ReturnRequest.findOneAndUpdate(
    { _id: id, status: "refund_pending", "refund.status": { $in: ["pending", "failed"] } },
    {
      $set: { "refund.status": "processing", "refund.requestedAt": new Date(), "refund.error": "" },
      $inc: { "refund.attempts": 1 },
    },
    { new: true }
  );
  if (!rr) throw wrongState();
  const amount = rr.refund.amount;

  // Нічого повертати (усе утримано) — просто закриваємо заявку
  if (amount <= 0) return finalizeRefund(rr._id, { provider: "manual", fromProcessing: false, by });

  // Атомарна перевірка: усі повернення разом не перевищують оплаченої суми
  const order = await customerOrderModel.findOneAndUpdate(
    {
      _id: rr.orderId,
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ["$refunded_total", 0] }, { $ifNull: ["$refund_inflight", 0] }, amount] },
          "$price",
        ],
      },
    },
    { $inc: { refund_inflight: amount } },
    { new: true }
  );
  if (!order) {
    return failRefund(rr._id, "Сума повернень перевищує оплачену суму замовлення", false);
  }

  // Кожна повторна спроба має власний номер (monobank не дозволяє перевикористати extRef
  // невдалої операції); попередні спроби перевіряються у refundPayment.
  const baseRef = rr.refund.extRef || `rr-${rr._id}`;
  const attemptRef = rr.refund.attempts > 1 ? `${baseRef}-${rr.refund.attempts}` : baseRef;
  const res = await paymentService.refundPayment(order, amount, attemptRef);
  if (res.state === "success") {
    return finalizeRefund(rr._id, { provider: res.provider, fromProcessing: true, by });
  }
  if (res.state === "processing") {
    await ReturnRequest.updateOne(
      { _id: rr._id },
      {
        $set: { "refund.provider": res.provider },
        $push: { timeline: ev("system", "Банк обробляє повернення", res.error ? String(res.error).slice(0, 200) : "") },
      }
    );
    return ReturnRequest.findById(rr._id);
  }
  if (res.state === "manual") {
    await customerOrderModel.updateOne({ _id: rr.orderId }, { $inc: { refund_inflight: -amount } });
    await ReturnRequest.updateOne(
      { _id: rr._id },
      {
        $set: {
          "refund.status": "pending",
          "refund.provider": "manual",
          "refund.error": "Автоматичне повернення недоступне для цього способу оплати — переведіть кошти вручну й підтвердіть",
        },
        $push: { timeline: ev("system", "Потрібне ручне повернення коштів") },
      }
    );
    return ReturnRequest.findById(rr._id);
  }
  return failRefund(rr._id, res.error || "Банк відхилив повернення", true);
}

async function failRefund(id, message, inflightTaken) {
  const rr = await ReturnRequest.findOneAndUpdate(
    { _id: id, "refund.status": "processing" },
    {
      $set: { "refund.status": "failed", "refund.error": String(message).slice(0, 500) },
      $push: { timeline: ev("system", "Помилка повернення коштів", String(message).slice(0, 200)) },
    },
    { new: false }
  );
  if (rr && inflightTaken) {
    await customerOrderModel.updateOne({ _id: rr.orderId }, { $inc: { refund_inflight: -rr.refund.amount } });
  }
  return ReturnRequest.findById(id);
}

// Запис у журнал виплат: під замком (щоб фонова перевірка й основний потік не писали одночасно).
// recordReturn ідемпотентний по кожному запису, тож повтор після збою безпечний.
async function writeLedger(rr) {
  const stale = new Date(Date.now() - 2 * 60 * 1000);
  const claimed = await ReturnRequest.findOneAndUpdate(
    {
      _id: rr._id,
      "refund.ledgerDone": { $ne: true },
      $or: [{ "refund.ledgerLockAt": null }, { "refund.ledgerLockAt": { $lt: stale } }],
    },
    { $set: { "refund.ledgerLockAt": new Date() } },
    { new: true }
  );
  if (!claimed) return false;
  try {
    if (claimed.kind === "return") await ledger.recordReturn(claimed);
    await ReturnRequest.updateOne({ _id: rr._id }, { $set: { "refund.ledgerDone": true, "refund.ledgerLockAt": null } });
    return true;
  } catch (e) {
    console.error("💥 ledger.recordReturn:", e.message);
    await ReturnRequest.updateOne({ _id: rr._id }, { $set: { "refund.ledgerLockAt": null } });
    return false;
  }
}

// Повернення виконано: рахуємо залишки, пишемо журнал, надсилаємо лист. Ідемпотентно.
async function finalizeRefund(id, { provider, fromProcessing, by = "system" }) {
  const prev = await ReturnRequest.findOneAndUpdate(
    { _id: id, status: "refund_pending", "refund.status": { $in: ["pending", "failed", "processing"] } },
    {
      $set: {
        status: "refunded",
        "refund.status": "success",
        "refund.provider": provider || "manual",
        "refund.refundedAt": new Date(),
        "refund.error": "",
      },
      $push: { timeline: ev(by, "Кошти повернено") },
    },
    { new: false }
  );
  if (!prev) return ReturnRequest.findById(id); // уже завершено іншим викликом

  const amount = prev.refund.amount;
  const wasInflight = prev.refund.status === "processing" && fromProcessing !== false && amount > 0;
  await customerOrderModel.updateOne(
    { _id: prev.orderId },
    { $inc: { refunded_total: amount, refund_inflight: wasInflight ? -amount : 0 } }
  );
  const order = await customerOrderModel.findById(prev.orderId);
  if (order) {
    const full = order.refunded_total >= order.price - 0.005;
    await customerOrderModel.updateOne({ _id: order._id }, { $set: { refund_status: full ? "full" : "partial" } });
  }

  const fresh = await ReturnRequest.findById(id);
  // Збій журналу не має ламати вже виконане повернення: ledgerDone лишається false,
  // а фонова перевірка (sweepProcessingRefunds) повторить запис — recordReturn ідемпотентний.
  await writeLedger(fresh);
  notifyCustomer(fresh.kind === "cancellation" ? "cancelled_refund" : "refunded", fresh);
  return ReturnRequest.findById(id);
}

// Адмін підтверджує, що переказав кошти вручну (або перевірив у кабінеті банку, що повернення пройшло).
// Дозволено зі статусів «очікує»/«помилка», а також для повернення, що «зависло» в обробці понад 2 хв.
async function markManualRefunded(id, { note = "" } = {}, by = "admin") {
  const rr0 = await getOrThrow(id);
  if (rr0.status !== "refund_pending") throw wrongState();
  const stale = new Date(Date.now() - 2 * 60 * 1000);
  // Атомарно «захоплюємо» заявку — два одночасні кліки не пройдуть
  const claimed = await ReturnRequest.findOneAndUpdate(
    {
      _id: id,
      status: "refund_pending",
      $or: [
        { "refund.status": { $in: ["pending", "failed"] } },
        { "refund.status": "processing", "refund.requestedAt": { $lt: stale } },
      ],
    },
    {
      $set: { "refund.status": "processing", "refund.manualNote": String(note).slice(0, 500) },
      $push: { timeline: ev(by, "Повернено вручну", note) },
    },
    { new: false }
  );
  if (!claimed) throw wrongState();

  const alreadyReserved = claimed.refund.status === "processing";
  const amount = claimed.refund.amount;
  if (!alreadyReserved && amount > 0) {
    const order = await customerOrderModel.findOneAndUpdate(
      {
        _id: claimed.orderId,
        $expr: {
          $lte: [
            { $add: [{ $ifNull: ["$refunded_total", 0] }, { $ifNull: ["$refund_inflight", 0] }, amount] },
            "$price",
          ],
        },
      },
      { $inc: { refund_inflight: amount } },
      { new: true }
    );
    if (!order) {
      await ReturnRequest.updateOne({ _id: id }, { $set: { "refund.status": claimed.refund.status } });
      throw new ReturnError("Сума повернень перевищує оплачену суму замовлення", 409);
    }
  }
  return finalizeRefund(id, { provider: "manual", fromProcessing: true, by });
}

// Оновлює статус повернення, яке банк обробляє асинхронно
async function syncRefund(id) {
  const rr = await getOrThrow(id);
  if (rr.refund.status !== "processing") return rr;
  const order = await customerOrderModel.findById(rr.orderId);
  const res = await paymentService.syncRefund(order, rr.refund.extRef);
  if (res.state === "success") return finalizeRefund(id, { provider: res.provider, fromProcessing: true });
  if (res.state === "failed") return failRefund(id, res.error || "Банк відхилив повернення", true);
  return rr;
}

async function sweepProcessingRefunds() {
  const stale = await ReturnRequest.find({
    "refund.status": "processing",
    "refund.requestedAt": { $lt: new Date(Date.now() - 2 * 60 * 1000) },
  }).limit(50);
  for (const rr of stale) {
    try {
      await syncRefund(rr._id);
    } catch (e) {
      console.error("💥 syncRefund:", e.message);
    }
  }
  // Виконані повернення, для яких не вдалося записати журнал виплат
  const pendingLedger = await ReturnRequest.find({
    status: "refunded",
    kind: "return",
    "refund.ledgerDone": { $ne: true },
  }).limit(50);
  for (const rr of pendingLedger) await writeLedger(rr);
  return stale.length;
}

// ---------------------------------------------------------------------------
// Скасування замовлення з поверненням коштів
// ---------------------------------------------------------------------------

// Після скасування оплаченого замовлення (повністю або підзамовлення) створює «заявку на повернення
// коштів» зі статусом refund_pending: адмін підтверджує повернення одним кліком.
// prevOrder — замовлення. authOrderIds — які підзамовлення скасовано (порожньо = усі).
async function createCancellationRefund({ order, authOrderIds = null, by = "admin", reason = "cancel_by_store" }) {
  if (!order || order.payment_status !== "paid") return null;
  const policy = await loadPolicy();
  const allAuth = await authorOrderModel.find({ orderId: order._id });
  const targets = authOrderIds
    ? allAuth.filter((a) => authOrderIds.map(String).includes(String(a._id)))
    : allAuth;
  if (targets.length === 0) return null;

  // Заявка покупця на скасування, що ще не розглянута, більше не потрібна — магазин сам скасовує й повертає кошти
  await ReturnRequest.updateMany(
    { orderId: order._id, kind: "cancellation", status: "requested" },
    {
      $set: { status: "cancelled" },
      $push: { timeline: ev("system", "Замовлення скасовано магазином — заявку закрито, кошти повертаються окремою заявкою") },
    }
  );

  // Не створюємо дубль для тих самих підзамовлень
  const existing = await ReturnRequest.find({
    orderId: order._id,
    kind: "cancellation",
    status: { $nin: NOT_COUNTED },
  });
  const covered = new Set(existing.flatMap((r) => r.items.map((i) => String(i.authOrderId))));
  const fresh = targets.filter((a) => !covered.has(String(a._id)));
  if (fresh.length === 0) return null;

  const selection = fresh.flatMap((a) =>
    (a.products || []).map((p) => ({ productId: p._id, quantity: p.quantity }))
  );
  const items = buildItems(order, allAuth, selection);
  const itemsValue = sumItems(items);
  const committed = await committedFor(order._id);
  const calc = math.refundForItems({ goodsTotal: order.goods_total, price: order.price }, committed, itemsValue);
  if (calc.goodsAmount <= 0) return null;

  const rr = await newRequestDoc(
    order,
    {
      kind: "cancellation",
      reason,
      resolution: "refund",
      createdBy: by,
      status: "refund_pending",
      items,
      refund: {
        status: "pending",
        amount: calc.goodsAmount,
        goodsAmount: calc.goodsAmount,
        discountShare: calc.discountShare,
        provider: order.payment?.provider || null,
        extRef: null,
        shippingPayer: "store",
      },
      timeline: [ev(by, "Замовлення скасовано — потрібне повернення коштів", `₴${calc.goodsAmount}`)],
    },
    policy
  );
  rr.refund.extRef = `rr-${rr._id}`;
  await rr.save();
  notifyCustomer("cancelled_refund", rr);
  notifyAdmin(
    `Потрібне повернення коштів ${rr.number}`,
    `Замовлення ${orderLabel(order)} скасовано, потрібно повернути ₴${calc.goodsAmount}. Дашборд → Повернення.`
  );
  return rr;
}

// Адмін схвалює заявку покупця на скасування: скасовуємо замовлення й повертаємо кошти.
async function approveCancellation(id, { note = "" } = {}, by = "admin") {
  const rr0 = await getOrThrow(id);
  if (rr0.kind !== "cancellation" || rr0.status !== "requested") throw wrongState();
  const order = await customerOrderModel.findById(rr0.orderId);
  if (!order) throw new ReturnError("Замовлення не знайдено", 404);
  if (order.refund_status === "full" || order.refund_inflight > 0) {
    throw new ReturnError("За цим замовленням уже є повернення коштів", 409);
  }
  const blocker = await orderLifecycle.cancelBlocker(order._id);
  if (blocker) throw new ReturnError(blocker, 409);

  // Спершу атомарно «захоплюємо» заявку — паралельне схвалення не скасує замовлення двічі
  const paid = order.payment_status === "paid";
  const claimed = await ReturnRequest.findOneAndUpdate(
    { _id: id, status: "requested" },
    {
      $set: { status: "approved", "decision.note": String(note).slice(0, 1000), "decision.at": new Date() },
      $push: { timeline: ev(by, "Скасування схвалено", note) },
    },
    { new: true }
  );
  if (!claimed) throw wrongState();

  const prev = await orderLifecycle.cancelWholeOrder(order._id);
  if (!prev) {
    // замовлення вже відправлене/скасоване — повертаємо заявку у «нову»
    await ReturnRequest.updateOne(
      { _id: id },
      { $set: { status: "requested" }, $push: { timeline: ev("system", "Скасувати замовлення не вдалося — воно вже відправлене або скасоване") } }
    );
    throw new ReturnError("Замовлення вже відправлене або скасоване — скасування неможливе", 409);
  }

  const committed = await committedFor(order._id, rr0._id);
  // Позиції, що вже скасовані окремою заявкою (напр. продавець скасував свою частину), не рахуємо вдруге
  const calc = paid
    ? math.refundForItems({ goodsTotal: order.goods_total, price: order.price }, committed, rr0.itemsValue)
    : { goodsAmount: 0, discountShare: 0 };

  const rr = await ReturnRequest.findOneAndUpdate(
    { _id: id, status: "approved" },
    {
      $set: {
        status: paid && calc.goodsAmount > 0 ? "refund_pending" : "refunded",
        "refund.status": paid && calc.goodsAmount > 0 ? "pending" : "none",
        "refund.amount": calc.goodsAmount,
        "refund.goodsAmount": calc.goodsAmount,
        "refund.discountShare": calc.discountShare,
        "refund.provider": order.payment?.provider || null,
        "refund.extRef": `rr-${rr0._id}`,
        "refund.shippingPayer": "store",
      },
    },
    { new: true }
  );
  if (!rr) throw wrongState();
  if (!(paid && calc.goodsAmount > 0)) {
    notifyCustomer("approved", rr);
    return rr;
  }
  return executeRefund(id, by);
}

// ---------------------------------------------------------------------------
// Подання для покупця (без внутрішніх даних)
// ---------------------------------------------------------------------------
function customerView(rr) {
  const r = rr.toObject ? rr.toObject() : rr;
  return {
    _id: r._id,
    number: r.number,
    orderId: r.orderId,
    kind: r.kind,
    reason: r.reason,
    resolution: r.resolution,
    comment: r.comment,
    status: r.status,
    items: r.items.map((i) => ({
      productId: i.productId,
      name: i.name,
      image: i.image,
      quantity: i.quantity,
      value: i.value,
    })),
    itemsValue: r.itemsValue,
    shipment: { carrier: r.shipment?.carrier || "", ttn: r.shipment?.ttn || "" },
    decision: { note: r.decision?.note || "", rejectReason: r.decision?.rejectReason || "" },
    refund: {
      status: r.refund?.status,
      amount: r.refund?.amount || 0,
      deduction: r.refund?.deduction || 0,
      deductionReason: r.refund?.deductionReason || "",
      shippingCost: r.refund?.shippingPayer === "customer" ? r.refund?.shippingCost || 0 : 0,
      refundedAt: r.refund?.refundedAt || null,
    },
    refundDueAt: r.refundDueAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

module.exports = {
  ReturnError,
  OPEN_STATUSES,
  loadPolicy,
  eligibilityFor,
  committedFor,
  createByCustomer,
  createByAdmin,
  approve,
  reject,
  cancelByCustomer,
  setShipment,
  receive,
  exchange,
  decideRefund,
  executeRefund,
  markManualRefunded,
  syncRefund,
  sweepProcessingRefunds,
  createCancellationRefund,
  approveCancellation,
  customerView,
  buildItems,
};
