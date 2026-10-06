// Artist-level data: favorite artists, the enrichment cache (genre tags per
// artist), similar-artist expansion, and the per-event artist_tags rollup.
import db from './index.js';
import { artistKey, lineupKeys } from '../lineup.js';

export function parseLineupColumn(value) {
  try {
    const list = JSON.parse(value || '[]');
    return Array.isArray(list) ? list.filter((n) => typeof n === 'string' && n) : [];
  } catch {
    return [];
  }
}

// ── Favorite artists ────────────────────────────────────────────────────
export function getFavoriteArtists() {
  return db
    .prepare('SELECT artist_key, name, weight, source FROM favorite_artists ORDER BY weight DESC, name COLLATE NOCASE')
    .all();
}

export function setFavoriteArtist(name, weight = 3, source = 'manual') {
  const display = String(name || '').trim();
  const key = artistKey(display);
  if (!key) return null;
  const w = Math.max(1, Math.min(5, parseInt(weight, 10) || 3));
  db.prepare(
    `INSERT INTO favorite_artists (artist_key, name, weight, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(artist_key) DO UPDATE SET name = excluded.name, weight = excluded.weight`
  ).run(key, display, w, source);
  return key;
}

export function deleteFavoriteArtist(key) {
  db.prepare('DELETE FROM favorite_artists WHERE artist_key = ?').run(String(key || ''));
  db.prepare('DELETE FROM similar_artists WHERE seed_key = ?').run(String(key || ''));
  // Forget the fetch too, so re-adding the artist refetches its list.
  db.prepare('UPDATE artists SET similar_at = NULL WHERE artist_key = ?').run(String(key || ''));
}

// Headliners of events you starred — a learned, softer kind of favorite.
export function getLearnedArtists(limit = 60) {
  const rows = db
    .prepare(
      `SELECT lineup, MAX(updated_at) AS at FROM events
       WHERE interested = 1 AND lineup != '[]'
       GROUP BY lineup ORDER BY at DESC LIMIT ?`
    )
    .all(limit);
  const out = new Map();
  for (const r of rows) {
    const head = parseLineupColumn(r.lineup)[0];
    if (head && !out.has(artistKey(head))) out.set(artistKey(head), head);
  }
  return [...out].map(([artist_key, name]) => ({ artist_key, name }));
}

// Headliners of events you hid — used as a mild negative signal.
export function getHiddenHeadlinerKeys() {
  const rows = db.prepare("SELECT lineup FROM events WHERE hidden = 1 AND lineup != '[]'").all();
  const keys = new Set();
  for (const r of rows) {
    const head = parseLineupColumn(r.lineup)[0];
    if (head) keys.add(artistKey(head));
  }
  return keys;
}

// ── Artist metadata cache ───────────────────────────────────────────────
export function getArtist(key) {
  return db.prepare('SELECT * FROM artists WHERE artist_key = ?').get(key);
}

export function saveArtist({ key, name, mbid = null, tags = [], status }) {
  db.prepare(
    `INSERT INTO artists (artist_key, name, mbid, tags, status, fetched_at)
     VALUES (@key, @name, @mbid, @tags, @status, datetime('now'))
     ON CONFLICT(artist_key) DO UPDATE SET
       name = excluded.name, mbid = excluded.mbid, tags = excluded.tags,
       status = excluded.status, fetched_at = excluded.fetched_at`
  ).run({ key, name, mbid, tags: tags.join(', '), status });
}

// Keys whose cached lookup is still fresh (found: 90 days; misses retried
// after 14 days, errors after 1 day).
export function getFreshArtistKeys() {
  return new Set(
    db
      .prepare(
        `SELECT artist_key FROM artists WHERE
           (status = 'found' AND fetched_at > datetime('now', '-90 days')) OR
           (status = 'not_found' AND fetched_at > datetime('now', '-14 days')) OR
           (status = 'error' AND fetched_at > datetime('now', '-1 days'))`
      )
      .all()
      .map((r) => r.artist_key)
  );
}

// Upcoming music events' lineups, soonest first — what enrichment should look up.
export function getUpcomingLineups(fromDate, toDate) {
  return db
    .prepare(
      `SELECT id, lineup, category FROM events
       WHERE date >= ? AND date <= ? AND hidden = 0 AND lineup != '[]'
       ORDER BY date ASC`
    )
    .all(fromDate, toDate)
    .map((r) => ({ id: r.id, category: r.category, lineup: parseLineupColumn(r.lineup) }));
}

// Tags for one lineup entry. A co-bill like "Highly Suspect & Yelawolf" is
// looked up act by act — but only trusted when *every* act resolves, so a
// title fragment like "Best Of The 80's & Beyond" can't borrow the tags of
// some unrelated band called "Beyond". Exported for the row's genre line
// (src/feel.js), which reads the headliner's tags the same way.
export function lineupTags(name, tagsByKey) {
  const [whole, ...parts] = lineupKeys(name);
  if (tagsByKey.has(whole)) return tagsByKey.get(whole);
  // "Dave Hause & The Mermaid", "Craig Finn & The Band of Forgiveness": a
  // named artist with a backing band. Two-word-plus names only, so a lone
  // first name ("Laith & The Texas Birds") can't match a stranger.
  const backed = String(name).match(/^(.+?)\s+(?:&|and)\s+the\s+\S/i);
  if (backed && backed[1].trim().split(/\s+/).length >= 2) {
    const lead = tagsByKey.get(artistKey(backed[1]));
    if (lead) return lead;
  }
  if (parts.length < 2 || !parts.every((k) => tagsByKey.has(k))) return [];
  const merged = [];
  const lists = parts.map((k) => tagsByKey.get(k));
  for (let i = 0; i < 8; i += 1) for (const l of lists) if (l[i]) merged.push(l[i]);
  return [...new Set(merged)];
}

// Roll each upcoming event's artist tags up onto the event row so genre
// filters and the scoring engine see them. Headliner tags first, then a few
// from the support acts.
export function syncEventArtistTags(fromDate) {
  const tagsByKey = new Map(
    db
      .prepare("SELECT artist_key, tags FROM artists WHERE status = 'found' AND tags != ''")
      .all()
      .map((r) => [r.artist_key, r.tags.split(',').map((t) => t.trim()).filter(Boolean)])
  );
  const rows = db.prepare('SELECT id, lineup, artist_tags FROM events WHERE date >= ?').all(fromDate);
  const update = db.prepare('UPDATE events SET artist_tags = ? WHERE id = ?');
  let changed = 0;
  db.transaction(() => {
    for (const r of rows) {
      const tags = [];
      parseLineupColumn(r.lineup).slice(0, 3).forEach((name, i) => {
        tags.push(...lineupTags(name, tagsByKey).slice(0, i === 0 ? 6 : 3));
      });
      const value = [...new Set(tags)].join(', ');
      if (value !== r.artist_tags) {
        update.run(value, r.id);
        changed += 1;
      }
    }
  })();
  return changed;
}

// ── Similar artists ─────────────────────────────────────────────────────
// Replace an artist's similar list and stamp artists.similar_at, so an empty
// answer is remembered too. The artist must already be in the cache.
export function replaceSimilarArtists(seedKey, seedName, list) {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO similar_artists (seed_key, seed_name, artist_key, name, score, fetched_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  );
  db.transaction(() => {
    db.prepare('DELETE FROM similar_artists WHERE seed_key = ?').run(seedKey);
    for (const a of list) {
      if (a.key !== seedKey) insert.run(seedKey, seedName, a.key, a.name, a.score);
    }
    db.prepare("UPDATE artists SET similar_at = datetime('now') WHERE artist_key = ?").run(seedKey);
  })();
}

// Artists whose similar list was fetched within the last `days` days.
export function getFreshSimilarSeeds(days) {
  return new Set(
    db
      .prepare('SELECT artist_key FROM artists WHERE similar_at > datetime(\'now\', ?)')
      .all(`-${days} days`)
      .map((r) => r.artist_key)
  );
}

export function getSimilarArtists() {
  return db.prepare('SELECT seed_key, seed_name, artist_key, name, score FROM similar_artists').all();
}

// Cheap fingerprint of the similar_artists table, for memoising derived data.
export function similarArtistsVersion() {
  const r = db.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS at FROM similar_artists').get();
  return `${r.n}|${r.at}`;
}

// Artists similar to this one, closest first: its own ListenBrainz list
// (fetched for favorites and starred artists).
export function getSimilarFor(key, limit = 8) {
  return db
    .prepare('SELECT artist_key, name FROM similar_artists WHERE seed_key = ? ORDER BY score DESC LIMIT ?')
    .all(key, limit);
}

// ── Artist profiles (the artist sheet) ──────────────────────────────────
// A found profile is kept for 30 days; a miss is retried after a week; a
// failed or partly failed lookup (a service down, rate limited, no network)
// after an hour.
export function getArtistProfile(key) {
  const row = db
    .prepare(
      `SELECT *, (
         (status = 'found' AND fetched_at > datetime('now', '-30 days')) OR
         (status = 'not_found' AND fetched_at > datetime('now', '-7 days')) OR
         (status IN ('partial', 'error') AND fetched_at > datetime('now', '-1 hours'))
       ) AS fresh
       FROM artist_profiles WHERE artist_key = ?`
    )
    .get(key);
  if (!row) return null;
  let data = {};
  try {
    data = JSON.parse(row.data || '{}');
  } catch {
    /* a corrupt row reads as empty and is refetched */
  }
  return { ...data, key: row.artist_key, status: row.status, fresh: Boolean(row.fresh), fetched_at: row.fetched_at };
}

export function saveArtistProfile(key, name, status, data) {
  db.prepare(
    `INSERT INTO artist_profiles (artist_key, name, data, status, fetched_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(artist_key) DO UPDATE SET
       name = excluded.name, data = excluded.data, status = excluded.status, fetched_at = excluded.fetched_at`
  ).run(key, name, JSON.stringify(data || {}), status);
}

export function countSimilarArtists() {
  return db.prepare('SELECT COUNT(DISTINCT artist_key) AS n FROM similar_artists').get().n;
}

export function countEnrichedArtists() {
  return db.prepare("SELECT COUNT(*) AS n FROM artists WHERE status = 'found'").get().n;
}
