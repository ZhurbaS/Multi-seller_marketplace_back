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
  },
  { timestamps: true }
);

module.exports = model("customers", customerSchema);
