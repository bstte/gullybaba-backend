const https = require("https");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

// Helper function to fetch coupons directly from WooCommerce REST API
const fetchCouponsFromWooCommerce = (queryParams) => {
  return new Promise((resolve, reject) => {
    const url = getApiUrl("coupons", queryParams);
    const authHeader = getBasicAuthHeader();

    const options = {
      headers: {
        "Authorization": authHeader
      }
    };

    const req = https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`WooCommerce API returned status ${res.statusCode}`));
          }
          const coupons = JSON.parse(data);

          // WooCommerce API returns total count headers
          const total = parseInt(res.headers["x-wp-total"], 10) || coupons.length;
          const totalPages = parseInt(res.headers["x-wp-totalpages"], 10) || 1;

          resolve({ coupons, total, totalPages });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
};

// Get Coupons listing with pagination and filters
exports.getCoupons = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const search = req.query.search || "";
    const status = req.query.status || "";

    // Set up query params for WooCommerce API
    const wcParams = {
      page,
      per_page: limit
    };

    if (search) {
      wcParams.search = search;
    }

    if (status && status !== "all") {
      wcParams.status = status;
    }

    const { coupons, total, totalPages } = await fetchCouponsFromWooCommerce(wcParams);

    // Map WooCommerce response objects to frontend coupons schema
    const formattedCoupons = coupons.map(c => {
      return {
        id: c.id,
        code: c.code,
        amount: c.amount,
        status: c.status,
        discount_type: c.discount_type,
        description: c.description || "—",
        date_expires: c.date_expires,
        usage_count: c.usage_count || 0,
        usage_limit: c.usage_limit,
        minimum_amount: c.minimum_amount || "0.00",
        maximum_amount: c.maximum_amount || "0.00",
        date_created: c.date_created
      };
    });

    return res.json({
      success: true,
      coupons: formattedCoupons,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error("Error fetching live WooCommerce coupons:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch live coupons from WooCommerce API"
    });
  }
};
