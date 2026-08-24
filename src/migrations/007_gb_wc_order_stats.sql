CREATE TABLE IF NOT EXISTS gb_wc_order_stats (
  order_id BIGINT PRIMARY KEY,
  parent_id BIGINT NOT NULL DEFAULT 0,
  date_created TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00',
  date_created_gmt TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00',
  date_paid TIMESTAMP DEFAULT '1970-01-01 00:00:00',
  date_completed TIMESTAMP DEFAULT '1970-01-01 00:00:00',
  num_items_sold INTEGER NOT NULL DEFAULT 0,
  total_sales DOUBLE PRECISION NOT NULL DEFAULT 0,
  tax_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  shipping_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  net_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  returning_customer BOOLEAN,
  status VARCHAR(20) NOT NULL,
  customer_id BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gb_wc_order_stats_status ON gb_wc_order_stats (status);
CREATE INDEX IF NOT EXISTS idx_gb_wc_order_stats_date_created ON gb_wc_order_stats (date_created);
CREATE INDEX IF NOT EXISTS idx_gb_wc_order_stats_date_paid ON gb_wc_order_stats (date_paid);
CREATE INDEX IF NOT EXISTS idx_gb_wc_order_stats_customer_id ON gb_wc_order_stats (customer_id);
