CREATE TABLE IF NOT EXISTS gb_wc_order_coupon_lookup (
  order_id BIGINT NOT NULL,
  coupon_id BIGINT NOT NULL,
  date_created TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00',
  discount_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, coupon_id)
);

CREATE INDEX IF NOT EXISTS idx_gb_wc_order_coupon_lookup_date_created ON gb_wc_order_coupon_lookup (date_created);
