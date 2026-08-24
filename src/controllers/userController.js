const https = require("https");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

// Helper function to fetch customers directly from WooCommerce
const fetchCustomersFromWooCommerce = (page, limit, search) => {
  return new Promise((resolve, reject) => {
    // Generate URL dynamically using centralized config
    const url = getApiUrl("customers", { page, per_page: limit, search });
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
          const customers = JSON.parse(data);

          // WooCommerce API returns total count headers
          const total = parseInt(res.headers["x-wp-total"], 10) || customers.length;
          const totalPages = parseInt(res.headers["x-wp-totalpages"], 10) || 1;

          resolve({ customers, total, totalPages });
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

// Helper function to fetch a single customer by ID from WooCommerce
const fetchCustomerById = (id) => {
  return new Promise((resolve, reject) => {
    const url = getApiUrl("customers", {}, id);
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
          resolve(JSON.parse(data));
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

exports.getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const customer = await fetchCustomerById(id);

    return res.json({
      success: true,
      user: {
        id: customer.id,
        username: customer.username,
        email: customer.email || null,
        first_name: customer.first_name || null,
        last_name: customer.last_name || null,
        role: customer.role || "customer",
        mobile: customer.billing ? customer.billing.phone : null,
        billing: customer.billing || null,
        shipping: customer.shipping || null,
        date_created: customer.date_created,
        avatar_url: customer.avatar_url || null,
      },
    });
  } catch (error) {
    console.error("Error fetching WooCommerce customer by ID:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customer data from WooCommerce API",
    });
  }
};

exports.getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const search = req.query.search || "";
    const role = req.query.role || "";

    // console.log(`Proxying WooCommerce customers request (page: ${page}, limit: ${limit}, search: '${search}')`);

    const { customers, total, totalPages } = await fetchCustomersFromWooCommerce(page, limit, search);

    // Map WooCommerce response objects to what the frontend expects
    let formattedUsers = customers.map(c => ({
      id: c.id,
      username: c.username,
      email: c.email || null,
      first_name: c.first_name || null,
      last_name: c.last_name || null,
      role: c.role || "customer",
      mobile: c.billing ? c.billing.phone : null,
      date_created: c.date_created
    }));

    // Filter by role in-memory if specified
    if (role) {
      formattedUsers = formattedUsers.filter(u => u.role.toLowerCase() === role.toLowerCase());
    }

    return res.json({
      success: true,
      users: formattedUsers,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error("Error fetching live WooCommerce customers:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch live data from WooCommerce API",
    });
  }
};
