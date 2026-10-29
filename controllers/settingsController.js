const mongoose = require("mongoose");
const storeSettingsModel = require("../models/storeSettingsModel");
const sellerModel = require("../models/sellerModel");
const pricing = require("../utiles/pricing");
const returnPolicy = require("../utiles/returnPolicy");
const invoiceLib = require("../utiles/invoice");
const { responseReturn } = require("../utiles/response");

// Налаштування магазину з типовими значеннями (документа ще може не бути).
async function loadSettings() {
  const s = (await storeSettingsModel.findOne({ key: "main" }).lean()) || {};
  return {
    orderDiscountTiers: s.orderDiscountTiers || [],
    defaultCommissionPercent:
      typeof s.defaultCommissionPercent === "number" ? s.defaultCommissionPercent : 10,
    categoryCommissions: s.categoryCommissions || [],
    payoutHoldDays: typeof s.payoutHoldDays === "number" ? s.payoutHoldDays : 14,
    returns: returnPolicy.normalizePolicy(s.returns),
    company: invoiceLib.normalizeCompany(s.company),
  };
}

// Використовується в кошику й оформленні замовлення.
async function loadOrderDiscountTiers() {
  return (await loadSettings()).orderDiscountTiers;
}

class settingsController {
  // Публічно: покупцю показуємо «від ₴5000 знижка 3%»
  async get_discounts(req, res) {
    try {
      const tiers = await loadOrderDiscountTiers();
      responseReturn(res, 200, { orderDiscountTiers: tiers });
    } catch (error) {
      console.error("💥 settingsController.get_discounts:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Лише адмін
  async update_discounts(req, res) {
    try {
      const result = pricing.sanitizeOrderTiers(req.body?.orderDiscountTiers);
      if (result.error) return responseReturn(res, 400, { error: result.error });
      const s = await storeSettingsModel.findOneAndUpdate(
        { key: "main" },
        { $set: { orderDiscountTiers: result.value } },
        { upsert: true, new: true }
      );
      responseReturn(res, 200, {
        orderDiscountTiers: s.orderDiscountTiers,
        message: "Знижки збережено",
      });
    } catch (error) {
      console.error("💥 settingsController.update_discounts:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Адмін: комісія за замовчуванням, ставки категорій, утримання виплат
  async get_commission(req, res) {
    try {
      const s = await loadSettings();
      responseReturn(res, 200, {
        defaultCommissionPercent: s.defaultCommissionPercent,
        categoryCommissions: s.categoryCommissions,
        payoutHoldDays: s.payoutHoldDays,
      });
    } catch (error) {
      console.error("💥 settingsController.get_commission:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  async update_commission(req, res) {
    try {
      const result = pricing.sanitizeCommissionSettings(req.body);
      if (result.error) return responseReturn(res, 400, { error: result.error });
      const s = await storeSettingsModel.findOneAndUpdate(
        { key: "main" },
        { $set: result.value },
        { upsert: true, new: true }
      );
      responseReturn(res, 200, {
        defaultCommissionPercent: s.defaultCommissionPercent,
        categoryCommissions: s.categoryCommissions,
        payoutHoldDays: s.payoutHoldDays,
        message: "Налаштування комісії збережено",
      });
    } catch (error) {
      console.error("💥 settingsController.update_commission:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Адмін: індивідуальна комісія продавця (null — за категорією/типова, 0 — власний магазин)
  async update_seller_commission(req, res) {
    try {
      const { sellerId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(sellerId)) {
        return responseReturn(res, 400, { error: "Некоректний продавець" });
      }
      const raw = req.body?.percent;
      let percent = null;
      if (raw !== null && raw !== "" && raw !== undefined) {
        percent = Number(raw);
        if (!Number.isFinite(percent) || percent < 0 || percent > 50) {
          return responseReturn(res, 400, { error: "Комісія: відсоток від 0 до 50" });
        }
      }
      const seller = await sellerModel.findByIdAndUpdate(
        sellerId,
        { commissionPercent: percent },
        { new: true }
      );
      if (!seller) return responseReturn(res, 404, { error: "Продавця не знайдено" });
      responseReturn(res, 200, {
        commissionPercent: seller.commissionPercent,
        message:
          percent === null
            ? "Індивідуальну комісію прибрано"
            : percent === 0
            ? "Власний магазин: комісія 0%"
            : `Комісію встановлено: ${percent}%`,
      });
    } catch (error) {
      console.error("💥 settingsController.update_seller_commission:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Політика повернень: адмін бачить усе (+ попередження щодо законодавства)
  async get_returns_policy(req, res) {
    try {
      const { returns } = await loadSettings();
      responseReturn(res, 200, { policy: returns, warnings: returnPolicy.policyWarnings(returns) });
    } catch (error) {
      console.error("💥 settingsController.get_returns_policy:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  async update_returns_policy(req, res) {
    try {
      const result = returnPolicy.sanitizePolicy(req.body);
      if (result.error) return responseReturn(res, 400, { error: result.error });
      await storeSettingsModel.findOneAndUpdate(
        { key: "main" },
        { $set: { returns: result.value } },
        { upsert: true, new: true }
      );
      responseReturn(res, 200, {
        policy: result.value,
        warnings: returnPolicy.policyWarnings(result.value),
        message: "Умови повернення збережено",
      });
    } catch (error) {
      console.error("💥 settingsController.update_returns_policy:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Реквізити магазину для рахунків юрособам (лише адмін)
  async get_company(req, res) {
    try {
      const { company } = await loadSettings();
      responseReturn(res, 200, { company, configured: invoiceLib.isCompanyConfigured(company) });
    } catch (error) {
      console.error("💥 settingsController.get_company:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  async update_company(req, res) {
    try {
      const result = invoiceLib.sanitizeCompany(req.body);
      if (result.error) return responseReturn(res, 400, { error: result.error });
      await storeSettingsModel.findOneAndUpdate(
        { key: "main" },
        { $set: { company: result.value } },
        { upsert: true, new: true }
      );
      responseReturn(res, 200, { company: result.value, configured: true, message: "Реквізити збережено" });
    } catch (error) {
      console.error("💥 settingsController.update_company:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Публічна частина політики: текст, контакти, прапорці видимості (без внутрішніх налаштувань)
  async get_public_returns_policy(req, res) {
    try {
      const { returns: p } = await loadSettings();
      responseReturn(res, 200, {
        enabled: p.enabled,
        cabinetVisible: p.cabinetVisible,
        policyText: p.policyText,
        returnAddress: p.returnAddress,
        contactInfo: p.contactInfo,
        refundDeadlineDays: p.refundDeadlineDays,
        individual: {
          withdrawalAllowed: p.individual.withdrawalAllowed,
          withdrawalDays: p.individual.withdrawalDays,
          defectAllowed: p.individual.defectAllowed,
          defectDays: p.individual.defectDays,
        },
        company: {
          withdrawalAllowed: p.company.withdrawalAllowed,
          withdrawalDays: p.company.withdrawalDays,
          defectAllowed: p.company.defectAllowed,
          defectDays: p.company.defectDays,
        },
      });
    } catch (error) {
      console.error("💥 settingsController.get_public_returns_policy:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Продавець: яку комісію він платить (для підказки «ви отримаєте» у формі товару)
  async get_seller_commission_info(req, res) {
    try {
      const [s, seller] = await Promise.all([
        loadSettings(),
        sellerModel.findById(req.id).select("commissionPercent"),
      ]);
      const categoryRates = {};
      for (const c of s.categoryCommissions) categoryRates[String(c.categoryId)] = c.percent;
      responseReturn(res, 200, {
        sellerPercent:
          typeof seller?.commissionPercent === "number" ? seller.commissionPercent : null,
        defaultPercent: s.defaultCommissionPercent,
        categoryRates,
        payoutHoldDays: s.payoutHoldDays,
      });
    } catch (error) {
      console.error("💥 settingsController.get_seller_commission_info:", error.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }
}

module.exports = new settingsController();
module.exports.loadSettings = loadSettings;
module.exports.loadOrderDiscountTiers = loadOrderDiscountTiers;
