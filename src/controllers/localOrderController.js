const pool = require("../config/database");

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

    return {
      id: item.order_item_id,
      name: item.order_item_name,
      product_id: int(metaValue(im, "_product_id")),
      variation_id: int(metaValue(im, "_variation_id")),
      quantity: int(metaValue(im, "_qty")),
      tax_class: metaValue(im, "_tax_class") || "",
      subtotal: num(metaValue(im, "_line_subtotal")),
      subtotal_tax: num(metaValue(im, "_line_subtotal_tax")),
      total: num(metaValue(im, "_line_total")),
      total_tax: num(metaValue(im, "_line_tax")),
      taxes: [], // _line_tax_data is PHP-serialized; not decoded here
      meta_data: extraMeta,
      sku: null, // no local product table imported
      price: null, // no local product table imported
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
      params.push(`wc-${status}`);
      conditions.push(`status = $${params.length}`);
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
    res.json({ success: true, order });
  } catch (error) {
    console.error(`Error fetching local order ${req.params.id}:`, error);
    res.status(500).json({ success: false, message: "Failed to fetch order from local database" });
  }
};
