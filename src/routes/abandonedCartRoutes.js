const express = require("express");
const router = express.Router();
const abandonedCartController = require("../controllers/abandonedCartController");
const authMiddleware = require("../middleware/auth");

router.get("/", authMiddleware, abandonedCartController.getAbandonedCarts);

module.exports = router;
