const express = require("express");
const router = express.Router();
const wcAbandonedCartController = require("../controllers/wcAbandonedCartController");
const authMiddleware = require("../middleware/auth");

router.get("/", authMiddleware, wcAbandonedCartController.getWcAbandonedCarts);
router.put("/:id/notes", authMiddleware, wcAbandonedCartController.updateWcAbandonedCartNote);

module.exports = router;
