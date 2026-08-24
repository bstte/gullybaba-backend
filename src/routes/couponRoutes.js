const express = require("express");
const router = express.Router();
const couponController = require("../controllers/couponController");
const authMiddleware = require("../middleware/auth");

router.get("/", authMiddleware, couponController.getCoupons);

module.exports = router;
