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

// 1. Get List of all downloads for a category (e.g. cod-orders, abandoned-carts, etc.)
exports.getDownloads = async (req, res) => {
  const type = (req.query.type || "cod-orders").trim();
  const search = (req.query.search || "").trim();

  try {
    const queryParams = { type };
    if (search) {
      queryParams.search = search;
    }

    const url = getApiUrl("downloads", queryParams);
    const wpRes = await makeWpRequest(url, "GET");

    if (wpRes && wpRes.success !== undefined) {
      return res.json({
        success: wpRes.success,
        type: wpRes.type || type,
        directory: wpRes.directory,
        total: wpRes.total !== undefined ? wpRes.total : (wpRes.downloads || []).length,
        downloads: wpRes.downloads || [],
        message: wpRes.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: (wpRes && wpRes.message) || "Failed to fetch downloads list from WordPress",
      downloads: [],
    });
  } catch (error) {
    console.error("[downloads] WordPress API Error:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch downloads from WordPress",
      downloads: [],
    });
  }
};

// 2. Proxy download of file directly from WordPress
exports.downloadFile = async (req, res) => {
  const filename = (req.query.file || "").trim();
  if (!filename) {
    return res.status(400).json({ success: false, message: "File name is required" });
  }

  // Prevent directory traversal attacks
  const safeFilename = filename.replace(/^.*[\\\/]/, "");
  const type = (req.query.type || "cod-orders").trim();

  try {
    const url = new URL(getApiUrl("downloads", { file: safeFilename, type }, "file"));
    const authHeader = getBasicAuthHeader();

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        "Authorization": authHeader,
        "User-Agent": "Gullybaba-Portal",
      },
      timeout: 30000,
    };

    const wpReq = https.request(options, (wpRes) => {
      if (wpRes.statusCode !== 200) {
        return res.status(wpRes.statusCode).json({
          success: false,
          message: `Failed to download file from WordPress (status: ${wpRes.statusCode})`,
        });
      }

      res.setHeader("Content-Type", wpRes.headers["content-type"] || "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
      if (wpRes.headers["content-length"]) {
        res.setHeader("Content-Length", wpRes.headers["content-length"]);
      }

      wpRes.pipe(res);
    });

    wpReq.on("error", (err) => {
      console.error("[downloads] Stream error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: "Stream error occurred while downloading file" });
      }
    });

    wpReq.end();
  } catch (error) {
    console.error("[downloads] Download error:", error.message);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
};
