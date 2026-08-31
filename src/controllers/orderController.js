const https = require("https");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

// Helper function to fetch orders directly from WooCommerce REST API
const fetchOrdersFromWooCommerce = (queryParams) => {
  return new Promise((resolve, reject) => {
    // Generate URL dynamically using centralized config
    const url = getApiUrl("orders", queryParams);
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
          const orders = JSON.parse(data);

          // WooCommerce API returns total count headers
          const total = parseInt(res.headers["x-wp-total"], 10) || orders.length;
          const totalPages = parseInt(res.headers["x-wp-totalpages"], 10) || 1;

          resolve({ orders, total, totalPages });
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

// Helper function to PUT an arbitrary payload to a WooCommerce order (status, billing, shipping, ...)
const updateOrderInWooCommerce = (id, payload) => {
  return new Promise((resolve, reject) => {
    // Build PUT request URL using centralized credentials
    const baseUrl = getApiUrl("orders").split('?')[0]; // base endpoint path
    const keysQuery = getApiUrl("orders").split('?')[1]; // consumer_key & consumer_secret
    const putUrl = `${baseUrl}/${id}?${keysQuery}`;

    const parsedUrl = new URL(putUrl);
    const authHeader = getBasicAuthHeader();
    const bodyData = JSON.stringify(payload);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "PUT",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyData)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`WooCommerce API returned status ${res.statusCode}`));
          }
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.write(bodyData);
    req.end();
  });
};

// Kept for backwards compatibility with existing callers
const updateOrderStatusInWooCommerce = (id, status) => updateOrderInWooCommerce(id, { status });

exports.updateOrderInWooCommerce = updateOrderInWooCommerce;
exports.updateOrderStatusInWooCommerce = updateOrderStatusInWooCommerce;

// Get Orders listing with filters and pagination
exports.getOrders = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const search = req.query.search || "";
    const status = req.query.status || "";
    const start_date = req.query.start_date || "";
    const end_date = req.query.end_date || "";
    const category = req.query.category || "";
    const payment_method = req.query.payment_method || "";

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

    if (start_date) {
      wcParams.after = `${start_date}T00:00:00`;
    }

    if (end_date) {
      wcParams.before = `${end_date}T23:59:59`;
    }

    const { orders, total, totalPages } = await fetchOrdersFromWooCommerce(wcParams);

    // Map WooCommerce response objects to frontend schema
    let formattedOrders = orders.map(o => {
      // Find category in line items metadata
      const categories = [];
      o.line_items.forEach(item => {
        if (item.meta_data) {
          item.meta_data.forEach(meta => {
            if ((meta.key || "").toLowerCase() === "category" && meta.value) {
              categories.push(meta.value);
            }
          });
        }
      });

      // Parse order attribution for Origin
      let origin = "Direct";
      if (o.meta_data) {
        const sourceMeta = o.meta_data.find(m => m.key === "_wc_order_attribution_source_type");
        const utmMeta = o.meta_data.find(m => m.key === "_wc_order_attribution_utm_source");
        if (sourceMeta && sourceMeta.value) {
          origin = sourceMeta.value;
          if (utmMeta && utmMeta.value && utmMeta.value !== "(direct)") {
            origin = `${sourceMeta.value}: ${utmMeta.value}`;
          }
        }
      }

      return {
        id: o.id,
        order_key: o.order_key,
        status: o.status,
        currency: o.currency,
        date_created: o.date_created,
        total: o.total,
        customer_id: o.customer_id,
        billing: {
          first_name: o.billing ? o.billing.first_name : "",
          last_name: o.billing ? o.billing.last_name : "",
          email: o.billing ? o.billing.email : "",
          phone: o.billing ? o.billing.phone : ""
        },
        shipping: {
          first_name: o.shipping ? o.shipping.first_name : "",
          last_name: o.shipping ? o.shipping.last_name : "",
          phone: o.shipping ? o.shipping.phone : ""
        },
        payment_method: o.payment_method,
        payment_method_title: o.payment_method_title,
        categories: categories.length > 0 ? Array.from(new Set(categories)).join(", ") : "IGNOU Help Books", // Default category label fallback if none specified
        origin: origin.charAt(0).toUpperCase() + origin.slice(1)
      };
    });

    // Apply in-memory filtering for category if requested
    if (category) {
      formattedOrders = formattedOrders.filter(o => 
        o.categories.toLowerCase().includes(category.toLowerCase())
      );
    }

    // Apply in-memory filtering for payment method if requested
    if (payment_method && payment_method !== "all") {
      formattedOrders = formattedOrders.filter(o => 
        o.payment_method.toLowerCase() === payment_method.toLowerCase()
      );
    }

    return res.json({
      success: true,
      orders: formattedOrders,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error("Error fetching live WooCommerce orders:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch live orders from WooCommerce API"
    });
  }
};

// Update order status
exports.updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, message: "Status is required" });
    }

    const updatedOrder = await updateOrderStatusInWooCommerce(id, status);

    return res.json({
      success: true,
      message: `Order status updated to ${status} successfully`,
      order: updatedOrder
    });
  } catch (error) {
    console.error(`Error updating WooCommerce order status for ID ${req.params.id}:`, error);
    return res.status(500).json({
      success: false,
      message: "Failed to update order status in WooCommerce"
    });
  }
};
