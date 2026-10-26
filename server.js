require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const http = require("http");
const socket = require("socket.io");
const { dbConnect } = require("./utiles/db");

const app = express();
const server = http.createServer(app);

// Додаткові дозволені адреси (Codespaces тощо) беруться з .env — через кому,
// без пробілів і без слеша в кінці. Редагувати server.js для цього не потрібно.
const extraOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

const allowedOrigins =
  process.env.NODE_ENV === "production"
    ? [
        process.env.client_customer_production_url,
        process.env.client_admin_production_url,
        ...extraOrigins,
      ]
    : [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5000",
        "http://localhost:5001",
        "http://localhost:5002",
        ...extraOrigins,
      ];

// Попередження на старті: заглушки в .env призводять до неочевидних помилок
// (наприклад, Cloudinary з CLOUD_NAME=dummy відповідає «Too many concurrent requests»).
const looksLikePlaceholder = (v) => !v || /^(dummy|sk_test_dummy|changeme)$/i.test(v);
if (
  looksLikePlaceholder(process.env.CLOUD_NAME) ||
  looksLikePlaceholder(process.env.API_KEY) ||
  looksLikePlaceholder(process.env.API_SECRET)
) {
  console.warn(
    "⚠️  Cloudinary не налаштовано (CLOUD_NAME/API_KEY/API_SECRET порожні або dummy): завантаження фото товарів не працюватиме. Див. SETUP.md."
  );
}
{
  const pay = require("./payments/config");
  const on = [
    pay.monobankEnabled() && "monobank",
    pay.liqpayEnabled() && "LiqPay",
    pay.mockEnabled() && "mock (тест)",
    pay.codEnabled() && "оплата при отриманні",
  ].filter(Boolean);
  console.log(`💳 Способи оплати: ${on.join(", ") || "жодного"}`);
  if (
    (pay.monobankEnabled() || pay.liqpayEnabled()) &&
    /localhost/.test(pay.publicApiUrl())
  ) {
    console.warn(
      "⚠️  PUBLIC_API_URL не задано/localhost: monobank і LiqPay не зможуть надіслати вебхук. Задайте публічну адресу бека (Codespaces: порт 5000). Див. SETUP.md."
    );
  }
}
if (process.env.NODE_ENV !== "production" && extraOrigins.length === 0) {
  console.warn(
    "ℹ️  ALLOWED_ORIGINS порожній: у Codespaces додайте адреси фронта й дашборду в .env, інакше браузер заблокує запити (CORS). Див. SETUP.md."
  );
}

// rawBody зберігаємо для перевірки підпису вебхуків (monobank підписує сире тіло запиту).
app.use(
  bodyParser.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(cookieParser());

app.use(
  cors({
    origin: function (origin, callback) {
      // console.log("🌍 Incoming Origin:", origin);
      // console.log("✅ Allowed Origins:", allowedOrigins);
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

// CORS для Socket.IO
const io = socket(server, {
  cors: {
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  },
});

var allCustomer = [];
var allSeller = [];
var admin = {};

const addUser = (customerId, socketId, userInfo) => {
  const checkUser = allCustomer.some((u) => u.customerId === customerId);
  if (!checkUser) {
    allCustomer.push({
      customerId,
      socketId,
      userInfo,
    });
  }
};

const addSeller = (sellerId, socketId, userInfo) => {
  const checkSeller = allSeller.some((u) => u.sellerId === sellerId);
  if (!checkSeller) {
    allSeller.push({
      sellerId,
      socketId,
      userInfo,
    });
  }
};

const findCustomer = (customerId) => {
  return allCustomer.find((c) => c.customerId === customerId);
};

const findSeller = (sellerId) => {
  return allSeller.find((c) => c.sellerId === sellerId);
};

const remove = (socketId) => {
  allCustomer = allCustomer.filter((c) => c.socketId !== socketId);
  allSeller = allSeller.filter((c) => c.socketId !== socketId);
};

io.on("connection", (soc) => {
  console.log("✔️  Socket server is running");

  soc.on("add_user", (customerId, userInfo) => {
    // console.log(userInfo);
    addUser(customerId, soc.id, userInfo);
    // console.log(allCustomer);
    io.emit("activeSeller", allSeller);
  });

  soc.on("add_seller", (sellerId, userInfo) => {
    // console.log(sellerId, userInfo);
    addSeller(sellerId, soc.id, userInfo);
    io.emit("activeSeller", allSeller);
  });

  soc.on("send_seller_message", (msg) => {
    // console.log(msg);
    const customer = findCustomer(msg.receiverId); // customerId
    // console.log(customer);
    if (customer !== undefined) {
      soc.to(customer.socketId).emit("seller_message", msg);
    }
  });

  soc.on("send_customer_message", (msg) => {
    // console.log(msg);
    const seller = findSeller(msg.receiverId); // customerId
    // console.log(seller);
    if (seller !== undefined) {
      soc.to(seller.socketId).emit("customer_message", msg);
    }
  });

  soc.on("send_message_admin_to_seller", (msg) => {
    // console.log(msg);
    const seller = findSeller(msg.receiverId);
    // console.log(seller);
    if (seller !== undefined) {
      soc.to(seller.socketId).emit("received_admin_message", msg);
    }
  });

  soc.on("send_message_seller_to_admin", (msg) => {
    if (admin.socketId) {
      soc.to(admin.socketId).emit("received_seller_message", msg);
    }
  });

  soc.on("add_admin", (adminInfo) => {
    delete adminInfo.email;
    delete adminInfo.password;
    admin = adminInfo;
    admin.socketId = soc.id;
  });

  soc.on("disconnect", () => {
    console.log("user disconnected");
    remove(soc.id);
    io.emit("activeSeller", allSeller);
  });
});

app.use("/api/home", require("./routes/home/homeRoutes"));
app.use("/api", require("./routes/authRoutes"));
app.use("/api", require("./routes/order/orderRoutes"));
app.use("/api", require("./routes/order/payRoutes"));
app.use("/api", require("./routes/home/cardRoutes"));
app.use("/api", require("./routes/dashboard/categoryRoutes"));
app.use("/api", require("./routes/dashboard/productRoutes"));
app.use("/api", require("./routes/dashboard/sellerRoutes"));
app.use("/api", require("./routes/home/customerAuthRoutes"));
app.use("/api", require("./routes/chatRoutes"));
app.use("/api", require("./routes/paymentRoutes"));
app.use("/api", require("./routes/dashboard/dashboardRoutes"));

app.get("/", (req, res) => res.send("My backend"));

const port = process.env.PORT;
(async () => {
  try {
    await dbConnect();
    server.listen(port, () =>
      console.log(`✅ Server is running on port ${port}`)
    );
  } catch (error) {
    console.error("❌ Failed to start server due to DB error.");
    process.exit(1);
  }
})();
