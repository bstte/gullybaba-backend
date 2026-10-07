const express = require("express");
const router = express.Router();
const exportController = require("../controllers/exportController");
const authMiddleware = require("../middleware/auth");

router.get("/inspect", authMiddleware, exportController.inspectExport);
router.get("/categories", authMiddleware, exportController.getCategories);
router.get("/states-and-cities", authMiddleware, exportController.getStatesAndCities);
router.get("/download", authMiddleware, exportController.downloadExport);

module.exports = router;
