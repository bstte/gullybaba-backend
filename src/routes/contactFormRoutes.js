const express = require("express");
const router = express.Router();
const contactFormController = require("../controllers/contactFormController");
const authMiddleware = require("../middleware/auth");

router.get("/", authMiddleware, contactFormController.getContactForms);
router.get("/:formId/submissions", authMiddleware, contactFormController.getFormSubmissions);
router.get("/submissions/:submissionId", authMiddleware, contactFormController.getSubmissionDetail);
router.put("/submissions/:submissionId/status", authMiddleware, contactFormController.updateSubmissionStatus);
router.delete("/submissions/:submissionId", authMiddleware, contactFormController.deleteSubmission);

module.exports = router;
