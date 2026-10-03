// Movie listings (cinema showtimes) — see the movies table in schema.sql.
import db from './index.js';

const COLUMNS = [
  'theater_id', 'source_id', 'theater', 'city', 'title', 'url', 'poster_url', 'trailer_url',
  'synopsis', 'rating', 'rating_reason', 'runtime', 'genre', 'director', 'starring',
  'release_date', 'tmdb_id', 'showtimes', 'first_showing', 'last_showing',
];

const upsert = db.prepare(`
  INSERT INTO movies (${COLUMNS.join(', ')}, updated_at)
  VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')}, datetime('now'))
  ON CONFLICT(theater_id, source_id) DO UPDATE SET
    ${COLUMNS.filter((c) => c !== 'theater_id' && c !== 'source_id').map((c) => `${c} = excluded.${c}`).join(', ')},
    updated_at = datetime('now')
`);

// Replace a theater's listings with a fresh fetch. Films no longer showing are
// removed; your ✕ and the cached Wikidata facts survive for films still on.
export const replaceTheaterMovies = db.transaction((theaterId, rows) => {
  const keep = new Set();
  for (const row of rows) {
    const params = Object.fromEntries(COLUMNS.map((c) => [c, row[c] ?? null]));
    upsert.run({ ...params, showtimes: JSON.stringify(row.showtimes || []) });
    keep.add(String(row.source_id));
  }
  const existing = db.prepare('SELECT id, source_id FROM movies WHERE theater_id = ?').all(theaterId);
  const remove = db.prepare('DELETE FROM movies WHERE id = ?');
  let removed = 0;
  for (const r of existing) {
    if (!keep.has(r.source_id)) removed += remove.run(r.id).changes;
  }
  return { saved: rows.length, removed };
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
