// Cinema listings: fetch each configured theater's upcoming films, store them,
// and look up film facts (genres, franchise, critic scores) for the filters.
import { fetchIndyMovies } from './indy.js';
import { lookupFilms } from './wikidata.js';
import { replaceTheaterMovies, moviesNeedingFacts, saveMovieFacts } from '../db/movies.js';

// Theaters on the Indy Systems platform. site-id / circuit-id are the values
// the theater's own website sends with every request.
export const THEATERS = [
  {
    id: 'grand-cinema',
    name: 'The Grand Cinema',
    url: 'https://grandcinema.com',
    city: 'Tacoma',
    tz: 'America/Los_Angeles', // the theater's schedule dates are local
    platform: 'indy',
    siteId: 138,
    circuitId: 87,
  },
];

export const DAYS_AHEAD = 42;

// Refresh every theater. Returns one run per theater in the adapter shape
// (see adapters/index.js), so each is logged and shown in the status bar.
export async function refreshCinemas() {
  const runs = [];
  for (const theater of THEATERS) {
    const run = { source: 'cinema', source_name: theater.id, status: 'ok', events: [], error_msg: null };
    try {
      const movies = await fetchIndyMovies(theater, { days: DAYS_AHEAD });
      // An empty answer is more likely a hiccup than an empty month — keep
      // the last good listings rather than wiping them.
      if (movies.length) {
        const { saved, added } = replaceTheaterMovies(theater.id, movies);
        run.counts = { found: saved, added };
      } else {
        run.status = 'error';
        run.error_msg = 'No showtimes returned — kept the previous listings';
      }
    } catch (err) {
      run.status = 'error';
      run.error_msg = err.response ? `HTTP ${err.response.status}` : err.message;
    }
    runs.push(run);
  }

  // Film facts for the kids / action filters (best-effort; filters fall back
  // to the theater's own rating and genre without them).
  const pending = moviesNeedingFacts();
  if (pending.length) {
    try {
      const facts = await lookupFilms(pending.map((m) => m.tmdb_id));
      for (const m of pending) saveMovieFacts(m.id, facts.get(String(m.tmdb_id)) || null);
    } catch (err) {
      console.warn('[cinema] Wikidata lookup failed:', err.message);
    }
  }
  return { runs };
}
