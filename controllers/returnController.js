// HTTP-шар заявок на повернення: покупець, адмін, продавець. Уся логіка — в utiles/returnService.js.

const mongoose = require("mongoose");
const { responseReturn } = require("../utiles/response");
const ReturnRequest = require("../models/returnRequestModel");
const customerOrderModel = require("../models/customerOrderModel");
const authorOrderModel = require("../models/authorOrderModel");
const customerModel = require("../models/customerModel");
const sellerWallet = require("../models/sellerWallet");
const returns = require("../utiles/returnService");
const math = require("../utiles/returnMath");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v)) && /^[a-f\d]{24}$/i.test(String(v));

function fail(res, error, where) {
  if (error instanceof returns.ReturnError) {
    return responseReturn(res, error.status, { error: error.message });
  }
  console.error(`💥 returnController.${where}:`, error);
  return responseReturn(res, 500, { error: "Щось пішло не так" });
}

const TERMINAL = ["refunded", "exchanged", "rejected", "cancelled"];

class returnController {
  // ------------------------------------------------------------------ покупець
  // Чи можна повернути/скасувати замовлення і які товари доступні
  async eligibility(req, res) {
    try {
      const { orderId } = req.params;
      if (!isId(orderId)) return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      const order = await customerOrderModel.findOne({ _id: orderId, customerId: req.id });
      if (!order) return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      const { eligibility } = await returns.eligibilityFor(order);
      responseReturn(res, 200, { eligibility });
    } catch (error) {
      fail(res, error, "eligibility");
    }
  }

  async create(req, res) {
    try {
      const { orderId } = req.body || {};
      if (!isId(orderId)) return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      const order = await customerOrderModel.findOne({ _id: orderId, customerId: req.id });
      if (!order) return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      const rr = await returns.createByCustomer(order, req.body || {});
      responseReturn(res, 201, {
        request: returns.customerView(rr),
        message: "Заявку подано. Ми повідомимо про рішення на email",
      });
    } catch (error) {
      fail(res, error, "create");
    }
  }

  async list(req, res) {
    try {
      const policy = await returns.loadPolicy();
      if (!policy.cabinetVisible) {
        return responseReturn(res, 200, { enabled: policy.enabled, cabinetVisible: false, requests: [] });
      }
      const filter = { customerId: req.id, visibleToCustomer: true };
      if (req.query.orderId && isId(req.query.orderId)) filter.orderId = req.query.orderId;
      const list = await ReturnRequest.find(filter).sort({ createdAt: -1 }).limit(100);
      responseReturn(res, 200, {
        enabled: policy.enabled,
        cabinetVisible: true,
        requests: list.map(returns.customerView),
      });
    } catch (error) {
      fail(res, error, "list");
    }
  }

  async details(req, res) {
    try {
      const { id } = req.params;
      const policy = await returns.loadPolicy();
      if (!isId(id) || !policy.cabinetVisible) {
        return responseReturn(res, 404, { error: "Заявку не знайдено" });
      }
      const rr = await ReturnRequest.findOne({ _id: id, customerId: req.id, visibleToCustomer: true });
      if (!rr) return responseReturn(res, 404, { error: "Заявку не знайдено" });
      responseReturn(res, 200, {
        request: returns.customerView(rr),
        returnAddress: policy.returnAddress,
        contactInfo: policy.contactInfo,
      });
    } catch (error) {
      fail(res, error, "details");
    }
  }

  async ship(req, res) {
    try {
      const { id } = req.params;
      if (!isId(id)) return responseReturn(res, 404, { error: "Заявку не знайдено" });
      const rr = await returns.setShipment(id, req.body || {}, "customer", req.id);
      responseReturn(res, 200, { request: returns.customerView(rr), message: "Накладну збережено" });
    } catch (error) {
      fail(res, error, "ship");
    }
  }

  async cancel(req, res) {
    try {
      const { id } = req.params;
      if (!isId(id)) return responseReturn(res, 404, { error: "Заявку не знайдено" });
      const rr = await returns.cancelByCustomer(id, req.id);
      responseReturn(res, 200, { request: returns.customerView(rr), message: "Заявку відкликано" });
    } catch (error) {
      fail(res, error, "cancel");
    }
  }

  // ------------------------------------------------------------------ адмін
  async admin_list(req, res) {
    try {
      let { status = "open", q = "", orderId, page = 1, perPage = 15 } = req.query;
      page = Math.max(1, parseInt(page) || 1);
      perPage = Math.min(100, Math.max(1, parseInt(perPage) || 15));

      const filter = {};
      if (status === "open") filter.status = { $in: returns.OPEN_STATUSES };
      else if (status === "refund_due") {
        filter.status = "refund_pending";
      } else if (status === "overdue") {
        filter.status = { $in: returns.OPEN_STATUSES };
        filter.refundDueAt = { $lt: new Date() };
      } else if (status !== "all") filter.status = String(status);
      if (orderId && isId(orderId)) filter.orderId = orderId;
      const text = String(q || "").trim();
      if (text) {
        if (isId(text)) filter.$or = [{ _id: text }, { orderId: text }, { customerId: text }];
        else filter.number = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }

      const [list, total, grouped] = await Promise.all([
        ReturnRequest.find(filter).sort({ createdAt: -1 }).skip((page - 1) * perPage).limit(perPage).lean(),
        ReturnRequest.countDocuments(filter),
        ReturnRequest.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      ]);
      const counts = Object.fromEntries(grouped.map((g) => [g._id, g.n]));
      const open = returns.OPEN_STATUSES.reduce((s, k) => s + (counts[k] || 0), 0);
      const overdue = await ReturnRequest.countDocuments({
        status: { $in: returns.OPEN_STATUSES },
        refundDueAt: { $lt: new Date() },
      });

      responseReturn(res, 200, {
        requests: list.map((r) => ({ ...r, overdue: !TERMINAL.includes(r.status) && r.refundDueAt && r.refundDueAt < new Date() })),
        total,
        counts: { ...counts, open, overdue },
      });
    } catch (error) {
      fail(res, error, "admin_list");
    }
  }

  async admin_details(req, res) {
    try {
      const { id } = req.params;
      if (!isId(id)) return responseReturn(res, 404, { error: "Заявку не знайдено" });
      const rr = await ReturnRequest.findById(id);
      if (!rr) return responseReturn(res, 404, { error: "Заявку не знайдено" });
      const [order, customer, policy, committed, authOrders] = await Promise.all([
        customerOrderModel.findById(rr.orderId).lean(),
        customerModel.findById(rr.customerId).select("name email phone").lean(),
        returns.loadPolicy(),
        returns.committedFor(rr.orderId, rr._id),
        authorOrderModel.find({ orderId: rr.orderId }).select("sellerId price delivery_status").lean(),
      ]);
      // Орієнтовна сума повернення (без утримань) — підказка для форми рішення
      let preview = null;
      if (order && !["refunded", "exchanged", "rejected", "cancelled"].includes(rr.status)) {
        preview = math.refundForItems({ goodsTotal: order.goods_total, price: order.price }, committed, rr.itemsValue);
      }
      responseReturn(res, 200, {
        request: rr,
        order,
        customer,
        policy,
        preview,
        authOrders,
        overdue: !TERMINAL.includes(rr.status) && rr.refundDueAt && rr.refundDueAt < new Date(),
      });
    } catch (error) {
      fail(res, error, "admin_details");
    }
  }

  // Універсальний обгортник адмін-дій
  act(handler, where) {
    return async (req, res) => {
      try {
        const { id } = req.params;
        if (!isId(id)) return responseReturn(res, 404, { error: "Заявку не знайдено" });
        const rr = await handler(id, req.body || {}, req);
        responseReturn(res, 200, { request: rr, message: "Готово" });
      } catch (error) {
        fail(res, error, where);
      }
    };
  }

  admin_approve = this.act((id, b) => returns.approve(id, b, "admin"), "admin_approve");
  admin_reject = this.act((id, b) => returns.reject(id, b, "admin"), "admin_reject");
  admin_shipment = this.act((id, b) => returns.setShipment(id, b, "admin"), "admin_shipment");
  admin_receive = this.act((id, b) => returns.receive(id, b, "admin"), "admin_receive");
  admin_exchange = this.act((id, b) => returns.exchange(id, b, "admin"), "admin_exchange");
  admin_refund = this.act((id, b) => returns.decideRefund(id, b, "admin"), "admin_refund");
  admin_refund_retry = this.act((id) => returns.executeRefund(id, "admin"), "admin_refund_retry");
  admin_refund_manual = this.act((id, b) => returns.markManualRefunded(id, b, "admin"), "admin_refund_manual");
  admin_refund_sync = this.act((id) => returns.syncRefund(id), "admin_refund_sync");

  async admin_visibility(req, res) {
    try {
      const { id } = req.params;
      if (!isId(id)) return responseReturn(res, 404, { error: "Заявку не знайдено" });
      const visible = req.body?.visible === true;
      const rr = await ReturnRequest.findByIdAndUpdate(
        id,
        {
          $set: { visibleToCustomer: visible },
          $push: { timeline: { at: new Date(), by: "admin", action: visible ? "Показано покупцю" : "Приховано від покупця" } },
        },
        { new: true }
      );
      if (!rr) return responseReturn(res, 404, { error: "Заявку не знайдено" });
      responseReturn(res, 200, {
        request: rr,
        message: visible ? "Заявку показано в кабінеті покупця" : "Заявку приховано від покупця",
      });
    } catch (error) {
      fail(res, error, "admin_visibility");
    }
  }

  async admin_create(req, res) {
    try {
      const { orderId } = req.body || {};
      if (!isId(orderId)) return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      const order = await customerOrderModel.findById(orderId);
      if (!order) return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      const rr = await returns.createByAdmin(order, req.body, req.id);
      responseReturn(res, 201, { request: rr, message: "Заявку створено" });
    } catch (error) {
      fail(res, error, "admin_create");
    }
  }

  // Для окремого замовлення адмін може дозволити або заборонити повернення незалежно від загальних умов
  async admin_order_override(req, res) {
    try {
      const { orderId } = req.params;
      const mode = req.body?.mode;
      if (!isId(orderId)) return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      if (!["default", "allow", "deny"].includes(mode)) {
        return responseReturn(res, 400, { error: "Некоректний режим" });
      }
      const order = await customerOrderModel.findByIdAndUpdate(orderId, { returnOverride: mode }, { new: true });
      if (!order) return responseReturn(res, 404, { error: "Замовлення не знайдено" });
      responseReturn(res, 200, {
        returnOverride: order.returnOverride,
        message:
          mode === "allow"
            ? "Для цього замовлення повернення дозволено незалежно від строків"
            : mode === "deny"
            ? "Для цього замовлення повернення заборонено"
            : "Діють загальні умови повернення",
      });
    } catch (error) {
      fail(res, error, "admin_order_override");
    }
  }

  // ------------------------------------------------------------------ продавець
  // Заявки, що стосуються товарів продавця (лише перегляд) + вплив на його баланс
  async seller_list(req, res) {
    try {
      const sellerId = req.id;
      const list = await ReturnRequest.find({ "items.sellerId": sellerId, status: { $ne: "cancelled" } })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();
      const ids = list.map((r) => r._id);
      const entries = ids.length
        ? await sellerWallet.find({ sellerId: String(sellerId), returnId: { $in: ids } }).lean()
        : [];
      const impact = {};
      for (const e of entries) {
        const k = String(e.returnId);
        impact[k] = math.round2((impact[k] || 0) + e.amount);
      }
      responseReturn(res, 200, {
        requests: list.map((r) => ({
          _id: r._id,
          number: r.number,
          orderId: r.orderId,
          kind: r.kind,
          reason: r.reason,
          status: r.status,
          createdAt: r.createdAt,
          items: r.items.filter((i) => String(i.sellerId) === String(sellerId)),
          inspection: { result: r.inspection?.result || "", note: r.inspection?.note || "" },
          shipment: { carrier: r.shipment?.carrier || "", ttn: r.shipment?.ttn || "" },
          deduction: r.refund?.deduction || 0,
          deductionReason: r.refund?.deductionReason || "",
          shippingCost: r.refund?.shippingPayer === "seller" ? r.refund?.shippingCost || 0 : 0,
          // Скільки списано з балансу продавця за цією заявкою (від'ємне число)
          balanceImpact: impact[String(r._id)] || 0,
        })),
      });
    } catch (error) {
      fail(res, error, "seller_list");
    }
  }
}

module.exports = new returnController();
