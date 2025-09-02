const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const { dbConnect } = require("./utiles/db");

app.use(
  cors({
    origin: [`http://localhost:5174`, `http://localhost:5173`],
    credentials: true,
  })
);
app.use(bodyParser.json());
app.use(cookieParser());

app.use("/api/home", require("./routes/home/homeRoutes"));
app.use("/api", require("./routes/authRoutes"));
app.use("/api", require("./routes/home/cardRoutes"));
app.use("/api", require("./routes/dashboard/categoryRoutes"));
app.use("/api", require("./routes/dashboard/productRoutes"));
app.use("/api", require("./routes/dashboard/sellerRoutes"));
app.use("/api", require("./routes/home/customerAuthRoutes"));

app.get("/", (req, res) => res.send("My backend"));

const port = process.env.PORT;
(async () => {
  try {
    await dbConnect();
    app.listen(port, () => console.log(`✅ Server is running on port ${port}`));
  } catch (error) {
    console.error("❌ Failed to start server due to DB error.");
    process.exit(1);
  }
})();
