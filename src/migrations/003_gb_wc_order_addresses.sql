CREATE TABLE IF NOT EXISTS gb_wc_order_addresses (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  address_type VARCHAR(20),
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  address_1 TEXT,
  address_2 TEXT,
  city TEXT,
  state TEXT,
  postcode TEXT,
  country TEXT,
  email VARCHAR(320),
  phone VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_gb_wc_order_addresses_order_id ON gb_wc_order_addresses (order_id);
CREATE INDEX IF NOT EXISTS idx_gb_wc_order_addresses_address_type ON gb_wc_order_addresses (address_type);
CREATE INDEX IF NOT EXISTS idx_gb_wc_order_addresses_email ON gb_wc_order_addresses (email);
CREATE INDEX IF NOT EXISTS idx_gb_wc_order_addresses_phone ON gb_wc_order_addresses (phone);
