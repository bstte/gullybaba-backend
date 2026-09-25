const https = require("https");
const pool = require("../config/database");
const { updateOrderStatusInWooCommerce, updateOrderInWooCommerce } = require("./orderController");
const { getApiUrl, getBasicAuthHeader } = require("../config/woocommerce");
const { fetchCustomerById } = require("../utils/wcCustomer");

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

// POST-JSON helper against the live WooCommerce site (basic-auth bypass + JSON body)
const wcPostJson = (url, bodyObj) => {
  return new Promise((resolve) => {
    const dataStr = JSON.stringify(bodyObj || {});
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Authorization": getBasicAuthHeader(),
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(dataStr),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: json });
        } catch {
          resolve({ statusCode: res.statusCode, raw: data, data: null });
        }
      });
    });
    req.on("error", (err) => resolve({ statusCode: 500, error: err.message, data: null }));
    req.write(dataStr);
    req.end();
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

// Ports the WordPress order-send-to-dtdc OSDTDC_Api::build_consignment() payload builder.
const DTDC_LANGUAGE_CODES = {
  English: "EN",
  Hindi: "HI",
  Bengali: "BN",
  Punjabi: "PA",
  Sanskrit: "SA",
  Urdu: "UR",
  "english-medium": "EN",
  "hindi-medium": "HI",
  "bengali-medium": "BN",
  "punjabi-medium": "PA",
  "sanskrit-medium": "SA",
  "urdu-medium": "UR",
};

async function buildDtdcPayload(order, customWeight = null) {
  const warnings = [];
  const productIds = order.line_items.map((li) => li.product_id);
  const productMap = await fetchProductsBulk(productIds);

  let commodity = "";
  const pieces_detail = [];
  let totalWeight = 0;
  let totalPieces = 0;
  let excludedOrderValue = 0;
  const weightAddon = 0.015;

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

    const quantity = Math.max(1, parseInt(li.quantity, 10) || 1);
    const itemTotal = parseFloat(li.total || 0);

    const itemCode = orderItemMetaValue(li, "Code") || orderItemMetaValue(li, "code") || li.sku || "";
    let itemLang = orderItemMetaValue(li, "Medium") || orderItemMetaValue(li, "Select Medium") || orderItemMetaValue(li, "pa_languages") || li.medium || "";
    itemLang = DTDC_LANGUAGE_CODES[itemLang] || itemLang;

    if (itemCode) {
      const itemCommodity = `${itemCode} - ${itemLang} * ${quantity}`;
      commodity = commodity ? `${commodity}, ${itemCommodity}` : itemCommodity;
    }

    if (product.type === "woosb") {
      const bundleIdsRaw = productMetaValue(product, "woosb_ids");
      if (bundleIdsRaw) {
        const bundleIds = bundleIdsRaw.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
        const bundleMap = await fetchProductsBulk(bundleIds);
        const childCount = bundleIds.length;
        const totalLinePcs = quantity * childCount;
        const perPieceVal = totalLinePcs > 0 ? (itemTotal / totalLinePcs).toFixed(2) : itemTotal.toFixed(2);

        bundleIds.forEach((bid) => {
          const bp = bundleMap[bid];
          if (!bp) return;
          const childWeight = parseFloat(bp.weight || 0) + weightAddon;
          const childLength = parseFloat(bp.length) || 10;
          const childWidth = parseFloat(bp.width) || 10;
          const childHeight = parseFloat(bp.height) || 10;

          for (let i = 0; i < quantity; i++) {
            pieces_detail.push({
              description: commodity,
              declared_value: perPieceVal,
              weight: childWeight.toFixed(3),
              height: childHeight.toFixed(2),
              length: childLength.toFixed(2),
              width: childWidth.toFixed(2),
            });
            totalPieces++;
          }
          totalWeight += childWeight * quantity;
        });
      } else {
        warnings.push(`Bundle product #${li.product_id} (${li.name}) has no woosb_ids; using fallback dimensions.`);
        for (let i = 0; i < quantity; i++) {
          pieces_detail.push({
            description: commodity,
            declared_value: (quantity > 0 ? itemTotal / quantity : itemTotal).toFixed(2),
            weight: (0.5 + weightAddon).toFixed(3),
            height: "10.00",
            length: "10.00",
            width: "10.00",
          });
          totalPieces++;
        }
        totalWeight += (0.5 + weightAddon) * quantity;
      }
      continue;
    }

    let variationWeight = null;
    if (li.variation_id) {
      const variation = await fetchVariation(li.product_id, li.variation_id);
      if (variation && variation.weight) variationWeight = variation.weight;
    }

    const productWeight = parseFloat(variationWeight || product.weight || 0) + weightAddon;
    const length = parseFloat(product.length) || 10;
    const width = parseFloat(product.width) || 10;
    const height = parseFloat(product.height) || 10;

    const perUnitWeight = productWeight.toFixed(3);
    const perUnitDeclaredVal = (quantity > 0 ? itemTotal / quantity : itemTotal).toFixed(2);

    for (let i = 0; i < quantity; i++) {
      pieces_detail.push({
        product_code: commodity,
        declared_value: perUnitDeclaredVal,
        weight: perUnitWeight,
        height: height.toFixed(2),
        length: length.toFixed(2),
        width: width.toFixed(2),
      });
    }

    totalWeight += productWeight * quantity;
    totalPieces += quantity;
  }

  if (totalWeight <= 0) {
    totalWeight = 0.5;
  }
  if (totalPieces <= 0) {
    totalPieces = 1;
  }

  const finalWeight = customWeight && Number(customWeight) > 0 ? Number(customWeight) : totalWeight;
  const declaredValue = Math.max(0, parseFloat(order.total) - excludedOrderValue);
  const paymentMethod = (order.payment_method || "").toLowerCase();
  const isCod = paymentMethod === "cod";

  const shippingState = order.shipping?.state || order.billing?.state || "";
  const shippingCity = order.shipping?.city || order.billing?.city || "";
  const shippingAddress1 = order.shipping?.address_1 || order.billing?.address_1 || "";
  const shippingAddress2 = order.shipping?.address_2 || order.billing?.address_2 || "";
  const shippingPostcode = order.shipping?.postcode || order.billing?.postcode || "";
  const customerName = `${order.shipping?.first_name || order.billing?.first_name || ""} ${order.shipping?.last_name || order.billing?.last_name || ""}`.trim();
  const phone = order.billing?.phone || "";

  const dateParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(order.date_created)); // e.g. "23 Sep 2026"

  const payload = {
    customer_code: process.env.DTDC_CUSTOMER_CODE || "GL018",
    service_type_id: process.env.DTDC_SERVICE_TYPE_ID || "GROUND EXPRESS",
    load_type: process.env.DTDC_LOAD_TYPE || "NON-DOCUMENT",
    consignment_type: process.env.DTDC_CONSIGNMENT_TYPE || "Forward",
    description: commodity,
    dimension_unit: "cm",
    length: "10",
    width: "10",
    height: "10",
    weight_unit: "kg",
    weight: Number(finalWeight).toFixed(3),
    declared_value: Number(declaredValue).toFixed(2),
    num_pieces: 1,
    origin_details: {
      name: process.env.DTDC_ORIGIN_NAME || "TEST ENTERPRISES",
      phone: process.env.DTDC_ORIGIN_PHONE || "0000000000",
      alternate_phone: process.env.DTDC_ORIGIN_ALT_PHONE || "0000000000",
      address_line_1: process.env.DTDC_ORIGIN_ADDRESS_1 || "",
      address_line_2: process.env.DTDC_ORIGIN_ADDRESS_2 || "",
      pincode: process.env.DTDC_ORIGIN_PINCODE || "",
      city: process.env.DTDC_ORIGIN_CITY || "",
      latitude: "",
      longitude: "",
      state: process.env.DTDC_ORIGIN_STATE || "",
    },
    destination_details: {
      name: customerName,
      phone,
      alternate_phone: phone,
      address_line_1: shippingAddress1,
      address_line_2: shippingAddress2,
      pincode: shippingPostcode,
      city: shippingCity,
      latitude: "",
      longitude: "",
      state: shippingState,
    },
    return_details: {
      address_line_1: process.env.DTDC_RETURN_ADDRESS_1 || "",
      address_line_2: process.env.DTDC_RETURN_ADDRESS_2 || "",
      city_name: process.env.DTDC_RETURN_CITY || "",
      name: process.env.DTDC_RETURN_NAME || "",
      phone: process.env.DTDC_RETURN_PHONE || "0000000000",
      pincode: process.env.DTDC_RETURN_PINCODE || "",
      state_name: process.env.DTDC_RETURN_STATE || "",
      email: process.env.DTDC_RETURN_EMAIL || "",
      latitude: "",
      longitude: "",
      alternate_phone: process.env.DTDC_RETURN_ALT_PHONE || "0000000000",
    },
    customer_reference_number: String(order.id),
    cod_collection_mode: isCod ? "Cash" : "",
    cod_amount: isCod ? Number(declaredValue).toFixed(2) : "",
    commodity_id: "72",
    eway_bill: "",
    is_risk_surcharge_applicable: "false",
    invoice_number: String(order.id),
    invoice_date: dateParts,
    reference_number: "",
    pieces_detail,
  };

  if (pieces_detail.length === 0) {
    warnings.push("No valid items to send to DTDC (all line items excluded by category).");
  }

  return { payload, warnings, pieces_detail };
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

const userNameCache = new Map();

async function resolveUserNames(userIds) {
  const cleanIds = [...new Set(userIds.map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id) && id > 0))];
  if (cleanIds.length === 0) return {};

  const nameMap = {};
  const missingIds = [];

  for (const id of cleanIds) {
    if (userNameCache.has(id)) {
      nameMap[id] = userNameCache.get(id);
    } else {
      missingIds.push(id);
    }
  }

  if (missingIds.length > 0) {
    await Promise.all(
      missingIds.slice(0, 15).map(async (id) => {
        try {
          const u = await fetchCustomerById(id);
          const fullName = `${u.first_name || ""} ${u.last_name || ""}`.trim();
          const name = u.display_name || fullName || u.username || u.name || `#${id}`;
          userNameCache.set(id, name);
          nameMap[id] = name;
        } catch {
          const fallback = `#${id}`;
          nameMap[id] = fallback;
          userNameCache.set(id, fallback);
        }
      })
    );
  }

  return nameMap;
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
  const metaLookupByOrder = new Map();
  const allUpdatedUserIds = [];
  metaRes.rows.forEach((r) => {
    if (!metaByOrder.has(r.order_id)) metaByOrder.set(r.order_id, []);
    metaByOrder.get(r.order_id).push(r);

    if (!metaLookupByOrder.has(r.order_id)) metaLookupByOrder.set(r.order_id, {});
    metaLookupByOrder.get(r.order_id)[r.meta_key] = r.meta_value;
    if (r.meta_key === "_last_updated_user" && r.meta_value) {
      allUpdatedUserIds.push(r.meta_value);
    }
  });

  const userNameMap = await resolveUserNames(allUpdatedUserIds);
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

  const resolveMedium = (im) => {
    const raw = metaValue(im, "Medium") || metaValue(im, "medium") || metaValue(im, "Language") || metaValue(im, "pa_languages");
    if (!raw) return "";
    let s = String(raw).trim();
    const lower = s.toLowerCase();
    if (lower === "hindi-medium" || lower === "hindi medium" || lower === "hindi") return "Hindi";
    if (lower === "english-medium" || lower === "english medium" || lower === "english") return "English";
    if (lower === "sanskrit-medium" || lower === "sanskrit medium" || lower === "sanskrit") return "Sanskrit";
    if (lower === "urdu-medium" || lower === "urdu medium" || lower === "urdu") return "Urdu";
    if (lower === "bengali-medium" || lower === "bengali medium" || lower === "bengali") return "Bengali";
    if (lower === "punjabi-medium" || lower === "punjabi medium" || lower === "punjabi") return "Punjabi";
    return s.replace(/-medium$/i, "").replace(/^./, (c) => c.toUpperCase());
  };

  const buildLineItem = (item) => {
    const im = itemMetaByItem.get(item.order_item_id) || [];
    const extraMeta = im
      .filter((m) => !LINE_ITEM_CORE_KEYS.has(m.meta_key))
      .map((m) => ({ id: m.meta_id, key: m.meta_key, value: m.meta_value }));

    const quantity = int(metaValue(im, "_qty"));
    const subtotal = num(metaValue(im, "_line_subtotal"));
    const medium = resolveMedium(im);
    const category = metaValue(im, "Category") || metaValue(im, "category") || "";
    const code = metaValue(im, "Code") || metaValue(im, "code") || metaValue(im, "_sku") || metaValue(im, "sku") || "";
    const variationId = int(metaValue(im, "_variation_id")) || int(metaValue(im, "variation_id")) || 0;
    const session = metaValue(im, "Session") || metaValue(im, "session") || metaValue(im, "pa_assignment-session") || metaValue(im, "assignment-session") || "";
    const type = metaValue(im, "Type") || metaValue(im, "type") || metaValue(im, "pa_assignment-type") || metaValue(im, "assignment-type") || "";
    const demand = metaValue(im, "Demand") || metaValue(im, "demand") || "";
    const language = metaValue(im, "Language") || metaValue(im, "language") || medium || metaValue(im, "pa_languages") || "";
    const enrollmentNo = metaValue(im, "Enrollment No.") || metaValue(im, "Enrollment No") || metaValue(im, "enrolment no") || metaValue(im, "enrollment no") || metaValue(im, "Enrollment") || metaValue(im, "enrollment_no") || "";
    const paymentType = metaValue(im, "Payment Type") || metaValue(im, "payment type") || metaValue(im, "payment_type") || metaValue(im, "Payment_Type") || "";

    return {
      id: item.order_item_id,
      name: item.order_item_name,
      product_id: int(metaValue(im, "_product_id")),
      variation_id: variationId,
      quantity,
      tax_class: metaValue(im, "_tax_class") || "",
      subtotal,
      subtotal_tax: num(metaValue(im, "_line_subtotal_tax")),
      total: num(metaValue(im, "_line_total")),
      total_tax: num(metaValue(im, "_line_tax")),
      taxes: [], // _line_tax_data is PHP-serialized; not decoded here
      meta_data: extraMeta,
      sku: code || metaValue(im, "Code") || null,
      code,
      price: quantity > 0 ? (Number(subtotal) / quantity).toFixed(2) : subtotal,
      category,
      medium,
      language: language || medium,
      session,
      type,
      demand,
      enrollment_no: enrollmentNo,
      payment_type: paymentType,
    };
  };

  const buildShippingLine = (item) => {
    const im = itemMetaByItem.get(item.order_item_id) || [];
    const cost = metaValue(im, "cost")
      ?? metaValue(im, "total")
      ?? metaValue(im, "shipping_cost")
      ?? metaValue(im, "_line_total")
      ?? metaValue(im, "amount");
    return {
      id: item.order_item_id,
      method_title: item.order_item_name,
      method_id: metaValue(im, "method_id") || "",
      instance_id: metaValue(im, "instance_id") || "",
      total: num(cost),
      total_tax: num(metaValue(im, "total_tax")),
      taxes: [],
      meta_data: im.map((m) => ({ id: m.meta_id, key: m.meta_key, value: m.meta_value })),
    };
  };

  const buildFeeLine = (item) => {
    const im = itemMetaByItem.get(item.order_item_id) || [];
    const feeTotal = metaValue(im, "_line_total") ?? metaValue(im, "_fee_amount") ?? metaValue(im, "total") ?? metaValue(im, "amount") ?? metaValue(im, "cost");
    return {
      id: item.order_item_id,
      name: item.order_item_name,
      tax_class: metaValue(im, "_tax_class") || "",
      tax_status: metaValue(im, "_tax_status") || "",
      amount: num(metaValue(im, "_fee_amount") || feeTotal),
      total: num(feeTotal),
      total_tax: num(metaValue(im, "_line_tax")),
      taxes: [],
      meta_data: im.map((m) => ({ id: m.meta_id, key: m.meta_key, value: m.meta_value })),
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

    // If shipping line total ended up as 0.00, but operational data has shipping_total_amount > 0,
    // and there is 1 shipping line, assign that shipping_total_amount to it
    const opShipping = Number(op.shipping_total_amount) || 0;
    if (shippingLines.length === 1 && parseFloat(shippingLines[0].total) === 0 && opShipping > 0) {
      shippingLines[0].total = num(opShipping);
    }

    const calculatedShippingTotal = shippingLines.reduce((sum, s) => sum + parseFloat(s.total || "0"), 0);
    const finalShippingTotal = opShipping > 0 ? num(opShipping) : num(calculatedShippingTotal);

    // If order has a shipping amount but no items had order_item_type = 'shipping', synthesize one
    const effectiveShippingLines = shippingLines.length > 0
      ? shippingLines
      : (opShipping > 0
        ? [{
          id: 0,
          method_title: "Shipping",
          method_id: "shipping",
          instance_id: "",
          total: num(opShipping),
          total_tax: num(op.shipping_tax_amount),
          taxes: [],
          meta_data: [],
        }]
        : []);

    const status = stripStatusPrefix(o.status);

    const hasSameDay = effectiveShippingLines.some(s =>
      /same\s*day/i.test(s.method_title || "") || /same\s*day/i.test(s.method_id || "")
    );

    const oMeta = metaLookupByOrder.get(o.id) || {};
    let deliveredBy = "";
    if (oMeta["shiprocket_status"] === "Sent") {
      deliveredBy = "Shiprocket";
    } else if (oMeta["tekipost_status"] === "Sent") {
      deliveredBy = "TekiPost";
    } else if (oMeta["dtdc_status"] === "Sent" || oMeta["_dtdc_reference_number"]) {
      deliveredBy = "DTDC";
    }

    const updatedUserId = oMeta["_last_updated_user"] ? parseInt(oMeta["_last_updated_user"], 10) : null;
    let updatedBy = "";
    if (oMeta["_last_updated_user"]) {
      if (updatedUserId && Number.isFinite(updatedUserId) && updatedUserId > 0) {
        updatedBy = userNameMap[updatedUserId] || `#${updatedUserId}`;
      } else {
        updatedBy = String(oMeta["_last_updated_user"]);
      }
    }
    const orderPaymentType = oMeta["_awcdp_deposits_payment_type"] || oMeta["Payment Type"] || oMeta["payment_type"] || lineItems.find(li => li.payment_type)?.payment_type || "";

    return {
      id: o.id,
      parent_id: o.parent_order_id || 0,
      status,
      payment_type: orderPaymentType,
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
      shipping_total: finalShippingTotal,
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
      shipping_lines: effectiveShippingLines,
      is_same_day_delivery: hasSameDay,
      fee_lines: feeLines,
      coupon_lines: couponLines,
      refunds: refunds.map((r) => ({
        id: r.id,
        total: num(r.total_amount),
        date_created: r.date_created_gmt,
      })),
      delivered_by: deliveredBy,
      updated_by: updatedBy,
      display_name: updatedBy,
      updated_by_id: updatedUserId,
    };
  });
}

// Build the compact listing shape the admin Orders table expects
async function buildOrderListPayload(orderRows) {
  if (orderRows.length === 0) return [];
  const orderIds = orderRows.map((o) => o.id);

  const [addressesRes, categoriesRes, metaRes, shippingRes] = await Promise.all([
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
       WHERE order_id = ANY($1) AND meta_key IN (
         '_wc_order_attribution_source_type',
         '_wc_order_attribution_utm_source',
         'shiprocket_status',
         'tekipost_status',
         'dtdc_status',
         '_dtdc_reference_number',
         '_last_updated_user'
       )`,
      [orderIds]
    ),
    pool.query(
      `SELECT oi.order_id, oi.order_item_name, im.meta_value AS method_id
       FROM gb_woocommerce_order_items oi
       LEFT JOIN gb_woocommerce_order_itemmeta im ON im.order_item_id = oi.order_item_id AND im.meta_key = 'method_id'
       WHERE oi.order_id = ANY($1) AND oi.order_item_type = 'shipping'`,
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

  const metaByOrder = new Map();
  const userIdsToResolve = [];
  metaRes.rows.forEach((r) => {
    if (!metaByOrder.has(r.order_id)) metaByOrder.set(r.order_id, {});
    metaByOrder.get(r.order_id)[r.meta_key] = r.meta_value;
    if (r.meta_key === "_last_updated_user" && r.meta_value) {
      const parsed = parseInt(r.meta_value, 10);
      if (Number.isFinite(parsed) && parsed > 0) userIdsToResolve.push(parsed);
    }
  });

  // For orders on the current page missing _last_updated_user locally, check WooCommerce directly
  const ordersMissingUser = orderRows.filter((o) => {
    const meta = metaByOrder.get(o.id) || {};
    return !meta["_last_updated_user"];
  });

  if (ordersMissingUser.length > 0 && ordersMissingUser.length <= 5) {
    await Promise.all(
      ordersMissingUser.map(async (o) => {
        try {
          const wcOrderUrl = getApiUrl("orders", {}, o.id);
          const authHeader = getBasicAuthHeader();
          const wcData = await new Promise((resolve) => {
            https.get(wcOrderUrl, { headers: { Authorization: authHeader } }, (wcRes) => {
              let chunkData = "";
              wcRes.on("data", (c) => (chunkData += c));
              wcRes.on("end", () => {
                try { resolve(JSON.parse(chunkData)); } catch { resolve(null); }
              });
            }).on("error", () => resolve(null));
          });
          if (wcData && Array.isArray(wcData.meta_data)) {
            const m = wcData.meta_data.find((item) => item.key === "_last_updated_user");
            if (m && m.value) {
              const valStr = String(m.value);
              if (!metaByOrder.has(o.id)) metaByOrder.set(o.id, {});
              metaByOrder.get(o.id)["_last_updated_user"] = valStr;
              const p = parseInt(valStr, 10);
              if (Number.isFinite(p) && p > 0) userIdsToResolve.push(p);

              pool.query(
                `UPDATE gb_wc_orders_meta SET meta_value = $1 WHERE order_id = $2 AND meta_key = '_last_updated_user'`,
                [valStr, o.id]
              ).then((upd) => {
                if (upd.rowCount === 0) {
                  pool.query(
                    `INSERT INTO gb_wc_orders_meta (order_id, meta_key, meta_value) VALUES ($1, '_last_updated_user', $2)`,
                    [o.id, valStr]
                  ).catch(() => {});
                }
              }).catch(() => {});
            }
          }
        } catch {
          // ignore
        }
      })
    );
  }

  const userNameMap = await resolveUserNames(userIdsToResolve);

  const shippingByOrder = new Map();
  const isSameDayByOrder = new Map();
  shippingRes.rows.forEach((r) => {
    if (!shippingByOrder.has(r.order_id)) shippingByOrder.set(r.order_id, r.order_item_name);
    const combined = `${r.order_item_name || ""} ${r.method_id || ""}`.toLowerCase();
    if (combined.includes("same day") || combined.includes("sameday")) {
      isSameDayByOrder.set(r.order_id, true);
    }
  });

  const buildAddress = (addrRow, fields) => {
    const out = {};
    fields.forEach((f) => { out[f] = (addrRow && addrRow[f]) || ""; });
    return out;
  };

  return orderRows.map((o) => {
    const addr = addressesByOrder.get(o.id) || {};
    const categories = categoriesByOrder.get(o.id);
    const meta = metaByOrder.get(o.id) || {};

    let origin = "Direct";
    const sourceType = meta["_wc_order_attribution_source_type"];
    const utmSource = meta["_wc_order_attribution_utm_source"];
    if (sourceType && sourceType !== "typein") {
      origin = sourceType;
      if (utmSource && utmSource !== "(direct)") {
        origin = `${sourceType}: ${utmSource}`;
      }
    }
    const isSameDay = !!(isSameDayByOrder.get(o.id) || /same\s*day/i.test(shippingByOrder.get(o.id) || ""));

    // Delivered By: Shiprocket, TekiPost, DTDC
    let deliveredBy = "";
    if (meta["shiprocket_status"] === "Sent") {
      deliveredBy = "Shiprocket";
    } else if (meta["tekipost_status"] === "Sent") {
      deliveredBy = "TekiPost";
    } else if (meta["dtdc_status"] === "Sent" || meta["_dtdc_reference_number"]) {
      deliveredBy = "DTDC";
    }

    // Update By: user who last updated the order
    const updatedUserId = meta["_last_updated_user"] ? parseInt(meta["_last_updated_user"], 10) : null;
    let updatedBy = "";
    if (meta["_last_updated_user"]) {
      if (updatedUserId && Number.isFinite(updatedUserId) && updatedUserId > 0) {
        updatedBy = userNameMap[updatedUserId] || `#${updatedUserId}`;
      } else {
        updatedBy = String(meta["_last_updated_user"]);
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
      shipping_method: shippingByOrder.get(o.id) || "",
      is_same_day_delivery: isSameDay,
      delivered_by: deliveredBy,
      updated_by: updatedBy,
      display_name: updatedBy,
      updated_by_id: updatedUserId,
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

    const isRestricted = Array.isArray(req.allowedStatuses);
    const counts = {};
    let total = 0;
    rows.forEach((r) => {
      const value = stripStatusPrefix(r.status) || r.status;
      counts[value] = (counts[value] || 0) + r.count;
      if (!isRestricted || req.allowedStatuses.includes(value)) {
        total += r.count;
      }
    });

    const knownValues = new Set(STATUS_LIST.map((s) => s.value));
    const extraStatuses = Object.keys(counts)
      .filter((v) => !knownValues.has(v))
      .map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1).replace(/-/g, " ") }));

    const fullStatusList = [...STATUS_LIST, ...extraStatuses];
    const statusList = isRestricted
      ? fullStatusList.filter((s) => req.allowedStatuses.includes(s.value))
      : fullStatusList;

    if (isRestricted) {
      Object.keys(counts).forEach((k) => {
        if (!req.allowedStatuses.includes(k)) {
          delete counts[k];
        }
      });
    }

    res.json({
      success: true,
      total,
      statusList,
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

    const isRestricted = Array.isArray(req.allowedStatuses);

    if (status && status !== "all") {
      if (isRestricted && !req.allowedStatuses.includes(status)) {
        conditions.push("1 = 0");
      } else {
        params.push(status, `wc-${status}`);
        conditions.push(`o.status IN ($${params.length - 1}, $${params.length})`);
      }
    } else if (isRestricted) {
      if (req.allowedStatuses.length === 0) {
        conditions.push("1 = 0");
      } else {
        const allowedFull = [];
        req.allowedStatuses.forEach((s) => {
          allowedFull.push(s, `wc-${s}`);
        });
        params.push(allowedFull);
        conditions.push(`o.status = ANY($${params.length})`);
      }
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

const ORDER_ADDRESS_FIELDS = ["first_name", "last_name", "company", "address_1", "address_2", "city", "state", "postcode", "country", "email", "phone"];

// PUT /api/orders/:id/status
// Keeps WordPress/WooCommerce and the local database in sync: the local row is updated inside
// a transaction, then pushed to WooCommerce; if the WooCommerce call fails, the local change is
// rolled back so neither side is ever left out of sync with the other.
// POST /api/orders/create — webhook for WordPress to call when a new WooCommerce order is created,
// so it lands in this local copy too. Writes everything this app actually reads: gb_wc_orders,
// gb_wc_orders_meta, gb_wc_order_addresses, gb_wc_order_operational_data, gb_woocommerce_order_items
// and gb_woocommerce_order_itemmeta — all inside one transaction. Idempotent/resend-safe: the base
// order row is upserted on `id`, and every child table is fully replaced (delete-then-insert) for
// that order_id, so a retried webhook call never creates duplicates.
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
//   "customer_note": "",
//   "meta": [ { "key": "_order_source", "value": "app" }, ... ],
//   "addresses": {
//     "billing":  { "first_name": "...", ..., "email": "...", "phone": "..." },
//     "shipping": { "first_name": "...", ... }
//   },
//   "operational_data": {
//     "created_via": "checkout", "woocommerce_version": "9.4.0", "prices_include_tax": false,
//     "coupon_usages_are_counted": true, "download_permission_granted": true, "cart_hash": "...",
//     "new_order_email_sent": true, "order_key": "wc_order_...", "order_stock_reduced": true,
//     "date_paid_gmt": "2026-08-31 12:00:05", "date_completed_gmt": null,
//     "shipping_tax_amount": 0, "shipping_total_amount": 0,
//     "discount_tax_amount": 0, "discount_total_amount": 0, "recorded_sales": true
//   },
//   "items": [
//     {
//       "order_item_id": 4501,             // REQUIRED per item — must match WP's order_item_id
//       "order_item_name": "IGNOU MBA Guide",
//       "order_item_type": "line_item",    // line_item | shipping | tax | coupon | fee
//       "meta": [ { "key": "_product_id", "value": "123" }, { "key": "_qty", "value": "1" }, ... ]
//     }
//   ],
//   // Everything below is optional / best-effort — WooCommerce computes these analytics tables
//   // asynchronously, so send them only if/when available; if omitted, nothing is written for them.
//   "coupon_lookup": [ { "coupon_id": 12, "date_created": "...", "discount_amount": 50 } ],
//   "product_lookup": [
//     { "order_item_id": 4501, "product_id": 123, "variation_id": 0, "customer_id": 98891,
//       "date_created": "...", "product_qty": 1, "product_net_revenue": 300, "product_gross_revenue": 318,
//       "coupon_amount": 0, "tax_amount": 18, "shipping_amount": 0, "shipping_tax_amount": 0 }
//   ],
//   "tax_lookup": [ { "tax_rate_id": 1, "date_created": "...", "shipping_tax": 0, "order_tax": 18, "total_tax": 18 } ],
//   "stats": {
//     "parent_id": 0, "date_created": "...", "date_created_gmt": "...", "date_paid": "...",
//     "date_completed": null, "num_items_sold": 1, "total_sales": 318, "tax_total": 18,
//     "shipping_total": 0, "net_total": 300, "returning_customer": false
//   }
// }
// Expected JSON body format:
// Can be either the direct table schema OR standard WooCommerce order format (e.g. from $order->get_data()).
// All WordPress IDs (order id, item id, product id, variation id, meta id, address id) are strictly preserved.
exports.createOrder = async (req, res) => {
  const body = req.body || {};
  const orderId = body.id || body.order_id;

  if (!orderId) {
    return res.status(400).json({ success: false, message: "Order id is required (must match WordPress order ID)" });
  }

  // Normalize order status (WooCommerce DB format uses "wc-" prefix, except core WordPress post statuses)
  let rawStatus = body.status ? String(body.status).trim() : "wc-processing";
  let status = rawStatus;
  if (status && !status.startsWith("wc-") && !["trash", "auto-draft"].includes(status)) {
    status = `wc-${status}`;
  }

  const currency = body.currency || "INR";
  const type = body.type || "shop_order";
  const tax_amount = body.tax_amount ?? body.total_tax ?? 0;
  const total_amount = body.total_amount ?? body.total ?? 0;
  const customer_id = body.customer_id ?? 0;
  const billing_email = body.billing_email || body.billing?.email || body.addresses?.billing?.email || null;
  const date_created_gmt = body.date_created_gmt || body.date_created || new Date().toISOString().slice(0, 19).replace("T", " ");
  const date_updated_gmt = body.date_updated_gmt || body.date_modified_gmt || body.date_modified || date_created_gmt;
  const parent_order_id = body.parent_order_id ?? body.parent_id ?? 0;
  const payment_method = body.payment_method || null;
  const payment_method_title = body.payment_method_title || null;
  const transaction_id = body.transaction_id || null;
  const ip_address = body.ip_address || body.customer_ip_address || null;
  const user_agent = body.user_agent || body.customer_user_agent || null;
  const customer_note = body.customer_note || null;

  // Operational data normalization
  const op = body.operational_data || {};
  const opData = {
    id: op.id ?? null,
    created_via: op.created_via || body.created_via || "checkout",
    woocommerce_version: op.woocommerce_version || body.version || null,
    prices_include_tax: op.prices_include_tax ?? body.prices_include_tax ?? false,
    coupon_usages_are_counted: op.coupon_usages_are_counted ?? true,
    download_permission_granted: op.download_permission_granted ?? false,
    cart_hash: op.cart_hash || body.cart_hash || null,
    new_order_email_sent: op.new_order_email_sent ?? false,
    order_key: op.order_key || body.order_key || null,
    order_stock_reduced: op.order_stock_reduced ?? true,
    date_paid_gmt: op.date_paid_gmt || body.date_paid_gmt || body.date_paid || null,
    date_completed_gmt: op.date_completed_gmt || body.date_completed_gmt || body.date_completed || null,
    shipping_tax_amount: op.shipping_tax_amount ?? body.shipping_tax ?? 0,
    shipping_total_amount: op.shipping_total_amount ?? body.shipping_total ?? 0,
    discount_tax_amount: op.discount_tax_amount ?? body.discount_tax ?? 0,
    discount_total_amount: op.discount_total_amount ?? body.discount_total ?? 0,
    recorded_sales: op.recorded_sales ?? true,
  };

  // If shipping_total_amount is 0, but shipping items were passed, infer it
  if (Number(opData.shipping_total_amount) === 0) {
    if (Array.isArray(body.shipping_lines) && body.shipping_lines.length > 0) {
      const sSum = body.shipping_lines.reduce((acc, s) => acc + Number(s.cost || s.total || s.amount || s.shipping_amount || 0), 0);
      if (sSum > 0) opData.shipping_total_amount = sSum;
    } else if (Array.isArray(body.items)) {
      const sItems = body.items.filter((i) => i.order_item_type === "shipping" || i.type === "shipping" || i.method_title);
      const sSum = sItems.reduce((acc, s) => acc + Number(s.cost || s.total || s.amount || s.shipping_amount || 0), 0);
      if (sSum > 0) opData.shipping_total_amount = sSum;
    }
  }

  // Addresses normalization (supports body.addresses.billing or root body.billing)
  const billingAddress = body.addresses?.billing || body.billing || null;
  const shippingAddress = body.addresses?.shipping || body.shipping || null;

  // Order items normalization (supports body.items or body.line_items + shipping_lines + fee_lines + coupon_lines)
  let rawItems = [];
  if (Array.isArray(body.items) && body.items.length > 0) {
    rawItems = body.items;
  } else {
    if (Array.isArray(body.line_items)) {
      body.line_items.forEach((li) => {
        rawItems.push({
          ...li,
          order_item_id: li.order_item_id || li.id,
          order_item_name: li.order_item_name || li.name,
          order_item_type: "line_item",
        });
      });
    }
    if (Array.isArray(body.shipping_lines)) {
      body.shipping_lines.forEach((sl) => {
        rawItems.push({
          ...sl,
          order_item_id: sl.order_item_id || sl.id,
          order_item_name: sl.order_item_name || sl.method_title || "Shipping",
          order_item_type: "shipping",
        });
      });
    }
    if (Array.isArray(body.fee_lines)) {
      body.fee_lines.forEach((fl) => {
        rawItems.push({
          ...fl,
          order_item_id: fl.order_item_id || fl.id,
          order_item_name: fl.order_item_name || fl.name || "Fee",
          order_item_type: "fee",
        });
      });
    }
    if (Array.isArray(body.coupon_lines)) {
      body.coupon_lines.forEach((cl) => {
        rawItems.push({
          ...cl,
          order_item_id: cl.order_item_id || cl.id,
          order_item_name: cl.order_item_name || cl.code || "Coupon",
          order_item_type: "coupon",
        });
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. gb_wc_orders — Upsert main order row
    const { rows: orderRows } = await client.query(
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
        orderId, status, currency, type, tax_amount, total_amount,
        customer_id, billing_email, date_created_gmt, date_updated_gmt,
        parent_order_id, payment_method, payment_method_title, transaction_id,
        ip_address, user_agent, customer_note,
      ]
    );

    // 2. gb_wc_orders_meta — Full replace for this order_id (preserves WP meta ID if provided)
    await client.query(`DELETE FROM gb_wc_orders_meta WHERE order_id = $1`, [orderId]);
    const rawMeta = Array.isArray(body.meta) ? body.meta : (Array.isArray(body.meta_data) ? body.meta_data : []);
    if (rawMeta.length > 0) {
      for (const m of rawMeta) {
        const metaId = m.id || m.meta_id || null;
        const metaKey = m.key ?? m.meta_key ?? null;
        let metaVal = m.value !== undefined ? m.value : m.meta_value;
        if (typeof metaVal === "object" && metaVal !== null) {
          metaVal = JSON.stringify(metaVal);
        } else if (metaVal !== null && metaVal !== undefined) {
          metaVal = String(metaVal);
        } else {
          metaVal = null;
        }

        if (metaKey) {
          if (metaId) {
            await client.query(
              `INSERT INTO gb_wc_orders_meta (id, order_id, meta_key, meta_value) VALUES ($1, $2, $3, $4)
               ON CONFLICT (id) DO UPDATE SET meta_key = EXCLUDED.meta_key, meta_value = EXCLUDED.meta_value`,
              [metaId, orderId, metaKey, metaVal]
            );
          } else {
            await client.query(
              `INSERT INTO gb_wc_orders_meta (order_id, meta_key, meta_value) VALUES ($1, $2, $3)`,
              [orderId, metaKey, metaVal]
            );
          }
        }
      }
    }

    // 3. gb_wc_order_addresses — Full replace (billing + shipping) for this order_id
    await client.query(`DELETE FROM gb_wc_order_addresses WHERE order_id = $1`, [orderId]);
    const addressPairs = [
      { type: "billing", data: billingAddress },
      { type: "shipping", data: shippingAddress },
    ];
    for (const { type: addrType, data: addr } of addressPairs) {
      if (!addr || typeof addr !== "object") continue;
      const addrId = addr.id || null;
      const vals = ORDER_ADDRESS_FIELDS.map((f) => (addr[f] !== undefined ? addr[f] : null));
      if (addrId) {
        await client.query(
          `INSERT INTO gb_wc_order_addresses
             (id, order_id, address_type, first_name, last_name, company, address_1, address_2, city, state, postcode, country, email, phone)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (id) DO UPDATE SET
             first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, company = EXCLUDED.company,
             address_1 = EXCLUDED.address_1, address_2 = EXCLUDED.address_2, city = EXCLUDED.city,
             state = EXCLUDED.state, postcode = EXCLUDED.postcode, country = EXCLUDED.country,
             email = EXCLUDED.email, phone = EXCLUDED.phone`,
          [addrId, orderId, addrType, ...vals]
        );
      } else {
        await client.query(
          `INSERT INTO gb_wc_order_addresses
             (order_id, address_type, first_name, last_name, company, address_1, address_2, city, state, postcode, country, email, phone)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [orderId, addrType, ...vals]
        );
      }
    }

    // 4. gb_wc_order_operational_data — Full replace for this order_id
    await client.query(`DELETE FROM gb_wc_order_operational_data WHERE order_id = $1`, [orderId]);
    if (opData.id) {
      await client.query(
        `INSERT INTO gb_wc_order_operational_data (
           id, order_id, created_via, woocommerce_version, prices_include_tax, coupon_usages_are_counted,
           download_permission_granted, cart_hash, new_order_email_sent, order_key, order_stock_reduced,
           date_paid_gmt, date_completed_gmt, shipping_tax_amount, shipping_total_amount,
           discount_tax_amount, discount_total_amount, recorded_sales
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (id) DO UPDATE SET
           created_via = EXCLUDED.created_via, woocommerce_version = EXCLUDED.woocommerce_version,
           prices_include_tax = EXCLUDED.prices_include_tax, coupon_usages_are_counted = EXCLUDED.coupon_usages_are_counted,
           download_permission_granted = EXCLUDED.download_permission_granted, cart_hash = EXCLUDED.cart_hash,
           new_order_email_sent = EXCLUDED.new_order_email_sent, order_key = EXCLUDED.order_key,
           order_stock_reduced = EXCLUDED.order_stock_reduced, date_paid_gmt = EXCLUDED.date_paid_gmt,
           date_completed_gmt = EXCLUDED.date_completed_gmt, shipping_tax_amount = EXCLUDED.shipping_tax_amount,
           shipping_total_amount = EXCLUDED.shipping_total_amount, discount_tax_amount = EXCLUDED.discount_tax_amount,
           discount_total_amount = EXCLUDED.discount_total_amount, recorded_sales = EXCLUDED.recorded_sales`,
        [
          opData.id, orderId, opData.created_via, opData.woocommerce_version, opData.prices_include_tax,
          opData.coupon_usages_are_counted, opData.download_permission_granted, opData.cart_hash,
          opData.new_order_email_sent, opData.order_key, opData.order_stock_reduced,
          opData.date_paid_gmt, opData.date_completed_gmt, opData.shipping_tax_amount,
          opData.shipping_total_amount, opData.discount_tax_amount, opData.discount_total_amount,
          opData.recorded_sales,
        ]
      );
    } else {
      await client.query(
        `INSERT INTO gb_wc_order_operational_data (
           order_id, created_via, woocommerce_version, prices_include_tax, coupon_usages_are_counted,
           download_permission_granted, cart_hash, new_order_email_sent, order_key, order_stock_reduced,
           date_paid_gmt, date_completed_gmt, shipping_tax_amount, shipping_total_amount,
           discount_tax_amount, discount_total_amount, recorded_sales
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          orderId, opData.created_via, opData.woocommerce_version, opData.prices_include_tax,
          opData.coupon_usages_are_counted, opData.download_permission_granted, opData.cart_hash,
          opData.new_order_email_sent, opData.order_key, opData.order_stock_reduced,
          opData.date_paid_gmt, opData.date_completed_gmt, opData.shipping_tax_amount,
          opData.shipping_total_amount, opData.discount_tax_amount, opData.discount_total_amount,
          opData.recorded_sales,
        ]
      );
    }

    // 9 & 10. gb_woocommerce_order_items + gb_woocommerce_order_itemmeta
    // First clear existing itemmeta for any items of this order_id, then clear the order items
    const existingItems = await client.query(
      `SELECT order_item_id FROM gb_woocommerce_order_items WHERE order_id = $1`,
      [orderId]
    );
    if (existingItems.rows.length > 0) {
      const existingItemIds = existingItems.rows.map((r) => r.order_item_id);
      await client.query(
        `DELETE FROM gb_woocommerce_order_itemmeta WHERE order_item_id = ANY($1::bigint[])`,
        [existingItemIds]
      );
    }
    await client.query(`DELETE FROM gb_woocommerce_order_items WHERE order_id = $1`, [orderId]);

    const lineItemsForLookup = [];
    let totalItemsSold = 0;

    for (const item of rawItems) {
      const itemId = item.order_item_id || item.id;
      if (!itemId) continue;

      const itemName = item.order_item_name || item.name || item.method_title || item.code || "";
      const itemType = item.order_item_type || item.type || (item.method_title ? "shipping" : item.code ? "coupon" : "line_item");

      // Insert item row preserving exact WP order_item_id
      await client.query(
        `INSERT INTO gb_woocommerce_order_items (order_item_id, order_item_name, order_item_type, order_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (order_item_id) DO UPDATE SET
           order_item_name = EXCLUDED.order_item_name,
           order_item_type = EXCLUDED.order_item_type,
           order_id = EXCLUDED.order_id`,
        [itemId, itemName, itemType, orderId]
      );

      // Collect item metadata
      const itemMetaList = Array.isArray(item.meta) ? [...item.meta] : (Array.isArray(item.meta_data) ? [...item.meta_data] : []);
      const existingKeys = new Set(itemMetaList.map((m) => m.key || m.meta_key));

      // Auto-inject core fields into meta if passed at top-level of item
      if (itemType === "line_item") {
        const prodId = item.product_id;
        const varId = item.variation_id ?? 0;
        const qty = item.quantity ?? item.product_qty ?? 1;
        const subtotal = item.subtotal ?? item.total ?? 0;
        const total = item.total ?? subtotal;
        const subtotalTax = item.subtotal_tax ?? 0;
        const lineTax = item.total_tax ?? item.tax_amount ?? 0;

        if (prodId !== undefined && !existingKeys.has("_product_id")) itemMetaList.push({ key: "_product_id", value: String(prodId) });
        if (varId !== undefined && !existingKeys.has("_variation_id")) itemMetaList.push({ key: "_variation_id", value: String(varId) });
        if (qty !== undefined && !existingKeys.has("_qty")) itemMetaList.push({ key: "_qty", value: String(qty) });
        if (subtotal !== undefined && !existingKeys.has("_line_subtotal")) itemMetaList.push({ key: "_line_subtotal", value: String(subtotal) });
        if (total !== undefined && !existingKeys.has("_line_total")) itemMetaList.push({ key: "_line_total", value: String(total) });
        if (subtotalTax !== undefined && !existingKeys.has("_line_subtotal_tax")) itemMetaList.push({ key: "_line_subtotal_tax", value: String(subtotalTax) });
        if (lineTax !== undefined && !existingKeys.has("_line_tax")) itemMetaList.push({ key: "_line_tax", value: String(lineTax) });
        if (item.tax_class !== undefined && !existingKeys.has("_tax_class")) itemMetaList.push({ key: "_tax_class", value: item.tax_class || "" });
        if (item.sku && !existingKeys.has("Code")) itemMetaList.push({ key: "Code", value: item.sku });
        if (item.category && !existingKeys.has("Category")) itemMetaList.push({ key: "Category", value: item.category });

        totalItemsSold += Number(qty) || 1;
        lineItemsForLookup.push({
          order_item_id: itemId,
          product_id: prodId,
          variation_id: varId,
          quantity: qty,
          subtotal,
          total,
          tax: lineTax,
        });
      } else if (itemType === "shipping") {
        const costVal = item.cost !== undefined ? item.cost : (item.total !== undefined ? item.total : (item.amount !== undefined ? item.amount : (item.shipping_amount !== undefined ? item.shipping_amount : null)));
        if (item.method_id && !existingKeys.has("method_id")) itemMetaList.push({ key: "method_id", value: String(item.method_id) });
        if (item.instance_id && !existingKeys.has("instance_id")) itemMetaList.push({ key: "instance_id", value: String(item.instance_id) });
        if (costVal !== null && costVal !== undefined && !existingKeys.has("cost")) {
          itemMetaList.push({ key: "cost", value: String(costVal) });
        } else if (!existingKeys.has("cost") && (Number(opData.shipping_total_amount) > 0 || Number(body.shipping_total) > 0)) {
          itemMetaList.push({ key: "cost", value: String(opData.shipping_total_amount || body.shipping_total) });
        }
        if (item.total_tax !== undefined && !existingKeys.has("total_tax")) itemMetaList.push({ key: "total_tax", value: String(item.total_tax) });
      } else if (itemType === "fee") {
        if (item.amount !== undefined && !existingKeys.has("_fee_amount")) itemMetaList.push({ key: "_fee_amount", value: String(item.amount) });
        if (item.total !== undefined && !existingKeys.has("_line_total")) itemMetaList.push({ key: "_line_total", value: String(item.total) });
        if (item.total_tax !== undefined && !existingKeys.has("_line_tax")) itemMetaList.push({ key: "_line_tax", value: String(item.total_tax) });
      } else if (itemType === "coupon") {
        if (item.discount !== undefined && !existingKeys.has("discount_amount")) itemMetaList.push({ key: "discount_amount", value: String(item.discount) });
        if (item.discount_tax !== undefined && !existingKeys.has("discount_amount_tax")) itemMetaList.push({ key: "discount_amount_tax", value: String(item.discount_tax) });
      }

      // Insert item metadata rows
      for (const m of itemMetaList) {
        const metaId = m.id || m.meta_id || null;
        const metaKey = m.key ?? m.meta_key ?? null;
        let metaVal = m.value !== undefined ? m.value : m.meta_value;
        if (typeof metaVal === "object" && metaVal !== null) {
          metaVal = JSON.stringify(metaVal);
        } else if (metaVal !== null && metaVal !== undefined) {
          metaVal = String(metaVal);
        } else {
          metaVal = null;
        }

        if (metaKey) {
          if (metaId) {
            await client.query(
              `INSERT INTO gb_woocommerce_order_itemmeta (meta_id, order_item_id, meta_key, meta_value)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (meta_id) DO UPDATE SET meta_key = EXCLUDED.meta_key, meta_value = EXCLUDED.meta_value`,
              [metaId, itemId, metaKey, metaVal]
            );
          } else {
            await client.query(
              `INSERT INTO gb_woocommerce_order_itemmeta (order_item_id, meta_key, meta_value) VALUES ($1, $2, $3)`,
              [itemId, metaKey, metaVal]
            );
          }
        }
      }
    }

    // 5. gb_wc_order_coupon_lookup — Full replace for this order_id
    await client.query(`DELETE FROM gb_wc_order_coupon_lookup WHERE order_id = $1`, [orderId]);
    const couponLookupData = Array.isArray(body.coupon_lookup)
      ? body.coupon_lookup
      : (Array.isArray(body.coupon_lines)
        ? body.coupon_lines.map((cl) => ({
          coupon_id: cl.coupon_id || cl.id,
          date_created: cl.date_created || date_created_gmt,
          discount_amount: cl.discount || cl.discount_amount || 0,
        }))
        : []);

    for (const row of couponLookupData) {
      if (!row.coupon_id) continue;
      await client.query(
        `INSERT INTO gb_wc_order_coupon_lookup (order_id, coupon_id, date_created, discount_amount)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (order_id, coupon_id) DO UPDATE SET
           date_created = EXCLUDED.date_created,
           discount_amount = EXCLUDED.discount_amount`,
        [orderId, row.coupon_id, row.date_created || date_created_gmt, row.discount_amount ?? 0]
      );
    }

    // 6. gb_wc_order_product_lookup — Full replace for this order_id
    await client.query(`DELETE FROM gb_wc_order_product_lookup WHERE order_id = $1`, [orderId]);
    if (Array.isArray(body.product_lookup) && body.product_lookup.length > 0) {
      for (const row of body.product_lookup) {
        if (!row.order_item_id) continue;
        await client.query(
          `INSERT INTO gb_wc_order_product_lookup (
             order_item_id, order_id, product_id, variation_id, customer_id, date_created, product_qty,
             product_net_revenue, product_gross_revenue, coupon_amount, tax_amount, shipping_amount, shipping_tax_amount
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (order_item_id) DO UPDATE SET
             product_id = EXCLUDED.product_id, variation_id = EXCLUDED.variation_id, customer_id = EXCLUDED.customer_id,
             date_created = EXCLUDED.date_created, product_qty = EXCLUDED.product_qty,
             product_net_revenue = EXCLUDED.product_net_revenue, product_gross_revenue = EXCLUDED.product_gross_revenue,
             coupon_amount = EXCLUDED.coupon_amount, tax_amount = EXCLUDED.tax_amount,
             shipping_amount = EXCLUDED.shipping_amount, shipping_tax_amount = EXCLUDED.shipping_tax_amount`,
          [
            row.order_item_id, orderId, row.product_id ?? null, row.variation_id ?? 0, row.customer_id ?? customer_id,
            row.date_created || date_created_gmt, row.product_qty ?? 0, row.product_net_revenue ?? 0,
            row.product_gross_revenue ?? 0, row.coupon_amount ?? 0, row.tax_amount ?? 0,
            row.shipping_amount ?? 0, row.shipping_tax_amount ?? 0,
          ]
        );
      }
    } else if (lineItemsForLookup.length > 0) {
      // Auto-generate product lookup rows from line items if not explicitly provided
      for (const li of lineItemsForLookup) {
        if (!li.product_id) continue;
        const netRev = Number(li.total || li.subtotal || 0);
        const taxVal = Number(li.tax || 0);
        const grossRev = netRev + taxVal;
        await client.query(
          `INSERT INTO gb_wc_order_product_lookup (
             order_item_id, order_id, product_id, variation_id, customer_id, date_created, product_qty,
             product_net_revenue, product_gross_revenue, coupon_amount, tax_amount, shipping_amount, shipping_tax_amount
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (order_item_id) DO UPDATE SET
             product_id = EXCLUDED.product_id, variation_id = EXCLUDED.variation_id, customer_id = EXCLUDED.customer_id,
             date_created = EXCLUDED.date_created, product_qty = EXCLUDED.product_qty,
             product_net_revenue = EXCLUDED.product_net_revenue, product_gross_revenue = EXCLUDED.product_gross_revenue,
             coupon_amount = EXCLUDED.coupon_amount, tax_amount = EXCLUDED.tax_amount,
             shipping_amount = EXCLUDED.shipping_amount, shipping_tax_amount = EXCLUDED.shipping_tax_amount`,
          [
            li.order_item_id, orderId, li.product_id, li.variation_id || 0, customer_id,
            date_created_gmt, Number(li.quantity) || 1, netRev, grossRev, 0, taxVal, 0, 0,
          ]
        );
      }
    }

    // 7. gb_wc_order_tax_lookup — Full replace for this order_id
    await client.query(`DELETE FROM gb_wc_order_tax_lookup WHERE order_id = $1`, [orderId]);
    const taxLookupData = Array.isArray(body.tax_lookup)
      ? body.tax_lookup
      : (Array.isArray(body.tax_lines)
        ? body.tax_lines.map((tl) => ({
          tax_rate_id: tl.rate_id || tl.tax_rate_id || tl.id,
          date_created: tl.date_created || date_created_gmt,
          shipping_tax: tl.shipping_tax_total || tl.shipping_tax || 0,
          order_tax: tl.tax_total || tl.order_tax || 0,
          total_tax: (Number(tl.tax_total || 0) + Number(tl.shipping_tax_total || 0)) || tl.total_tax || 0,
        }))
        : []);

    for (const row of taxLookupData) {
      if (!row.tax_rate_id) continue;
      await client.query(
        `INSERT INTO gb_wc_order_tax_lookup (order_id, tax_rate_id, date_created, shipping_tax, order_tax, total_tax)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (order_id, tax_rate_id) DO UPDATE SET
           date_created = EXCLUDED.date_created, shipping_tax = EXCLUDED.shipping_tax,
           order_tax = EXCLUDED.order_tax, total_tax = EXCLUDED.total_tax`,
        [orderId, row.tax_rate_id, row.date_created || date_created_gmt, row.shipping_tax ?? 0, row.order_tax ?? 0, row.total_tax ?? 0]
      );
    }

    // 8. gb_wc_order_stats — Upsert one row per order_id
    const statsData = (body.stats && typeof body.stats === "object") ? body.stats : {
      parent_id: parent_order_id,
      date_created: date_created_gmt,
      date_created_gmt: date_created_gmt,
      date_paid: opData.date_paid_gmt,
      date_completed: opData.date_completed_gmt,
      num_items_sold: totalItemsSold > 0 ? totalItemsSold : 1,
      total_sales: Number(total_amount) || 0,
      tax_total: Number(tax_amount) || 0,
      shipping_total: Number(opData.shipping_total_amount) || 0,
      net_total: Math.max(0, (Number(total_amount) || 0) - (Number(tax_amount) || 0) - (Number(opData.shipping_total_amount) || 0)),
      returning_customer: false,
    };

    await client.query(
      `INSERT INTO gb_wc_order_stats (
         order_id, parent_id, date_created, date_created_gmt, date_paid, date_completed,
         num_items_sold, total_sales, tax_total, shipping_total, net_total, returning_customer,
         status, customer_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (order_id) DO UPDATE SET
         parent_id = EXCLUDED.parent_id,
         date_created = EXCLUDED.date_created,
         date_created_gmt = EXCLUDED.date_created_gmt,
         date_paid = EXCLUDED.date_paid,
         date_completed = EXCLUDED.date_completed,
         num_items_sold = EXCLUDED.num_items_sold,
         total_sales = EXCLUDED.total_sales,
         tax_total = EXCLUDED.tax_total,
         shipping_total = EXCLUDED.shipping_total,
         net_total = EXCLUDED.net_total,
         returning_customer = EXCLUDED.returning_customer,
         status = EXCLUDED.status,
         customer_id = EXCLUDED.customer_id`,
      [
        orderId, statsData.parent_id ?? 0, statsData.date_created || date_created_gmt, statsData.date_created_gmt || date_created_gmt,
        statsData.date_paid || null, statsData.date_completed || null, statsData.num_items_sold ?? 0,
        statsData.total_sales ?? 0, statsData.tax_total ?? 0, statsData.shipping_total ?? 0, statsData.net_total ?? 0,
        statsData.returning_customer ?? false, status, customer_id,
      ]
    );

    // 11 & 12. gb_comments & gb_commentmeta (Order notes if sent)
    if (Array.isArray(body.notes) && body.notes.length > 0) {
      for (const note of body.notes) {
        const commentId = note.comment_id || note.id;
        const noteContent = note.content || note.note || "";
        if (!commentId || !noteContent) continue;

        await client.query(
          `INSERT INTO gb_comments
             (comment_id, comment_post_id, comment_author, comment_author_email, comment_author_url,
              comment_author_ip, comment_date, comment_date_gmt, comment_content, comment_approved,
              comment_agent, comment_type, comment_parent, user_id)
           VALUES ($1, $2, $3, '', '', '', $4, $4, $5, '1', '', 'order_note', 0, $6)
           ON CONFLICT (comment_id) DO UPDATE SET
             comment_post_id = EXCLUDED.comment_post_id,
             comment_author = EXCLUDED.comment_author,
             comment_date = EXCLUDED.comment_date,
             comment_date_gmt = EXCLUDED.comment_date_gmt,
             comment_content = EXCLUDED.comment_content,
             user_id = EXCLUDED.user_id`,
          [commentId, orderId, note.author || "WooCommerce", note.date_gmt || date_created_gmt, noteContent, note.user_id ?? 0]
        );

        await client.query(`DELETE FROM gb_commentmeta WHERE comment_id = $1 AND meta_key = 'is_customer_note'`, [commentId]);
        if (note.is_customer_note) {
          await client.query(
            `INSERT INTO gb_commentmeta (comment_id, meta_key, meta_value) VALUES ($1, 'is_customer_note', '1')`,
            [commentId]
          );
        }
      }
    }

    // Keep sequences in sync with max IDs in case of any auto-increment inserts
    await client.query(`
      SELECT setval('gb_wc_orders_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM gb_wc_orders), 1), true);
      SELECT setval('gb_wc_orders_meta_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM gb_wc_orders_meta), 1), true);
      SELECT setval('gb_wc_order_addresses_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM gb_wc_order_addresses), 1), true);
      SELECT setval('gb_wc_order_operational_data_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM gb_wc_order_operational_data), 1), true);
      SELECT setval('gb_woocommerce_order_items_order_item_id_seq', GREATEST((SELECT COALESCE(MAX(order_item_id), 1) FROM gb_woocommerce_order_items), 1), true);
      SELECT setval('gb_woocommerce_order_itemmeta_meta_id_seq', GREATEST((SELECT COALESCE(MAX(meta_id), 1) FROM gb_woocommerce_order_itemmeta), 1), true);
      SELECT setval('gb_comments_comment_id_seq', GREATEST((SELECT COALESCE(MAX(comment_id), 1) FROM gb_comments), 1), true);
      SELECT setval('gb_commentmeta_meta_id_seq', GREATEST((SELECT COALESCE(MAX(meta_id), 1) FROM gb_commentmeta), 1), true);
    `);

    await client.query("COMMIT");

    console.log(`[order-webhook] order #${orderId} synced across all tables (order + meta + addresses + operational_data + ${rawItems.length} items + stats)`);
    res.json({ success: true, order: orderRows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`Error saving order ${orderId} from webhook:`, error);
    res.status(500).json({ success: false, message: "Failed to save order", error: error.message });
  } finally {
    client.release();
  }
};

// PUT /api/orders/:id  OR  POST /api/orders/update  OR  POST /api/orders/:id/update
// Order update endpoint:
// Only updates the fields that can change during an order update:
// 1. Status (gb_wc_orders.status & gb_wc_order_stats.status)
// 2. Billing Address (gb_wc_order_addresses)
// 3. Shipping Address (gb_wc_order_addresses)
// 4. Customer Note (gb_wc_orders.customer_note)
// 5. Metadata (gb_wc_orders_meta: _last_updated_user, shiprocket_status, tekipost_status, dtdc_status, etc.)
// 6. date_updated_gmt
exports.updateOrder = async (req, res) => {
  const body = req.body || {};
  const orderId = parseInt(req.params.id || body.id || body.order_id || body.ID, 10);

  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ success: false, message: "A valid numeric order id is required" });
  }

  // Detect whether this is a webhook/server-to-server call from WordPress
  const webhookSecret = process.env.ORDER_WEBHOOK_SECRET || "gullybaba_order_webhook_2026";
  const providedSecret =
    req.headers["x-webhook-secret"] ||
    req.headers["x-wc-webhook-secret"] ||
    req.query.secret ||
    req.query.webhook_secret ||
    body.webhook_secret ||
    body.secret;

  const isWebhookFromWordPress =
    (providedSecret && providedSecret === webhookSecret) ||
    req.isWebhook === true ||
    req.headers["x-wc-webhook-topic"] ||
    body.from_wordpress === true;

  const shouldSyncToWordPress = !isWebhookFromWordPress && body.sync_to_wordpress !== false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Check existing order
    const { rows: existingRows } = await client.query(
      `SELECT id, status, billing_email FROM gb_wc_orders WHERE id = $1`,
      [orderId]
    );
    if (existingRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: `Order #${orderId} not found` });
    }
    const existing = existingRows[0];

    // 2. Status normalization
    let newStatus = null;
    if (body.status !== undefined && body.status !== null) {
      let rawStatus = String(body.status).trim();
      if (!rawStatus.startsWith("wc-") && !["trash", "auto-draft"].includes(rawStatus)) {
        newStatus = `wc-${rawStatus}`;
      } else {
        newStatus = rawStatus;
      }
    }

    // 3. Billing & Shipping Addresses (if provided)
    const billingAddress = body.billing || body.addresses?.billing || null;
    const shippingAddress = body.shipping || body.addresses?.shipping || null;

    if (billingAddress && typeof billingAddress === "object") {
      const vals = ORDER_ADDRESS_FIELDS.map((f) => (billingAddress[f] !== undefined ? billingAddress[f] : null));
      const upd = await client.query(
        `UPDATE gb_wc_order_addresses SET
           first_name = $1, last_name = $2, company = $3, address_1 = $4, address_2 = $5,
           city = $6, state = $7, postcode = $8, country = $9, email = $10, phone = $11
         WHERE order_id = $12 AND address_type = 'billing'`,
        [...vals, orderId]
      );
      if (upd.rowCount === 0) {
        await client.query(
          `INSERT INTO gb_wc_order_addresses
             (order_id, address_type, first_name, last_name, company, address_1, address_2, city, state, postcode, country, email, phone)
           VALUES ($1, 'billing', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [orderId, ...vals]
        );
      }
    }

    if (shippingAddress && typeof shippingAddress === "object") {
      const vals = ORDER_ADDRESS_FIELDS.map((f) => (shippingAddress[f] !== undefined ? shippingAddress[f] : null));
      const upd = await client.query(
        `UPDATE gb_wc_order_addresses SET
           first_name = $1, last_name = $2, company = $3, address_1 = $4, address_2 = $5,
           city = $6, state = $7, postcode = $8, country = $9, email = $10, phone = $11
         WHERE order_id = $12 AND address_type = 'shipping'`,
        [...vals, orderId]
      );
      if (upd.rowCount === 0) {
        await client.query(
          `INSERT INTO gb_wc_order_addresses
             (order_id, address_type, first_name, last_name, company, address_1, address_2, city, state, postcode, country, email, phone)
           VALUES ($1, 'shipping', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [orderId, ...vals]
        );
      }
    }

    // 4. Update core order table: gb_wc_orders
    const updateFields = ["date_updated_gmt = NOW()"];
    const updateParams = [orderId];
    let paramIdx = 2;

    if (newStatus) {
      updateFields.push(`status = $${paramIdx++}`);
      updateParams.push(newStatus);
    }
    const billingEmail = billingAddress?.email || body.billing_email;
    if (billingEmail) {
      updateFields.push(`billing_email = $${paramIdx++}`);
      updateParams.push(billingEmail);
    }
    if (body.customer_note !== undefined) {
      updateFields.push(`customer_note = $${paramIdx++}`);
      updateParams.push(body.customer_note);
    }

    const { rows: updatedOrderRows } = await client.query(
      `UPDATE gb_wc_orders SET ${updateFields.join(", ")} WHERE id = $1 RETURNING *`,
      updateParams
    );

    // Also update order status in gb_wc_order_stats if changed
    if (newStatus) {
      await client.query(
        `UPDATE gb_wc_order_stats SET status = $1 WHERE order_id = $2`,
        [newStatus, orderId]
      );
    }

    // 5. Metadata: gb_wc_orders_meta
    let rawMeta = [];
    if (Array.isArray(body.meta_data)) rawMeta = [...body.meta_data];
    else if (Array.isArray(body.meta)) rawMeta = [...body.meta];
    else if (body.meta_data && typeof body.meta_data === "object") {
      rawMeta = Object.entries(body.meta_data).map(([key, value]) => ({ key, value }));
    }

    // Shortcut fields
    const shortcutMeta = [
      "_last_updated_user", "last_updated_user", "updated_by", "updated_by_id", "user_id",
      "shiprocket_status", "tekipost_status", "dtdc_status", "_dtdc_reference_number", "payment_type"
    ];
    for (const sk of shortcutMeta) {
      if (body[sk] !== undefined && body[sk] !== null && !rawMeta.some((m) => (m.key || m.meta_key) === sk)) {
        rawMeta.push({ key: sk, value: body[sk] });
      }
    }

    let incomingLastUser =
      body._last_updated_user ||
      body.last_updated_user ||
      body.updated_by ||
      body.updated_by_id ||
      body.user_id ||
      (req.user?.id ? String(req.user.id) : null);

    // If still missing and this is a sync from WordPress, check WooCommerce directly
    if (!incomingLastUser) {
      try {
        const wcOrderUrl = getApiUrl("orders", {}, orderId);
        const authHeader = getBasicAuthHeader();
        const wcData = await new Promise((resolve) => {
          https.get(wcOrderUrl, { headers: { Authorization: authHeader } }, (wcRes) => {
            let chunkData = "";
            wcRes.on("data", (c) => (chunkData += c));
            wcRes.on("end", () => {
              try { resolve(JSON.parse(chunkData)); } catch { resolve(null); }
            });
          }).on("error", () => resolve(null));
        });
        if (wcData && Array.isArray(wcData.meta_data)) {
          const m = wcData.meta_data.find((item) => item.key === "_last_updated_user");
          if (m && m.value) incomingLastUser = m.value;
        }
      } catch (err) {
        console.warn(`[updateOrder] Could not fetch _last_updated_user for #${orderId}:`, err.message);
      }
    }

    if (incomingLastUser) {
      const existingLastUser = rawMeta.find((m) => (m.key || m.meta_key) === "_last_updated_user");
      if (existingLastUser) {
        existingLastUser.value = String(incomingLastUser);
      } else {
        rawMeta.push({ key: "_last_updated_user", value: String(incomingLastUser) });
      }
    }

    const incomingUserName = body.updated_by_name || body.display_name || null;
    if (incomingLastUser && incomingUserName) {
      const pId = parseInt(incomingLastUser, 10);
      if (Number.isFinite(pId) && pId > 0) {
        userNameCache.set(pId, incomingUserName);
      }
    }

    const userId = req.user?.id || null;
    const userName = req.user?.display_name || req.user?.name || `${req.user?.first_name || ""} ${req.user?.last_name || ""}`.trim() || req.user?.username || null;
    if (userId && userName) {
      userNameCache.set(parseInt(userId, 10), userName);
    }

    for (const m of rawMeta) {
      const metaKey = m.key ?? m.meta_key ?? null;
      if (!metaKey) continue;
      let metaVal = m.value !== undefined ? m.value : m.meta_value;
      if (typeof metaVal === "object" && metaVal !== null) {
        metaVal = JSON.stringify(metaVal);
      } else if (metaVal !== null && metaVal !== undefined) {
        metaVal = String(metaVal);
      } else {
        metaVal = null;
      }

      const updateMetaRes = await client.query(
        `UPDATE gb_wc_orders_meta SET meta_value = $1 WHERE order_id = $2 AND meta_key = $3`,
        [metaVal, orderId, metaKey]
      );
      if (updateMetaRes.rowCount === 0) {
        await client.query(
          `INSERT INTO gb_wc_orders_meta (order_id, meta_key, meta_value) VALUES ($1, $2, $3)`,
          [orderId, metaKey, metaVal]
        );
      }

      if (metaKey === "_last_updated_user" && metaVal) {
        const uId = parseInt(metaVal, 10);
        if (Number.isFinite(uId) && uId > 0 && !userNameCache.has(uId)) {
          fetchCustomerById(uId).then((cu) => {
            const name = cu.display_name || `${cu.first_name || ""} ${cu.last_name || ""}`.trim() || cu.username || `#${uId}`;
            userNameCache.set(uId, name);
          }).catch(() => {});
        }
      }
    }

    // 6. Push to WooCommerce if initiated by admin / client from CRM
    if (shouldSyncToWordPress) {
      const wcPayload = {};
      if (newStatus) wcPayload.status = stripStatusPrefix(newStatus);
      if (billingAddress) wcPayload.billing = billingAddress;
      if (shippingAddress) wcPayload.shipping = shippingAddress;
      if (body.customer_note !== undefined) wcPayload.customer_note = body.customer_note;

      const metaToSend = [];
      if (userId) {
        metaToSend.push({ key: "_last_updated_user", value: String(userId) });
      }
      for (const m of rawMeta) {
        const k = m.key || m.meta_key;
        const v = m.value !== undefined ? m.value : m.meta_value;
        if (k && k !== "_last_updated_user") {
          metaToSend.push({ key: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) });
        }
      }
      if (metaToSend.length > 0) {
        wcPayload.meta_data = metaToSend;
      }

      if (Object.keys(wcPayload).length > 0) {
        try {
          await updateOrderInWooCommerce(orderId, wcPayload);
        } catch (wcError) {
          await client.query("ROLLBACK");
          console.error(`Failed to push order update to WooCommerce for #${orderId}:`, wcError.message);
          return res.status(502).json({
            success: false,
            message: `Failed to update order #${orderId} on WordPress/WooCommerce: ${wcError.message}. Local changes were rolled back.`,
          });
        }
      }
    }

    await client.query("COMMIT");

    console.log(`[order-update] order #${orderId} updated successfully (syncedToWP: ${shouldSyncToWordPress})`);
    return res.json({
      success: true,
      message: `Order #${orderId} updated successfully${shouldSyncToWordPress ? " and synced to WordPress" : ""}`,
      order: updatedOrderRows[0] || existing,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`Error updating order #${orderId}:`, error);
    return res.status(500).json({ success: false, message: "Failed to update order", error: error.message });
  } finally {
    client.release();
  }
};

exports.syncOrderUpdate = exports.updateOrder;
exports.updateFullOrder = exports.updateOrder;

// POST /api/orders/:id/analytics/sync — webhook for WordPress to re-send just the 4 analytics
// lookup tables (coupon_lookup, product_lookup, tax_lookup, stats) once WooCommerce has finished
// computing them in the background (it writes these asynchronously via Action Scheduler, so they're
// often not ready yet at order-creation time). Deliberately does NOT touch gb_wc_orders or any of
// the other order tables — only whichever of these 4 optional fields are present in the body.
exports.syncOrderAnalytics = async (req, res) => {
  const { id } = req.params;
  const { coupon_lookup, product_lookup, tax_lookup, stats } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (Array.isArray(coupon_lookup)) {
      await client.query(`DELETE FROM gb_wc_order_coupon_lookup WHERE order_id = $1`, [id]);
      for (const row of coupon_lookup) {
        if (!row.coupon_id) continue;
        await client.query(
          `INSERT INTO gb_wc_order_coupon_lookup (order_id, coupon_id, date_created, discount_amount)
           VALUES ($1, $2, $3, $4)`,
          [id, row.coupon_id, row.date_created || null, row.discount_amount ?? 0]
        );
      }
    }

    if (Array.isArray(product_lookup)) {
      await client.query(`DELETE FROM gb_wc_order_product_lookup WHERE order_id = $1`, [id]);
      for (const row of product_lookup) {
        if (!row.order_item_id) continue;
        await client.query(
          `INSERT INTO gb_wc_order_product_lookup (
             order_item_id, order_id, product_id, variation_id, customer_id, date_created, product_qty,
             product_net_revenue, product_gross_revenue, coupon_amount, tax_amount, shipping_amount, shipping_tax_amount
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            row.order_item_id, id, row.product_id ?? null, row.variation_id ?? 0, row.customer_id ?? null,
            row.date_created || null, row.product_qty ?? 0, row.product_net_revenue ?? 0,
            row.product_gross_revenue ?? 0, row.coupon_amount ?? 0, row.tax_amount ?? 0,
            row.shipping_amount ?? 0, row.shipping_tax_amount ?? 0,
          ]
        );
      }
    }

    if (Array.isArray(tax_lookup)) {
      await client.query(`DELETE FROM gb_wc_order_tax_lookup WHERE order_id = $1`, [id]);
      for (const row of tax_lookup) {
        if (!row.tax_rate_id) continue;
        await client.query(
          `INSERT INTO gb_wc_order_tax_lookup (order_id, tax_rate_id, date_created, shipping_tax, order_tax, total_tax)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, row.tax_rate_id, row.date_created || null, row.shipping_tax ?? 0, row.order_tax ?? 0, row.total_tax ?? 0]
        );
      }
    }

    if (stats && typeof stats === "object") {
      await client.query(
        `INSERT INTO gb_wc_order_stats (
           order_id, parent_id, date_created, date_created_gmt, date_paid, date_completed,
           num_items_sold, total_sales, tax_total, shipping_total, net_total, returning_customer,
           status, customer_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (order_id) DO UPDATE SET
           parent_id = EXCLUDED.parent_id,
           date_created = EXCLUDED.date_created,
           date_created_gmt = EXCLUDED.date_created_gmt,
           date_paid = EXCLUDED.date_paid,
           date_completed = EXCLUDED.date_completed,
           num_items_sold = EXCLUDED.num_items_sold,
           total_sales = EXCLUDED.total_sales,
           tax_total = EXCLUDED.tax_total,
           shipping_total = EXCLUDED.shipping_total,
           net_total = EXCLUDED.net_total,
           returning_customer = EXCLUDED.returning_customer,
           status = EXCLUDED.status,
           customer_id = EXCLUDED.customer_id`,
        [
          id, stats.parent_id ?? 0, stats.date_created || null, stats.date_created_gmt || null,
          stats.date_paid || null, stats.date_completed || null, stats.num_items_sold ?? 0,
          stats.total_sales ?? 0, stats.tax_total ?? 0, stats.shipping_total ?? 0, stats.net_total ?? 0,
          stats.returning_customer ?? null, stats.status || null, stats.customer_id ?? null,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`Error syncing analytics tables for order ${id}:`, error);
    res.status(500).json({ success: false, message: "Failed to sync order analytics" });
  } finally {
    client.release();
  }
};

// POST /api/orders/status/sync or POST /api/orders/:id/status/sync
// Webhook called FROM WordPress whenever an order status changes on WordPress/WooCommerce.
// Protected by checkWebhookSecret middleware (server-to-server).
// Updates gb_wc_orders, gb_wc_order_stats, and gb_wc_order_operational_data in local Postgres.
// Does NOT call back to WooCommerce, preventing redundant requests or loops.
exports.syncOrderStatus = async (req, res) => {
  const body = req.body || {};
  const orderId = req.params.id || body.order_id || body.orderId || body.id;
  const rawStatus = body.status || body.new_status || body.order_status;

  if (!orderId) {
    return res.status(400).json({ success: false, message: "order_id (or order id in url/body) is required" });
  }

  if (!rawStatus) {
    return res.status(400).json({ success: false, message: "status (or new_status) is required" });
  }

  // Normalize order status (WooCommerce DB format uses "wc-" prefix, except core WordPress post statuses)
  let status = String(rawStatus).trim();
  if (!status.startsWith("wc-") && !["trash", "auto-draft"].includes(status)) {
    status = `wc-${status}`;
  }

  const cleanStatus = stripStatusPrefix(status);
  let dateModified = body.date_modified_gmt || body.date_updated_gmt || body.date_modified || body.date_updated;
  if (!dateModified) {
    dateModified = new Date().toISOString().slice(0, 19).replace("T", " ");
  } else if (dateModified instanceof Date) {
    dateModified = dateModified.toISOString().slice(0, 19).replace("T", " ");
  } else {
    dateModified = String(dateModified).replace("T", " ").replace(/\..*$/, "").replace(/Z$/, "");
  }

  const isCompleted = status === "wc-completed";
  const isPaid = ["wc-processing", "wc-completed"].includes(status);
  const datePaid = body.date_paid_gmt || body.date_paid || (isPaid ? dateModified : null);
  const dateCompleted = body.date_completed_gmt || body.date_completed || (isCompleted ? dateModified : null);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Update gb_wc_orders
    let { rows: orderRows } = await client.query(
      `UPDATE gb_wc_orders
       SET status = $1, date_updated_gmt = COALESCE($2::timestamp, NOW())
       WHERE id = $3 AND type = 'shop_order'
       RETURNING id, status, total_amount, customer_id, billing_email, date_created_gmt, date_updated_gmt`,
      [status, dateModified, orderId]
    );

    if (orderRows.length === 0) {
      // Check if order exists with different type
      const { rows: anyOrder } = await client.query(`SELECT id, type, status FROM gb_wc_orders WHERE id = $1`, [orderId]);
      if (anyOrder.length > 0) {
        const { rows: updatedAny } = await client.query(
          `UPDATE gb_wc_orders SET status = $1, date_updated_gmt = COALESCE($2::timestamp, NOW()) WHERE id = $3 RETURNING id, status, total_amount, customer_id, billing_email, date_created_gmt, date_updated_gmt`,
          [status, dateModified, orderId]
        );
        orderRows = updatedAny;
      } else {
        await client.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          message: `Order #${orderId} not found in database. Please ensure order is created first via /api/orders/create.`,
        });
      }
    }

    // 2. Update gb_wc_order_stats if row exists
    await client.query(
      `UPDATE gb_wc_order_stats
       SET status = $1,
           date_completed = CASE
             WHEN $2::boolean THEN COALESCE($3::timestamp, date_completed, NOW())
             ELSE date_completed
           END,
           date_paid = CASE
             WHEN $4::boolean THEN COALESCE($5::timestamp, date_paid, NOW())
             ELSE date_paid
           END
       WHERE order_id = $6`,
      [status, isCompleted, dateCompleted, isPaid, datePaid, orderId]
    );

    // 3. Update gb_wc_order_operational_data if row exists
    await client.query(
      `UPDATE gb_wc_order_operational_data
       SET date_completed_gmt = CASE
             WHEN $1::boolean THEN COALESCE($2::timestamp, date_completed_gmt, NOW())
             ELSE date_completed_gmt
           END,
           date_paid_gmt = CASE
             WHEN $3::boolean THEN COALESCE($4::timestamp, date_paid_gmt, NOW())
             ELSE date_paid_gmt
           END
       WHERE order_id = $5`,
      [isCompleted, dateCompleted, isPaid, datePaid, orderId]
    );

    // 4. Optional: If note is provided, insert into gb_comments
    const noteContent = body.note || body.note_content || body.comment || body.message;
    if (noteContent && String(noteContent).trim()) {
      const author = body.author || body.author_name || body.comment_author || "WordPress";
      const isCustomerNote = Boolean(body.is_customer_note || body.customer_note);

      if (body.comment_id || body.note_id) {
        const commentId = body.comment_id || body.note_id;
        await client.query(
          `INSERT INTO gb_comments
             (comment_id, comment_post_id, comment_author, comment_author_email, comment_author_url,
              comment_author_ip, comment_date, comment_date_gmt, comment_content, comment_approved,
              comment_agent, comment_type, comment_parent, user_id)
           VALUES ($1, $2, $3, '', '', '', $4::timestamp, $4::timestamp, $5, '1', 'WooCommerce', 'order_note', 0, 0)
           ON CONFLICT (comment_id) DO UPDATE SET
             comment_content = EXCLUDED.comment_content,
             comment_author = EXCLUDED.comment_author,
             comment_date = EXCLUDED.comment_date,
             comment_date_gmt = EXCLUDED.comment_date_gmt`,
          [commentId, orderId, author, dateModified, String(noteContent).trim()]
        );
        if (isCustomerNote) {
          await client.query(`DELETE FROM gb_commentmeta WHERE comment_id = $1 AND meta_key = 'is_customer_note'`, [commentId]);
          await client.query(`INSERT INTO gb_commentmeta (comment_id, meta_key, meta_value) VALUES ($1, 'is_customer_note', '1')`, [commentId]);
        }
      } else {
        const { rows: insertedComment } = await client.query(
          `INSERT INTO gb_comments
             (comment_post_id, comment_author, comment_author_email, comment_author_url,
              comment_author_ip, comment_date, comment_date_gmt, comment_content, comment_approved,
              comment_agent, comment_type, comment_parent, user_id)
           VALUES ($1, $2, '', '', '', $3::timestamp, $3::timestamp, $4, '1', 'WooCommerce', 'order_note', 0, 0)
           RETURNING comment_id`,
          [orderId, author, dateModified, String(noteContent).trim()]
        );
        if (isCustomerNote && insertedComment.length > 0) {
          await client.query(
            `INSERT INTO gb_commentmeta (comment_id, meta_key, meta_value) VALUES ($1, 'is_customer_note', '1')`,
            [insertedComment[0].comment_id]
          );
        }
      }
    }

    // 5. Update _last_updated_user in gb_wc_orders_meta
    let updatedUserId =
      body._last_updated_user ||
      body.last_updated_user ||
      body.updated_by ||
      body.updated_by_id ||
      body.user_id ||
      (req.user?.id ? String(req.user.id) : null);

    if (!updatedUserId) {
      // If WordPress webhook didn't send user, fetch _last_updated_user from WooCommerce API
      try {
        const wcOrderUrl = getApiUrl("orders", {}, orderId);
        const authHeader = getBasicAuthHeader();
        const wcData = await new Promise((resolve) => {
          https.get(wcOrderUrl, { headers: { Authorization: authHeader } }, (wcRes) => {
            let chunkData = "";
            wcRes.on("data", (c) => (chunkData += c));
            wcRes.on("end", () => {
              try { resolve(JSON.parse(chunkData)); } catch { resolve(null); }
            });
          }).on("error", () => resolve(null));
        });
        if (wcData && Array.isArray(wcData.meta_data)) {
          const m = wcData.meta_data.find((item) => item.key === "_last_updated_user");
          if (m && m.value) updatedUserId = m.value;
        }
      } catch (err) {
        console.warn(`[syncOrderStatus] Could not fetch _last_updated_user for #${orderId}:`, err.message);
      }
    }

    if (updatedUserId) {
      const uIdStr = String(updatedUserId);
      const updateMetaRes = await client.query(
        `UPDATE gb_wc_orders_meta SET meta_value = $1 WHERE order_id = $2 AND meta_key = '_last_updated_user'`,
        [uIdStr, orderId]
      );
      if (updateMetaRes.rowCount === 0) {
        await client.query(
          `INSERT INTO gb_wc_orders_meta (order_id, meta_key, meta_value) VALUES ($1, '_last_updated_user', $2)`,
          [orderId, uIdStr]
        );
      }
      const numId = parseInt(uIdStr, 10);
      const incomingUserName = body.updated_by_name || body.display_name || null;
      if (incomingUserName && Number.isFinite(numId) && numId > 0) {
        userNameCache.set(numId, incomingUserName);
      } else if (Number.isFinite(numId) && numId > 0 && !userNameCache.has(numId)) {
        fetchCustomerById(numId).then((cu) => {
          const fullName = `${cu.first_name || ""} ${cu.last_name || ""}`.trim();
          const name = cu.display_name || fullName || cu.username || cu.name || `#${numId}`;
          userNameCache.set(numId, name);
        }).catch(() => {});
      }
    }

    await client.query("COMMIT");

    console.log(`[order-status-sync] order #${orderId} status updated to ${status} via WordPress webhook`);

    return res.json({
      success: true,
      message: `Order #${orderId} status updated to ${cleanStatus} successfully`,
      order: {
        id: Number(orderId),
        status: cleanStatus,
        wc_status: status,
        date_updated_gmt: orderRows[0]?.date_updated_gmt || dateModified,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`Error updating order status for ID ${orderId} via sync:`, error);
    return res.status(500).json({ success: false, message: "Failed to update order status", error: error.message });
  } finally {
    client.release();
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

    if (req.user?.id) {
      const displayName = req.user.display_name || req.user.name || `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || req.user.username;
      if (displayName) {
        userNameCache.set(parseInt(req.user.id, 10), displayName);
      }
      const updateMetaRes = await client.query(
        `UPDATE gb_wc_orders_meta SET meta_value = $1 WHERE order_id = $2 AND meta_key = '_last_updated_user'`,
        [String(req.user.id), id]
      );
      if (updateMetaRes.rowCount === 0) {
        await client.query(
          `INSERT INTO gb_wc_orders_meta (order_id, meta_key, meta_value) VALUES ($1, '_last_updated_user', $2)`,
          [id, String(req.user.id)]
        );
      }
    }

    try {
      const metaData = req.user?.id ? [{ key: "_last_updated_user", value: String(req.user.id) }] : [];
      await updateOrderStatusInWooCommerce(id, status, metaData);
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

    // Update order date_updated_gmt
    await client.query(
      `UPDATE gb_wc_orders SET date_updated_gmt = NOW() WHERE id = $1 AND type = 'shop_order'`,
      [id]
    );

    // Record the user who updated the order in _last_updated_user
    if (req.user?.id) {
      const displayName = req.user.display_name || req.user.name || `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || req.user.username;
      if (displayName) {
        userNameCache.set(parseInt(req.user.id, 10), displayName);
      }
      const updateMetaRes = await client.query(
        `UPDATE gb_wc_orders_meta SET meta_value = $1 WHERE order_id = $2 AND meta_key = '_last_updated_user'`,
        [String(req.user.id), id]
      );
      if (updateMetaRes.rowCount === 0) {
        await client.query(
          `INSERT INTO gb_wc_orders_meta (order_id, meta_key, meta_value) VALUES ($1, '_last_updated_user', $2)`,
          [id, String(req.user.id)]
        );
      }
    }

    const wcPayload = {};
    if (billing) wcPayload.billing = billing;
    if (shipping) wcPayload.shipping = shipping;
    if (req.user?.id) {
      wcPayload.meta_data = [{ key: "_last_updated_user", value: String(req.user.id) }];
    }

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

    const isRestricted = Array.isArray(req.allowedStatuses);

    if (status && status !== "all") {
      if (isRestricted && !req.allowedStatuses.includes(status)) {
        conditions.push("1 = 0");
      } else {
        params.push(status, `wc-${status}`);
        conditions.push(`status IN ($${params.length - 1}, $${params.length})`);
      }
    } else if (isRestricted) {
      if (req.allowedStatuses.length === 0) {
        conditions.push("1 = 0");
      } else {
        const allowedFull = [];
        req.allowedStatuses.forEach((s) => {
          allowedFull.push(s, `wc-${s}`);
        });
        params.push(allowedFull);
        conditions.push(`status = ANY($${params.length})`);
      }
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

    const isRestricted = Array.isArray(req.allowedStatuses);
    if (isRestricted) {
      const orderStatus = stripStatusPrefix(rows[0].status) || rows[0].status;
      if (!req.allowedStatuses.includes(orderStatus)) {
        return res.status(403).json({ success: false, message: "You do not have permission to view this order" });
      }
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

    let origin = "Direct";
    const sourceType = metaMap["_wc_order_attribution_source_type"];
    const utmSource = metaMap["_wc_order_attribution_utm_source"];
    if (sourceType && sourceType !== "typein") {
      origin = sourceType;
      if (utmSource && utmSource !== "(direct)") {
        origin = `${sourceType}: ${utmSource}`;
      }
    }
    order.attribution = {
      origin: origin.charAt(0).toUpperCase() + origin.slice(1),
      device_type: metaMap["_wc_order_attribution_device_type"] || "",
      session_pages: metaMap["_wc_order_attribution_session_pages"] || "",
      referrer: metaMap["_wc_order_attribution_referrer"] || "",
    };

    // If DTDC reference number is missing locally, check WooCommerce to backfill it
    if (!metaMap["_dtdc_reference_number"]) {
      try {
        const wcOrder = await wcGetJson(getApiUrl("orders", {}, order.id));
        const ref = wcOrder?.meta_data?.find((m) => m.key === "_dtdc_reference_number")?.value;
        if (ref) {
          metaMap["_dtdc_reference_number"] = ref;
          order.meta_data.push({ key: "_dtdc_reference_number", value: ref });
          const updateRes = await pool.query(
            `UPDATE gb_wc_orders_meta SET meta_value = $1 WHERE order_id = $2 AND meta_key = '_dtdc_reference_number'`,
            [ref, order.id]
          );
          if (updateRes.rowCount === 0) {
            await pool.query(
              `INSERT INTO gb_wc_orders_meta (order_id, meta_key, meta_value) VALUES ($1, '_dtdc_reference_number', $2)`,
              [order.id, ref]
            ).catch(() => { });
          }
        }
      } catch (wcErr) {
        // Non-blocking
      }
    }

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

// GET /api/orders/local/:id/downloads — fetches downloadable product permissions for this order
exports.getOrderDownloads = async (req, res) => {
  const { id } = req.params;
  try {
    const consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY || "ck_4a4a35a6115395e1514cdd63cc40ec6f3c1970f2";
    const consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET || "cs_c3dc056e368ae43104ffe418e55b016e527c003e";
    const url = `https://gullybababooks.in/wp-json/custom/v1/orders/${id}/downloads?consumer_key=${consumerKey}&consumer_secret=${consumerSecret}`;

    const data = await wcGetJson(url);
    if (!data) {
      return res.json({ success: true, order_id: Number(id), downloads: [] });
    }

    return res.json({
      success: true,
      order_id: data.order_id || Number(id),
      downloads: Array.isArray(data.downloads) ? data.downloads : [],
    });
  } catch (error) {
    console.error(`Error fetching downloads for order ${id}:`, error);
    return res.status(500).json({ success: false, message: "Failed to fetch order downloads", downloads: [] });
  }
};

// GET /api/orders/downloadable-products?search=... — search downloadable products
exports.searchDownloadableProducts = async (req, res) => {
  const search = req.query.search || "";
  if (!search || search.trim().length < 3) {
    return res.json({ success: true, count: 0, products: [] });
  }

  try {
    const consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY || "ck_4a4a35a6115395e1514cdd63cc40ec6f3c1970f2";
    const consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET || "cs_c3dc056e368ae43104ffe418e55b016e527c003e";
    const url = `https://gullybababooks.in/wp-json/custom/v1/downloadable-products?search=${encodeURIComponent(search.trim())}&consumer_key=${consumerKey}&consumer_secret=${consumerSecret}`;

    const data = await wcGetJson(url);
    if (!data) {
      return res.json({ success: true, count: 0, products: [] });
    }

    return res.json({
      success: true,
      count: data.count || (data.products ? data.products.length : 0),
      products: Array.isArray(data.products) ? data.products : [],
    });
  } catch (error) {
    console.error("Error searching downloadable products:", error);
    return res.status(500).json({ success: false, message: "Failed to search downloadable products", products: [] });
  }
};

// POST /api/orders/local/:id/downloads/grant — grant downloadable permission for a product (or array of products)
exports.grantOrderDownloadAccess = async (req, res) => {
  const { id } = req.params;
  const { product_id, product_ids, download_id, quantity } = req.body;

  const targetProductIds = Array.isArray(product_ids)
    ? product_ids
    : product_id
      ? [product_id]
      : [];

  if (targetProductIds.length === 0) {
    return res.status(400).json({ success: false, message: "product_id or product_ids is required" });
  }

  try {
    const consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY || "ck_4a4a35a6115395e1514cdd63cc40ec6f3c1970f2";
    const consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET || "cs_c3dc056e368ae43104ffe418e55b016e527c003e";
    const baseUrl = `https://gullybababooks.in/wp-json/custom/v1/orders/${id}/downloads/grant?consumer_key=${consumerKey}&consumer_secret=${consumerSecret}`;

    const grantedResults = [];
    const errors = [];

    for (const pid of targetProductIds) {
      const payload = {
        product_id: Number(pid),
        quantity: quantity ? Number(quantity) : 1,
      };
      if (download_id) {
        payload.download_id = download_id;
      }

      const result = await wcPostJson(baseUrl, payload);
      if (result.statusCode >= 200 && result.statusCode < 300 && result.data && result.data.success) {
        grantedResults.push(result.data);
      } else {
        const errMsg = (result.data && (result.data.message || result.data.code)) || result.error || `HTTP ${result.statusCode}`;
        errors.push({ product_id: pid, error: errMsg });
      }
    }

    if (grantedResults.length === 0 && errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: errors[0].error || "Failed to grant download access",
        errors,
      });
    }

    return res.json({
      success: true,
      order_id: Number(id),
      results: grantedResults,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error(`Error granting download access for order ${id}:`, error);
    return res.status(500).json({ success: false, message: "Internal server error while granting download access" });
  }
};

// POST /api/orders/local/:id/downloads/revoke — revokes downloadable permission for this order
exports.revokeOrderDownloadAccess = async (req, res) => {
  const { id } = req.params;
  const { permission_id, product_id, download_id } = req.body;

  if (!permission_id && !product_id) {
    return res.status(400).json({ success: false, message: "permission_id or product_id is required" });
  }

  try {
    const consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY || "ck_4a4a35a6115395e1514cdd63cc40ec6f3c1970f2";
    const consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET || "cs_c3dc056e368ae43104ffe418e55b016e527c003e";
    const url = `https://gullybababooks.in/wp-json/custom/v1/orders/${id}/downloads/revoke?consumer_key=${consumerKey}&consumer_secret=${consumerSecret}`;

    const payload = {};
    if (permission_id) payload.permission_id = Number(permission_id);
    if (product_id) payload.product_id = Number(product_id);
    if (download_id) payload.download_id = download_id;

    const result = await wcPostJson(url, payload);
    if (result.statusCode >= 200 && result.statusCode < 300 && result.data && result.data.success) {
      return res.json({
        success: true,
        message: result.data.message || "Download access revoked successfully",
        order_id: Number(id),
        permission_id: permission_id ? Number(permission_id) : undefined,
      });
    }

    const errMsg = (result.data && (result.data.message || result.data.code)) || result.error || `HTTP ${result.statusCode}`;
    return res.status(result.statusCode >= 400 && result.statusCode < 500 ? result.statusCode : 400).json({
      success: false,
      message: errMsg,
    });
  } catch (error) {
    console.error(`Error revoking download access for order ${id}:`, error);
    return res.status(500).json({ success: false, message: "Internal server error while revoking download access" });
  }
};

// GET /api/orders/local/:id/downloads/logs — fetch customer download logs
exports.getOrderDownloadLogs = async (req, res) => {
  const { id } = req.params;
  const permissionId = req.query.permission_id;
  const orderId = id || req.query.order_id;

  try {
    const consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY || "ck_4a4a35a6115395e1514cdd63cc40ec6f3c1970f2";
    const consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET || "cs_c3dc056e368ae43104ffe418e55b016e527c003e";

    let url = `https://gullybababooks.in/wp-json/custom/v1/orders/${orderId}/downloads/logs?consumer_key=${consumerKey}&consumer_secret=${consumerSecret}`;
    if (permissionId) {
      url += `&permission_id=${encodeURIComponent(permissionId)}`;
    }

    const data = await wcGetJson(url);
    if (!data) {
      return res.json({
        success: true,
        order_id: orderId ? Number(orderId) : null,
        permission_id: permissionId ? Number(permissionId) : null,
        count: 0,
        logs: [],
      });
    }

    return res.json({
      success: true,
      order_id: data.order_id || (orderId ? Number(orderId) : null),
      permission_id: data.permission_id || (permissionId ? Number(permissionId) : null),
      count: data.count || (Array.isArray(data.logs) ? data.logs.length : 0),
      logs: Array.isArray(data.logs) ? data.logs : [],
    });
  } catch (error) {
    console.error(`Error fetching download logs for order ${id}:`, error);
    return res.status(500).json({ success: false, message: "Failed to fetch download logs", logs: [] });
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

// Saves DTDC reference number and dtdc_status='Sent' in Postgres and syncs to WooCommerce
async function markOrderSentToDtdc(orderId, referenceNumber) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE gb_wc_orders SET status = 'wc-completed', date_updated_gmt = NOW() WHERE id = $1 AND type = 'shop_order'`,
      [orderId]
    );

    const statusRes = await client.query(
      `UPDATE gb_wc_orders_meta SET meta_value = 'Sent' WHERE order_id = $1 AND meta_key = 'dtdc_status'`,
      [orderId]
    );
    if (statusRes.rowCount === 0) {
      await client.query(
        `INSERT INTO gb_wc_orders_meta (order_id, meta_key, meta_value) VALUES ($1, 'dtdc_status', 'Sent')`,
        [orderId]
      );
    }

    if (referenceNumber) {
      const refRes = await client.query(
        `UPDATE gb_wc_orders_meta SET meta_value = $1 WHERE order_id = $2 AND meta_key = '_dtdc_reference_number'`,
        [referenceNumber, orderId]
      );
      if (refRes.rowCount === 0) {
        await client.query(
          `INSERT INTO gb_wc_orders_meta (order_id, meta_key, meta_value) VALUES ($1, '_dtdc_reference_number', $2)`,
          [orderId, referenceNumber]
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  try {
    const meta_data = [{ key: "dtdc_status", value: "Sent" }];
    if (referenceNumber) {
      meta_data.push({ key: "_dtdc_reference_number", value: referenceNumber });
    }
    await updateOrderInWooCommerce(orderId, { status: "completed", meta_data });
  } catch (error) {
    console.error(`Failed to sync DTDC status to WooCommerce for order ${orderId}:`, error);
  }
}

// Recursively extracts a DTDC reference number from any response structure
function extractDtdcReference(obj) {
  if (!obj) return "";
  if (typeof obj === "string") {
    if (/^[A-Z0-9]{8,20}$/i.test(obj.trim())) return obj.trim();
    return "";
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = extractDtdcReference(item);
      if (found) return found;
    }
  } else if (typeof obj === "object") {
    if (obj.reference_number) return String(obj.reference_number).trim();
    if (obj.consignment_no) return String(obj.consignment_no).trim();
    if (obj.awb_no) return String(obj.awb_no).trim();
    if (obj.awb) return String(obj.awb).trim();
    for (const key of Object.keys(obj)) {
      const found = extractDtdcReference(obj[key]);
      if (found) return found;
    }
  }
  return "";
}

// POST /api/orders/local/:id/dtdc-send — sends order to DTDC via the WordPress order-send-to-dtdc integration,
// with direct Softdata API fallback. Saves _dtdc_reference_number and dtdc_status upon success.
exports.sendToDtdc = async (req, res) => {
  try {
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

    // Prevent duplicate sending if already sent
    const existingRef = (order.meta_data || []).find((m) => m.key === "_dtdc_reference_number")?.value;
    if (existingRef) {
      return res.status(400).json({
        success: false,
        message: `Order #${order.id} has already been sent to DTDC (Reference: ${existingRef}).`,
        reference_number: existingRef,
      });
    }

    const { payload, warnings, pieces_detail } = await buildDtdcPayload(order, totalWeight);

    if (pieces_detail.length === 0) {
      return res.status(400).json({
        success: false,
        message: "This order has no items in DTDC allowed categories (ignou-help-books, ignou-cbcs-help-books, ignou-combos).",
        warnings,
      });
    }

    let referenceNumber = "";
    let dtdcResponse = null;
    let sendSuccess = false;
    let errorMessage = "";

    // 1. Primary path: Dispatch via WordPress order-send-to-dtdc ajax endpoint
    try {
      const wpAjaxUrl = "https://gullybababooks.in/wp-admin/admin-ajax.php";
      const formData = new URLSearchParams({
        action: "send_to_dtdc",
        order_id: String(order.id),
        total_weight: String(totalWeight),
      });

      const wpRes = await fetch(wpAjaxUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
      });

      const wpText = await wpRes.text();
      let wpJson = null;
      try {
        wpJson = JSON.parse(wpText);
      } catch {
        console.error(`[dtdc] non-JSON response from WP admin-ajax for order #${order.id}:`, wpText.slice(0, 300));
      }

      if (wpJson) {
        dtdcResponse = wpJson;
        if (wpJson.success) {
          sendSuccess = true;
          referenceNumber = extractDtdcReference(wpJson);
        } else {
          errorMessage = wpJson.data?.message || wpJson.message || "DTDC request failed via WordPress.";
        }
      }
    } catch (wpErr) {
      console.warn(`[dtdc] WordPress AJAX call failed for order #${order.id}:`, wpErr.message);
    }

    // 2. Fallback path: If WP didn't succeed and direct DTDC API key is configured in env
    if (!sendSuccess && process.env.DTDC_API_KEY && process.env.DTDC_X_ACCESS_TOKEN) {
      try {
        const directRes = await httpJsonRequest("https://pxapi.dtdc.in/api/customer/integration/consignment/softdata", {
          headers: {
            "Content-Type": "application/json",
            "api-key": process.env.DTDC_API_KEY,
            "x-access-token": process.env.DTDC_X_ACCESS_TOKEN,
          },
          body: JSON.stringify({ consignments: [payload] }),
        });

        dtdcResponse = directRes.json || directRes.raw;
        const dtdcSuccess = directRes.json?.data?.[0]?.success;
        if (directRes.statusCode >= 200 && directRes.statusCode < 300 && dtdcSuccess !== false) {
          sendSuccess = true;
          referenceNumber = extractDtdcReference(directRes.json) || "";
        } else {
          errorMessage = directRes.json?.data?.[0]?.message || directRes.json?.error?.message || errorMessage || "DTDC rejected consignment.";
        }
      } catch (directErr) {
        console.error(`[dtdc] direct API call failed for order #${order.id}:`, directErr.message);
      }
    }

    if (!sendSuccess) {
      return res.status(400).json({
        success: false,
        message: errorMessage || "Failed to send order to DTDC.",
        details: dtdcResponse,
        warnings,
      });
    }

    // If WordPress reported success but referenceNumber was not extracted, fetch it directly from WooCommerce
    if (!referenceNumber) {
      try {
        const wcOrder = await wcGetJson(getApiUrl("orders", {}, order.id));
        referenceNumber = wcOrder?.meta_data?.find((m) => m.key === "_dtdc_reference_number")?.value || "";
      } catch (wcErr) {
        console.warn(`[dtdc] Failed to fetch WC order meta for order #${order.id}:`, wcErr.message);
      }
    }

    // Mark order sent in Postgres & sync to WooCommerce
    await markOrderSentToDtdc(order.id, referenceNumber);

    res.json({
      success: true,
      message: `Order #${order.id} sent to DTDC successfully.`,
      reference_number: referenceNumber,
      payload,
      warnings,
      submission: dtdcResponse,
    });
  } catch (error) {
    console.error(`Error sending order ${req.params.id} to DTDC:`, error);
    res.status(500).json({ success: false, message: error.message || "Failed to send order to DTDC" });
  }
};
exports.previewDtdc = exports.sendToDtdc;


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
      putReq.write(JSON.stringify({
        meta_data: [
          { key: "_tekipost_awb", value: trackingDetails.tracking_number },
          { key: "_tekipost_courier_name", value: trackingDetails.courier_name },
          { key: "_tekipost_c_status", value: trackingDetails.tracking_statuses },
        ]
      }));
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
      putReq.write(JSON.stringify({
        meta_data: [
          { key: "_shiprocket_awb", value: trackingDetails.awb_code },
          { key: "_shiprocket_pickup_date", value: trackingDetails.pickup_date },
          { key: "_shiprocket_current_status", value: trackingDetails.current_status },
          { key: "_shiprocket_courier_name", value: trackingDetails.courier_name },
          { key: "_shiprocket_edd", value: trackingDetails.edd },
        ]
      }));
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

    // Resolve user display names
    const userIds = rows
      .map((r) => parseInt(r.user_id, 10))
      .filter((id) => Number.isFinite(id) && id > 0);

    const { rows: lastUserMeta } = await pool.query(
      `SELECT meta_value FROM gb_wc_orders_meta WHERE order_id = $1 AND meta_key = '_last_updated_user' LIMIT 1`,
      [req.params.id]
    );
    const lastUpdatedUserId = lastUserMeta.length > 0 ? parseInt(lastUserMeta[0].meta_value, 10) : null;
    if (lastUpdatedUserId && Number.isFinite(lastUpdatedUserId) && lastUpdatedUserId > 0) {
      userIds.push(lastUpdatedUserId);
    }

    const userNameMap = await resolveUserNames(userIds);

    const notes = rows.map((r) => {
      const uId = parseInt(r.user_id, 10);
      let author = (r.comment_author || "").trim();

      if ((!author || author.toLowerCase() === "woocommerce" || author.toLowerCase() === "wordpress") && uId > 0 && userNameMap[uId]) {
        author = userNameMap[uId];
      } else if ((!author || author.toLowerCase() === "woocommerce" || author.toLowerCase() === "wordpress") && /order status changed/i.test(r.comment_content || "") && lastUpdatedUserId && userNameMap[lastUpdatedUserId]) {
        author = userNameMap[lastUpdatedUserId];
      }

      const isSystemNote =
        (!author || author.toLowerCase() === "woocommerce" || author.toLowerCase() === "system") &&
        (!uId || uId === 0);

      return {
        id: Number(r.comment_id),
        content: r.comment_content,
        date: r.comment_date,
        author: author,
        user_id: uId,
        is_customer_note: r.is_customer_note,
        is_system_note: isSystemNote,
      };
    });

    res.json({ success: true, notes });
  } catch (error) {
    console.error(`Error fetching order notes for order ${req.params.id}:`, error);
    res.status(500).json({ success: false, message: "Failed to fetch order notes" });
  }
};

// Helper to post an order note to WooCommerce REST API (/wc/v2/orders/:id/notes)
const sendOrderNoteToWooCommerce = (orderId, notePayload) => {
  return new Promise((resolve) => {
    const baseUrl = process.env.WOOCOMMERCE_BASE_URL || "https://gullybababooks.in/wp-json";
    const ck = process.env.WOOCOMMERCE_CONSUMER_KEY || "ck_4a4a35a6115395e1514cdd63cc40ec6f3c1970f2";
    const cs = process.env.WOOCOMMERCE_CONSUMER_SECRET || "cs_c3dc056e368ae43104ffe418e55b016e527c003e";
    const postUrl = `${baseUrl}/wc/v2/orders/${orderId}/notes?consumer_key=${ck}&consumer_secret=${cs}`;

    const parsedUrl = new URL(postUrl);
    const authHeader = getBasicAuthHeader();
    const bodyData = JSON.stringify(notePayload);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyData),
        "User-Agent": "Gullybaba-Portal",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const json = JSON.parse(data);
            console.log(`[wc-note] Note synced to WooCommerce order #${orderId}, WC note ID #${json.id}`);
            resolve(json);
          } else {
            console.warn(`[wc-note] WooCommerce returned ${res.statusCode}:`, data);
            resolve(null);
          }
        } catch (err) {
          console.warn("[wc-note] Failed to parse WooCommerce note response:", err.message);
          resolve(null);
        }
      });
    });

    req.on("error", (err) => {
      console.error("[wc-note] Error calling WooCommerce note API:", err.message);
      resolve(null);
    });

    req.write(bodyData);
    req.end();
  });
};

// Helper to delete an order note from WooCommerce REST API (/wc/v2/orders/:id/notes/:noteId)
const deleteOrderNoteFromWooCommerce = (orderId, noteId) => {
  return new Promise((resolve) => {
    const baseUrl = process.env.WOOCOMMERCE_BASE_URL || "https://gullybababooks.in/wp-json";
    const ck = process.env.WOOCOMMERCE_CONSUMER_KEY || "ck_4a4a35a6115395e1514cdd63cc40ec6f3c1970f2";
    const cs = process.env.WOOCOMMERCE_CONSUMER_SECRET || "cs_c3dc056e368ae43104ffe418e55b016e527c003e";
    const deleteUrl = `${baseUrl}/wc/v2/orders/${orderId}/notes/${noteId}?force=true&consumer_key=${ck}&consumer_secret=${cs}`;

    const parsedUrl = new URL(deleteUrl);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "DELETE",
      headers: {
        "Authorization": getBasicAuthHeader(),
        "User-Agent": "Gullybaba-Portal",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[wc-note] Note #${noteId} deleted successfully from WooCommerce order #${orderId}`);
          resolve({ success: true, statusCode: res.statusCode });
        } else if (res.statusCode === 404) {
          console.log(`[wc-note] Note #${noteId} already deleted/not found on WooCommerce`);
          resolve({ success: true, statusCode: 404 });
        } else {
          console.warn(`[wc-note] WooCommerce delete note returned ${res.statusCode}:`, data);
          resolve({ success: false, statusCode: res.statusCode });
        }
      });
    });

    req.on("error", (err) => {
      console.error(`[wc-note] Error calling WooCommerce delete note API:`, err.message);
      resolve({ success: false, error: err.message });
    });

    req.end();
  });
};

// POST /api/orders/local/:id/notes — add an order note. body: { content, note_type }
// note_type is "customer" for "Note to customer", anything else (including "") is a private note.
// Mirrors WC_Order::add_order_note(), including the is_customer_note commentmeta flag, and pushes
// the note live to the WooCommerce WordPress site.
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
    const author = req.user?.display_name || req.user?.name || req.user?.username || "Admin";
    const authorEmail = req.user?.email || req.user?.user_email || "";
    const userId = req.user?.id || req.user?.ID || 0;
    const trimmedContent = content.trim();

    // 1. Forward note to WooCommerce REST API so WordPress site has it live
    const wcPayload = {
      comment_post_ID: String(req.params.id),
      comment_author: author,
      comment_author_email: authorEmail,
      note: trimmedContent,
      customer_note: isCustomerNote,
      comment_karma: 0,
      comment_approved: 1,
      comment_agent: "WooCommerce",
      comment_type: "order_note",
      comment_parent: 0,
      user_id: String(userId),
    };

    const wcResult = await sendOrderNoteToWooCommerce(req.params.id, wcPayload);
    const wpCommentId = wcResult?.id ? Number(wcResult.id) : null;

    // 2. Ensure sequence is ahead of max comment_id to prevent any duplicate key errors
    await pool.query(`SELECT setval('gb_comments_comment_id_seq', GREATEST((SELECT COALESCE(MAX(comment_id), 1) FROM gb_comments), 1), true)`);

    let note;
    if (wpCommentId) {
      // Use the exact comment_id assigned by WordPress
      const { rows } = await pool.query(
        `INSERT INTO gb_comments
           (comment_id, comment_post_id, comment_author, comment_author_email, comment_author_url, comment_author_ip,
            comment_date, comment_date_gmt, comment_content, comment_approved, comment_agent, comment_type,
            comment_parent, user_id)
         VALUES ($1, $2, $3, $4, '', '', NOW(), NOW(), $5, '1', 'WooCommerce', 'order_note', 0, $6)
         ON CONFLICT (comment_id) DO UPDATE SET
           comment_content = EXCLUDED.comment_content,
           comment_author = EXCLUDED.comment_author,
           comment_date = EXCLUDED.comment_date
         RETURNING comment_id, comment_author, comment_content, comment_date, user_id`,
        [wpCommentId, req.params.id, author, authorEmail, trimmedContent, userId]
      );
      note = rows[0];
    } else {
      // Fallback if WooCommerce call did not return an id
      const { rows } = await pool.query(
        `INSERT INTO gb_comments
           (comment_post_id, comment_author, comment_author_email, comment_author_url, comment_author_ip,
            comment_date, comment_date_gmt, comment_content, comment_approved, comment_agent, comment_type,
            comment_parent, user_id)
         VALUES ($1, $2, $3, '', '', NOW(), NOW(), $4, '1', 'WooCommerce', 'order_note', 0, $5)
         RETURNING comment_id, comment_author, comment_content, comment_date, user_id`,
        [req.params.id, author, authorEmail, trimmedContent, userId]
      );
      note = rows[0];
    }

    // Keep sequence ahead of max comment_id
    await pool.query(`SELECT setval('gb_comments_comment_id_seq', GREATEST((SELECT COALESCE(MAX(comment_id), 1) FROM gb_comments), 1), true)`);

    // 3. Save customer note meta flag
    await pool.query(`DELETE FROM gb_commentmeta WHERE comment_id = $1 AND meta_key = 'is_customer_note'`, [note.comment_id]);
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
      synced_to_woocommerce: !!wpCommentId,
    });
  } catch (error) {
    console.error(`Error adding order note for order ${req.params.id}:`, error);
    res.status(500).json({ success: false, message: error.message || "Failed to add order note" });
  }
};

// DELETE /api/orders/local/:id/notes/:noteId
exports.deleteOrderNote = async (req, res) => {
  const { id: orderId, noteId } = req.params;

  try {
    // 1. Delete from local database
    const { rows } = await pool.query(
      `DELETE FROM gb_comments WHERE comment_id = $1 AND comment_post_id = $2 RETURNING comment_id`,
      [noteId, orderId]
    );

    await pool.query(`DELETE FROM gb_commentmeta WHERE comment_id = $1`, [noteId]);

    // 2. Delete from WooCommerce REST API (/wc/v2/orders/:id/notes/:noteId?force=true&consumer_key=...&consumer_secret=...)
    const wcResult = await deleteOrderNoteFromWooCommerce(orderId, noteId);

    // If not found in local DB and WooCommerce also reported not found / 404
    if (rows.length === 0 && (!wcResult || !wcResult.success || wcResult.notFound)) {
      return res.status(404).json({ success: false, message: "Order note not found" });
    }

    res.json({
      success: true,
      message: "Order note deleted successfully",
      deleted_locally: rows.length > 0,
      deleted_from_woocommerce: !!(wcResult?.success && !wcResult?.notFound),
    });
  } catch (error) {
    console.error(`Error deleting order note ${noteId} for order ${orderId}:`, error);
    res.status(500).json({ success: false, message: "Failed to delete order note" });
  }
};

// POST /api/orders/notes/sync or POST /api/orders/:id/notes/sync
// Webhook for WordPress to call when an order note is added on its side (a WooCommerce system note,
// e.g. a status-change note, or a note added in wp-admin).
// Accepts parameters in either WooCommerce comment format, WooCommerce REST API format, or custom format.
// Preserves WordPress comment_id and keeps local Postgres sequence synced.
exports.syncOrderNote = async (req, res) => {
  const body = req.body || {};
  const orderId = req.params.id || body.order_id || body.comment_post_ID || body.comment_post_id || body.orderId || body.id;
  const content = body.content || body.note || body.comment_content || body.message;

  if (!orderId) {
    return res.status(400).json({ success: false, message: "order_id (or comment_post_ID) is required" });
  }

  if (!content || !String(content).trim()) {
    return res.status(400).json({ success: false, message: "note content is required" });
  }

  const trimmedContent = String(content).trim();
  const author = body.author || body.comment_author || body.author_name || body.added_by || body.updated_by_name || body.display_name || "WooCommerce";
  const authorEmail = body.author_email || body.comment_author_email || body.email || "";
  const userId = body.user_id ?? body.userId ?? 0;

  const isCustomerNote =
    body.is_customer_note === true ||
    body.customer_note === true ||
    body.is_customer_note === 1 ||
    body.customer_note === 1 ||
    body.is_customer_note === "1" ||
    body.customer_note === "1" ||
    body.is_customer_note === "true" ||
    body.customer_note === "true";

  let commentDate = body.date_gmt || body.comment_date_gmt || body.date_created_gmt || body.comment_date || body.date_created || body.date;
  if (!commentDate) {
    commentDate = new Date().toISOString().slice(0, 19).replace("T", " ");
  } else if (commentDate instanceof Date) {
    commentDate = commentDate.toISOString().slice(0, 19).replace("T", " ");
  } else {
    commentDate = String(commentDate).replace("T", " ").replace(/\..*$/, "").replace(/Z$/, "");
  }

  let commentId = body.comment_id || body.comment_ID || body.id || body.note_id;

  const commentKarma = parseInt(body.comment_karma, 10) || 0;
  const commentApproved = String(body.comment_approved ?? "1");
  const commentAgent = body.comment_agent || "WooCommerce";
  const commentType = body.comment_type || "order_note";
  const commentParent = parseInt(body.comment_parent, 10) || 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let finalCommentId;

    if (commentId) {
      finalCommentId = Number(commentId);
      await client.query(
        `INSERT INTO gb_comments
           (comment_id, comment_post_id, comment_author, comment_author_email, comment_author_url,
            comment_author_ip, comment_date, comment_date_gmt, comment_content, comment_karma,
            comment_approved, comment_agent, comment_type, comment_parent, user_id)
         VALUES ($1, $2, $3, $4, '', '', $5, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (comment_id) DO UPDATE SET
           comment_post_id = EXCLUDED.comment_post_id,
           comment_author = EXCLUDED.comment_author,
           comment_author_email = EXCLUDED.comment_author_email,
           comment_date = EXCLUDED.comment_date,
           comment_date_gmt = EXCLUDED.comment_date_gmt,
           comment_content = EXCLUDED.comment_content,
           comment_karma = EXCLUDED.comment_karma,
           comment_approved = EXCLUDED.comment_approved,
           comment_agent = EXCLUDED.comment_agent,
           comment_type = EXCLUDED.comment_type,
           comment_parent = EXCLUDED.comment_parent,
           user_id = EXCLUDED.user_id`,
        [finalCommentId, orderId, author, authorEmail, commentDate, trimmedContent, commentKarma, commentApproved, commentAgent, commentType, commentParent, userId]
      );
    } else {
      const { rows } = await client.query(
        `INSERT INTO gb_comments
           (comment_post_id, comment_author, comment_author_email, comment_author_url,
            comment_author_ip, comment_date, comment_date_gmt, comment_content, comment_karma,
            comment_approved, comment_agent, comment_type, comment_parent, user_id)
         VALUES ($1, $2, $3, '', '', $4, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING comment_id`,
        [orderId, author, authorEmail, commentDate, trimmedContent, commentKarma, commentApproved, commentAgent, commentType, commentParent, userId]
      );
      finalCommentId = Number(rows[0].comment_id);
    }

    // Always keep sequence ahead of MAX(comment_id)
    await client.query(
      `SELECT setval('gb_comments_comment_id_seq', GREATEST((SELECT COALESCE(MAX(comment_id), 1) FROM gb_comments), 1), true)`
    );

    // Save customer note meta flag
    await client.query(`DELETE FROM gb_commentmeta WHERE comment_id = $1 AND meta_key = 'is_customer_note'`, [finalCommentId]);
    if (isCustomerNote) {
      await client.query(
        `INSERT INTO gb_commentmeta (comment_id, meta_key, meta_value) VALUES ($1, 'is_customer_note', '1')`,
        [finalCommentId]
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Order note synced successfully",
      note: {
        id: finalCommentId,
        order_id: Number(orderId),
        content: trimmedContent,
        author,
        date: commentDate,
        is_customer_note: isCustomerNote,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`Error syncing order note for order ${orderId}:`, error);
    res.status(500).json({ success: false, message: error.message || "Failed to sync order note" });
  } finally {
    client.release();
  }
};
