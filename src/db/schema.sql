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
  lineup        TEXT NOT NULL DEFAULT '[]', -- JSON array of artist names, headliner first
  artist_tags   TEXT NOT NULL DEFAULT '',   -- genre tags looked up for the lineup (enrichment)
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

-- ── Favorite artists (Preference Engine, strongest signal) ─────────────
-- Artists you love — seeded from taste-profile.json and editable in Settings.
-- Unlike behavioral signals these never decay: if a favorite plays, it's a pick.
CREATE TABLE IF NOT EXISTS favorite_artists (
  artist_key  TEXT PRIMARY KEY,           -- normalised name (see src/lineup.js)
  name        TEXT NOT NULL,
  weight      INTEGER NOT NULL DEFAULT 3, -- 1..5
  source      TEXT NOT NULL DEFAULT 'manual',  -- manual | spotify
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Artist metadata cache (enrichment) ──────────────────────────────────
-- Genre tags per artist from MusicBrainz, so scraped shows (which only say
-- "music") can be matched against your genre weights.
CREATE TABLE IF NOT EXISTS artists (
  artist_key  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  mbid        TEXT,
  tags        TEXT NOT NULL DEFAULT '',   -- comma-separated, most-voted first
  status      TEXT NOT NULL,              -- found | not_found | error
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
  similar_at  TEXT                        -- last similar-artist fetch (even if empty)
);

-- Similar-artist lists (ListenBrainz), one row per (seed, similar artist);
-- score is 0..1 relative to the seed's closest match. Seeds are your favorite
-- and starred artists *and* upcoming headliners, so the engine can link a
-- touring band to your taste in either direction or through a shared neighbor.
CREATE TABLE IF NOT EXISTS similar_artists (
  seed_key    TEXT NOT NULL,
  seed_name   TEXT NOT NULL,
  artist_key  TEXT NOT NULL,
  name        TEXT NOT NULL,
  score       REAL NOT NULL,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (seed_key, artist_key)
);

CREATE INDEX IF NOT EXISTS idx_similar_artist ON similar_artists(artist_key);

-- ── Movies (cinema listings) ────────────────────────────────────────────
-- One row per film per theater, replaced on each refresh. Showtimes are a
-- JSON array of UTC ISO datetimes. wd_* columns are Wikidata facts looked up
-- by TMDB id (used by the kids / action filters); hidden is your own ✕.
CREATE TABLE IF NOT EXISTS movies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  theater_id     TEXT NOT NULL,             -- e.g. grand-cinema
  source_id      TEXT NOT NULL,             -- the theater system's movie id
  theater        TEXT NOT NULL,
  city           TEXT,
  title          TEXT NOT NULL,
  url            TEXT,
  poster_url     TEXT,
  trailer_url    TEXT,
  synopsis       TEXT,
  rating         TEXT,                      -- MPAA (G, PG, PG-13, R, NC-17)
  rating_reason  TEXT,
  runtime        INTEGER,                   -- minutes
  genre          TEXT,
  director       TEXT,
  starring       TEXT,
  release_date   TEXT,
  tmdb_id        TEXT,
  showtimes      TEXT NOT NULL DEFAULT '[]',
  first_showing  TEXT,
  last_showing   TEXT,
  peak_showings  INTEGER NOT NULL DEFAULT 0, -- most showtimes ever listed at once
  wd_genres      TEXT,                      -- comma-separated
  wd_series      TEXT,                      -- franchise / film series, if any
  rt_score       INTEGER,                   -- Rotten Tomatoes %
  mc_score       INTEGER,                   -- Metacritic /100
  wd_fetched_at  TEXT,
  hidden         INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (theater_id, source_id)
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

-- ── Alerts already sent ─────────────────────────────────────────────────
-- One row per show you were told about ("<date>|<headliner>"), so each show
-- alerts once however many sources list it or how often it's refreshed.
CREATE TABLE IF NOT EXISTS alerts_sent (
  key      TEXT PRIMARY KEY,
  sent_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
