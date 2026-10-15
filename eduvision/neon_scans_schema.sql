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
  diksha_checked_at       TIMESTAMPTZ,
  -- added 15 Oct 2026 (see the migration below for an existing database)
  model                   TEXT,                        -- model the API reported using, e.g. claude-haiku-5-5
  prompt_version          TEXT,                        -- v1 / v2 / v3
  ai_ms                   INTEGER,                     -- ms spent in the Anthropic call (what the 3 s rule applies to)
  in_tokens               INTEGER,
  out_tokens              INTEGER                      -- includes any thinking tokens
);

-- Migration for a database whose scans table already exists (safe to run more than once).
-- Rows saved before this migration keep NULL in these columns.
ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS model          TEXT,
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS ai_ms          INTEGER,
  ADD COLUMN IF NOT EXISTS in_tokens      INTEGER,
  ADD COLUMN IF NOT EXISTS out_tokens     INTEGER;

CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans (created_at);
CREATE INDEX IF NOT EXISTS idx_scans_lang       ON scans (lang);

-- Pilot report: speed per model (the 3 s rule), using only rows saved after the migration.
--   SELECT model,
--          count(*)                                                  AS scans,
--          percentile_cont(0.5) WITHIN GROUP (ORDER BY ai_ms)        AS median_ms,
--          percentile_cont(0.95) WITHIN GROUP (ORDER BY ai_ms)       AS p95_ms,
--          count(*) FILTER (WHERE ai_ms > 3000)                      AS over_3s
--   FROM scans WHERE ai_ms IS NOT NULL GROUP BY model;
