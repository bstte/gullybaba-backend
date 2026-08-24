CREATE TABLE IF NOT EXISTS gb_wc_orders (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(20),
  currency VARCHAR(10),
  type VARCHAR(20),
  tax_amount NUMERIC(26,8),
  total_amount NUMERIC(26,8),
  customer_id BIGINT,
  billing_email VARCHAR(320),
  date_created_gmt TIMESTAMP,
  date_updated_gmt TIMESTAMP,
  parent_order_id BIGINT,
  payment_method VARCHAR(100),
  payment_method_title TEXT,
  transaction_id VARCHAR(100),
  ip_address VARCHAR(100),
  user_agent TEXT,
  customer_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_gb_wc_orders_status ON gb_wc_orders (status);
CREATE INDEX IF NOT EXISTS idx_gb_wc_orders_type ON gb_wc_orders (type);
CREATE INDEX IF NOT EXISTS idx_gb_wc_orders_customer_id ON gb_wc_orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_gb_wc_orders_date_created_gmt ON gb_wc_orders (date_created_gmt);
CREATE INDEX IF NOT EXISTS idx_gb_wc_orders_parent_order_id ON gb_wc_orders (parent_order_id);
CREATE INDEX IF NOT EXISTS idx_gb_wc_orders_transaction_id ON gb_wc_orders (transaction_id);
