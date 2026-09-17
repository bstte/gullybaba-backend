const https = require("https");
const fs = require("fs");
const path = require("path");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

const CACHE_FILE = path.resolve(__dirname, "../../data/wc_abandoned_carts_cache.json");
const STALE_TTL_MS = 15 * 60 * 1000; // 15 minutes cache before background refresh

// In-memory cache
let memoryCache = {
  carts: null,
  timestamp: 0,
};

let ongoingFetchPromise = null;

// Helper: load cache from disk on startup or when memory is empty
const loadDiskCache = () => {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.carts) && parsed.carts.length > 0) {
        memoryCache = {
          carts: parsed.carts,
          timestamp: parsed.timestamp || fs.statSync(CACHE_FILE).mtimeMs,
        };
        console.log(`[wc-carts] Loaded ${memoryCache.carts.length} carts from disk cache.`);
        return memoryCache.carts;
      }
    }
  } catch (err) {
    console.warn("[wc-carts] Could not load disk cache:", err.message);
  }
  return null;
};

// Helper: atomically persist cache to disk
const saveDiskCache = (carts, timestamp) => {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ timestamp, carts });
    const tempFile = `${CACHE_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, payload);
    fs.renameSync(tempFile, CACHE_FILE);
  } catch (err) {
    console.warn("[wc-carts] Failed to save disk cache:", err.message);
  }
};

// Immediately load disk cache into memory
loadDiskCache();

// Fetch all carts from WordPress REST endpoint
const fetchWcAbandonedCartsFromWordPress = () => {
  if (ongoingFetchPromise) {
    return ongoingFetchPromise;
  }

  ongoingFetchPromise = new Promise((resolve, reject) => {
    const url = getApiUrl("wcAbandonedCarts");
    const authHeader = getBasicAuthHeader();

    const options = {
      headers: {
        "Authorization": authHeader,
        "User-Agent": "Gullybaba-Portal",
      },
    };

    console.log("[wc-carts] Fetching latest abandoned carts from WordPress...");
    const startTime = Date.now();

    const req = https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        ongoingFetchPromise = null;
        if (res.statusCode !== 200) {
          return reject(new Error(`WordPress API returned status ${res.statusCode}`));
        }
        try {
          const responseBody = JSON.parse(data);
          const carts = responseBody.data || [];
          const now = Date.now();
          memoryCache = {
            carts,
            timestamp: now,
          };
          saveDiskCache(carts, now);
          console.log(`[wc-carts] Successfully fetched ${carts.length} carts from WordPress in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
          resolve(carts);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", (err) => {
      ongoingFetchPromise = null;
      console.error("[wc-carts] Error fetching from WordPress:", err.message);
      reject(err);
    });
  });

  return ongoingFetchPromise;
};

// Update abandoned cart note on WordPress
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
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent": "Gullybaba-Portal",
      },
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
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = (req.query.search || "").trim();
    const status = (req.query.status || "").trim();
    const forceRefresh = req.query.refresh === "true";

    // 1. Ensure memory cache is loaded
    if (!memoryCache.carts) {
      loadDiskCache();
    }

    const hasData = Array.isArray(memoryCache.carts) && memoryCache.carts.length > 0;
    const isStale = !hasData || (Date.now() - memoryCache.timestamp > STALE_TTL_MS);

    let carts = null;

    if (forceRefresh || !hasData) {
      // If we don't have any cached data at all, or user explicitly requested refresh
      carts = await fetchWcAbandonedCartsFromWordPress();
    } else {
      // We have data! Serve it instantly.
      carts = memoryCache.carts;

      // If data is stale, trigger background refresh so next requests stay fresh without blocking
      if (isStale && !ongoingFetchPromise) {
        fetchWcAbandonedCartsFromWordPress().catch((err) => {
          console.warn("[wc-carts] Background refresh error:", err.message);
        });
      }
    }

    // 2. Format cart items
    let formattedCarts = carts.map((c) => ({
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
      notes: c.notes || "",
    }));

    // 3. In-memory filter: Search
    if (search) {
      const queryLower = search.toLowerCase();
      formattedCarts = formattedCarts.filter(
        (c) =>
          c.email.toLowerCase().includes(queryLower) ||
          c.customer.toLowerCase().includes(queryLower) ||
          (c.phone && c.phone.includes(queryLower)) ||
          (c.notes && c.notes.toLowerCase().includes(queryLower))
      );
    }

    // 4. In-memory filter: Status
    if (status && status !== "all") {
      formattedCarts = formattedCarts.filter(
        (c) => c.status.toLowerCase() === status.toLowerCase()
      );
    }

    // 5. Pagination
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
        totalPages,
      },
      cached_at: memoryCache.timestamp,
      is_refreshing: !!ongoingFetchPromise,
    });
  } catch (error) {
    console.error("Error fetching WooCommerce Abandon Cart Lite data:", error);

    // Fallback: If fetch failed but we have any cached data on disk, return it!
    if (memoryCache.carts && memoryCache.carts.length > 0) {
      console.log("[wc-carts] Serving cached data as fallback after error.");
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const startIndex = (page - 1) * limit;
      return res.json({
        success: true,
        carts: memoryCache.carts.slice(startIndex, startIndex + limit),
        pagination: {
          page,
          limit,
          total: memoryCache.carts.length,
          totalPages: Math.ceil(memoryCache.carts.length / limit) || 1,
        },
        cached_at: memoryCache.timestamp,
        warning: "Served from offline cache due to upstream error",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to fetch WooCommerce abandoned carts",
    });
  }
};

// Update note with optimistic local cache update
exports.updateWcAbandonedCartNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    if (typeof notes !== "string") {
      return res.status(400).json({
        success: false,
        message: "notes field is required",
      });
    }

    // 1. Optimistically update local in-memory & disk cache immediately
    if (memoryCache.carts) {
      const cart = memoryCache.carts.find((c) => String(c.id) === String(id));
      if (cart) {
        cart.notes = notes;
      }
      saveDiskCache(memoryCache.carts, memoryCache.timestamp);
    }

    // 2. Persist to WordPress in background or await
    await updateWcAbandonedCartNoteOnWordPress(id, notes);

    return res.json({
      success: true,
      message: "Note updated successfully",
    });
  } catch (error) {
    console.error("Error updating WooCommerce abandoned cart note:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update abandoned cart note",
    });
  }
};
