const express = require("express");
const app = express();
const cors = require("cors");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const { dbConnect } = require("./utiles/db");

const socket = require("socket.io");
const http = require("http");
const server = http.createServer(app);

app.use(
  cors({
    origin: [
      `http://localhost:5174`,
      `http://localhost:5173`,
      `http://localhost:5001`,
    ],
    credentials: true,
  })
);

const io = socket(server, {
  cors: {
    origin: "*",
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
    io.emit("activeSeller", allSeller);
  });
});

require("dotenv").config();

app.use(bodyParser.json());
app.use(cookieParser());

app.use("/api/home", require("./routes/home/homeRoutes"));
app.use("/api", require("./routes/authRoutes"));
app.use("/api", require("./routes/order/orderRoutes"));
app.use("/api", require("./routes/home/cardRoutes"));
app.use("/api", require("./routes/dashboard/categoryRoutes"));
app.use("/api", require("./routes/dashboard/productRoutes"));
app.use("/api", require("./routes/dashboard/sellerRoutes"));
app.use("/api", require("./routes/home/customerAuthRoutes"));
app.use("/api", require("./routes/chatRoutes"));

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
