const mongoose = require("mongoose");

module.exports.dbConnect = async () => {
  try {
    if (process.env.NODE_ENV === "production") {
      await mongoose.connect(process.env.DB_PRO_URL, { useNewUrlParser: true });
      console.log("Database connected in production mode...");
    } else {
      await mongoose.connect(process.env.DB_LOCAL_URL, {
        useNewUrlParser: true,
      });
      console.log("Local database connected...");
    }
  } catch (error) {
    // console.log(error.message);
    throw error;
  }
};
