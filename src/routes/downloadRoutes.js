const express = require("express");
const router = express.Router();
const downloadController = require("../controllers/downloadController");
const authMiddleware = require("../middleware/auth");

router.get("/", authMiddleware, downloadController.getDownloads);
router.get("/file", authMiddleware, downloadController.downloadFile);

module.exports = router;
