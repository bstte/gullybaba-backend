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
      timeout: 30000,
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

// 1. Inspect WordPress Export implementation
exports.inspectExport = async (req, res) => {
  try {
    const url = getApiUrl("export", {}, "inspect");
    const wpRes = await makeWpRequest(url, "GET");
    return res.json(wpRes);
  } catch (error) {
    console.error("[export] Inspect error:", error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 2. Get Product Categories for Export Products dropdown
exports.getCategories = async (req, res) => {
  try {
    const url = getApiUrl("export", {}, "categories");
    const wpRes = await makeWpRequest(url, "GET");
    return res.json(wpRes);
  } catch (error) {
    console.error("[export] Categories error:", error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 3. Get States and Cities for Export Orders by State & City
exports.getStatesAndCities = async (req, res) => {
  try {
    const url = getApiUrl("export", {}, "states-and-cities");
    const wpRes = await makeWpRequest(url, "GET");
    return res.json(wpRes);
  } catch (error) {
    console.error("[export] States & Cities error:", error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 4. Download Export CSV file (Streams file directly from WordPress to client)
exports.downloadExport = async (req, res) => {
  const type = (req.query.type || "").trim(); // products | orders | state-city | question-papers | posts
  if (!type) {
    return res.status(400).json({ success: false, message: "Export type is required" });
  }

  try {
    const queryParams = { ...req.query };
    const url = new URL(getApiUrl("export", queryParams, "download"));
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
      timeout: 120000, // Export may take time for large datasets
    };

    const wpReq = https.request(options, (wpRes) => {
      if (wpRes.statusCode !== 200) {
        return res.status(wpRes.statusCode).json({
          success: false,
          message: `Failed to generate export file (status: ${wpRes.statusCode})`,
        });
      }

      const defaultFilename = `export-${type}-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader("Content-Type", wpRes.headers["content-type"] || "text/csv; charset=UTF-8");
      res.setHeader(
        "Content-Disposition",
        wpRes.headers["content-disposition"] || `attachment; filename="${defaultFilename}"`
      );

      wpRes.pipe(res);
    });

    wpReq.on("error", (err) => {
      console.error("[export] Stream error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: "Stream error occurred while generating export" });
      }
    });

    wpReq.end();
  } catch (error) {
    console.error("[export] Export error:", error.message);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
};
