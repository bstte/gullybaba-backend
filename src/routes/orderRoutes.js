const express = require("express");
const router = express.Router();
const orderController = require("../controllers/orderController");
const localOrderController = require("../controllers/localOrderController");
const authMiddleware = require("../middleware/auth");

router.get("/local", localOrderController.getLocalOrders);
router.get("/local/:id", localOrderController.getLocalOrderById);

router.get("/", authMiddleware, orderController.getOrders);
router.put("/:id/status", authMiddleware, orderController.updateStatus);

module.exports = router;
