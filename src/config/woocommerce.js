const WOOCOMMERCE_BASE_URL = process.env.WOOCOMMERCE_BASE_URL;
const CONSUMER_KEY = process.env.WOOCOMMERCE_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.WOOCOMMERCE_CONSUMER_SECRET;

const endpoints = {
  customers: "/wc/v3/customers",
  orders: "/wc/v2/orders",
  products: "/wc/v2/products",
  coupons: "/wc/v3/coupons",
  blog: "/wp/v2/posts",
  abandonedCarts: "/custom/v1/abandoned-carts"
};

// Helper function to build a complete API URL with keys appended
const getApiUrl = (endpointKey, queryParams = {}, resourceId = null) => {
  const path = endpoints[endpointKey];
  if (!path) {
    throw new Error(`Endpoint key '${endpointKey}' not defined`);
  }

  const fullPath = resourceId !== null ? `${path}/${resourceId}` : path;
  const urlObj = new URL(`${WOOCOMMERCE_BASE_URL}${fullPath}`);
  
  // Append consumer key and secret automatically
  urlObj.searchParams.append("consumer_key", CONSUMER_KEY);
  urlObj.searchParams.append("consumer_secret", CONSUMER_SECRET);

  // Append other query params
  Object.entries(queryParams).forEach(([key, val]) => {
    if (val !== undefined && val !== null && val !== "") {
      urlObj.searchParams.append(key, val.toString());
    }
  });

  return urlObj.toString();
};

// Helper function to retrieve the server-level Basic Auth bypass header
const getBasicAuthHeader = () => {
  const authString = "gullybaba:Gullybaba@2026";
  return `Basic ${Buffer.from(authString).toString("base64")}`;
};

module.exports = {
  WOOCOMMERCE_BASE_URL,
  CONSUMER_KEY,
  CONSUMER_SECRET,
  endpoints,
  getApiUrl,
  getBasicAuthHeader
};
