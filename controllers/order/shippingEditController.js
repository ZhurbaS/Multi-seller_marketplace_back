const customerOrderModel = require("../../models/customerOrderModel");
const authorOrderModel = require("../../models/authorOrderModel");
const customerModel = require("../../models/customerModel");
const { responseReturn } = require("../../utiles/response");
const { sanitizeShipping } = require("../../utiles/shipping");
const { orderLabel } = require("../../utiles/orderNumber");
const mailer = require("../../utiles/mailer");
const os = require("../../utiles/orderShipping");

async function loadOwn(req, res) {
  const id = String(req.params.orderId || "");
  if (!/^[a-f\d]{24}$/i.test(id)) {
    responseReturn(res, 404, { error: "Замовлення не знайдено" });
    return null;
  }
  const order = await customerOrderModel.findById(id);
  if (!order) {
    responseReturn(res, 404, { error: "Замовлення не знайдено" });
    return null;
  }
  if (order.customerId.toString() !== req.id) {
    responseReturn(res, 403, { error: "Доступ заборонено" });
    return null;
  }
  return order;
}

class shippingEditController {
  // Чи можна зараз змінити отримувача й доставку
  async check(req, res) {
    try {
      const order = await loadOwn(req, res);
      if (!order) return;
      const subs = await authorOrderModel.find({ orderId: order._id }).select("delivery_status").lean();
      const reason = os.editBlocker(order, subs);
      responseReturn(res, 200, { allowed: !reason, reason });
    } catch (e) {
      console.error("💥 shipping check:", e.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  async update(req, res) {
    try {
      const order = await loadOwn(req, res);
      if (!order) return;
      const subs = await authorOrderModel.find({ orderId: order._id }).select("delivery_status").lean();
      const reason = os.editBlocker(order, subs);
      if (reason) return responseReturn(res, 409, { error: reason });

      const checked = sanitizeShipping(req.body?.shippingInfo);
      if (checked.error) return responseReturn(res, 400, { error: checked.error });
      const next = checked.value;
      if (!os.changed(order.shippingInfo, next)) {
        return responseReturn(res, 200, { order, message: "Дані не змінилися" });
      }

      const $set = { shippingInfo: next, shippingChangedAt: new Date() };
      // Телефон для месенджера в рахунку — актуальний
      if (order.invoice?.channel && order.invoice.channel !== "email") $set["invoice.contact"] = next.phone;
      // Атомарно: статус міг змінитися, поки покупець заповнював форму
      const updated = await customerOrderModel.findOneAndUpdate(
        {
          _id: order._id,
          delivery_status: { $in: os.EDITABLE },
          trackingNumber: { $in: ["", null] },
        },
        {
          $set,
          $push: {
            shippingChanges: {
              $each: [{ at: new Date(), before: order.shippingInfo, after: next }],
              $slice: -20,
            },
          },
        },
        { new: true }
      );
      if (!updated) {
        return responseReturn(res, 409, { error: "Замовлення вже передано в доставку — змінити дані не можна" });
      }

      const label = orderLabel(updated);
      // Листи не блокують відповідь і не впливають на результат
      (async () => {
        const c = await customerModel.findById(updated.customerId).select("email").lean();
        if (c?.email) {
          await mailer.sendMail({
            to: c.email,
            subject: `Дані доставки замовлення ${label} змінено`,
            text:
              `Ми отримали вашу зміну отримувача й доставки для замовлення ${label}.\n\n${os.describe(next)}\n\n` +
              `Зміна може потребувати додаткового часу на опрацювання — якщо виникнуть питання, ми зв'яжемося з вами.`,
            footer: "plain",
          });
        }
        if (process.env.ADMIN_EMAIL) {
          await mailer.sendMail({
            to: process.env.ADMIN_EMAIL,
            subject: `Покупець змінив доставку замовлення ${label}`,
            text: `Було:\n${os.describe(order.shippingInfo)}\n\nСтало:\n${os.describe(next)}`,
            footer: false,
          });
        }
      })().catch((e) => console.error("📧 shipping notify:", e.message));

      responseReturn(res, 200, {
        order: updated,
        message: "Дані збережено. Зміна може потребувати додаткового часу на опрацювання",
      });
    } catch (e) {
      console.error("💥 shipping update:", e.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }
}

module.exports = new shippingEditController();
