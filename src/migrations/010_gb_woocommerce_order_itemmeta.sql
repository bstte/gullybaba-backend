CREATE TABLE IF NOT EXISTS gb_woocommerce_order_itemmeta (
  meta_id BIGSERIAL PRIMARY KEY,
  order_item_id BIGINT NOT NULL,
  meta_key VARCHAR(255),
  meta_value TEXT
);

CREATE INDEX IF NOT EXISTS idx_gb_woocommerce_order_itemmeta_order_item_id ON gb_woocommerce_order_itemmeta (order_item_id);
CREATE INDEX IF NOT EXISTS idx_gb_woocommerce_order_itemmeta_meta_key ON gb_woocommerce_order_itemmeta (meta_key);
