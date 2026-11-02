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
    savedCompanies: {
      type: [{ companyName: String, edrpou: String, ipn: { type: String, default: "" } }],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = model("customers", customerSchema);
