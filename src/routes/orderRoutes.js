const express = require("express");
const router = express.Router();
const orderController = require("../controllers/orderController");
const localOrderController = require("../controllers/localOrderController");
const authMiddleware = require("../middleware/auth");
const checkWebhookSecret = require("../middleware/checkWebhookSecret");
const checkOrdersAccess = require("../middleware/checkOrdersAccess");
const {
  checkEditUserDetail,
  checkEditOrderStatus,
  checkSendToShiprocket,
  checkSendToTekipost,
  checkOrderWeight,
  checkOrderNote,
  checkDeleteNote,
  checkViewOrder,
} = require("../middleware/checkOrdersAccess");

router.get("/local", authMiddleware, checkOrdersAccess, localOrderController.getLocalOrders);
router.get("/local/:id", authMiddleware, checkOrdersAccess, checkViewOrder, localOrderController.getLocalOrderById);
router.get("/local/:id/weight", authMiddleware, checkOrdersAccess, checkOrderWeight, localOrderController.getOrderWeight);
router.post("/local/:id/tekipost-preview", authMiddleware, checkOrdersAccess, checkSendToTekipost, localOrderController.previewTekipost);
router.post("/local/:id/shiprocket-preview", authMiddleware, checkOrdersAccess, checkSendToShiprocket, localOrderController.previewShiprocket);
router.get("/local/:id/tekipost-status", authMiddleware, checkOrdersAccess, localOrderController.fetchTekipostStatus);
router.get("/local/:id/shiprocket-status", authMiddleware, checkOrdersAccess, localOrderController.fetchShiprocketStatus);
router.get("/local/:id/notes", authMiddleware, checkOrdersAccess, checkOrderNote, localOrderController.getOrderNotes);
router.post("/local/:id/notes", authMiddleware, checkOrdersAccess, checkOrderNote, localOrderController.addOrderNote);
router.delete("/local/:id/notes/:noteId", authMiddleware, checkOrdersAccess, checkDeleteNote, localOrderController.deleteOrderNote);

// Orders were previously served live from the WordPress/WooCommerce REST API.
// Now served from the local PostgreSQL copy of the orders table instead.
// router.get("/", authMiddleware, orderController.getOrders);
// router.put("/:id/status", authMiddleware, orderController.updateStatus);
router.get("/status-counts", authMiddleware, checkOrdersAccess, localOrderController.getStatusCounts);
router.get("/categories", authMiddleware, checkOrdersAccess, localOrderController.getCategories);
router.get("/months", authMiddleware, checkOrdersAccess, localOrderController.getMonths);
router.get("/", authMiddleware, checkOrdersAccess, localOrderController.getOrders);
router.put("/:id/status", authMiddleware, checkOrdersAccess, checkEditOrderStatus, localOrderController.updateStatus);
router.put("/:id/address", authMiddleware, checkOrdersAccess, checkEditUserDetail, localOrderController.updateAddress);

// Called FROM WordPress when a new order is created — server-to-server, gated by a shared
// secret (see middleware/checkWebhookSecret.js) instead of the admin-panel JWT.
router.post("/create", checkWebhookSecret, localOrderController.createOrder);

module.exports = router;
