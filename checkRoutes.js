const paths = [
  "./routes/home/homeRoutes",
  "./routes/authRoutes",
  "./routes/order/orderRoutes",
  "./routes/home/cardRoutes",
  "./routes/dashboard/categoryRoutes",
  "./routes/dashboard/productRoutes",
  "./routes/dashboard/sellerRoutes",
  "./routes/home/customerAuthRoutes",
  "./routes/chatRoutes",
  "./routes/paymentRoutes",
];

paths.forEach((p) => {
  try {
    console.log("Requiring", p);
    require(p);
    console.log("OK", p);
  } catch (e) {
    console.error("ERROR requiring", p);
    console.error(e);
    process.exit(1);
  }
});
