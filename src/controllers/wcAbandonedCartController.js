const https = require("https");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

// Simple in-memory cache to prevent fetching a large dataset on every request
let cartsCache = {
  data: null,
  timestamp: 0
};
const CACHE_DURATION = 60 * 1000; // 1 minute cache

const fetchWcAbandonedCartsFromWordPress = () => {
  const now = Date.now();
  if (cartsCache.data && (now - cartsCache.timestamp < CACHE_DURATION)) {
    return Promise.resolve(cartsCache.data);
  }

  return new Promise((resolve, reject) => {
    const url = getApiUrl("wcAbandonedCarts");
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
            return reject(new Error(`WordPress API returned status ${res.statusCode}`));
          }
          const responseBody = JSON.parse(data);
          const carts = responseBody.data || [];

          cartsCache.data = carts;
          cartsCache.timestamp = Date.now();

          resolve(carts);
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

const updateWcAbandonedCartNoteOnWordPress = (id, notes) => {
  return new Promise((resolve, reject) => {
    const url = new URL(getApiUrl("wcAbandonedCarts", {}, id));
    const authHeader = getBasicAuthHeader();
    const payload = JSON.stringify({ notes });

    const options = {
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: "PUT",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`WordPress API returned status ${res.statusCode}: ${data}`));
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
    req.write(payload);
    req.end();
  });
};

// Get WooCommerce Abandon Cart Lite listing
exports.getWcAbandonedCarts = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const search = req.query.search || "";
    const status = req.query.status || "";

    const carts = await fetchWcAbandonedCartsFromWordPress();

    let formattedCarts = carts.map(c => ({
      id: c.id,
      email: c.email || "—",
      customer: c.customer || "—",
      phone: c.phone || "",
      order_total: c.order_total || 0,
      tax_total: c.tax_total || 0,
      shipping_charges: c.shipping_charges || 0,
      billing: c.billing || {},
      shipping: c.shipping || {},
      items: c.items || [],
      items_count: c.items_count || (c.items ? c.items.length : 0),
      order_id: c.order_id || null,
      order_edit_link: c.order_edit_link || null,
      abandoned_date: c.abandoned_date,
      status: c.status || "Abandoned",
      notes: c.notes || ""
    }));

    if (search) {
      const queryLower = search.toLowerCase();
      formattedCarts = formattedCarts.filter(c =>
        c.email.toLowerCase().includes(queryLower) ||
        c.customer.toLowerCase().includes(queryLower)
      );
    }

    if (status && status !== "all") {
      formattedCarts = formattedCarts.filter(c =>
        c.status.toLowerCase() === status.toLowerCase()
      );
    }

    const total = formattedCarts.length;
    const totalPages = Math.ceil(total / limit) || 1;

    const startIndex = (page - 1) * limit;
    const paginatedCarts = formattedCarts.slice(startIndex, startIndex + limit);

    return res.json({
      success: true,
      carts: paginatedCarts,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error("Error fetching WooCommerce Abandon Cart Lite data:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch WooCommerce abandoned carts"
    });
  }
};

exports.updateWcAbandonedCartNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    if (typeof notes !== "string") {
      return res.status(400).json({
        success: false,
        message: "notes field is required"
      });
    }

    await updateWcAbandonedCartNoteOnWordPress(id, notes);

    cartsCache.data = null;
    cartsCache.timestamp = 0;

    return res.json({
      success: true,
      message: "Note updated successfully"
    });
  } catch (error) {
    console.error("Error updating WooCommerce abandoned cart note:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update abandoned cart note"
    });
  }
};
