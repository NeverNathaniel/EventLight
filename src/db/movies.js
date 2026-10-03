// Movie listings (cinema showtimes) — see the movies table in schema.sql.
import db from './index.js';

const COLUMNS = [
  'theater_id', 'source_id', 'theater', 'city', 'title', 'url', 'poster_url', 'trailer_url',
  'synopsis', 'rating', 'rating_reason', 'runtime', 'genre', 'director', 'starring',
  'release_date', 'tmdb_id', 'showtimes', 'first_showing', 'last_showing',
];

// peak_showings remembers the most showtimes a film ever had listed, so a run
// in its final days (only a show or two left) is still recognised as a run.
const upsert = db.prepare(`
  INSERT INTO movies (${COLUMNS.join(', ')}, peak_showings, updated_at)
  VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')}, @peak_showings, datetime('now'))
  ON CONFLICT(theater_id, source_id) DO UPDATE SET
    ${COLUMNS.filter((c) => c !== 'theater_id' && c !== 'source_id').map((c) => `${c} = excluded.${c}`).join(', ')},
    peak_showings = MAX(movies.peak_showings, excluded.peak_showings),
    updated_at = datetime('now')
`);

// Replace a theater's listings with a fresh fetch. A film missing from the
// fetch has its showtimes cleared (so it drops off the tab) but its row —
// your ✕ and the cached Wikidata facts — is kept in case it comes back;
// rows untouched for 90 days are deleted. Returns { saved, added, removed }.
export const replaceTheaterMovies = db.transaction((theaterId, rows) => {
  const existing = new Set(
    db.prepare('SELECT source_id FROM movies WHERE theater_id = ?').all(theaterId).map((r) => r.source_id)
  );
  const keep = new Set();
  let added = 0;
  for (const row of rows) {
    const params = Object.fromEntries(COLUMNS.map((c) => [c, row[c] ?? null]));
    const showtimes = row.showtimes || [];
    upsert.run({ ...params, showtimes: JSON.stringify(showtimes), peak_showings: showtimes.length });
    if (!existing.has(String(row.source_id))) added += 1;
    keep.add(String(row.source_id));
  }
  const clear = db.prepare(
    "UPDATE movies SET showtimes = '[]', first_showing = NULL, last_showing = NULL WHERE theater_id = ? AND source_id = ?"
  );
  let removed = 0;
  for (const sourceId of existing) {
    if (!keep.has(sourceId)) removed += clear.run(theaterId, sourceId).changes;
  }
  db.prepare(
    "DELETE FROM movies WHERE theater_id = ? AND showtimes = '[]' AND updated_at < datetime('now', '-90 days')"
  ).run(theaterId);
  return { saved: rows.length, added, removed };
});

// Films whose Wikidata facts are missing or older than a week (scores move).
export function moviesNeedingFacts() {
  return db
    .prepare(
      `SELECT id, tmdb_id FROM movies WHERE tmdb_id IS NOT NULL AND tmdb_id != ''
         AND (wd_fetched_at IS NULL OR wd_fetched_at < datetime('now', '-7 days'))`
    )
    .all();
}

export function saveMovieFacts(id, facts) {
  db.prepare(
    `UPDATE movies SET wd_genres = ?, wd_series = ?, rt_score = ?, mc_score = ?,
       wd_fetched_at = datetime('now') WHERE id = ?`
  ).run(
    facts ? facts.genres.join(', ') : null,
    facts?.series ?? null,
    facts?.rt ?? null,
    facts?.mc ?? null,
    id
  );
}

function parse(row) {
  let showtimes = [];
  try {
    showtimes = JSON.parse(row.showtimes || '[]');
  } catch {
    /* keep [] */
  }
  return { ...row, showtimes };
}

export function getMovies() {
  return db.prepare('SELECT * FROM movies ORDER BY first_showing ASC').all().map(parse);
}

export function setMovieHidden(id, value) {
  db.prepare('UPDATE movies SET hidden = ? WHERE id = ?').run(value ? 1 : 0, id);
  const row = db.prepare('SELECT * FROM movies WHERE id = ?').get(id);
  return row ? parse(row) : null;
}
