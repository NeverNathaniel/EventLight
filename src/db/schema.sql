-- EventLight schema. Applied idempotently on boot by migrate.js.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Events ──────────────────────────────────────────────────────────────
-- A unified row per event from any source. Deduplicated by dedupe_key,
-- a normalized (title|date|venue) tuple.
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key    TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL,            -- api | rss | scrape | manual
  source_name   TEXT NOT NULL,            -- e.g. ticketmaster, showbox, The Tractor Tavern
  title         TEXT NOT NULL,
  artist        TEXT,
  venue         TEXT NOT NULL,
  city          TEXT,
  date          TEXT NOT NULL,            -- ISO date (YYYY-MM-DD)
  time          TEXT,                     -- HH:MM (24h) when known
  doors_time    TEXT,
  category      TEXT NOT NULL DEFAULT 'other',  -- music | comedy | other
  genre_tags    TEXT NOT NULL DEFAULT '',  -- comma-separated
  ticket_url    TEXT,
  image_url     TEXT,
  price_range   TEXT,
  interested    INTEGER NOT NULL DEFAULT 0,  -- boolean
  hidden        INTEGER NOT NULL DEFAULT 0,  -- boolean
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_date     ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_city     ON events(city);
CREATE INDEX IF NOT EXISTS idx_events_source   ON events(source_name);

-- ── Manual genre weights (Preference Engine, Layer 1) ───────────────────
CREATE TABLE IF NOT EXISTS manual_genres (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  genre   TEXT NOT NULL UNIQUE,
  weight  INTEGER NOT NULL DEFAULT 3      -- 1..5
);

-- ── Behavioral signals (Preference Engine, Layer 2) ─────────────────────
-- One row per tag, accumulating signal as the user marks events interested.
CREATE TABLE IF NOT EXISTS preferences (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tag           TEXT NOT NULL UNIQUE,
  signal_count  REAL NOT NULL DEFAULT 0,
  last_signal   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Scrape / ingestion log ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scrape_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,            -- adapter identifier
  source_name   TEXT,                     -- specific feed/scraper/api name
  status        TEXT NOT NULL,            -- ok | error | skipped
  events_found  INTEGER NOT NULL DEFAULT 0,
  events_added  INTEGER NOT NULL DEFAULT 0,
  error_msg     TEXT,
  run_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scrape_log_run_at ON scrape_log(run_at);
CREATE INDEX IF NOT EXISTS idx_scrape_log_source ON scrape_log(source_name);

-- ── Key/value settings (non-secret app state) ───────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
