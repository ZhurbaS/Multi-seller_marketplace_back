const { Schema, model } = require("mongoose");

const customerSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    phone: {
      type: String,
      required: true,
      match: [/^\+?\d{10,15}$/, "Please fill a valid phone number"], // Валідація для номеру телефону
    },
    method: {
      type: String,
      required: true,
    },
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
    savedCompanies: {
      type: [{ companyName: String, edrpou: String, ipn: { type: String, default: "" } }],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = model("customers", customerSchema);
