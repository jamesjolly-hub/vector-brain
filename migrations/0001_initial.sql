-- Migration: 0001_initial
-- Schema for vector-brain corpus metadata store

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT    PRIMARY KEY,
  title       TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  source      TEXT,
  tags        TEXT    NOT NULL DEFAULT '[]',  -- JSON array of tag strings
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS stats (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);

INSERT OR IGNORE INTO stats (key, value) VALUES ('total_docs', '0');
INSERT OR IGNORE INTO stats (key, value) VALUES ('last_indexed_at', '');

CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_title   ON documents (title);
