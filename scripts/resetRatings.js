// One-off cleanup: resets every product's rating to 0. Needed once, after
// switching review approval to a moderation flow — old products still carry
// a "rating" value computed under the previous logic (every submitted
// review recalculated it instantly). Run once, then this file can be
// deleted; ratings now only update when an admin approves a review.
require("dotenv").config();
const { dbConnect } = require("../utiles/db");
const productModel = require("../models/productModel");

(async () => {
  try {
    await dbConnect();
    const result = await productModel.updateMany({}, { $set: { rating: 0 } });
    console.log(`✅ Скинуто рейтинг у ${result.modifiedCount} товарів`);
  } catch (error) {
    console.error("❌ Помилка:", error.message);
  } finally {
    process.exit(0);
  }
})();
