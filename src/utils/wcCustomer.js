const https = require("https");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

// Fetches a single customer directly from WooCommerce, including meta_data
// (used both for the admin profile endpoint and for server-side permission checks).
function fetchCustomerById(id) {
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
}

module.exports = { fetchCustomerById };
