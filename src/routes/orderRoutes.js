const express = require("express");
const router = express.Router();
const orderController = require("../controllers/orderController");
const localOrderController = require("../controllers/localOrderController");
const authMiddleware = require("../middleware/auth");

router.get("/local", authMiddleware, localOrderController.getLocalOrders);
router.get("/local/:id", authMiddleware, localOrderController.getLocalOrderById);

// Orders were previously served live from the WordPress/WooCommerce REST API.
// Now served from the local PostgreSQL copy of the orders table instead.
// router.get("/", authMiddleware, orderController.getOrders);
// router.put("/:id/status", authMiddleware, orderController.updateStatus);
router.get("/status-counts", authMiddleware, localOrderController.getStatusCounts);
router.get("/", authMiddleware, localOrderController.getOrders);
router.put("/:id/status", authMiddleware, localOrderController.updateStatus);

module.exports = router;
