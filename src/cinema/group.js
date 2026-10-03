// Group cinema listings for the Movies tab, applying the kids / vapid-action
// filter. Pure — takes stored movie rows, returns display groups.
import { classifyMovie } from './filter.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// A film with this many showtimes or fewer is a special screening (one-off,
// repertory, festival), not a run.
const SPECIAL_MAX_SHOWTIMES = 3;

// Group listings relative to `now`:
//   nowPlaying — runs with a showtime in the next 7 days, leaving soonest first
//   special    — one-off / limited screenings, soonest first
//   comingSoon — runs that open more than a week out
//   filtered   — kids' and vapid action films, with reasons
//   hidden     — films you ✕'d
export function groupMovies(movies, now = Date.now()) {
  const groups = { nowPlaying: [], special: [], comingSoon: [], filtered: [], hidden: [] };
  for (const m of movies) {
    const upcoming = m.showtimes.filter((t) => Date.parse(t) >= now - 30 * 60 * 1000);
    if (!upcoming.length) continue;
    const verdict = classifyMovie(m);
    const film = {
      ...m,
      showtimes: upcoming,
      year: /^\d{4}/.test(m.release_date || '') ? Number(m.release_date.slice(0, 4)) : null,
      _filter: verdict.hidden ? { kind: verdict.kind, reason: verdict.reason } : null,
    };
    if (m.hidden) groups.hidden.push(film);
    else if (verdict.hidden) groups.filtered.push(film);
    else if (upcoming.length <= SPECIAL_MAX_SHOWTIMES) groups.special.push(film);
    else if (Date.parse(upcoming[0]) <= now + 7 * DAY_MS) groups.nowPlaying.push(film);
    else groups.comingSoon.push(film);
  }
  const by = (key) => (a, b) => String(a[key]).localeCompare(String(b[key]));
  groups.nowPlaying.sort((a, b) => a.showtimes.at(-1).localeCompare(b.showtimes.at(-1)));
  groups.special.sort((a, b) => a.showtimes[0].localeCompare(b.showtimes[0]));
  groups.comingSoon.sort((a, b) => a.showtimes[0].localeCompare(b.showtimes[0]));
  groups.filtered.sort(by('title'));
  groups.hidden.sort(by('title'));
  return groups;
}
