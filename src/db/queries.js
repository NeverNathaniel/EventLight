// Prepared statements and higher-level query helpers.
import db from './index.js';
import { safeHttpUrl } from '../adapters/util.js';

// ── Normalisation / dedupe ──────────────────────────────────────────────
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A stable key from title + date(day) + venue used to deduplicate across sources.
export function dedupeKey(title, date, venue) {
  const day = String(date || '').slice(0, 10);
  return [norm(title), day, norm(venue)].join('|');
}

// ── Event upsert ────────────────────────────────────────────────────────
const selectByKey = db.prepare('SELECT id FROM events WHERE dedupe_key = ?');

const insertEvent = db.prepare(`
  INSERT INTO events
    (dedupe_key, source, source_name, title, artist, venue, city, date, time,
     doors_time, category, genre_tags, ticket_url, image_url, price_range,
     interested, hidden, created_at, updated_at)
  VALUES
    (@dedupe_key, @source, @source_name, @title, @artist, @venue, @city, @date, @time,
     @doors_time, @category, @genre_tags, @ticket_url, @image_url, @price_range,
     @interested, @hidden, datetime('now'), datetime('now'))
`);

// Re-ingestion refreshes mutable fields but preserves user state (interested/hidden).
const updateEvent = db.prepare(`
  UPDATE events SET
    source = @source, source_name = @source_name, title = @title, artist = @artist,
    venue = @venue, city = @city, date = @date, time = @time, doors_time = @doors_time,
    category = @category, genre_tags = @genre_tags, ticket_url = @ticket_url,
    image_url = @image_url, price_range = @price_range, updated_at = datetime('now')
  WHERE dedupe_key = @dedupe_key
`);

// Normalise a raw adapter event into a complete row, returning null if invalid.
function normalizeEvent(raw) {
  if (!raw || !raw.title || !raw.date || !raw.venue) return null;
  const date = String(raw.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const title = String(raw.title).trim();
  const venue = String(raw.venue).trim();
  const category = ['music', 'comedy'].includes((raw.category || '').toLowerCase())
    ? raw.category.toLowerCase()
    : 'other';
  return {
    dedupe_key: dedupeKey(title, date, venue),
    source: raw.source || 'api',
    source_name: raw.source_name || raw.source || 'unknown',
    title,
    artist: raw.artist || null,
    venue,
    city: raw.city || null,
    date,
    time: raw.time || null,
    doors_time: raw.doors_time || null,
    category,
    genre_tags: Array.isArray(raw.genre_tags)
      ? raw.genre_tags.join(', ')
      : (raw.genre_tags || ''),
    // http(s) only — scraped pages can carry javascript:/data: URLs that must
    // never be stored and later rendered as hrefs.
    ticket_url: safeHttpUrl(raw.ticket_url),
    image_url: safeHttpUrl(raw.image_url),
    price_range: raw.price_range || null,
    interested: 0,
    hidden: 0,
  };
}

// Insert or update a single event. Returns 'added' | 'updated' | 'invalid'.
export function upsertEvent(raw) {
  const ev = normalizeEvent(raw);
  if (!ev) return 'invalid';
  const existing = selectByKey.get(ev.dedupe_key);
  if (existing) {
    updateEvent.run(ev);
    return 'updated';
  }
  insertEvent.run(ev);
  return 'added';
}

// Bulk upsert wrapped in a transaction. Returns counts.
export const upsertEvents = db.transaction((rawList) => {
  let added = 0;
  let updated = 0;
  let invalid = 0;
  for (const raw of rawList) {
    const result = upsertEvent(raw);
    if (result === 'added') added += 1;
    else if (result === 'updated') updated += 1;
    else invalid += 1;
  }
  return { found: rawList.length, added, updated, invalid };
});

// ── Event listing with filters / sorting ────────────────────────────────
function buildWhere(filters = {}) {
  const clauses = [];
  const params = {};

  if (filters.category && filters.category !== 'all') {
    clauses.push('category = @category');
    params.category = filters.category;
  }
  if (filters.city && filters.city !== 'all') {
    clauses.push('city = @city');
    params.city = filters.city;
  }
  if (Array.isArray(filters.sources) && filters.sources.length) {
    const placeholders = filters.sources.map((_, i) => `@src${i}`);
    clauses.push(`source_name IN (${placeholders.join(',')})`);
    filters.sources.forEach((s, i) => (params[`src${i}`] = s));
  }
  if (filters.dateFrom) {
    clauses.push('date >= @dateFrom');
    params.dateFrom = String(filters.dateFrom).slice(0, 10);
  }
  if (filters.dateTo) {
    clauses.push('date <= @dateTo');
    params.dateTo = String(filters.dateTo).slice(0, 10);
  }
  if (!filters.showHidden) {
    clauses.push('hidden = 0');
  }
  if (filters.onlyInterested) {
    clauses.push('interested = 1');
  }
  if (filters.search) {
    clauses.push('(title LIKE @search OR artist LIKE @search OR venue LIKE @search)');
    params.search = `%${filters.search}%`;
  }
  // Genre tags: match any of the requested tags (OR).
  if (Array.isArray(filters.genres) && filters.genres.length) {
    const sub = filters.genres.map((g, i) => {
      params[`genre${i}`] = `%${g}%`;
      return `genre_tags LIKE @genre${i}`;
    });
    clauses.push(`(${sub.join(' OR ')})`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

const SORT_SQL = {
  date: 'date ASC, time ASC',
  venue: 'venue COLLATE NOCASE ASC, date ASC',
};

// Returns rows matching filters. Relevance sorting is handled by the caller
// (scoring engine) since scores are computed at query time, not stored.
export function queryEvents(filters = {}, { sort = 'date', limit, offset = 0 } = {}) {
  const { where, params } = buildWhere(filters);
  const orderBy = SORT_SQL[sort] || SORT_SQL.date;
  let sql = `SELECT * FROM events ${where} ORDER BY ${orderBy}`;
  if (limit != null) {
    sql += ` LIMIT @limit OFFSET @offset`;
    params.limit = limit;
    params.offset = offset;
  }
  return db.prepare(sql).all(params);
}

export function countEvents(filters = {}) {
  const { where, params } = buildWhere(filters);
  return db.prepare(`SELECT COUNT(*) AS n FROM events ${where}`).get(params).n;
}

export function getEventById(id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

// ── User actions ────────────────────────────────────────────────────────
const setInterestedStmt = db.prepare(
  "UPDATE events SET interested = ?, updated_at = datetime('now') WHERE id = ?"
);
export function setInterested(id, value) {
  setInterestedStmt.run(value ? 1 : 0, id);
  return getEventById(id);
}

const setHiddenStmt = db.prepare(
  "UPDATE events SET hidden = ?, updated_at = datetime('now') WHERE id = ?"
);
export function setHidden(id, value) {
  setHiddenStmt.run(value ? 1 : 0, id);
  return getEventById(id);
}

export function clearHidden() {
  return db.prepare('UPDATE events SET hidden = 0 WHERE hidden = 1').run().changes;
}

// ── Filter facet helpers (populate the UI filter controls) ──────────────
export function getDistinctCities() {
  return db
    .prepare("SELECT DISTINCT city FROM events WHERE city IS NOT NULL AND city != '' ORDER BY city")
    .all()
    .map((r) => r.city);
}

export function getDistinctSources() {
  return db
    .prepare('SELECT DISTINCT source_name FROM events ORDER BY source_name')
    .all()
    .map((r) => r.source_name);
}

export function getAllTags() {
  const rows = db.prepare("SELECT genre_tags FROM events WHERE genre_tags != ''").all();
  const set = new Set();
  for (const { genre_tags } of rows) {
    genre_tags.split(',').forEach((t) => {
      const tag = t.trim().toLowerCase();
      if (tag) set.add(tag);
    });
  }
  return [...set].sort();
}

// ── Manual genre weights (Preference Engine, Layer 1) ───────────────────
export function getManualGenres() {
  return db.prepare('SELECT genre, weight FROM manual_genres ORDER BY genre').all();
}

export function setManualGenre(genre, weight) {
  const w = Math.max(1, Math.min(5, parseInt(weight, 10) || 3));
  db.prepare(
    `INSERT INTO manual_genres (genre, weight) VALUES (?, ?)
     ON CONFLICT(genre) DO UPDATE SET weight = excluded.weight`
  ).run(genre.trim().toLowerCase(), w);
}

export function deleteManualGenre(genre) {
  db.prepare('DELETE FROM manual_genres WHERE genre = ?').run(genre.trim().toLowerCase());
}

// ── Behavioral signals (Preference Engine, Layer 2) ─────────────────────
const bumpSignalStmt = db.prepare(`
  INSERT INTO preferences (tag, signal_count, last_signal)
  VALUES (?, 1, datetime('now'))
  ON CONFLICT(tag) DO UPDATE SET
    signal_count = signal_count + 1,
    last_signal = datetime('now')
`);

// Record interest signals for a set of tags (e.g. an event's genre_tags + artist).
export const recordSignals = db.transaction((tags) => {
  for (const tag of tags) {
    const t = String(tag || '').trim().toLowerCase();
    if (t) bumpSignalStmt.run(t);
  }
});

export function getPreferences() {
  return db.prepare('SELECT tag, signal_count, last_signal FROM preferences').all();
}

// ── Scrape log / status ─────────────────────────────────────────────────
const insertLog = db.prepare(`
  INSERT INTO scrape_log (source, source_name, status, events_found, events_added, error_msg)
  VALUES (@source, @source_name, @status, @events_found, @events_added, @error_msg)
`);

export function logRun(entry) {
  insertLog.run({
    source: entry.source,
    source_name: entry.source_name || entry.source,
    status: entry.status,
    events_found: entry.events_found || 0,
    events_added: entry.events_added || 0,
    error_msg: entry.error_msg || null,
  });
}

// Latest run per source_name, for the status bar and /api/status.
export function getStatus() {
  return db
    .prepare(
      `SELECT l.* FROM scrape_log l
       JOIN (
         SELECT source_name, MAX(run_at) AS max_run, MAX(id) AS max_id
         FROM scrape_log GROUP BY source_name
       ) latest
       ON l.source_name = latest.source_name AND l.id = latest.max_id
       ORDER BY l.run_at DESC`
    )
    .all();
}

export function getRecentLogs(limit = 50) {
  return db.prepare('SELECT * FROM scrape_log ORDER BY id DESC LIMIT ?').all(limit);
}

// ── Key/value settings ──────────────────────────────────────────────────
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}
