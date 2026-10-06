const https = require("https");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

// Helper function to make HTTPS requests to WordPress REST API
function makeWpRequest(urlStr, method = "GET", payload = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const authHeader = getBasicAuthHeader();

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        "Authorization": authHeader,
        "User-Agent": "Gullybaba-Portal",
      },
      timeout: 15000,
    };

    if (payload) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`WordPress API returned status ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Failed to parse WordPress response: ${err.message}`));
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("WordPress API request timed out"));
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// 1. Get List of all Contact Forms & Submissions Count (Purely Dynamic from WordPress)
exports.getContactForms = async (req, res) => {
  try {
    const url = getApiUrl("contactForms");
    const wpRes = await makeWpRequest(url, "GET");

    if (wpRes && wpRes.success) {
      return res.json({
        success: true,
        forms: wpRes.data || [],
        total: (wpRes.data || []).length,
      });
    }

    return res.status(500).json({
      success: false,
      message: wpRes.message || "Failed to fetch contact forms from WordPress",
    });
  } catch (error) {
    console.error("[contact-forms] WordPress API Error:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch contact forms from WordPress",
    });
  }
};

// 2. Get Submissions for a Specific Form (Purely Dynamic with Pagination, Search, Filter)
exports.getFormSubmissions = async (req, res) => {
  const { formId } = req.params;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const search = (req.query.search || "").trim();
  const status = (req.query.status || "all").trim();

  try {
    const queryParams = {
      page,
      limit,
      search,
      status,
    };
    const url = getApiUrl("contactForms", queryParams, `${formId}/submissions`);
    const wpRes = await makeWpRequest(url, "GET");

    if (wpRes && wpRes.success) {
      return res.json({
        success: true,
        form: wpRes.form,
        columns: wpRes.columns || [],
        submissions: wpRes.submissions || [],
        pagination: wpRes.pagination || {
          page,
          limit,
          total: (wpRes.submissions || []).length,
          totalPages: 1,
        },
      });
    }

    return res.status(500).json({
      success: false,
      message: wpRes.message || "Failed to fetch submissions from WordPress",
    });
  } catch (error) {
    console.error(`[contact-forms] Error fetching submissions for form ${formId}:`, error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch form submissions from WordPress",
    });
  }
};

// 3. Get Single Submission Detail
exports.getSubmissionDetail = async (req, res) => {
  const { submissionId } = req.params;
  try {
    const url = getApiUrl("contactForms", {}, `submissions/${submissionId}`);
    const wpRes = await makeWpRequest(url, "GET");
    if (wpRes && wpRes.success) {
      return res.json(wpRes);
    }
    return res.status(404).json({
      success: false,
      message: wpRes.message || `Submission #${submissionId} not found`,
    });
  } catch (error) {
    console.error(`[contact-forms] Error fetching submission #${submissionId}:`, error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch submission detail from WordPress",
    });
  }
};

// 4. Update Submission Status (Read / Unread)
exports.updateSubmissionStatus = async (req, res) => {
  const { submissionId } = req.params;
  const { status } = req.body;

  try {
    const url = getApiUrl("contactForms", {}, `submissions/${submissionId}/status`);
    const wpRes = await makeWpRequest(url, "PUT", JSON.stringify({ status }));
    return res.json(wpRes);
  } catch (error) {
    console.error(`[contact-forms] Error updating status for #${submissionId}:`, error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update submission status in WordPress",
    });
  }
};

// 5. Delete Submission
exports.deleteSubmission = async (req, res) => {
  const { submissionId } = req.params;
  try {
    const url = getApiUrl("contactForms", {}, `submissions/${submissionId}`);
    const wpRes = await makeWpRequest(url, "DELETE");
    return res.json(wpRes);
  } catch (error) {
    console.error(`[contact-forms] Error deleting submission #${submissionId}:`, error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to delete submission from WordPress",
    });
  }
};
