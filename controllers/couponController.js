// Купони для адміна: створення, редагування, статистика використання.

const mongoose = require("mongoose");
const { responseReturn } = require("../utiles/response");
const couponModel = require("../models/couponModel");
const couponRedemptionModel = require("../models/couponRedemptionModel");
const couponService = require("../utiles/couponService");

const isId = (v) => /^[a-f\d]{24}$/i.test(String(v));

function fail(res, error, where) {
  if (error && error.code === 11000) {
    return responseReturn(res, 409, { error: "Купон з таким кодом уже існує" });
  }
  console.error(`💥 couponController.${where}:`, error);
  return responseReturn(res, 500, { error: "Щось пішло не так" });
}

async function uniqueCode() {
  for (let i = 0; i < 10; i++) {
    const code = couponService.generateCode(8);
    if (!(await couponModel.exists({ code }))) return code;
  }
  throw new Error("Не вдалося згенерувати унікальний код");
}

class couponController {
  async list(req, res) {
    try {
      let { status = "all", q = "", page = 1, perPage = 20 } = req.query;
      page = Math.max(1, parseInt(page) || 1);
      perPage = Math.min(100, Math.max(1, parseInt(perPage) || 20));
      const now = new Date();

      const filter = {};
      if (status === "active") {
        filter.active = true;
        filter.$and = [
          { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
          { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
        ];
      } else if (status === "inactive") filter.active = false;
      else if (status === "expired") filter.endsAt = { $lt: now };
      const text = String(q || "").trim();
      if (text) {
        const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ code: rx }, { title: rx }, { campaign: rx }];
      }

      const [coupons, total] = await Promise.all([
        couponModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * perPage).limit(perPage).lean(),
        couponModel.countDocuments(filter),
      ]);
      const ids = coupons.map((c) => c._id);
      const stats = ids.length
        ? await couponRedemptionModel.aggregate([
            { $match: { couponId: { $in: ids }, status: { $in: ["reserved", "redeemed"] } } },
            {
              $group: {
                _id: "$couponId",
                orders: { $sum: 1 },
                discount: { $sum: "$amount" },
                revenue: { $sum: { $subtract: ["$orderTotal", "$amount"] } },
                redeemed: { $sum: { $cond: [{ $eq: ["$status", "redeemed"] }, 1, 0] } },
              },
            },
          ])
        : [];
      const byId = new Map(stats.map((s) => [String(s._id), s]));
      responseReturn(res, 200, {
        coupons: coupons.map((c) => {
          const s = byId.get(String(c._id)) || {};
          return {
            ...c,
            stats: {
              orders: s.orders || 0,
              redeemed: s.redeemed || 0,
              discount: s.discount || 0,
              revenue: s.revenue || 0,
            },
          };
        }),
        total,
      });
    } catch (error) {
      fail(res, error, "list");
    }
  }

  async generate_code(req, res) {
    try {
      responseReturn(res, 200, { code: await uniqueCode() });
    } catch (error) {
      fail(res, error, "generate_code");
    }
  }

  async create(req, res) {
    try {
      const body = { ...(req.body || {}) };
      if (!couponService.normalizeCode(body.code)) body.code = await uniqueCode();
      const result = couponService.sanitizeCoupon(body);
      if (result.error) return responseReturn(res, 400, { error: result.error });
      const coupon = await couponModel.create({ active: true, ...result.value });
      responseReturn(res, 201, { coupon, message: `Купон ${coupon.code} створено` });
    } catch (error) {
      fail(res, error, "create");
    }
  }

  async update(req, res) {
    try {
      const { id } = req.params;
      if (!isId(id)) return responseReturn(res, 404, { error: "Купон не знайдено" });
      const current = await couponModel.findById(id);
      if (!current) return responseReturn(res, 404, { error: "Купон не знайдено" });

      // Поля, яких не передали, беремо з поточного купона — інакше вони б «скинулися» до типових
      const cur = current.toObject();
      const merged = { ...cur, ...(req.body || {}), code: current.code };
      const result = couponService.sanitizeCoupon(merged, { requireCode: false });
      if (result.error) return responseReturn(res, 400, { error: result.error });
      const patch = result.value;
      delete patch.code; // код після створення не змінюємо (його могли вже роздати)
      if (patch.totalLimit != null && patch.totalLimit < current.usedCount) {
        return responseReturn(res, 400, {
          error: `Загальний ліміт не може бути меншим за кількість використань (${current.usedCount})`,
        });
      }
      const coupon = await couponModel.findByIdAndUpdate(id, { $set: patch }, { new: true });
      responseReturn(res, 200, { coupon, message: "Купон збережено" });
    } catch (error) {
      fail(res, error, "update");
    }
  }

  async set_active(req, res) {
    try {
      const { id } = req.params;
      if (!isId(id)) return responseReturn(res, 404, { error: "Купон не знайдено" });
      const active = req.body?.active === true;
      const coupon = await couponModel.findByIdAndUpdate(id, { $set: { active } }, { new: true });
      if (!coupon) return responseReturn(res, 404, { error: "Купон не знайдено" });
      responseReturn(res, 200, { coupon, message: active ? "Купон увімкнено" : "Купон вимкнено" });
    } catch (error) {
      fail(res, error, "set_active");
    }
  }

  async remove(req, res) {
    try {
      const { id } = req.params;
      if (!isId(id)) return responseReturn(res, 404, { error: "Купон не знайдено" });
      // Купон, який уже використовувався, видаляти не можна — лише вимкнути (історія для обліку)
      if (await couponRedemptionModel.exists({ couponId: id })) {
        return responseReturn(res, 409, {
          error: "Купон уже використовувався — його можна лише вимкнути",
        });
      }
      const removed = await couponModel.findByIdAndDelete(id);
      if (!removed) return responseReturn(res, 404, { error: "Купон не знайдено" });
      responseReturn(res, 200, { message: "Купон видалено", id });
    } catch (error) {
      fail(res, error, "remove");
    }
  }

  async redemptions(req, res) {
    try {
      const { id } = req.params;
      if (!isId(id)) return responseReturn(res, 404, { error: "Купон не знайдено" });
      let { page = 1, perPage = 20 } = req.query;
      page = Math.max(1, parseInt(page) || 1);
      perPage = Math.min(100, Math.max(1, parseInt(perPage) || 20));
      const filter = { couponId: new mongoose.Types.ObjectId(id) };
      const [list, total] = await Promise.all([
        couponRedemptionModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * perPage).limit(perPage).lean(),
        couponRedemptionModel.countDocuments(filter),
      ]);
      responseReturn(res, 200, { redemptions: list, total });
    } catch (error) {
      fail(res, error, "redemptions");
    }
  }
}

module.exports = new couponController();
