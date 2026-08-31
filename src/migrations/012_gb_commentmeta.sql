CREATE TABLE IF NOT EXISTS gb_commentmeta (
  meta_id BIGSERIAL PRIMARY KEY,
  comment_id BIGINT NOT NULL DEFAULT 0,
  meta_key VARCHAR(255),
  meta_value TEXT
);

CREATE INDEX IF NOT EXISTS idx_gb_commentmeta_comment_id ON gb_commentmeta (comment_id);
CREATE INDEX IF NOT EXISTS idx_gb_commentmeta_meta_key ON gb_commentmeta (meta_key);
