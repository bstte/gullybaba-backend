const https = require("https");
const pool = require("../config/database");
const { updateOrderStatusInWooCommerce } = require("./orderController");
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

// GET /api/orders?page=&limit=&search=&status=&start_date=&end_date=&category=&payment_method=
exports.getOrders = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const search = (req.query.search || "").trim();
    const status = req.query.status || "";
    const start_date = req.query.start_date || "";
    const end_date = req.query.end_date || "";
    const category = (req.query.category || "").trim();
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
      params.push(payment_method);
      conditions.push(`o.payment_method = $${params.length}`);
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

    if (category) {
      params.push(`%${category}%`);
      conditions.push(
        `EXISTS (
          SELECT 1 FROM gb_woocommerce_order_items oi
          JOIN gb_woocommerce_order_itemmeta im ON im.order_item_id = oi.order_item_id
          WHERE oi.order_id = o.id AND oi.order_item_type = 'line_item'
            AND lower(im.meta_key) = 'category' AND im.meta_value ILIKE $${params.length}
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
