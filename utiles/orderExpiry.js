// Фонове автоскасування неоплачених замовлень і повернення товарів на склад.
// Замінює старий setTimeout у place_order, який губився при кожному перезапуску сервера
// (і тоді зарезервований товар «зависав» назавжди).
//
// Скасовуємо замовлення, які: не оплачені, не «оплата при отриманні», не скасовані
// і старші за ORDER_PAYMENT_CHECK_IN днів (за замовчуванням 3).

const customerOrderModel = require("../models/customerOrderModel");

const SWEEP_EVERY_MS = 10 * 60 * 1000;

async function sweepExpiredOrders() {
  // require тут, щоб уникнути циклічної залежності під час завантаження модулів
  const orderController = require("../controllers/order/orderController");
  const days = Number(process.env.ORDER_PAYMENT_CHECK_IN) || 3;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const expired = await customerOrderModel
    .find({
      payment_status: "unpaid",
      payment_method: { $nin: ["cod", "invoice"] },
      delivery_status: { $ne: "cancelled" },
      createdAt: { $lt: cutoff },
    })
    .select("_id")
    .limit(200);

  // Замовлення «за рахунком» скасовуємо не за ORDER_PAYMENT_CHECK_IN, а коли минув строк дії рахунку
  const expiredInvoices = await customerOrderModel
    .find({
      payment_status: "unpaid",
      payment_method: "invoice",
      delivery_status: { $ne: "cancelled" },
      "invoice.dueAt": { $lt: new Date() },
    })
    .select("_id")
    .limit(200);
  expired.push(...expiredInvoices);

  for (const o of expired) {
    await orderController.paymentCheck(o._id);
  }
  // Повернення коштів, що «зависли» в обробці банку, — звіряємо статус
  try {
    await require("./returnService").sweepProcessingRefunds();
  } catch (e) {
    console.error("💥 sweepProcessingRefunds:", e.message);
  }
  return expired.length;
}

function startOrderExpiry() {
  const run = () =>
    sweepExpiredOrders()
      .then((n) => n && console.log(`🧹 Скасовано прострочених замовлень: ${n}`))
      .catch((e) => console.error("💥 orderExpiry:", e.message));
  run();
  const timer = setInterval(run, SWEEP_EVERY_MS);
  timer.unref();
}

module.exports = { startOrderExpiry, sweepExpiredOrders };
