const { Schema, model } = require("mongoose");

// Одиничний документ (key = "main") із налаштуваннями всього магазину.
const storeSettingsSchema = new Schema(
  {
    key: { type: String, default: "main", unique: true },
    // Комісія магазину (% від суми товару продавця). Порядок визначення ставки:
    // індивідуальна ставка продавця (0 = власний магазин) → ставка категорії → ця, типова.
    defaultCommissionPercent: { type: Number, default: 10 },
    categoryCommissions: {
      type: [
        {
          categoryId: { type: Schema.Types.ObjectId, required: true },
          percent: { type: Number, required: true },
        },
      ],
      default: [],
    },
    // Скільки днів після статусу «Доставлено» гроші лишаються на утриманні (термін повернення).
    // 0 — відкривати для виплати одразу після доставки.
    payoutHoldDays: { type: Number, default: 14 },
    // Політика повернень (повністю керується адміном). Нормалізується в utiles/returnPolicy.js.
    returns: { type: Object, default: {} },
    // Реквізити магазину для рахунків юридичним особам (див. utiles/invoice.js) і лічильник номерів рахунків.
    company: { type: Object, default: {} },
    // Юридичні документи (публічна оферта): текст, поля, вимикач показу, зафіксовані редакції — див. utiles/legalService.js
    legal: { type: Object, default: {} },
    // Месенджери для відправки рахунків (див. utiles/messengers)
    messengers: { type: Object, default: {} },
    // Тема магазину: { preset, overrides, history[] } — див. utiles/theme.js
    theme: { type: Object, default: {} },
    // Вітрина: { mode, autoThreshold, catalogBgUrl, showStoresLink } — див. utiles/storefront.js
    storefront: { type: Object, default: {} },
    // Банери: { home_hero:{autoplay, intervalSec}, announcement:{dismissible} } — див. utiles/siteBanner.js
    bannerSettings: { type: Object, default: {} },
    // Маркетинг (розсилки, автоматизації, тексти згоди) — див. utiles/marketingSettings.js
    marketing: { type: Object, default: {} },
    invoiceSeq: { type: Number, default: 0 },
    orderSeq: { type: Number, default: 0 }, // лічильник номерів замовлень (utiles/orderNumber.js)
    // Знижка за сумою замовлення: від minTotal ₴ — percent %
    orderDiscountTiers: {
      type: [
        {
          minTotal: { type: Number, required: true },
          percent: { type: Number, required: true },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = model("storeSettings", storeSettingsSchema);
