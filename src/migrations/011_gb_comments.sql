CREATE TABLE IF NOT EXISTS gb_comments (
  comment_id BIGSERIAL PRIMARY KEY,
  comment_post_id BIGINT NOT NULL DEFAULT 0,
  comment_author TEXT NOT NULL,
  comment_author_email VARCHAR(100) NOT NULL DEFAULT '',
  comment_author_url VARCHAR(200) NOT NULL DEFAULT '',
  comment_author_ip VARCHAR(100) NOT NULL DEFAULT '',
  comment_date TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00',
  comment_date_gmt TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00',
  comment_content TEXT NOT NULL,
  comment_karma INTEGER NOT NULL DEFAULT 0,
  comment_approved VARCHAR(20) NOT NULL DEFAULT '1',
  comment_agent VARCHAR(255) NOT NULL DEFAULT '',
  comment_type VARCHAR(20) NOT NULL DEFAULT 'comment',
  comment_parent BIGINT NOT NULL DEFAULT 0,
  user_id BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_gb_comments_post_id ON gb_comments (comment_post_id);
CREATE INDEX IF NOT EXISTS idx_gb_comments_type ON gb_comments (comment_type);
CREATE INDEX IF NOT EXISTS idx_gb_comments_post_id_type ON gb_comments (comment_post_id, comment_type);
