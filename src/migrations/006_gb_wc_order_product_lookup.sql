CREATE TABLE IF NOT EXISTS gb_wc_order_product_lookup (
  order_item_id BIGINT PRIMARY KEY,
  order_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  variation_id BIGINT NOT NULL,
  customer_id BIGINT,
  date_created TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00',
  product_qty INTEGER NOT NULL,
  product_net_revenue DOUBLE PRECISION NOT NULL DEFAULT 0,
  product_gross_revenue DOUBLE PRECISION NOT NULL DEFAULT 0,
  coupon_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  tax_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  shipping_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  shipping_tax_amount DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_gb_wc_order_product_lookup_order_id ON gb_wc_order_product_lookup (order_id);
CREATE INDEX IF NOT EXISTS idx_gb_wc_order_product_lookup_product_id ON gb_wc_order_product_lookup (product_id);
CREATE INDEX IF NOT EXISTS idx_gb_wc_order_product_lookup_customer_id ON gb_wc_order_product_lookup (customer_id);
