const express = require("express");
const router = express.Router();
const orderController = require("../controllers/orderController");
const localOrderController = require("../controllers/localOrderController");
const authMiddleware = require("../middleware/auth");

router.get("/local", authMiddleware, localOrderController.getLocalOrders);
router.get("/local/:id", authMiddleware, localOrderController.getLocalOrderById);
router.get("/local/:id/weight", authMiddleware, localOrderController.getOrderWeight);
router.post("/local/:id/tekipost-preview", authMiddleware, localOrderController.previewTekipost);
router.post("/local/:id/shiprocket-preview", authMiddleware, localOrderController.previewShiprocket);
router.get("/local/:id/tekipost-status", authMiddleware, localOrderController.fetchTekipostStatus);
router.get("/local/:id/shiprocket-status", authMiddleware, localOrderController.fetchShiprocketStatus);
router.get("/local/:id/notes", authMiddleware, localOrderController.getOrderNotes);
router.post("/local/:id/notes", authMiddleware, localOrderController.addOrderNote);
router.delete("/local/:id/notes/:noteId", authMiddleware, localOrderController.deleteOrderNote);

// Orders were previously served live from the WordPress/WooCommerce REST API.
// Now served from the local PostgreSQL copy of the orders table instead.
// router.get("/", authMiddleware, orderController.getOrders);
// router.put("/:id/status", authMiddleware, orderController.updateStatus);
router.get("/status-counts", authMiddleware, localOrderController.getStatusCounts);
router.get("/", authMiddleware, localOrderController.getOrders);
router.put("/:id/status", authMiddleware, localOrderController.updateStatus);

module.exports = router;
