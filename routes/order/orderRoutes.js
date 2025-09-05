const orderController = require("../../controllers/order/orderController");

const router = require("express").Router();

router.post("/home/oders/place-order", orderController.place_order);

module.exports = router;
