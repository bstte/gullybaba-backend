const https = require("https");
const fs = require("fs");
const path = require("path");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

const CACHE_FILE = path.resolve(__dirname, "../../data/abandoned_carts_cache.json");
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
        console.log(`[carts] Loaded ${memoryCache.carts.length} abandoned carts from disk cache.`);
        return memoryCache.carts;
      }
    }
  } catch (err) {
    console.warn("[carts] Could not load disk cache:", err.message);
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
    console.warn("[carts] Failed to save disk cache:", err.message);
  }
};

// Immediately load disk cache into memory
loadDiskCache();

// Helper function to fetch abandoned carts from custom REST API
const fetchAbandonedCartsFromWooCommerce = () => {
  if (ongoingFetchPromise) {
    return ongoingFetchPromise;
  }

  ongoingFetchPromise = new Promise((resolve, reject) => {
    const url = getApiUrl("abandonedCarts");
    const authHeader = getBasicAuthHeader();

    const options = {
      headers: {
        "Authorization": authHeader,
        "User-Agent": "Gullybaba-Portal",
      },
    };

    console.log("[carts] Fetching latest abandoned carts from WordPress...");
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
          console.log(`[carts] Successfully fetched ${carts.length} carts from WordPress in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
          resolve(carts);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", (err) => {
      ongoingFetchPromise = null;
      console.error("[carts] Error fetching from WordPress:", err.message);
      reject(err);
    });
  });

  return ongoingFetchPromise;
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

// Update Abandoned Cart Note with optimistic local cache update
exports.updateAbandonedCartNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    if (typeof notes !== "string") {
      return res.status(400).json({
        success: false,
        message: "notes field is required",
      });
    }

    // 1. Optimistically update memory and disk cache immediately
    if (memoryCache.carts) {
      const cart = memoryCache.carts.find((c) => String(c.id) === String(id));
      if (cart) {
        cart.notes = notes;
      }
      saveDiskCache(memoryCache.carts, memoryCache.timestamp);
    }

    // 2. Persist to WordPress
    await updateAbandonedCartNoteOnWordPress(id, notes);

    return res.json({
      success: true,
      message: "Note updated successfully",
    });
  } catch (error) {
    console.error("Error updating abandoned cart note:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update abandoned cart note",
    });
  }
};

// Get Abandoned Carts listing
exports.getAbandonedCarts = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = (req.query.search || "").trim();
    const productType = (req.query.product || "").trim(); // 'Book' or 'Assignment' or 'all'
    const forceRefresh = req.query.refresh === "true";

    // 1. Ensure memory cache is loaded
    if (!memoryCache.carts) {
      loadDiskCache();
    }

    const hasData = Array.isArray(memoryCache.carts) && memoryCache.carts.length > 0;
    const isStale = !hasData || (Date.now() - memoryCache.timestamp > STALE_TTL_MS);

    let carts = null;

    if (forceRefresh || !hasData) {
      carts = await fetchAbandonedCartsFromWooCommerce();
    } else {
      carts = memoryCache.carts;

      if (isStale && !ongoingFetchPromise) {
        fetchAbandonedCartsFromWooCommerce().catch((err) => {
          console.warn("[carts] Background refresh error:", err.message);
        });
      }
    }

    // 2. Map response objects
    let formattedCarts = carts.map((c) => ({
      id: c.id,
      phone: c.phone || "—",
      notes: c.notes || "—",
      product: c.product || "—",
      created_at: c.created_at,
    }));

    // 3. In-memory filters matching search terms
    if (search) {
      const queryLower = search.toLowerCase();
      formattedCarts = formattedCarts.filter(
        (c) =>
          c.phone.toLowerCase().includes(queryLower) ||
          c.notes.toLowerCase().includes(queryLower)
      );
    }

    if (productType && productType !== "all") {
      formattedCarts = formattedCarts.filter(
        (c) => c.product.toLowerCase() === productType.toLowerCase()
      );
    }

    // 4. Correctly calculate total items and pages for the filtered dataset
    const total = formattedCarts.length;
    const totalPages = Math.ceil(total / limit) || 1;

    // 5. Slice the array to only return the requested page
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
    console.error("Error fetching live WooCommerce abandoned carts:", error);

    // Fallback if cache exists
    if (memoryCache.carts && memoryCache.carts.length > 0) {
      console.log("[carts] Serving cached data as fallback after error.");
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
      message: "Failed to fetch abandoned carts from WooCommerce API",
    });
  }
};
