// The Week screen and the detail sheet behind it: the next seven days at a
// glance, and everything you can tap into from there — a show, a night, an
// artist, a venue. Films from the cinema listings sit alongside the shows.
import { queryEvents, getEventById, getHomeSetting } from './db/queries.js';
import { getArtist, getArtistProfile, parseLineupColumn } from './db/artists.js';
import { scoreEvents, buildContext, hasArtistMatch } from './scoring/engine.js';
import { proximity } from './scoring/home.js';
import { onePerShow } from './picks.js';
import { artistKey, lineupKeys } from './lineup.js';
import { getMovies } from './db/movies.js';
import { groupMovies } from './cinema/group.js';
import { DAYS_AHEAD } from './cinema/index.js';
import { todayISO, addDays, localISO } from './dates.js';

export const WEEK_DAYS = 7;
// A show needs this score to be a top pick — roughly a favorite or sound-alike
// on the bill, or a strong genre match close to home.
export const PICK_MIN = 8;
// …and this much to make a night's short list on the Week screen.
export const GOOD_MIN = 3;
const MAX_PICKS = 8;
const FURTHER_LIMIT = 12;
// Films aren't scored against your taste. One-off screenings rank like a
// decent match so they can make a night's short list; regular runs don't.
const SPECIAL_FILM_SCORE = 6;

const timeOf = (e) => e.time || '99:99';
const byTime = (a, b) => String(a.date).localeCompare(String(b.date)) || timeOf(a).localeCompare(timeOf(b));
const byScore = (a, b) => b._score - a._score || byTime(a, b);

function clock(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Shows (not films) on the given dates, scored, each cross-listed show once.
function scoredShows(from, to, now, filters = {}) {
  return onePerShow(scoreEvents(queryEvents({ ...filters, dateFrom: from, dateTo: to }, { sort: 'date' }), now))
    .map((e) => ({ ...e, kind: e.category }));
}

// Films showing from `from` to `to`, keyed by local date: one entry per film
// per day, with that day's showtimes, in the same shape as a show.
export function filmsByDay(from, to, now = Date.now(), movies = getMovies()) {
  const { nowPlaying, special, comingSoon } = groupMovies(movies, now, { windowDays: DAYS_AHEAD });
  const out = new Map();
  const add = (m, isSpecial) => {
    const byDay = new Map();
    for (const iso of m.showtimes) {
      const d = new Date(iso);
      const date = localISO(d);
      if (date < from || date > to) continue;
      if (!byDay.has(date)) byDay.set(date, []);
      byDay.get(date).push(clock(d));
    }
    for (const [date, times] of byDay) {
      if (!out.has(date)) out.set(date, []);
      out.get(date).push({
        id: `film-${m.id}-${date}`,
        kind: 'film',
        movie_id: m.id,
        title: m.title,
        date,
        time: times[0],
        times,
        venue: m.theater,
        city: m.city,
        ticket_url: m.url,
        special: isSpecial,
        rating: m.rating,
        runtime: m.runtime,
        director: m.director,
        starring: m.starring,
        year: m.year,
        genre: m.genre,
        synopsis: m.synopsis,
        poster_url: m.poster_url,
        trailer_url: m.trailer_url,
        mc_score: m.mc_score,
        rt_score: m.rt_score,
        _score: isSpecial ? SPECIAL_FILM_SCORE : 0,
        _reasons: isSpecial
          ? [{ kind: 'film', text: m.showtimes.length === 1 ? 'One night only' : 'Special screening' }]
          : [],
      });
    }
  };
  nowPlaying.forEach((m) => add(m, false));
  comingSoon.forEach((m) => add(m, false));
  special.forEach((m) => add(m, true));
  for (const list of out.values()) list.sort(byTime);
  return out;
}

// The Week screen: the next seven days starting today (not Monday–Sunday,
// which on a Saturday is mostly over), the week's top picks, each night's
// short list, and shows by your artists further out.
export function weekBrief({ today = todayISO(), now = Date.now(), movies } = {}) {
  const to = addDays(today, WEEK_DAYS - 1);
  const shows = scoredShows(today, addDays(today, 365), now);
  const week = shows.filter((e) => e.date <= to);
  const films = filmsByDay(today, to, now, movies);

  const picks = week.filter((e) => e._score >= PICK_MIN).sort(byScore).slice(0, MAX_PICKS);
  const pickIds = new Set(picks.map((e) => e.id));

  const days = [];
  for (let i = 0; i < WEEK_DAYS; i += 1) {
    const date = addDays(today, i);
    const dayShows = week.filter((e) => e.date === date);
    const dayFilms = films.get(date) || [];
    const best = [...dayShows, ...dayFilms]
      .filter((e) => e._score >= GOOD_MIN)
      .sort(byScore)
      .slice(0, 3)
      .sort(byTime);
    const total = dayShows.length + dayFilms.length;
    days.push({ date, total, more: total - best.length, hasPick: dayShows.some((e) => pickIds.has(e.id)), best });
  }

  const further = shows.filter((e) => e.date > to && hasArtistMatch(e)).slice(0, FURTHER_LIMIT);
  return { today, from: today, to, picks, days, further };
}

// Everything on one night: shows best-first, then films.
export function dayView(date, { now = Date.now(), movies } = {}) {
  return {
    date,
    shows: scoredShows(date, date, now).sort(byScore),
    films: filmsByDay(date, date, now, movies).get(date) || [],
  };
}

// Who an act is to you: genres, whether they're a favorite or starred, and the
// favorite they sound like.
function artistSummary(name, ctx) {
  const keys = lineupKeys(name);
  const favorite = keys.map((k) => ctx.favorites.get(k)).find(Boolean);
  const starred = keys.map((k) => ctx.learned.get(k)).find(Boolean);
  const similar = keys.map((k) => ctx.similar.get(k)).find(Boolean);
  const cached = getArtist(artistKey(name));
  return {
    name,
    key: artistKey(name),
    favorite: Boolean(favorite),
    starred: Boolean(starred),
    tags: cached?.tags ? cached.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6) : [],
    similar: similar && !favorite ? { seed: similar.seed, via: similar.via } : null,
  };
}

function distanceFromHome(city) {
  const near = proximity(city, getHomeSetting().city);
  return { nearby: near.factor > 0, miles: near.miles };
}

// The show sheet: the show itself, who's on the bill, what else is on that
// night, and what's next at the same venue.
export function eventDetails(id, { today = todayISO(), now = Date.now() } = {}) {
  const row = getEventById(id);
  if (!row) return null;
  const [event] = scoreEvents([row], now);
  const ctx = buildContext(now);
  const sameNight = scoredShows(row.date, row.date, now)
    .filter((e) => e.id !== row.id && !(row.headliner_key && e.headliner_key === row.headliner_key))
    .sort(byScore)
    .slice(0, 4);
  return {
    event: { ...event, kind: event.category },
    lineup: (event._lineup || []).map((name) => artistSummary(name, ctx)),
    sameNight,
    home: distanceFromHome(row.city),
  };
}

// An artist profile (src/enrich/profile.js) as the artist sheet shows it,
// with your favorites marked among the similar artists.
export function profileView(profile, ctx = buildContext()) {
  if (!profile) return null;
  const similar = (profile.similar || []).map((name) => ({
    name,
    favorite: lineupKeys(name).some((k) => ctx.favorites.has(k)),
  }));
  return { ...profile, similar };
}

// The artist sheet: who they are to you, every upcoming date in the next
// year, and their profile if it has been looked up (`profile.fresh` false
// means it's due for a refresh — GET /api/artist/profile fetches it).
export function artistView(name, { today = todayISO(), now = Date.now() } = {}) {
  const ctx = buildContext(now);
  const keys = new Set(lineupKeys(name));
  const rows = queryEvents({ dateFrom: today, dateTo: addDays(today, 365) }, { sort: 'date' }).filter((r) =>
    parseLineupColumn(r.lineup).some((act) => lineupKeys(act).some((k) => keys.has(k)))
  );
  const upcoming = onePerShow(scoreEvents(rows, now)).map((e) => ({ ...e, kind: e.category }));
  return {
    ...artistSummary(name, ctx),
    upcoming: upcoming.slice(0, 20),
    profile: profileView(getArtistProfile(artistKey(name)), ctx),
  };
}

// The venue sheet: its next shows and how far it is from home.
export function venueView(name, { today = todayISO(), now = Date.now() } = {}) {
  const rows = queryEvents({ dateFrom: today, dateTo: addDays(today, 60) }, { sort: 'date' }).filter(
    (r) => r.venue === name
  );
  const upcoming = scoreEvents(rows, now).map((e) => ({ ...e, kind: e.category }));
  const city = rows[0]?.city || null;
  return { name, city, home: distanceFromHome(city), upcoming: upcoming.slice(0, 20) };
}

// Saved: shows you're going to, and shows you've marked Maybe.
export function savedLists({ today = todayISO(), now = Date.now() } = {}) {
  const starred = scoreEvents(queryEvents({ dateFrom: today, onlyInterested: true }, { sort: 'date' }), now).map(
    (e) => ({ ...e, kind: e.category })
  );
  return { going: starred.filter((e) => e.going), maybe: starred.filter((e) => !e.going) };
}
