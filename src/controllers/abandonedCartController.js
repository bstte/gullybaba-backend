const https = require("https");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

// Simple in-memory cache to prevent fetching 13,000+ items on every request
let cartsCache = {
  data: null,
  timestamp: 0
};
const CACHE_DURATION = 60 * 1000; // 1 minute cache

// Helper function to fetch abandoned carts from custom REST API
const fetchAbandonedCartsFromWooCommerce = () => {
  const now = Date.now();
  if (cartsCache.data && (now - cartsCache.timestamp < CACHE_DURATION)) {
    return Promise.resolve(cartsCache.data);
  }

  return new Promise((resolve, reject) => {
    const url = getApiUrl("abandonedCarts");
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
          
          // Save to cache
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

// Helper function to update an abandoned cart's note via the same custom REST API
const updateAbandonedCartNoteOnWordPress = (id, notes) => {
  return new Promise((resolve, reject) => {
    const url = new URL(getApiUrl("abandonedCarts", {}, id));
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

// Update Abandoned Cart Note
exports.updateAbandonedCartNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    if (typeof notes !== "string") {
      return res.status(400).json({
        success: false,
        message: "notes field is required"
      });
    }

    await updateAbandonedCartNoteOnWordPress(id, notes);

    // Invalidate the cache so the next list fetch reflects the updated note
    cartsCache.data = null;
    cartsCache.timestamp = 0;

    return res.json({
      success: true,
      message: "Note updated successfully"
    });
  } catch (error) {
    console.error("Error updating abandoned cart note:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update abandoned cart note"
    });
  }
};

// Get Abandoned Carts listing
exports.getAbandonedCarts = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const search = req.query.search || "";
    const productType = req.query.product || ""; // 'Book' or 'Assignment' or 'all'

    // Fetch full dataset
    const carts = await fetchAbandonedCartsFromWooCommerce();

    // Map response objects
    let formattedCarts = carts.map(c => {
      return {
        id: c.id,
        phone: c.phone || "—",
        notes: c.notes || "—",
        product: c.product || "—",
        created_at: c.created_at
      };
    });

    // In-memory filters matching search terms
    if (search) {
      const queryLower = search.toLowerCase();
      formattedCarts = formattedCarts.filter(c => 
        c.phone.toLowerCase().includes(queryLower) || 
        c.notes.toLowerCase().includes(queryLower)
      );
    }

    if (productType && productType !== "all") {
      formattedCarts = formattedCarts.filter(c => 
        c.product.toLowerCase() === productType.toLowerCase()
      );
    }

    // Correctly calculate total items and pages for the filtered dataset
    const total = formattedCarts.length;
    const totalPages = Math.ceil(total / limit) || 1;

    // Slice the array to only return the requested page
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
    console.error("Error fetching live WooCommerce abandoned carts:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch abandoned carts from WooCommerce API"
    });
  }
};
