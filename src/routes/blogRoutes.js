const express = require("express");
const router = express.Router();
const blogController = require("../controllers/blogController");
const authMiddleware = require("../middleware/auth");

router.get("/", authMiddleware, blogController.getPosts);

module.exports = router;
