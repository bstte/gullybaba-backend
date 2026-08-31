const https = require("https");
const pool = require("../config/database");
const { updateOrderStatusInWooCommerce, updateOrderInWooCommerce } = require("./orderController");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");

// Fetch product thumbnail images from the live WooCommerce API, keyed by product id
const fetchProductImages = (productIds) => {
  return new Promise((resolve) => {
    const ids = [...new Set(productIds.filter(Boolean))];
    if (ids.length === 0) return resolve({});

    const url = getApiUrl("products", { include: ids.join(","), per_page: ids.length });
    const options = { headers: { "Authorization": getBasicAuthHeader() } };

    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) return resolve({});
          const products = JSON.parse(data);
          const map = {};
          products.forEach((p) => {
            map[p.id] = p.images && p.images.length > 0 ? p.images[0].src : null;
          });
          resolve(map);
        } catch {
          resolve({});
        }
      });
    }).on("error", () => resolve({}));
  });
};

// Minimal GET-JSON helper against the live WooCommerce site (basic-auth bypass + query-string keys)
const wcGetJson = (url) => {
  return new Promise((resolve) => {
    https.get(url, { headers: { "Authorization": getBasicAuthHeader() } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) return resolve(null);
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    }).on("error", () => resolve(null));
  });
};

const ALLOWED_WEIGHT_CATEGORIES = ["ignou-help-books", "ignou-cbcs-help-books", "ignou-combos"];
const ALLOWED_ASSIGNMENT_CATEGORIES = ["ignou-solved-assignments", "ignou-cbcs-solved-assignments"];

// Best-effort code -> full-name maps standing in for WC()->countries / WC()->countries->get_states().
// Only India is filled in (this storefront ships domestically); anything else falls back to the raw
// code and raises a warning, since we don't have WooCommerce's full country/state list available here.
const COUNTRY_NAMES = { IN: "India" };
const INDIA_STATE_NAMES = {
  AN: "Andaman and Nicobar Islands", AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam",
  BR: "Bihar", CH: "Chandigarh", CT: "Chhattisgarh", DN: "Dadra and Nagar Haveli and Daman and Diu",
  DL: "Delhi", GA: "Goa", GJ: "Gujarat", HR: "Haryana", HP: "Himachal Pradesh",
  JK: "Jammu and Kashmir", JH: "Jharkhand", KA: "Karnataka", KL: "Kerala", LA: "Ladakh",
  LD: "Lakshadweep", MP: "Madhya Pradesh", MH: "Maharashtra", MN: "Manipur", ML: "Meghalaya",
  MZ: "Mizoram", NL: "Nagaland", OR: "Odisha", PY: "Puducherry", PB: "Punjab", RJ: "Rajasthan",
  SK: "Sikkim", TN: "Tamil Nadu", TG: "Telangana", TR: "Tripura", UP: "Uttar Pradesh",
  UT: "Uttarakhand", WB: "West Bengal",
};

const resolveCountryName = (code, warnings) => {
  if (COUNTRY_NAMES[code]) return COUNTRY_NAMES[code];
  warnings.push(`No name mapping for country code "${code}" — using the raw code.`);
  return code;
};

const resolveStateName = (countryCode, stateCode, warnings) => {
  if (countryCode === "IN" && INDIA_STATE_NAMES[stateCode]) return INDIA_STATE_NAMES[stateCode];
  warnings.push(`No name mapping for state code "${stateCode}" (country "${countryCode}") — using the raw code.`);
  return stateCode;
};

// Bulk-fetch parent products (categories, weight, type, meta_data/ACF fields) for a set of product ids
const fetchProductsBulk = async (productIds) => {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const url = getApiUrl("products", { include: ids.join(","), per_page: ids.length });
  const products = await wcGetJson(url);
  const map = {};
  (products || []).forEach((p) => { map[p.id] = p; });
  return map;
};

// Fetch a single variation record (its own weight override, attributes) — no bulk endpoint across parents.
// getApiUrl appends consumer_key/secret as query params on the base products/{id} URL, so /variations/{id}
// has to be spliced in before the query string.
const fetchVariation = async (parentId, variationId) => {
  const base = getApiUrl("products", {}, parentId);
  const [path, query] = base.split("?");
  const variationUrl = `${path}/variations/${variationId}?${query}`;
  return wcGetJson(variationUrl);
};

const productMetaValue = (product, key) => {
  const entry = (product?.meta_data || []).find((m) => m.key === key);
  return entry ? entry.value : null;
};

const orderItemMetaValue = (lineItem, key) => {
  const entry = (lineItem.meta_data || []).find((m) => m.key === key);
  return entry ? entry.value : null;
};

// Ports the WordPress "$total_weight" calculation (Weight (kg) field on the order page).
// Returns { total_weight, warnings } — warnings lists line items we couldn't fully resolve.
async function computeOrderWeight(order) {
  const warnings = [];
  const productIds = order.line_items.map((li) => li.product_id);
  const productMap = await fetchProductsBulk(productIds);

  let totalWeight = 0;

  for (const li of order.line_items) {
    const product = productMap[li.product_id];
    if (!product) {
      warnings.push(`Product #${li.product_id} (${li.name}) could not be fetched from WooCommerce — excluded from weight.`);
      continue;
    }

    const categories = (product.categories || []).map((c) => c.slug);
    const isAllowed = categories.some((c) => ALLOWED_WEIGHT_CATEGORIES.includes(c));
    if (!isAllowed) continue; // matches PHP: category not in allowed list, skip silently

    if (li.variation_id) {
      const variation = await fetchVariation(li.product_id, li.variation_id);
      if (!variation) {
        warnings.push(`Variation #${li.variation_id} of product #${li.product_id} (${li.name}) could not be fetched — used parent weight as fallback.`);
      }
      const weight = parseFloat((variation && variation.weight) || product.weight || 0) + 0.015;
      totalWeight += weight * li.quantity;
    } else if (product.type === "simple") {
      const weight = parseFloat(product.weight || 0) + 0.015;
      totalWeight += weight * li.quantity;
    } else if (product.type === "woosb") {
      const bundleIdsRaw = productMetaValue(product, "woosb_ids");
      if (!bundleIdsRaw) {
        warnings.push(`Bundle product #${li.product_id} (${li.name}) has no "woosb_ids" meta — bundle weight NOT included (unverified field, no woosb order was available to confirm the real meta key/shape).`);
        continue;
      }
      const bundleIds = bundleIdsRaw.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
      const bundleMap = await fetchProductsBulk(bundleIds);
      bundleIds.forEach((bid) => {
        const bp = bundleMap[bid];
        if (!bp) return;
        const weight = parseFloat(bp.weight || 0) + 0.015;
        totalWeight += weight * li.quantity;
      });
    } else {
      warnings.push(`Product #${li.product_id} (${li.name}) has unhandled type "${product.type}" — excluded from weight.`);
    }
  }

  return { total_weight: Number(totalWeight.toFixed(3)), warnings };
}

// Ports the WordPress send_order_to_tekipost() payload builder — NO external API calls are made here.
async function buildTekipostPreview(order) {
  const warnings = [];
  const productIds = order.line_items.map((li) => li.product_id);
  const productMap = await fetchProductsBulk(productIds);

  let totalPages = 0;
  let totalWeight = 0;
  let totalQty = 0;
  let excludedOrderValue = 0;
  const getItems = [];

  for (const li of order.line_items) {
    const product = productMap[li.product_id];
    if (!product) {
      warnings.push(`Product #${li.product_id} (${li.name}) could not be fetched from WooCommerce — treated as excluded.`);
      excludedOrderValue += parseFloat(li.total || 0);
      continue;
    }

    const categories = (product.categories || []).map((c) => c.slug);
    const isAllowed = categories.some((c) => ALLOWED_WEIGHT_CATEGORIES.includes(c));
    if (!isAllowed) {
      excludedOrderValue += parseFloat(li.total || 0);
      continue;
    }

    const name = li.name;
    const sku = li.sku;

    if (li.variation_id) {
      const variation = await fetchVariation(li.product_id, li.variation_id);
      if (!variation) warnings.push(`Variation #${li.variation_id} of product #${li.product_id} (${li.name}) could not be fetched.`);

      const languageRaw = orderItemMetaValue(li, "pa_languages");
      if (!languageRaw) warnings.push(`Line item "${name}" has no "pa_languages" order-item meta — language/page-count lookup skipped.`);
      const itemLanguage = languageRaw ? languageRaw.split("-")[0].toLowerCase() : null;

      const pageCount = itemLanguage ? parseInt(productMetaValue(product, `pages_${itemLanguage}`), 10) || 0 : 0;
      if (itemLanguage && !productMetaValue(product, `pages_${itemLanguage}`)) {
        warnings.push(`Product #${li.product_id} has no "pages_${itemLanguage}" ACF field — page count treated as 0.`);
      }

      const weight = parseFloat((variation && variation.weight) || product.weight || 0) + 0.015;
      totalPages += pageCount * li.quantity;
      totalWeight += weight * li.quantity;
      totalQty += li.quantity;

      getItems.push({ sku_number: sku, product_name: name, product_quantity: li.quantity, product_value: li.total });
    } else if (product.type === "simple") {
      const languageRaw = orderItemMetaValue(li, "Medium");
      if (!languageRaw) warnings.push(`Line item "${name}" has no "Medium" order-item meta — language/page-count lookup skipped.`);
      const itemLanguage = languageRaw ? languageRaw.split("-")[0].toLowerCase() : null;

      const pageCount = itemLanguage ? parseInt(productMetaValue(product, `pages_${itemLanguage}`), 10) || 0 : 0;
      const weight = parseFloat(product.weight || 0) + 0.015;
      totalPages += pageCount * li.quantity;
      totalWeight += weight * li.quantity;
      totalQty += li.quantity;

      getItems.push({
        sku_number: sku,
        product_name: languageRaw ? `${name} - ${languageRaw}` : name,
        product_quantity: li.quantity,
        product_value: li.total,
      });
    } else if (product.type === "woosb") {
      warnings.push(`Bundle product #${li.product_id} (${li.name}) — woosb bundle expansion is unverified (no woosb order available to confirm the "woosb_ids" meta shape); item skipped from weight/pages, but still listed.`);
      getItems.push({ sku_number: sku, product_name: name, product_quantity: li.quantity, product_value: li.total });
      totalQty += li.quantity;
    } else {
      warnings.push(`Product #${li.product_id} (${li.name}) has unhandled type "${product.type}".`);
      getItems.push({ sku_number: sku, product_name: name, product_quantity: li.quantity, product_value: li.total });
      totalQty += li.quantity;
    }
  }

  const tekipostOrderValue = Math.max(0, parseFloat(order.total) - excludedOrderValue);
  let height = (totalPages / 25) * 0.1;
  if (height < 0.5) height = 0.5;

  const method = (order.payment_method || "").toLowerCase();
  const mod = method === "cod" ? "1" : "0";

  const receiverState = order.billing.state
    ? resolveStateName(order.billing.country, order.billing.state, warnings)
    : "";
  if (!order.billing.state) warnings.push("Billing state is empty — receiver_state will be blank.");

  const payload = {
    isorder: 1,
    consignee_name: `${order.billing.first_name} ${order.billing.last_name}`.trim(),
    mobile_no: order.billing.phone || "",
    alternate_mobile_no: order.billing.phone || "",
    email_id: order.billing.email || "",
    receiver_address: [order.billing.address_1, order.billing.address_2].filter(Boolean).join(", "),
    receiver_pincode: order.billing.postcode || "",
    receiver_city: order.billing.city || "",
    receiver_state: receiverState,
    receiver_landmark: "",
    customer_order_no: order.id,
    order_type: mod,
    product_quantity: totalQty,
    cod_amount: method === "cod" ? tekipostOrderValue : 0,
    physical_weight: Number(totalWeight.toFixed(3)),
    product_length: 21,
    product_width: 14,
    product_height: Number(height.toFixed(3)),
    hsn_number: "12e34",
    order_value: tekipostOrderValue,
    productdetatis: getItems,
    sender_address_id: 142,
    return_address_same_as_pickup_address: 142,
    return_consignee_name: "Gullybaba Return",
    return_mobile_no: "9350849407",
    return_alternate_mobile_no: "9350849407",
    return_address: "2525/193, First Floor, Tota Ram Bazar, Near Hanuman Temple, Tri Nagar, Onkar Nagar-A, 110035, Delhi, India",
    return_pincode: "110035",
    return_city: "Tri Nagar",
    return_state: "Delhi",
    return_landmark: "Tota Ram Bazar, Near Hanuman Temple",
  };

  if (getItems.length === 0) warnings.push("No valid items to send to TekiPost (all line items excluded by category).");

  return { payload, warnings };
}

// Ports the WordPress send_order_to_shiprocket() payload builder — NO external API calls are made here.
// The 'woosb' bundle branch and the "solved assignments" (allowedAssignmentCategoryData) branch are
// best-effort ports: no order with those item types was available to verify against, so both raise a
// warning instead of silently producing a wrong number. Everything else (variation/simple line items)
// was verified against a real order.
async function buildShiprocketPreview(order) {
  const warnings = [];
  const productIds = order.line_items.map((li) => li.product_id);
  const productMap = await fetchProductsBulk(productIds);

  let totalPages = 0;
  let totalWeight = 0;
  let height = 0;
  let length = 21;
  let breadth = 14;
  const getItems = [];

  for (const li of order.line_items) {
    const product = productMap[li.product_id];
    if (!product) {
      warnings.push(`Product #${li.product_id} (${li.name}) could not be fetched from WooCommerce — excluded.`);
      continue;
    }

    const categories = (product.categories || []).map((c) => c.slug);
    const isAllowed = categories.some((c) => ALLOWED_WEIGHT_CATEGORIES.includes(c));
    const isAssignment = categories.some((c) => ALLOWED_ASSIGNMENT_CATEGORIES.includes(c));

    const sku = li.sku || "N/A";
    let name = li.name;
    let itemQuantity = li.quantity;
    let productType = null;

    if (isAllowed) {
      if (li.variation_id) {
        productType = "variation";
        const languageRaw = orderItemMetaValue(li, "pa_languages");
        if (!languageRaw) warnings.push(`Line item "${name}" has no "pa_languages" order-item meta — page count skipped.`);
        const itemLanguage = languageRaw ? languageRaw.split("-")[0].toLowerCase() : null;
        const pageCount = itemLanguage ? parseInt(productMetaValue(product, `pages_${itemLanguage}`), 10) || 0 : 0;

        const variation = await fetchVariation(li.product_id, li.variation_id);
        if (!variation) warnings.push(`Variation #${li.variation_id} of product #${li.product_id} (${li.name}) could not be fetched — used parent weight as fallback.`);

        totalPages += pageCount * itemQuantity;
        const weight = parseFloat((variation && variation.weight) || product.weight || 0) + 0.015;
        totalWeight += weight * itemQuantity;
        height = (totalPages / 25) * 0.1;
      } else if (product.type === "simple") {
        productType = "simple";
        const languageRaw = orderItemMetaValue(li, "Medium");
        if (!languageRaw) warnings.push(`Line item "${name}" has no "Medium" order-item meta — page count skipped.`);
        const itemLanguage = languageRaw ? languageRaw.split("-")[0].toLowerCase() : null;
        const pageCount = itemLanguage ? parseInt(productMetaValue(product, `pages_${itemLanguage}`), 10) || 0 : 0;

        totalPages += pageCount * itemQuantity;
        const weight = parseFloat(product.weight || 0) + 0.015;
        totalWeight += weight * itemQuantity;
        height = (totalPages / 25) * 0.1;
        name = `${name} - ${languageRaw || ""}`.trim();
      } else if (product.type === "woosb") {
        productType = "woosb";
        warnings.push(
          `Bundle product #${li.product_id} (${li.name}) — woosb bundle expansion is unverified (no woosb order available to confirm the "woosb_ids" meta shape). The WordPress code also resets total pages/weight/height to just this bundle's items at this point (a quirk of the original code, ported as-is) — treat these numbers with caution.`
        );
        const bundleIdsRaw = productMetaValue(product, "woosb_ids");
        sku_reset: {
          if (!bundleIdsRaw) {
            warnings.push(`Bundle product #${li.product_id} has no "woosb_ids" meta — bundle contents skipped, item still listed.`);
            break sku_reset;
          }
          const bundleIds = bundleIdsRaw.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
          const bundleMap = await fetchProductsBulk(bundleIds);
          totalPages = 0;
          totalWeight = 0;
          height = 0;
          itemQuantity = 0;
          const languageRaw = orderItemMetaValue(li, "Medium");
          const itemLanguage = languageRaw ? languageRaw.split("-")[0].toLowerCase() : null;
          bundleIds.forEach((bid) => {
            const bp = bundleMap[bid];
            if (!bp) return;
            const pageCount = itemLanguage ? parseInt(productMetaValue(bp, `pages_${itemLanguage}`), 10) || 0 : 0;
            totalPages += pageCount * li.quantity;
            const weight = parseFloat(bp.weight || 0) + 0.015;
            totalWeight += weight * li.quantity;
            itemQuantity = li.quantity;
          });
          height = (totalPages / 25) * 0.1;
          name = languageRaw ? `${li.name} - ${languageRaw} (${sku})` : li.name;
        }
      }
    } else if (isAssignment) {
      // "Hard Copy Via Courier" is expected to be the value of the item's FIRST meta entry in the
      // WordPress code ($item->get_meta_data()[0]) — unverified, no solved-assignment order to test.
      const firstMetaValue = li.meta_data && li.meta_data[0] ? li.meta_data[0].value : null;
      if (firstMetaValue !== "Hard Copy Via Courier") {
        warnings.push(`Assignment item "${name}" skipped — first meta value was "${firstMetaValue}", not "Hard Copy Via Courier" (unverified check, ported as-is).`);
      } else if (product.type === "variable") {
        productType = "variable";
        warnings.push(`Assignment item "${name}" — solved-assignment branch is unverified (no matching order to test against).`);
        totalWeight += 0.55 * itemQuantity;
        height += 2.54 * itemQuantity;
        length += 29 * itemQuantity;
        breadth += 21 * itemQuantity;
      }
    }

    if (productType) {
      getItems.push({
        sku: sku.slice(0, 45),
        units: itemQuantity,
        selling_price: li.total,
        name,
      });
    }
  }

  if (height < 0.5) height = 0.5;

  const country = resolveCountryName(order.billing.country, warnings);
  const state = order.billing.state ? resolveStateName(order.billing.country, order.billing.state, warnings) : "";

  // WordPress's get_date_created()->date(...) returns the site's local time (Asia/Kolkata), not GMT —
  // order.date_created here is stored as GMT, so convert explicitly rather than using server-local time.
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(order.date_created));
  const partValue = (type) => dateParts.find((p) => p.type === type)?.value;
  const orderDate = `${partValue("year")}-${partValue("month")}-${partValue("day")} ${partValue("hour")}:${partValue("minute")}`;

  const payload = {
    order_id: `${order.id}_gb`,
    order_date: orderDate,
    order_items: getItems,
    pickup_location: "Gullybaba",
    billing_customer_name: order.billing.first_name || "",
    billing_last_name: order.billing.last_name || "",
    billing_address: [order.billing.address_1, order.billing.address_2].filter(Boolean).join(", "),
    billing_city: order.billing.city || "",
    billing_pincode: order.billing.postcode || "",
    billing_state: state,
    billing_country: country,
    billing_email: (order.billing.email || "").replace(/\s/g, ""),
    billing_phone: order.billing.phone || "",
    shipping_is_billing: true,
    name: `Order #${order.id}`,
    units: 1,
    length,
    breadth,
    height: Number(height.toFixed(3)),
    weight: null, // overridden by the admin-entered weight input before sending, see previewShiprocket
    selling_price: order.total,
    payment_method: (order.payment_method || "").toLowerCase() !== "cod" ? "prepaid" : "cod",
    sub_total: order.total,
  };

  if (getItems.length === 0) warnings.push("No valid items to send to Shiprocket (all line items excluded by category).");

  return { payload, warnings };
}

// Meta keys already surfaced as dedicated line_item fields — excluded from the generic meta_data array
const LINE_ITEM_CORE_KEYS = new Set([
  "_line_subtotal",
  "_line_subtotal_tax",
  "_line_tax",
  "_line_tax_data",
  "_line_total",
  "_product_id",
  "_qty",
  "_tax_class",
  "_variation_id",
  "_reduced_stock",
]);

const num = (v) => (v === null || v === undefined ? "0.00" : Number(v).toFixed(2));
const int = (v) => (v === null || v === undefined ? 0 : parseInt(v, 10));

// wp_wc_orders stores status with a "wc-" prefix; the REST API strips it
const stripStatusPrefix = (status) => (status || "").replace(/^wc-/, "");

const CURRENCY_SYMBOLS = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

// Canonical order status list, matching the WooCommerce site's status dropdown 1:1
const STATUS_LIST = [
  { value: "pending", label: "Pending payment" },
  { value: "processing", label: "Processing" },
  { value: "confirmed", label: "Confirmed" },
  { value: "delivered", label: "Delivered" },
  { value: "digital-orders", label: "Digital Orders" },
  { value: "in-cart", label: "In Cart" },
  { value: "in-transit", label: "In Transit" },
  { value: "pickup", label: "Pickup" },
  { value: "refund-processed", label: "Refund Initiated" },
  { value: "returned", label: "Returned" },
  { value: "shipped", label: "Shipped" },
  { value: "undelivered", label: "Undelivered" },
  { value: "confirmation", label: "Waiting For Confirmation" },
  { value: "dispatch", label: "Waiting For Dispatch" },
  { value: "on-hold", label: "On hold" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "refunded", label: "Refunded" },
  { value: "failed", label: "Failed" },
  { value: "checkout-draft", label: "Draft" },
];

async function fetchOrderRows(where, params) {
  const { rows } = await pool.query(
    `SELECT * FROM gb_wc_orders WHERE ${where} ORDER BY id DESC`,
    params
  );
  return rows;
}

async function buildOrdersPayload(orderRows) {
  if (orderRows.length === 0) return [];
  const orderIds = orderRows.map((o) => o.id);

  const [opDataRes, addressesRes, metaRes, itemsRes, refundsRes] = await Promise.all([
    pool.query(`SELECT * FROM gb_wc_order_operational_data WHERE order_id = ANY($1)`, [orderIds]),
    pool.query(`SELECT * FROM gb_wc_order_addresses WHERE order_id = ANY($1)`, [orderIds]),
    pool.query(`SELECT * FROM gb_wc_orders_meta WHERE order_id = ANY($1)`, [orderIds]),
    pool.query(`SELECT * FROM gb_woocommerce_order_items WHERE order_id = ANY($1)`, [orderIds]),
    pool.query(`SELECT id, parent_order_id, total_amount, date_created_gmt FROM gb_wc_orders WHERE parent_order_id = ANY($1)`, [orderIds]),
  ]);

  const itemIds = itemsRes.rows.map((i) => i.order_item_id);
  const itemMetaRes = itemIds.length
    ? await pool.query(`SELECT * FROM gb_woocommerce_order_itemmeta WHERE order_item_id = ANY($1)`, [itemIds])
    : { rows: [] };

  const opDataByOrder = new Map(opDataRes.rows.map((r) => [r.order_id, r]));
  const addressesByOrder = new Map();
  addressesRes.rows.forEach((r) => {
    if (!addressesByOrder.has(r.order_id)) addressesByOrder.set(r.order_id, {});
    addressesByOrder.get(r.order_id)[r.address_type] = r;
  });
  const metaByOrder = new Map();
  metaRes.rows.forEach((r) => {
    if (!metaByOrder.has(r.order_id)) metaByOrder.set(r.order_id, []);
    metaByOrder.get(r.order_id).push(r);
  });
  const itemsByOrder = new Map();
  itemsRes.rows.forEach((r) => {
    if (!itemsByOrder.has(r.order_id)) itemsByOrder.set(r.order_id, []);
    itemsByOrder.get(r.order_id).push(r);
  });
  const itemMetaByItem = new Map();
  itemMetaRes.rows.forEach((r) => {
    if (!itemMetaByItem.has(r.order_item_id)) itemMetaByItem.set(r.order_item_id, []);
    itemMetaByItem.get(r.order_item_id).push(r);
  });
  const refundsByOrder = new Map();
  refundsRes.rows.forEach((r) => {
    if (!refundsByOrder.has(r.parent_order_id)) refundsByOrder.set(r.parent_order_id, []);
    refundsByOrder.get(r.parent_order_id).push(r);
  });

  const metaValue = (itemMeta, key) => {
    const m = itemMeta.find((im) => im.meta_key === key);
    return m ? m.meta_value : null;
  };

  const buildAddress = (addrRow) =>
    addrRow
      ? {
          first_name: addrRow.first_name || "",
          last_name: addrRow.last_name || "",
          company: addrRow.company || "",
          address_1: addrRow.address_1 || "",
          address_2: addrRow.address_2 || "",
          city: addrRow.city || "",
          state: addrRow.state || "",
          postcode: addrRow.postcode || "",
          country: addrRow.country || "",
          email: addrRow.email || "",
          phone: addrRow.phone || "",
        }
      : {};

  const buildLineItem = (item) => {
    const im = itemMetaByItem.get(item.order_item_id) || [];
    const extraMeta = im
      .filter((m) => !LINE_ITEM_CORE_KEYS.has(m.meta_key))
      .map((m) => ({ id: m.meta_id, key: m.meta_key, value: m.meta_value }));

    const quantity = int(metaValue(im, "_qty"));
    const subtotal = num(metaValue(im, "_line_subtotal"));

    return {
      id: item.order_item_id,
      name: item.order_item_name,
      product_id: int(metaValue(im, "_product_id")),
      variation_id: int(metaValue(im, "_variation_id")),
      quantity,
      tax_class: metaValue(im, "_tax_class") || "",
      subtotal,
      subtotal_tax: num(metaValue(im, "_line_subtotal_tax")),
      total: num(metaValue(im, "_line_total")),
      total_tax: num(metaValue(im, "_line_tax")),
      taxes: [], // _line_tax_data is PHP-serialized; not decoded here
      meta_data: extraMeta,
      sku: metaValue(im, "Code") || null,
      price: quantity > 0 ? (Number(subtotal) / quantity).toFixed(2) : subtotal,
      category: metaValue(im, "Category") || "",
    };
  };

  const buildShippingLine = (item) => {
    const im = itemMetaByItem.get(item.order_item_id) || [];
    return {
      id: item.order_item_id,
      method_title: item.order_item_name,
      method_id: metaValue(im, "method_id") || "",
      instance_id: metaValue(im, "instance_id") || "",
      total: num(metaValue(im, "cost")),
      total_tax: num(metaValue(im, "total_tax")),
      taxes: [],
      meta_data: [],
    };
  };

  const buildFeeLine = (item) => {
    const im = itemMetaByItem.get(item.order_item_id) || [];
    return {
      id: item.order_item_id,
      name: item.order_item_name,
      tax_class: metaValue(im, "_tax_class") || "",
      tax_status: metaValue(im, "_tax_status") || "",
      amount: num(metaValue(im, "_fee_amount")),
      total: num(metaValue(im, "_line_total")),
      total_tax: num(metaValue(im, "_line_tax")),
      taxes: [],
      meta_data: [],
    };
  };

  const buildCouponLine = (item) => {
    const im = itemMetaByItem.get(item.order_item_id) || [];
    return {
      id: item.order_item_id,
      code: item.order_item_name,
      discount: num(metaValue(im, "discount_amount")),
      discount_tax: num(metaValue(im, "discount_amount_tax")),
      meta_data: [],
    };
  };

  return orderRows.map((o) => {
    const op = opDataByOrder.get(o.id) || {};
    const addr = addressesByOrder.get(o.id) || {};
    const meta = metaByOrder.get(o.id) || [];
    const items = itemsByOrder.get(o.id) || [];
    const refunds = refundsByOrder.get(o.id) || [];

    const lineItems = items.filter((i) => i.order_item_type === "line_item").map(buildLineItem);
    const shippingLines = items.filter((i) => i.order_item_type === "shipping").map(buildShippingLine);
    const feeLines = items.filter((i) => i.order_item_type === "fee").map(buildFeeLine);
    const couponLines = items.filter((i) => i.order_item_type === "coupon").map(buildCouponLine);

    const status = stripStatusPrefix(o.status);

    return {
      id: o.id,
      parent_id: o.parent_order_id || 0,
      status,
      currency: o.currency,
      currency_symbol: CURRENCY_SYMBOLS[o.currency] || o.currency,
      version: op.woocommerce_version || null,
      prices_include_tax: !!op.prices_include_tax,
      date_created: o.date_created_gmt,
      date_created_gmt: o.date_created_gmt,
      date_modified: o.date_updated_gmt,
      date_modified_gmt: o.date_updated_gmt,
      date_completed: op.date_completed_gmt || null,
      date_completed_gmt: op.date_completed_gmt || null,
      date_paid: op.date_paid_gmt || null,
      date_paid_gmt: op.date_paid_gmt || null,
      discount_total: num(op.discount_total_amount),
      discount_tax: num(op.discount_tax_amount),
      shipping_total: num(op.shipping_total_amount),
      shipping_tax: num(op.shipping_tax_amount),
      cart_tax: null, // not stored in any imported table
      total: num(o.total_amount),
      total_tax: num(o.tax_amount),
      customer_id: o.customer_id,
      order_key: op.order_key || null,
      billing: buildAddress(addr.billing),
      shipping: buildAddress(addr.shipping),
      payment_method: o.payment_method,
      payment_method_title: o.payment_method_title,
      transaction_id: o.transaction_id,
      customer_ip_address: o.ip_address,
      customer_user_agent: o.user_agent,
      created_via: op.created_via || null,
      customer_note: o.customer_note,
      cart_hash: op.cart_hash || null,
      number: String(o.id),
      needs_processing: status === "processing",
      needs_payment: ["pending", "failed"].includes(status) && Number(o.total_amount) > 0,
      is_editable: ["pending", "on-hold"].includes(status),
      meta_data: meta.map((m) => ({ id: m.id, key: m.meta_key, value: m.meta_value })),
      line_items: lineItems,
      tax_lines: [], // no order_item_type='tax' rows exist in the imported data
      shipping_lines: shippingLines,
      fee_lines: feeLines,
      coupon_lines: couponLines,
      refunds: refunds.map((r) => ({
        id: r.id,
        total: num(r.total_amount),
        date_created: r.date_created_gmt,
      })),
    };
  });
}

// Build the compact listing shape the admin Orders table expects
async function buildOrderListPayload(orderRows) {
  if (orderRows.length === 0) return [];
  const orderIds = orderRows.map((o) => o.id);

  const [addressesRes, categoriesRes, attributionRes] = await Promise.all([
    pool.query(`SELECT * FROM gb_wc_order_addresses WHERE order_id = ANY($1)`, [orderIds]),
    pool.query(
      `SELECT oi.order_id, im.meta_value AS category
       FROM gb_woocommerce_order_items oi
       JOIN gb_woocommerce_order_itemmeta im ON im.order_item_id = oi.order_item_id
       WHERE oi.order_id = ANY($1) AND oi.order_item_type = 'line_item' AND lower(im.meta_key) = 'category'`,
      [orderIds]
    ),
    pool.query(
      `SELECT order_id, meta_key, meta_value FROM gb_wc_orders_meta
       WHERE order_id = ANY($1) AND meta_key IN ('_wc_order_attribution_source_type', '_wc_order_attribution_utm_source')`,
      [orderIds]
    ),
  ]);

  const addressesByOrder = new Map();
  addressesRes.rows.forEach((r) => {
    if (!addressesByOrder.has(r.order_id)) addressesByOrder.set(r.order_id, {});
    addressesByOrder.get(r.order_id)[r.address_type] = r;
  });

  const categoriesByOrder = new Map();
  categoriesRes.rows.forEach((r) => {
    if (!categoriesByOrder.has(r.order_id)) categoriesByOrder.set(r.order_id, new Set());
    if (r.category) categoriesByOrder.get(r.order_id).add(r.category);
  });

  const attributionByOrder = new Map();
  attributionRes.rows.forEach((r) => {
    if (!attributionByOrder.has(r.order_id)) attributionByOrder.set(r.order_id, {});
    attributionByOrder.get(r.order_id)[r.meta_key] = r.meta_value;
  });

  const buildAddress = (addrRow, fields) => {
    const out = {};
    fields.forEach((f) => { out[f] = (addrRow && addrRow[f]) || ""; });
    return out;
  };

  return orderRows.map((o) => {
    const addr = addressesByOrder.get(o.id) || {};
    const categories = categoriesByOrder.get(o.id);
    const attribution = attributionByOrder.get(o.id) || {};

    let origin = "Direct";
    const sourceType = attribution["_wc_order_attribution_source_type"];
    const utmSource = attribution["_wc_order_attribution_utm_source"];
    if (sourceType) {
      origin = sourceType;
      if (utmSource && utmSource !== "(direct)") {
        origin = `${sourceType}: ${utmSource}`;
      }
    }

    return {
      id: o.id,
      order_key: null,
      status: stripStatusPrefix(o.status),
      currency: o.currency,
      date_created: o.date_created_gmt,
      total: num(o.total_amount),
      customer_id: o.customer_id,
      billing: {
        ...buildAddress(addr.billing, ["first_name", "last_name", "phone"]),
        email: (addr.billing && addr.billing.email) || o.billing_email || "",
      },
      shipping: buildAddress(addr.shipping, ["first_name", "last_name", "phone"]),
      payment_method: o.payment_method,
      payment_method_title: o.payment_method_title,
      categories: categories && categories.size > 0 ? Array.from(categories).join(", ") : "IGNOU Help Books",
      origin: origin.charAt(0).toUpperCase() + origin.slice(1),
    };
  });
}

// GET /api/orders/status-counts — live per-status counts straight from the status column,
// so the tabs on the Orders page always reflect what's actually in the table.
exports.getStatusCounts = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM gb_wc_orders WHERE type = 'shop_order' GROUP BY status`
    );

    const counts = {};
    let total = 0;
    rows.forEach((r) => {
      const value = stripStatusPrefix(r.status) || r.status;
      counts[value] = (counts[value] || 0) + r.count;
      total += r.count;
    });

    const knownValues = new Set(STATUS_LIST.map((s) => s.value));
    const extraStatuses = Object.keys(counts)
      .filter((v) => !knownValues.has(v))
      .map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1).replace(/-/g, " ") }));

    res.json({
      success: true,
      total,
      statusList: [...STATUS_LIST, ...extraStatuses],
      counts,
    });
  } catch (error) {
    console.error("Error fetching order status counts:", error);
    res.status(500).json({ success: false, message: "Failed to fetch order status counts" });
  }
};

// GET /api/orders/months — distinct year-month combinations that actually have orders, newest
// first, for the "Filter by Date" month dropdown on the orders list page.
exports.getMonths = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT to_char(date_created_gmt, 'YYYYMM') AS value
       FROM gb_wc_orders
       WHERE type = 'shop_order' AND date_created_gmt IS NOT NULL
       ORDER BY value DESC`
    );
    const months = rows.map((r) => {
      const year = Number(r.value.slice(0, 4));
      const monthIndex = Number(r.value.slice(4, 6)) - 1;
      const label = new Date(year, monthIndex, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
      return { value: r.value, label };
    });
    res.json({ success: true, months });
  } catch (error) {
    console.error("Error fetching order months:", error);
    res.status(500).json({ success: false, message: "Failed to fetch order months" });
  }
};

// GET /api/orders/categories — distinct product categories that actually appear on order line
// items, for the Category Filter dropdown on the orders list page.
exports.getCategories = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT im.meta_value AS category
       FROM gb_woocommerce_order_itemmeta im
       JOIN gb_woocommerce_order_items oi ON oi.order_item_id = im.order_item_id
       WHERE oi.order_item_type = 'line_item' AND lower(im.meta_key) = 'category' AND im.meta_value <> ''
       ORDER BY category`
    );
    res.json({ success: true, categories: rows.map((r) => r.category) });
  } catch (error) {
    console.error("Error fetching order categories:", error);
    res.status(500).json({ success: false, message: "Failed to fetch order categories" });
  }
};

// GET /api/orders?page=&limit=&search=&status=&start_date=&end_date=&category=&payment_method=
exports.getOrders = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const search = (req.query.search || "").trim();
    const status = req.query.status || "";
    const start_date = req.query.start_date || "";
    const end_date = req.query.end_date || "";
    const categories = (req.query.category || "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const payment_method = req.query.payment_method || "";

    const conditions = ["o.type = 'shop_order'"];
    const params = [];

    if (status && status !== "all") {
      // Most order statuses are stored with a "wc-" prefix, but a few core
      // WordPress post statuses (auto-draft, trash) are stored without it.
      params.push(status, `wc-${status}`);
      conditions.push(`o.status IN ($${params.length - 1}, $${params.length})`);
    }

    if (payment_method && payment_method !== "all") {
      // Only "cod" is a literal payment_method value; every other gateway (razorpay, cheque, ...)
      // counts as "prepaid", matching the same cod/prepaid split used for Shiprocket/TekiPost.
      if (payment_method === "cod") {
        conditions.push(`lower(o.payment_method) = 'cod'`);
      } else if (payment_method === "prepaid") {
        conditions.push(`(o.payment_method IS NULL OR lower(o.payment_method) <> 'cod')`);
      } else {
        params.push(payment_method);
        conditions.push(`o.payment_method = $${params.length}`);
      }
    }

    if (start_date) {
      params.push(`${start_date} 00:00:00`);
      conditions.push(`o.date_created_gmt >= $${params.length}`);
    }

    if (end_date) {
      params.push(`${end_date} 23:59:59`);
      conditions.push(`o.date_created_gmt <= $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      conditions.push(
        `(o.id::text ILIKE $${idx} OR o.billing_email ILIKE $${idx} OR ba.first_name ILIKE $${idx} OR ba.last_name ILIKE $${idx} OR ba.phone ILIKE $${idx})`
      );
    }

    if (categories.length > 0) {
      params.push(categories);
      conditions.push(
        `EXISTS (
          SELECT 1 FROM gb_woocommerce_order_items oi
          JOIN gb_woocommerce_order_itemmeta im ON im.order_item_id = oi.order_item_id
          WHERE oi.order_id = o.id AND oi.order_item_type = 'line_item'
            AND lower(im.meta_key) = 'category' AND im.meta_value = ANY($${params.length})
        )`
      );
    }

    const whereClause = conditions.join(" AND ");
    const baseFrom = `FROM gb_wc_orders o LEFT JOIN gb_wc_order_addresses ba ON ba.order_id = o.id AND ba.address_type = 'billing' WHERE ${whereClause}`;

    const countRes = await pool.query(`SELECT COUNT(DISTINCT o.id) ${baseFrom}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(limit, (page - 1) * limit);
    const { rows: idRows } = await pool.query(
      `SELECT DISTINCT o.id ${baseFrom} ORDER BY o.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const orderIds = idRows.map((r) => r.id);
    const orderRows = orderIds.length
      ? (await pool.query(`SELECT * FROM gb_wc_orders WHERE id = ANY($1)`, [orderIds])).rows
      : [];
    const orderRowsById = new Map(orderRows.map((o) => [o.id, o]));
    const orderedRows = orderIds.map((id) => orderRowsById.get(id)).filter(Boolean);

    const orders = await buildOrderListPayload(orderedRows);

    res.json({
      success: true,
      orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    console.error("Error fetching orders from local database:", error);
    res.status(500).json({ success: false, message: "Failed to fetch orders from local database" });
  }
};

// PUT /api/orders/:id/status
// Keeps WordPress/WooCommerce and the local database in sync: the local row is updated inside
// a transaction, then pushed to WooCommerce; if the WooCommerce call fails, the local change is
// rolled back so neither side is ever left out of sync with the other.
// POST /api/orders/create — webhook for WordPress to call when a new WooCommerce order is created,
// so it lands in this local copy too. TEST/first version: writes only to gb_wc_orders (no addresses,
// line items, or meta yet — those can be added the same way once this base row is confirmed working).
// Upserts on `id` (the WooCommerce order/post ID) so a retried webhook call is safe to resend.
//
// Expected JSON body (all fields optional except "id"; anything omitted is stored as NULL):
// {
//   "id": 113637,                          // WooCommerce order ID — REQUIRED, must match WP's order/post ID
//   "status": "wc-processing",             // WooCommerce order status, WITH the "wc-" prefix
//   "currency": "INR",
//   "type": "shop_order",                  // usually always "shop_order"
//   "tax_amount": 0,
//   "total_amount": 318.00,
//   "customer_id": 98891,
//   "billing_email": "customer@example.com",
//   "date_created_gmt": "2026-08-31 12:00:00",   // GMT, "YYYY-MM-DD HH:mm:ss"
//   "date_updated_gmt": "2026-08-31 12:00:00",
//   "parent_order_id": 0,
//   "payment_method": "cod",
//   "payment_method_title": "Cash on Delivery",
//   "transaction_id": "",
//   "ip_address": "203.0.113.10",
//   "user_agent": "Mozilla/5.0 ...",
//   "customer_note": ""
// }
exports.createOrder = async (req, res) => {
  const {
    id,
    status,
    currency,
    type,
    tax_amount,
    total_amount,
    customer_id,
    billing_email,
    date_created_gmt,
    date_updated_gmt,
    parent_order_id,
    payment_method,
    payment_method_title,
    transaction_id,
    ip_address,
    user_agent,
    customer_note,
  } = req.body || {};

  if (!id) {
    return res.status(400).json({ success: false, message: "id is required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO gb_wc_orders (
         id, status, currency, type, tax_amount, total_amount, customer_id, billing_email,
         date_created_gmt, date_updated_gmt, parent_order_id, payment_method, payment_method_title,
         transaction_id, ip_address, user_agent, customer_note
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         currency = EXCLUDED.currency,
         type = EXCLUDED.type,
         tax_amount = EXCLUDED.tax_amount,
         total_amount = EXCLUDED.total_amount,
         customer_id = EXCLUDED.customer_id,
         billing_email = EXCLUDED.billing_email,
         date_created_gmt = EXCLUDED.date_created_gmt,
         date_updated_gmt = EXCLUDED.date_updated_gmt,
         parent_order_id = EXCLUDED.parent_order_id,
         payment_method = EXCLUDED.payment_method,
         payment_method_title = EXCLUDED.payment_method_title,
         transaction_id = EXCLUDED.transaction_id,
         ip_address = EXCLUDED.ip_address,
         user_agent = EXCLUDED.user_agent,
         customer_note = EXCLUDED.customer_note
       RETURNING *`,
      [
        id, status || null, currency || null, type || "shop_order", tax_amount ?? null, total_amount ?? null,
        customer_id ?? null, billing_email || null, date_created_gmt || null, date_updated_gmt || null,
        parent_order_id ?? null, payment_method || null, payment_method_title || null, transaction_id || null,
        ip_address || null, user_agent || null, customer_note || null,
      ]
    );

    console.log(`[order-webhook] order #${id} saved to gb_wc_orders`);
    res.json({ success: true, order: rows[0] });
  } catch (error) {
    console.error(`Error saving order ${id} from webhook:`, error);
    res.status(500).json({ success: false, message: "Failed to save order" });
  }
};

exports.updateStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ success: false, message: "Status is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE gb_wc_orders SET status = $1, date_updated_gmt = NOW() WHERE id = $2 AND type = 'shop_order' RETURNING *`,
      [`wc-${status}`, id]
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    try {
      await updateOrderStatusInWooCommerce(id, status);
    } catch (wcError) {
      await client.query("ROLLBACK");
      console.error(`Failed to update WooCommerce status for order ${id}:`, wcError);
      return res.status(502).json({
        success: false,
        message: "Failed to update order status on WordPress/WooCommerce. No changes were saved.",
      });
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: `Order status updated to ${status} successfully`,
      order: { id: rows[0].id, status: stripStatusPrefix(rows[0].status) },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`Error updating order status for ID ${id}:`, error);
    return res.status(500).json({ success: false, message: "Failed to update order status" });
  } finally {
    client.release();
  }
};

const ADDRESS_FIELDS = ["first_name", "last_name", "company", "address_1", "address_2", "city", "state", "postcode", "country", "email", "phone"];

// PUT /api/orders/:id/address
// Same local-then-WooCommerce pattern as updateStatus: writes gb_wc_order_addresses inside a
// transaction, pushes the same billing/shipping fields to WooCommerce, and rolls back the local
// write if WooCommerce rejects it so both sides stay in sync.
exports.updateAddress = async (req, res) => {
  const { id } = req.params;
  const { billing, shipping } = req.body;

  if (!billing && !shipping) {
    return res.status(400).json({ success: false, message: "billing and/or shipping is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderExists = await client.query(
      `SELECT id FROM gb_wc_orders WHERE id = $1 AND type = 'shop_order'`,
      [id]
    );
    if (orderExists.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const upsertAddress = async (addressType, address) => {
      const values = ADDRESS_FIELDS.map((field) => address[field] ?? "");

      const updateRes = await client.query(
        `UPDATE gb_wc_order_addresses SET
           first_name = $1, last_name = $2, company = $3, address_1 = $4, address_2 = $5,
           city = $6, state = $7, postcode = $8, country = $9, email = $10, phone = $11
         WHERE order_id = $12 AND address_type = $13`,
        [...values, id, addressType]
      );

      if (updateRes.rowCount === 0) {
        await client.query(
          `INSERT INTO gb_wc_order_addresses
             (order_id, address_type, first_name, last_name, company, address_1, address_2, city, state, postcode, country, email, phone)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [id, addressType, ...values]
        );
      }
    };

    if (billing) {
      await upsertAddress("billing", billing);
      if (billing.email) {
        await client.query(`UPDATE gb_wc_orders SET billing_email = $1 WHERE id = $2`, [billing.email, id]);
      }
    }
    if (shipping) {
      await upsertAddress("shipping", shipping);
    }

    const wcPayload = {};
    if (billing) wcPayload.billing = billing;
    if (shipping) wcPayload.shipping = shipping;

    try {
      await updateOrderInWooCommerce(id, wcPayload);
    } catch (wcError) {
      await client.query("ROLLBACK");
      console.error(`Failed to update WooCommerce address for order ${id}:`, wcError);
      return res.status(502).json({
        success: false,
        message: "Failed to update order address on WordPress/WooCommerce. No changes were saved.",
      });
    }

    await client.query("COMMIT");

    return res.json({ success: true, message: "Order address updated successfully" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`Error updating order address for ID ${id}:`, error);
    return res.status(500).json({ success: false, message: "Failed to update order address" });
  } finally {
    client.release();
  }
};

// GET /api/orders/local?page=&per_page=&status=&customer_id=
exports.getLocalOrders = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 20, 100);
    const status = req.query.status || "";
    const customerId = req.query.customer_id || "";

    const conditions = ["type = 'shop_order'"];
    const params = [];

    if (status) {
      params.push(status, `wc-${status}`);
      conditions.push(`status IN ($${params.length - 1}, $${params.length})`);
    }
    if (customerId) {
      params.push(customerId);
      conditions.push(`customer_id = $${params.length}`);
    }

    const whereClause = conditions.join(" AND ");

    const countRes = await pool.query(`SELECT COUNT(*) FROM gb_wc_orders WHERE ${whereClause}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(perPage, (page - 1) * perPage);
    const { rows } = await pool.query(
      `SELECT * FROM gb_wc_orders WHERE ${whereClause} ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const orders = await buildOrdersPayload(rows);

    res.json({
      success: true,
      orders,
      pagination: {
        page,
        per_page: perPage,
        total,
        totalPages: Math.ceil(total / perPage),
      },
    });
  } catch (error) {
    console.error("Error fetching local orders:", error);
    res.status(500).json({ success: false, message: "Failed to fetch orders from local database" });
  }
};

// GET /api/orders/local/:id
exports.getLocalOrderById = async (req, res) => {
  try {
    const rows = await fetchOrderRows("id = $1", [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const [order] = await buildOrdersPayload(rows);

    const productImages = await fetchProductImages(order.line_items.map((li) => li.product_id));
    order.line_items = order.line_items.map((li) => ({
      ...li,
      image: productImages[li.product_id] || null,
    }));

    // Order attribution, derived from the generic meta_data the order already carries
    const metaMap = {};
    order.meta_data.forEach((m) => { metaMap[m.key] = m.value; });
    let origin = metaMap["_wc_order_attribution_source_type"] || "Direct";
    const utmSource = metaMap["_wc_order_attribution_utm_source"];
    if (utmSource && utmSource !== "(direct)") {
      origin = `${origin}: ${utmSource}`;
    }
    order.attribution = {
      origin: origin.charAt(0).toUpperCase() + origin.slice(1),
      device_type: metaMap["_wc_order_attribution_device_type"] || "",
      session_pages: metaMap["_wc_order_attribution_session_pages"] || "",
      referrer: metaMap["_wc_order_attribution_referrer"] || "",
    };

    // Customer order history, computed from the local orders table
    if (order.customer_id) {
      const statsRes = await pool.query(
        `SELECT COUNT(*)::int AS total_orders, COALESCE(SUM(total_amount), 0) AS total_revenue
         FROM gb_wc_orders WHERE customer_id = $1 AND type = 'shop_order' AND status NOT IN ('auto-draft', 'trash')`,
        [order.customer_id]
      );
      const { total_orders, total_revenue } = statsRes.rows[0];
      order.customer_stats = {
        total_orders,
        total_revenue: num(total_revenue),
        average_order_value: total_orders > 0 ? (Number(total_revenue) / total_orders).toFixed(2) : "0.00",
      };
    } else {
      order.customer_stats = { total_orders: 0, total_revenue: "0.00", average_order_value: "0.00" };
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error(`Error fetching local order ${req.params.id}:`, error);
    res.status(500).json({ success: false, message: "Failed to fetch order from local database" });
  }
};

// GET /api/orders/local/:id/weight — ported from the WordPress "Weight (kg)" calculation
exports.getOrderWeight = async (req, res) => {
  try {
    const rows = await fetchOrderRows("id = $1", [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const [order] = await buildOrdersPayload(rows);
    const { total_weight, warnings } = await computeOrderWeight(order);

    console.log(`[tekipost] order #${order.id} computed weight: ${total_weight} kg`);
    if (warnings.length) console.log(`[tekipost] order #${order.id} weight warnings:`, warnings);

    res.json({ success: true, total_weight, warnings });
  } catch (error) {
    console.error(`Error computing weight for order ${req.params.id}:`, error);
    res.status(500).json({ success: false, message: "Failed to compute order weight" });
  }
};

// Fires an HTTPS request and resolves with the status code plus the parsed JSON body
// (or the raw text if the response wasn't valid JSON). Used by the TekiPost/Shiprocket
// login + order-create calls below, where a non-2xx or unparsable response must be
// surfaced as a real error instead of being swallowed as a silent "success".
function httpJsonRequest(url, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (r) => {
      let data = "";
      r.on("data", (c) => (data += c));
      r.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          // leave json as null; raw text is still returned below
        }
        resolve({ statusCode: r.statusCode, raw: data, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// On a real successful send, WordPress's send_order_to_{shiprocket,tekipost}() marks the order
// completed and saves a "<carrier>_status" = "Sent" post meta (which is what the "Not Sent" badge
// on the order page reads). Mirrors that: updates the local copy, then pushes the same change to
// WooCommerce so the two stay in sync — matching the existing status-update pattern.
async function markOrderSentToCarrier(orderId, metaKey) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE gb_wc_orders SET status = 'wc-completed', date_updated_gmt = NOW() WHERE id = $1 AND type = 'shop_order'`,
      [orderId]
    );
    const updateRes = await client.query(
      `UPDATE gb_wc_orders_meta SET meta_value = 'Sent' WHERE order_id = $1 AND meta_key = $2`,
      [orderId, metaKey]
    );
    if (updateRes.rowCount === 0) {
      await client.query(
        `INSERT INTO gb_wc_orders_meta (order_id, meta_key, meta_value) VALUES ($1, $2, 'Sent')`,
        [orderId, metaKey]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  try {
    await updateOrderInWooCommerce(orderId, { status: "completed", meta_data: [{ key: metaKey, value: "Sent" }] });
  } catch (error) {
    // The local record is already marked sent (the shipment really was created) — a failure to also
    // push the flag to WooCommerce shouldn't fail the whole request, just gets logged for visibility.
    console.error(`Failed to sync "${metaKey}" = Sent to WooCommerce for order ${orderId}:`, error);
  }
}

// POST /api/orders/local/:id/tekipost-preview — builds the TekiPost payload, logs it, and
// actually submits it to TekiPost (login + create order). Returns the live submission result
// so the frontend can show whether TekiPost really accepted the order.
exports.previewTekipost = async (req, res) => {
  try {
    // Matches PHP: $shipweight = $_POST['total_weight']; must be provided and numeric > 0.
    const totalWeight = req.body?.total_weight;
    if (totalWeight === undefined || totalWeight === null || totalWeight === "") {
      return res.status(400).json({ success: false, message: "Weight not provided." });
    }
    if (!Number.isFinite(Number(totalWeight)) || Number(totalWeight) <= 0) {
      return res.status(400).json({ success: false, message: "Invalid weight provided." });
    }

    const rows = await fetchOrderRows("id = $1", [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const [order] = await buildOrdersPayload(rows);

    if (order.status === "failed") {
      return res.status(400).json({ success: false, message: "Order status is failed." });
    }
    if (order.status === "cancelled") {
      return res.status(400).json({ success: false, message: "Order status is cancelled." });
    }

    const { payload, warnings } = await buildTekipostPreview(order);
    payload.physical_weight = Number(totalWeight); // admin-entered weight overrides the auto-computed one, per PHP

    // console.log(`[tekipost] order #${order.id} payload:`, JSON.stringify(payload, null, 2));
    // if (warnings.length) console.log(`[tekipost] order #${order.id} warnings:`, warnings);

    const loginRes = await httpJsonRequest("https://app.tekipost.com/api-login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "promotion@gullybaba.com",
        password: "*&^Dot1936slas",
      }).toString(),
    });
    const apiToken = loginRes.json?.data?.token;
    if (!apiToken) {
      console.error(`[tekipost] order #${order.id} login failed:`, loginRes.statusCode, loginRes.raw);
      return res.status(502).json({
        success: false,
        message: "TekiPost login failed — could not retrieve API token.",
        details: loginRes.json || loginRes.raw,
      });
    }

    const submitRes = await httpJsonRequest("https://app.tekipost.com/api-b2c-single-order", {
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
      body: JSON.stringify(payload),
    });
    console.log(`[tekipost] order #${order.id} submit response (${submitRes.statusCode}):`, submitRes.raw);

    if (!submitRes.json) {
      return res.status(502).json({
        success: false,
        message: "TekiPost returned an unexpected (non-JSON) response.",
        details: submitRes.raw,
        payload,
        warnings,
      });
    }

    // Matches the WordPress branches exactly: CANCELED and a 422 validation error are both reported
    // back as non-fatal messages (the order was still "handled", just not actually shipped); anything
    // else with a non-2xx status is a real failure. Only the true success path marks the order Sent.
    if (submitRes.json.status === "CANCELED") {
      return res.json({ success: true, payload, warnings, message: "Order already Cancelled in TekiPost.", submission: submitRes.json });
    }
    if (submitRes.json.status_code === 422) {
      return res.json({ success: true, payload, warnings, message: JSON.stringify(submitRes.json.errors || submitRes.json), submission: submitRes.json });
    }
    if (submitRes.statusCode < 200 || submitRes.statusCode >= 300) {
      return res.status(502).json({
        success: false,
        message: submitRes.json.message || "TekiPost rejected the order.",
        details: submitRes.json,
        payload,
        warnings,
      });
    }

    await markOrderSentToCarrier(order.id, "tekipost_status");
    res.json({ success: true, payload, warnings, message: "Order successfully sent to TekiPost.", submission: submitRes.json });
  } catch (error) {
    console.error(`Error sending order ${req.params.id} to TekiPost:`, error);
    res.status(500).json({ success: false, message: error.message || "Failed to send order to TekiPost" });
  }
};

// POST /api/orders/local/:id/shiprocket-preview — builds the Shiprocket payload, logs it, and
// actually submits it to Shiprocket (login + create order). Returns the live submission result
// so the frontend can show whether Shiprocket really accepted the order.
exports.previewShiprocket = async (req, res) => {
  try {
    // Matches PHP: $shipweight = $_POST['total_weight']; must be provided and numeric > 0.
    const totalWeight = req.body?.total_weight;
    if (totalWeight === undefined || totalWeight === null || totalWeight === "") {
      return res.status(400).json({ success: false, message: "Weight not provided." });
    }
    if (!Number.isFinite(Number(totalWeight)) || Number(totalWeight) <= 0) {
      return res.status(400).json({ success: false, message: "Invalid weight provided." });
    }

    const rows = await fetchOrderRows("id = $1", [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const [order] = await buildOrdersPayload(rows);

    if (order.status === "failed") {
      return res.status(400).json({ success: false, message: "Order status is failed." });
    }

    const { payload, warnings } = await buildShiprocketPreview(order);
    payload.weight = Number(totalWeight); // admin-entered weight overrides the internally computed one, per PHP

    // console.log(`[shiprocket] order #${order.id} payload:`, JSON.stringify(payload, null, 2));
    // if (warnings.length) console.log(`[shiprocket] order #${order.id} warnings:`, warnings);

    const loginRes = await httpJsonRequest("https://apiv2.shiprocket.in/v1/external/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "kids@gullybaba.com", password: "Test@123" }),
    });
    const apiToken = loginRes.json?.token;
    if (!apiToken) {
      console.error(`[shiprocket] order #${order.id} login failed:`, loginRes.statusCode, loginRes.raw);
      return res.status(502).json({
        success: false,
        message: "Shiprocket login failed — could not retrieve API token.",
        details: loginRes.json || loginRes.raw,
      });
    }

    const submitRes = await httpJsonRequest("https://apiv2.shiprocket.in/v1/external/orders/create/adhoc", {
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
      body: JSON.stringify(payload),
    });
    console.log(`[shiprocket] order #${order.id} submit response (${submitRes.statusCode}):`, submitRes.raw);

    if (!submitRes.json) {
      return res.status(502).json({
        success: false,
        message: "Shiprocket returned an unexpected (non-JSON) response.",
        details: submitRes.raw,
        payload,
        warnings,
      });
    }

    // Matches the WordPress branches exactly: CANCELED and a 422 validation error are both reported
    // back as non-fatal messages (the order was still "handled", just not actually shipped); anything
    // else with a non-2xx status is a real failure. Only the true success path marks the order Sent.
    if (submitRes.json.status === "CANCELED") {
      return res.json({ success: true, payload, warnings, message: "Order already Cancelled in Shiprocket.", submission: submitRes.json });
    }
    if (submitRes.json.status_code === 422) {
      return res.json({ success: true, payload, warnings, message: JSON.stringify(submitRes.json.errors || submitRes.json), submission: submitRes.json });
    }
    if (submitRes.statusCode < 200 || submitRes.statusCode >= 300) {
      return res.status(502).json({
        success: false,
        message: submitRes.json.message || "Shiprocket rejected the order.",
        details: submitRes.json,
        payload,
        warnings,
      });
    }

    await markOrderSentToCarrier(order.id, "shiprocket_status");
    res.json({ success: true, payload, warnings, message: "Order successfully sent to Shiprocket.", submission: submitRes.json });
  } catch (error) {
    console.error(`Error sending order ${req.params.id} to Shiprocket:`, error);
    res.status(500).json({ success: false, message: error.message || "Failed to send order to Shiprocket" });
  }
};

// GET /api/orders/local/:id/tekipost-status — "Click to Get Current Status of tekipost Details".
// Ports get_tekipost_token() + fetch_tekipost_tracking_details() + save_tekipost_tracking_to_order().
exports.fetchTekipostStatus = async (req, res) => {
  try {
    const rows = await fetchOrderRows("id = $1", [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const [order] = await buildOrdersPayload(rows);

    const loginRes = await httpJsonRequest("https://app.tekipost.com/api-login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "promotion@gullybaba.com", password: "*&^Dot1936slas" }),
    });
    const token = loginRes.json?.data?.token;
    if (!token) throw new Error("Unable to authenticate with TekiPost.");

    // Step 1: shipment detail -> AWB + courier name
    const shipmentRes = await httpJsonRequest("https://app.tekipost.com/api-order-shipment-detail", {
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ order_no: order.id }),
    });
    if (!shipmentRes.json) {
      console.error(`[tekipost-status] order #${order.id} non-JSON shipment-detail response:`, shipmentRes.statusCode, shipmentRes.raw);
      throw new Error("TekiPost returned an unexpected response for shipment detail.");
    }
    const awbNumber = shipmentRes.json.tracking_number || "";
    if (!awbNumber) {
      // Expected right after an order is placed: TekiPost hasn't assigned an AWB/picked it up yet.
      const err = new Error(shipmentRes.json.message || "No tracking number available yet — order is still pending pickup at TekiPost.");
      err.statusCode = 409;
      throw err;
    }

    // Step 2: tracking detail by AWB -> latest status
    const trackingRes = await httpJsonRequest(`https://app.tekipost.com/api-tracking-details/${awbNumber}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const latestStatus = trackingRes.json?.data?.status_name || "";

    const trackingDetails = {
      tracking_number: awbNumber,
      courier_name: shipmentRes.json.courier_name || "",
      tracking_statuses: latestStatus,
    };

    // Save back to the order — mirrors $order->update_meta_data(...)->save() via the WC REST API.
    await new Promise((resolve, reject) => {
      const putUrl = getApiUrl("orders", {}, order.id);
      const putReq = https.request(putUrl, { method: "PUT", headers: { "Authorization": getBasicAuthHeader(), "Content-Type": "application/json" } }, (r) => {
        let data = ""; r.on("data", (c) => (data += c)); r.on("end", () => resolve(data));
      });
      putReq.on("error", reject);
      putReq.write(JSON.stringify({ meta_data: [
        { key: "_tekipost_awb", value: trackingDetails.tracking_number },
        { key: "_tekipost_courier_name", value: trackingDetails.courier_name },
        { key: "_tekipost_c_status", value: trackingDetails.tracking_statuses },
      ] }));
      putReq.end();
    });

    console.log(`[tekipost-status] order #${order.id} tracking details:`, trackingDetails);
    return res.json({ success: true, ...trackingDetails });
  } catch (error) {
    console.error(`Error fetching TekiPost status for order ${req.params.id}:`, error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || "Failed to fetch TekiPost status" });
  }
};

// GET /api/orders/local/:id/shiprocket-status — "Click to Get Current Status of Shiprocket Details".
// Ports the WordPress get_shiprocket_detail_button() + fetch_shiprocket_tracking_details() + save_shiprocket_tracking_to_order() flow.
exports.fetchShiprocketStatus = async (req, res) => {
  try {
    const rows = await fetchOrderRows("id = $1", [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const [order] = await buildOrdersPayload(rows);

    const loginRes = await httpJsonRequest("https://apiv2.shiprocket.in/v1/external/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "kids@gullybaba.com", password: "Test@123" }),
    });
    const token = loginRes.json?.token;
    if (!token) throw new Error("Unable to authenticate with Shiprocket.");

    // Step 1: order lookup by WooCommerce order id -> shipment (AWB + courier)
    const orderRes = await httpJsonRequest(`https://apiv2.shiprocket.in/v1/external/orders/show/${order.id}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!orderRes.json) {
      console.error(`[shiprocket-status] order #${order.id} non-JSON order lookup response:`, orderRes.statusCode, orderRes.raw);
      throw new Error("Shiprocket returned an unexpected response for the order lookup.");
    }
    const shipment = orderRes.json?.data?.shipments?.[0] || {};
    const awbCode = shipment.awb || "";
    if (!awbCode) {
      // Expected right after an order is placed: Shiprocket hasn't assigned an AWB/picked it up yet.
      const err = new Error("No AWB code available yet — order is still pending pickup at Shiprocket.");
      err.statusCode = 409;
      throw err;
    }

    // Step 2: track by AWB -> current status, pickup date, EDD
    const trackRes = await httpJsonRequest(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awbCode}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const shipmentTrack = trackRes.json?.tracking_data?.shipment_track?.[0] || {};

    const trackingDetails = {
      awb_code: awbCode,
      pickup_date: shipmentTrack.pickup_date || "",
      current_status: shipmentTrack.current_status || "",
      courier_name: shipment.courier || shipmentTrack.courier_name || "",
      edd: shipmentTrack.edd || "",
    };

    // Save back to the order — mirrors $order->update_meta_data(...)->save() via the WC REST API.
    await new Promise((resolve, reject) => {
      const putUrl = getApiUrl("orders", {}, order.id);
      const putReq = https.request(putUrl, { method: "PUT", headers: { "Authorization": getBasicAuthHeader(), "Content-Type": "application/json" } }, (r) => {
        let data = ""; r.on("data", (c) => (data += c)); r.on("end", () => resolve(data));
      });
      putReq.on("error", reject);
      putReq.write(JSON.stringify({ meta_data: [
        { key: "_shiprocket_awb", value: trackingDetails.awb_code },
        { key: "_shiprocket_pickup_date", value: trackingDetails.pickup_date },
        { key: "_shiprocket_current_status", value: trackingDetails.current_status },
        { key: "_shiprocket_courier_name", value: trackingDetails.courier_name },
        { key: "_shiprocket_edd", value: trackingDetails.edd },
      ] }));
      putReq.end();
    });

    console.log(`[shiprocket-status] order #${order.id} tracking details:`, trackingDetails);
    return res.json({ success: true, ...trackingDetails });
  } catch (error) {
    console.error(`Error fetching Shiprocket status for order ${req.params.id}:`, error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message || "Failed to fetch Shiprocket status" });
  }
};

// GET /api/orders/local/:id/notes — order notes list.
// Ports WooCommerce's order-notes metabox: rows in gb_comments with comment_type = 'order_note' and
// comment_post_id = the order id, newest first. A note is "customer-visible" when it has an
// is_customer_note = 1 row in gb_commentmeta (mirrors WC's wc_add_order_note()); notes without that
// meta are private admin notes. Notes imported from WordPress have no commentmeta, so they render as
// private notes here regardless of how WordPress displayed them.
exports.getOrderNotes = async (req, res) => {
  try {
    const { rows: orderRows } = await pool.query(`SELECT id FROM gb_wc_orders WHERE id = $1 AND type = 'shop_order'`, [req.params.id]);
    if (orderRows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const { rows } = await pool.query(
      `SELECT c.comment_id, c.comment_author, c.comment_content, c.comment_date, c.user_id,
              COALESCE(m.meta_value, '0') = '1' AS is_customer_note
       FROM gb_comments c
       LEFT JOIN gb_commentmeta m ON m.comment_id = c.comment_id AND m.meta_key = 'is_customer_note'
       WHERE c.comment_post_id = $1 AND c.comment_type = 'order_note'
       ORDER BY c.comment_date DESC, c.comment_id DESC`,
      [req.params.id]
    );

    const notes = rows.map((r) => ({
      id: Number(r.comment_id),
      content: r.comment_content,
      date: r.comment_date,
      author: r.comment_author,
      is_customer_note: r.is_customer_note,
      is_system_note: Number(r.user_id) === 0 && r.comment_author === "WooCommerce",
    }));

    res.json({ success: true, notes });
  } catch (error) {
    console.error(`Error fetching order notes for order ${req.params.id}:`, error);
    res.status(500).json({ success: false, message: "Failed to fetch order notes" });
  }
};

// POST /api/orders/local/:id/notes — add an order note. body: { content, note_type }
// note_type is "customer" for "Note to customer", anything else (including "") is a private note.
// Mirrors WC_Order::add_order_note(), including the is_customer_note commentmeta flag.
exports.addOrderNote = async (req, res) => {
  const { content, note_type } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ success: false, message: "Note content is required" });
  }

  try {
    const { rows: orderRows } = await pool.query(`SELECT id FROM gb_wc_orders WHERE id = $1 AND type = 'shop_order'`, [req.params.id]);
    if (orderRows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const isCustomerNote = note_type === "customer";
    const author = req.user?.username || "Admin";
    const userId = req.user?.id || 0;

    const { rows } = await pool.query(
      `INSERT INTO gb_comments
         (comment_post_id, comment_author, comment_author_email, comment_author_url, comment_author_ip,
          comment_date, comment_date_gmt, comment_content, comment_approved, comment_agent, comment_type,
          comment_parent, user_id)
       VALUES ($1, $2, '', '', '', NOW(), NOW(), $3, '1', '', 'order_note', 0, $4)
       RETURNING comment_id, comment_author, comment_content, comment_date, user_id`,
      [req.params.id, author, content.trim(), userId]
    );
    const note = rows[0];

    if (isCustomerNote) {
      await pool.query(
        `INSERT INTO gb_commentmeta (comment_id, meta_key, meta_value) VALUES ($1, 'is_customer_note', '1')`,
        [note.comment_id]
      );
    }

    res.json({
      success: true,
      note: {
        id: Number(note.comment_id),
        content: note.comment_content,
        date: note.comment_date,
        author: note.comment_author,
        is_customer_note: isCustomerNote,
        is_system_note: false,
      },
    });
  } catch (error) {
    console.error(`Error adding order note for order ${req.params.id}:`, error);
    res.status(500).json({ success: false, message: "Failed to add order note" });
  }
};

// DELETE /api/orders/local/:id/notes/:noteId
exports.deleteOrderNote = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM gb_comments WHERE comment_id = $1 AND comment_post_id = $2 AND comment_type = 'order_note' RETURNING comment_id`,
      [req.params.noteId, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Note not found" });
    }

    await pool.query(`DELETE FROM gb_commentmeta WHERE comment_id = $1`, [req.params.noteId]);

    res.json({ success: true });
  } catch (error) {
    console.error(`Error deleting order note ${req.params.noteId} for order ${req.params.id}:`, error);
    res.status(500).json({ success: false, message: "Failed to delete order note" });
  }
};
