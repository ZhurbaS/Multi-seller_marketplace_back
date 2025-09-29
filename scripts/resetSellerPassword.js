// scripts/resetSellerPassword.js
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const sellerModel = require("../models/sellerModel"); // поправ шлях якщо треба

(async () => {
  try {
    await mongoose.connect(process.env.DB_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    const sellerId = "68a5cdd5a626bb3c65b22730"; // встав тут seller._id
    const newPlain = "123456"; // новий пароль який хочеш поставити

    const saltRounds = parseInt(process.env.SALT_ROUNDS) || 10;
    const newHash = await bcrypt.hash(newPlain, saltRounds);

    const res = await sellerModel.findByIdAndUpdate(sellerId, {
      password: newHash,
    });
    if (!res) {
      console.log("Seller not found");
    } else {
      console.log("Password updated successfully for", sellerId);
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
