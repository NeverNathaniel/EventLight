// Indy Systems — the ticketing platform behind The Grand Cinema (and other
// independent cinemas). Its site is a JS app backed by a GraphQL endpoint on
// the cinema's own domain; requests identify the cinema with site-id /
// circuit-id headers, exactly as the site's own frontend does.
//
// One refresh = one request for the dates with showtimes + one request per
// day in the window — a few dozen small requests, a few times a day.
import axios from 'axios';
import { USER_AGENT, sleep, REQUEST_DELAY_MS } from '../config.js';
import { htmlToText } from '../adapters/util.js';

const MOVIE_FIELDS = `id name urlSlug synopsis rating ratingReason duration genre
  posterImage trailerYoutubeId releaseDate directedBy starring tmdbId`;

function client(theater) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    Origin: theater.url,
    'site-id': String(theater.siteId),
    'circuit-id': String(theater.circuitId),
    'client-type': 'consumer',
  };
  return async (query) => {
    const res = await axios.post(`${theater.url}/graphql`, { query }, { headers, timeout: 20000 });
    const err = res.data?.errors?.[0] || res.data?.error;
    if (err) throw new Error(err.message_to_log || err.message || 'GraphQL error');
    return res.data.data;
  };
}

// Strip the light HTML the theater uses in synopses ("<i>…</i>", "<div><br></div>").
export const plainText = htmlToText;

// Map an Indy movie (plus its collected showtimes) to a movies-table row.
export function mapIndyMovie(m, showtimes, theater) {
  const sorted = [...new Set(showtimes)].sort();
  return {
    theater_id: theater.id,
    source_id: String(m.id),
    theater: theater.name,
    city: theater.city || null,
    title: String(m.name || '').trim(),
    url: m.urlSlug ? `${theater.url}/movie/${encodeURIComponent(m.urlSlug)}/` : theater.url,
    poster_url: m.posterImage ? `https://indy-systems.imgix.net/${encodeURIComponent(m.posterImage)}?w=400&auto=format,compress` : null,
    trailer_url: m.trailerYoutubeId ? `https://www.youtube.com/watch?v=${encodeURIComponent(m.trailerYoutubeId)}` : null,
    synopsis: plainText(m.synopsis) || null,
    rating: m.rating || null,
    rating_reason: m.ratingReason || null,
    runtime: Number.isFinite(m.duration) ? m.duration : null,
    genre: m.genre || null,
    director: m.directedBy || null,
    starring: m.starring || null,
    release_date: m.releaseDate || null,
    tmdb_id: m.tmdbId ? String(m.tmdbId) : null,
    showtimes: sorted,
    first_showing: sorted[0] || null,
    last_showing: sorted[sorted.length - 1] || null,
  };
}

// A calendar date (YYYY-MM-DD) as seen in the theater's time zone — its
// schedule is keyed by local dates, which run behind UTC every evening.
export function localDate(when, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
}

// Every film with a showtime between now and `days` ahead, showtimes as UTC ISO.
export async function fetchIndyMovies(theater, { days = 28, now = new Date() } = {}) {
  const gql = client(theater);
  const tz = theater.tz || 'America/Los_Angeles';
  const today = localDate(now, tz);
  const until = localDate(new Date(now.getTime() + days * 86400000), tz);

  const datesRaw = (await gql('{ datesWithShowing { value } }'))?.datesWithShowing?.value;
  const dates = (typeof datesRaw === 'string' ? JSON.parse(datesRaw) : datesRaw || [])
    .filter((d) => d >= today && d <= until);

  const byMovie = new Map();
  for (const date of dates) {
    const data = await gql(
      `{ showingsForDate(date: "${date}") { data { id time movie { ${MOVIE_FIELDS} } } } }`
    );
    for (const s of data?.showingsForDate?.data || []) {
      if (!s?.movie?.id || !s.time || new Date(s.time) < now) continue;
      const entry = byMovie.get(s.movie.id) || { movie: s.movie, times: [] };
      entry.times.push(new Date(s.time).toISOString());
      byMovie.set(s.movie.id, entry);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  return [...byMovie.values()].map(({ movie, times }) => mapIndyMovie(movie, times, theater));
}
