const https = require("https");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

// Helper function to fetch products directly from WooCommerce REST API
const fetchProductsFromWooCommerce = (queryParams) => {
  return new Promise((resolve, reject) => {
    const url = getApiUrl("products", queryParams);
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
          const products = JSON.parse(data);

          // WooCommerce API returns total count headers
          const total = parseInt(res.headers["x-wp-total"], 10) || products.length;
          const totalPages = parseInt(res.headers["x-wp-totalpages"], 10) || 1;

          resolve({ products, total, totalPages });
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

// Get Products listing with pagination and filters
exports.getProducts = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const search = req.query.search || "";
    const category = req.query.category || "";
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

    const { products, total, totalPages } = await fetchProductsFromWooCommerce(wcParams);

    // Map WooCommerce response objects to frontend products schema
    let formattedProducts = products.map(p => {
      // Collect category names
      const categoryNames = p.categories ? p.categories.map(c => c.name).join(", ") : "";

      // Get first image src or default fallback
      const imageUrl = p.images && p.images.length > 0 ? p.images[0].src : "/logo.svg";

      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        permalink: p.permalink,
        status: p.status,
        type: p.type,
        weight: p.weight,
        price: p.price || "0",
        regular_price: p.regular_price || p.price || "0",
        sale_price: p.sale_price || "",
        on_sale: p.on_sale,
        in_stock: p.in_stock !== undefined ? p.in_stock : true,
        stock_quantity: p.stock_quantity,
        sku: p.sku || "—",
        categories: categoryNames,
        image: imageUrl,
        date_created: p.date_created
      };
    });

    // Apply in-memory category filter if requested
    if (category) {
      formattedProducts = formattedProducts.filter(p =>
        p.categories.toLowerCase().includes(category.toLowerCase())
      );
    }

    return res.json({
      success: true,
      products: formattedProducts,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error("Error fetching live WooCommerce products:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch live products from WooCommerce API"
    });
  }
};
