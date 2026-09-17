-- CurioX scan/event logging — Neon schema
-- Run this once in the Neon SQL editor (or via `psql "$DATABASE_URL" -f neon_scans_schema.sql`)
-- against the database you'll point DATABASE_URL at.

CREATE TABLE IF NOT EXISTS scans (
  id                      TEXT PRIMARY KEY,           -- scan_id generated client-side (crypto.randomUUID())
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  lang                    TEXT,                        -- en / hi / bn
  concept                 TEXT,
  confidence              REAL,
  subject                 TEXT,
  has_educational_content BOOLEAN,
  image_key               TEXT,                        -- R2 object key, e.g. scans/2026-09-17/<id>.jpg (NULL if the R2 write failed)
  diksha_hit              BOOLEAN,                      -- NULL until diksha.js runs (or never, for en/hi scans); TRUE = DIKSHA had content, FALSE = fell back to YouTube
  diksha_checked_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans (created_at);
CREATE INDEX IF NOT EXISTS idx_scans_lang       ON scans (lang);
