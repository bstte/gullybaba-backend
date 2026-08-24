CREATE TABLE IF NOT EXISTS gb_wc_order_operational_data (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT,
  created_via VARCHAR(100),
  woocommerce_version VARCHAR(20),
  prices_include_tax BOOLEAN,
  coupon_usages_are_counted BOOLEAN,
  download_permission_granted BOOLEAN,
  cart_hash VARCHAR(100),
  new_order_email_sent BOOLEAN,
  order_key VARCHAR(100),
  order_stock_reduced BOOLEAN,
  date_paid_gmt TIMESTAMP,
  date_completed_gmt TIMESTAMP,
  shipping_tax_amount NUMERIC(26,8),
  shipping_total_amount NUMERIC(26,8),
  discount_tax_amount NUMERIC(26,8),
  discount_total_amount NUMERIC(26,8),
  recorded_sales BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_gb_wc_order_operational_data_order_id ON gb_wc_order_operational_data (order_id);
CREATE INDEX IF NOT EXISTS idx_gb_wc_order_operational_data_order_key ON gb_wc_order_operational_data (order_key);
