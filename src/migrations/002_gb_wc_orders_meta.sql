CREATE TABLE IF NOT EXISTS gb_wc_orders_meta (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  meta_key VARCHAR(255),
  meta_value TEXT
);

CREATE INDEX IF NOT EXISTS idx_gb_wc_orders_meta_order_id ON gb_wc_orders_meta (order_id);
CREATE INDEX IF NOT EXISTS idx_gb_wc_orders_meta_meta_key ON gb_wc_orders_meta (meta_key);
