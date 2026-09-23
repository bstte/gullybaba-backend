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
  checkSendToDtdc,
  checkOrderWeight,
  checkOrderNote,
  checkDeleteNote,
  checkViewOrder,
} = require("../middleware/checkOrdersAccess");

router.get("/local", authMiddleware, checkOrdersAccess, localOrderController.getLocalOrders);
router.get("/downloadable-products", authMiddleware, checkOrdersAccess, localOrderController.searchDownloadableProducts);
router.get("/local/:id", authMiddleware, checkOrdersAccess, /* checkViewOrder, */ localOrderController.getLocalOrderById);
router.get("/local/:id/downloads", authMiddleware, checkOrdersAccess, localOrderController.getOrderDownloads);
router.get("/:id/downloads", authMiddleware, checkOrdersAccess, localOrderController.getOrderDownloads);
router.post("/local/:id/downloads/grant", authMiddleware, checkOrdersAccess, localOrderController.grantOrderDownloadAccess);
router.post("/:id/downloads/grant", authMiddleware, checkOrdersAccess, localOrderController.grantOrderDownloadAccess);
router.post("/local/:id/downloads/revoke", authMiddleware, checkOrdersAccess, localOrderController.revokeOrderDownloadAccess);
router.post("/:id/downloads/revoke", authMiddleware, checkOrdersAccess, localOrderController.revokeOrderDownloadAccess);
router.get("/local/:id/downloads/logs", authMiddleware, checkOrdersAccess, localOrderController.getOrderDownloadLogs);
router.get("/:id/downloads/logs", authMiddleware, checkOrdersAccess, localOrderController.getOrderDownloadLogs);
router.get("/local/:id/weight", authMiddleware, checkOrdersAccess, checkOrderWeight, localOrderController.getOrderWeight);
router.post("/local/:id/tekipost-preview", authMiddleware, checkOrdersAccess, checkSendToTekipost, localOrderController.previewTekipost);
router.post("/local/:id/shiprocket-preview", authMiddleware, checkOrdersAccess, checkSendToShiprocket, localOrderController.previewShiprocket);
router.post("/local/:id/dtdc-send", authMiddleware, checkOrdersAccess, checkSendToDtdc, localOrderController.sendToDtdc);
router.post("/local/:id/dtdc-preview", authMiddleware, checkOrdersAccess, checkSendToDtdc, localOrderController.sendToDtdc);
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

// Called FROM WordPress when order status is changed on WooCommerce — server-to-server,
// gated by shared secret (x-webhook-secret header, ?secret= query param, or secret in body).
router.post("/status/sync", checkWebhookSecret, localOrderController.syncOrderStatus);
router.post("/status-sync", checkWebhookSecret, localOrderController.syncOrderStatus);
router.post("/status", checkWebhookSecret, localOrderController.syncOrderStatus);
router.post("/:id/status/sync", checkWebhookSecret, localOrderController.syncOrderStatus);
router.post("/:id/status-sync", checkWebhookSecret, localOrderController.syncOrderStatus);
router.put("/:id/status-sync", checkWebhookSecret, localOrderController.syncOrderStatus);
router.post("/webhook/status", checkWebhookSecret, localOrderController.syncOrderStatus);

// Called FROM WordPress when an order note is added on its side (system note or wp-admin note).
router.post("/notes/sync", checkWebhookSecret, localOrderController.syncOrderNote);
router.post("/notes", checkWebhookSecret, localOrderController.syncOrderNote);
router.post("/:id/notes/sync", checkWebhookSecret, localOrderController.syncOrderNote);

// Called FROM WordPress a couple minutes after order creation, once WooCommerce's own analytics
// tables (coupon/product/tax lookup + stats) have finished computing in the background.
router.post("/:id/analytics/sync", checkWebhookSecret, localOrderController.syncOrderAnalytics);

module.exports = router;
