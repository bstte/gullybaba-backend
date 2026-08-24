CREATE TABLE IF NOT EXISTS gb_woocommerce_order_items (
  order_item_id BIGSERIAL PRIMARY KEY,
  order_item_name TEXT NOT NULL,
  order_item_type VARCHAR(200) NOT NULL DEFAULT '',
  order_id BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gb_woocommerce_order_items_order_id ON gb_woocommerce_order_items (order_id);
