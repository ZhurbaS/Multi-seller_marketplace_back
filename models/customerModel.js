const { Schema, model } = require("mongoose");

const customerSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    // Гостьовий (м'який) акаунт ще може не мати e-mail/телефону: їх покупець вказує при оформленні замовлення
    isGuest: { type: Boolean, default: false },
    // Гість без контактів автоматично видаляється через 30 днів (TTL); при вказанні e-mail поле знімається
    guestExpiresAt: { type: Date, default: undefined },
    email: {
      type: String,
      required: function () {
        return !this.isGuest;
      },
    },
    emailVerified: { type: Boolean, default: false },
    // Без пароля — гості й акаунти Google (входять за кодом на e-mail або через Google)
    password: {
      type: String,
      required: function () {
        return this.method === "manually";
      },
      select: false,
    },
    phone: {
      type: String,
      required: function () {
        return !this.isGuest && this.method === "manually";
      },
      match: [/^\+?\d{10,15}$/, "Please fill a valid phone number"], // Валідація для номеру телефону
    },
    // manually | guest | google
    method: {
      type: String,
      required: true,
    },
    googleId: { type: String, default: undefined, index: true, sparse: true },
    // Одноразовий код входу (лише хеш)
    otp: {
      type: { codeHash: String, expiresAt: Date, sentAt: Date, attempts: { type: Number, default: 0 } },
      default: undefined,
      select: false,
    },
    // Журнал згод: прийняті редакції документів + маркетингова згода (окремо, необов'язкова)
    consents: { type: [Object], default: [] },
    marketing: { type: Object, default: undefined },
    // Збережені під час оформлення: інші отримувачі й організації (до 10 кожних)
    savedRecipients: {
      type: [
        {
          lastName: String,
          firstName: String,
          middleName: { type: String, default: "" },
          phone: String,
        },
      ],
      default: [],
    },
    savedAddresses: {
      type: [
        {
          deliveryType: String,
          district: { type: String, default: "" },
          city: { type: String, default: "" },
          cityRef: { type: String, default: "" },
          settlementRef: { type: String, default: "" },
          warehouse: { type: String, default: "" },
          warehouseRef: { type: String, default: "" },
          address: { type: String, default: "" },
          post: { type: String, default: "" },
          area: { type: String, default: "" },
        },
      ],
      default: [],
    },
    // Зміна e-mail: очікує підтвердження кодом (код — лише у вигляді HMAC)
    pendingEmail: {
      type: { email: String, codeHash: String, expiresAt: Date, sentAt: Date, attempts: { type: Number, default: 0 } },
      default: undefined,
      select: false,
    },
    savedCompanies: {
      type: [{ companyName: String, edrpou: String, ipn: { type: String, default: "" } }],
      default: [],
    },
  },
  { timestamps: true }
);

customerSchema.index({ guestExpiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model("customers", customerSchema);
