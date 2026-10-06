// The Week screen, the day page and the detail sheet: the next seven days at
// a glance, each day on its own page, and everything you can tap into from
// there — a show, a film, an artist, a venue. Films from the cinema listings
// sit alongside the shows.
//
// Every list is dressed by annotate() (src/annotate.js), and the picks come
// from src/curation.js, so a day's picks are the same on the Week screen and
// on the day's own page.
import { queryEvents, getEventById, getHomeSetting } from './db/queries.js';
import { getArtist, getArtistProfile, parseLineupColumn } from './db/artists.js';
import db from './db/index.js';
import { scoreEvents, buildContext, hasArtistMatch } from './scoring/engine.js';
import { proximity } from './scoring/home.js';
import { onePerShow } from './picks.js';
import { artistKey, lineupKeys } from './lineup.js';
import { getMovies } from './db/movies.js';
import { groupMovies } from './cinema/group.js';
import { DAYS_AHEAD } from './cinema/index.js';
import { todayISO, addDays, localISO } from './dates.js';
import { annotate } from './annotate.js';
import { loadFacts, displayTags, fansOf, descriptorOf, previewOf } from './feel.js';
import { chooseDayPicks, chooseWeekPicks, dayDek, weekNote, loadCurated, startedLongAgo } from './curation.js';
import { flagsOf } from './kinds.js';

export const WEEK_DAYS = 7;
// A show needs this to be a top pick — roughly a favorite or sound-alike on
// the bill, or a strong genre match close to home. A day whose picks include
// one gets a dot on the strip.
export const PICK_MIN = 8;
// Shows below this are dimmed in lists.
export const GOOD_MIN = 3;
const MAX_PICKS = 8;
const DAY_PICKS = 3;
const FURTHER_LIMIT = 12;
// Each group on the day page shows this many, best first, then "+N more".
const GROUP_SHOWN = 5;
const GROUPS = [
  ['music', 'Music'],
  ['comedy', 'Comedy'],
  ['film', 'At the movies'],
  ['around', 'Around town'],
];

const timeOf = (e) => e.time || '99:99';
const byTime = (a, b) => String(a.date).localeCompare(String(b.date)) || timeOf(a).localeCompare(timeOf(b));
const byPick = (a, b) => (b._pick ?? 0) - (a._pick ?? 0) || byTime(a, b);
const hasFlag = (e, key) => (e._flags || []).some((f) => f.key === key);
// A cancelled or postponed show is dropped from every list but Saved (where
// it's struck through), so it can't fill a group, a count or a strip total.
const cancelled = (e) => (e._flags || flagsOf(e)).some((f) => f.key === 'cancelled');

function clock(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Shows (not films) on the given dates, scored, each cross-listed show once.
function scoredShows(from, to, now, filters = {}) {
  return onePerShow(scoreEvents(queryEvents({ ...filters, dateFrom: from, dateTo: to }, { sort: 'date' }), now))
    .map((e) => ({ ...e, kind: e.category }));
}

// The last date each theater has showtimes listed for. A film whose run ends
// at the edge of what the theater has posted isn't really on its last day.
export function theaterHorizons(movies = getMovies()) {
  const out = new Map();
  for (const m of movies) {
    for (const iso of m.showtimes || []) {
      const date = localISO(new Date(iso));
      if (!out.has(m.theater) || date > out.get(m.theater)) out.set(m.theater, date);
    }
  }
  return out;
}

// Films showing from `from` to `to`, keyed by local date: one entry per film
// per day, with that day's showtimes, in the same shape as a show. Each
// carries its run (first and last date, how many showings) for the film score.
export function filmsByDay(from, to, now = Date.now(), movies = getMovies()) {
  const { nowPlaying, special, comingSoon } = groupMovies(movies, now, { windowDays: DAYS_AHEAD });
  // First date of the run from every stored showtime, including today's that
  // are over. The store only ever holds what was still ahead at the last
  // fetch, so this isn't proof of an opening on its own (see filmScore).
  const listed = new Map(movies.map((m) => [m.id, m.showtimes || []]));
  const out = new Map();
  const add = (m, isSpecial) => {
    const all = listed.get(m.id) || m.showtimes;
    const firstDate = all.length ? localISO(new Date(all.reduce((a, b) => (a < b ? a : b)))) : null;
    const lastDate = m.showtimes.length ? localISO(new Date(m.showtimes[m.showtimes.length - 1])) : null;
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
        category: 'film',
        movie_id: m.id,
        title: m.title,
        date,
        time: times[0],
        times,
        venue: m.theater,
        city: m.city,
        ticket_url: m.url,
        special: isSpecial,
        firstDate,
        lastDate,
        peak: Math.max(m.peak_showings || 0, m.showtimes.length),
        upcoming: m.showtimes.length,
        rating: m.rating,
        runtime: m.runtime,
        director: m.director,
        starring: m.starring,
        year: m.year,
        release_date: m.release_date || null,
        genre: m.genre,
        synopsis: m.synopsis,
        poster_url: m.poster_url,
        trailer_url: m.trailer_url,
        mc_score: m.mc_score,
        rt_score: m.rt_score,
        _score: 0,
        _reasons: [],
      });
    }
  };
  nowPlaying.forEach((m) => add(m, false));
  comingSoon.forEach((m) => add(m, false));
  special.forEach((m) => add(m, true));
  for (const list of out.values()) list.sort(byTime);
  return out;
}

// The Film list in Explore: the cinema groups (special, now playing, coming
// soon, plus what's filtered or hidden), with each listed film dressed as of
// its next showing — the flags, feel line and _pick that date's page gives
// it — and each group best first (ties keep the soonest-first order).
export function movieGroups({ today = todayISO(), now = Date.now(), movies = getMovies() } = {}) {
  const groups = groupMovies(movies, now, { windowDays: DAYS_AHEAD });
  const listed = [...groups.special, ...groups.nowPlaying, ...groups.comingSoon];
  if (!listed.length) return groups;
  const nextDate = (m) => localISO(new Date(m.showtimes[0]));
  const dates = listed.map(nextDate).sort();
  const byDay = filmsByDay(dates[0], dates[dates.length - 1], now, movies);
  const dressed = new Map();
  for (const m of listed) {
    const item = (byDay.get(nextDate(m)) || []).find((f) => f.movie_id === m.id);
    if (item) dressed.set(m.id, item);
  }
  annotate([...dressed.values()], { now, today, horizonByTheater: theaterHorizons(movies) });
  for (const m of listed) {
    const f = dressed.get(m.id);
    if (f) Object.assign(m, { _kind: f._kind, _flags: f._flags, _feel: f._feel, _reasons: f._reasons, _film: f._film, _pick: f._pick });
  }
  for (const key of ['special', 'nowPlaying', 'comingSoon']) groups[key].sort((a, b) => (b._pick ?? 0) - (a._pick ?? 0));
  return groups;
}

// Every show and film from `from` to `to`, dressed, keyed by date. Cancelled
// and postponed shows are left out.
function dressedDays(from, to, { today, now, movies }) {
  const films = filmsByDay(from, to, now, movies);
  const items = [...scoredShows(from, to, now), ...[...films.values()].flat()];
  annotate(items, { now, today, horizonByTheater: theaterHorizons(movies) });
  const byDate = new Map();
  for (const e of items) {
    if (cancelled(e)) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  return byDate;
}

// Films in the order the day page lists them: one-off screenings, then last
// chances, openings, the best reviewed, and the earliest show.
function filmOrder(a, b) {
  const rank = (f) => (f.kind !== 'film' ? 1 : f.special ? 0 : hasFlag(f, 'last-chance') ? 2 : hasFlag(f, 'opens') ? 3 : 4);
  return rank(a) - rank(b) || (b._film?.crit ?? -1) - (a._film?.crit ?? -1) || timeOf(a).localeCompare(timeOf(b));
}

// What to say about a film in one line on the Week screen.
function filmNote(f) {
  const flag = (f._flags || []).find((x) => ['one-night', 'last-chance', 'opens'].includes(x.key));
  if (flag) return flag.key === 'one-night' ? 'one night' : flag.label.toLowerCase();
  if (f.mc_score != null) return `MC ${f.mc_score}`;
  if (f.rt_score != null) return `RT ${f.rt_score}%`;
  return null;
}

function countsOf(items) {
  const counts = { total: items.length, music: 0, comedy: 0, film: 0, around: 0, regulars: 0 };
  for (const e of items) {
    if (e._regular) counts.regulars += 1;
    else counts[e._group] = (counts[e._group] || 0) + 1;
  }
  return counts;
}

// What a quiet day's regulars are, for its sentence: "trivia, karaoke", or a
// music night by name ("Cumbia Night") since "music" says nothing.
const regularKinds = (items) => [
  ...new Set(
    items
      .filter((e) => e._regular)
      .map((e) => (e._kind.family === 'music' || e._kind.key === 'event' ? e._headline : e._kind.label.toLowerCase()))
  ),
];

// One day's picks and the numbers around them, for the Week screen and the
// day page's strip.
function summarize(date, items, { today, now }) {
  const { picks, label } = chooseDayPicks(items, { k: DAY_PICKS, now, today, date });
  const counts = countsOf(items);
  return {
    date,
    total: items.length,
    counts,
    picks,
    picksLabel: label,
    hasPick: picks.some((p) => (p._pick ?? 0) >= PICK_MIN),
    dek: dayDek(picks, { counts, regularKinds: regularKinds(items), label }),
  };
}

function curatedInfo(now) {
  const c = loadCurated(now);
  return c ? { criteria: c.criteria, generated_at: c.generated_at } : null;
}

// The Week screen: the next seven days starting today (not Monday–Sunday,
// which on a Saturday is mostly over), the week's top picks, each day's
// picks and films, and shows by your artists further out.
export function weekBrief({ today = todayISO(), now = Date.now(), movies = getMovies() } = {}) {
  const to = addDays(today, WEEK_DAYS - 1);
  const byDate = dressedDays(today, to, { today, now, movies });
  const picks = chooseWeekPicks([...byDate.values()].flat(), { max: MAX_PICKS, pickMin: PICK_MIN, now, today });

  const days = [];
  for (let i = 0; i < WEEK_DAYS; i += 1) {
    const date = addDays(today, i);
    const items = byDate.get(date) || [];
    const day = summarize(date, items, { today, now });
    // The films line is for the films not already shown as picks: `count`
    // is how many of those there are, so "+N" never counts a pick again.
    const shown = new Set(day.picks.map((p) => p.id));
    const films = items.filter((e) => e._group === 'film' && !shown.has(e.id)).sort(filmOrder);
    day.films = {
      count: films.length,
      top: films.slice(0, 2).map((f) => ({ id: f.id, title: f.title, note: filmNote(f) })),
    };
    day.regulars = day.counts.regulars;
    day.more = day.total - day.picks.length;
    days.push(day);
  }

  const further = annotate(
    scoredShows(addDays(to, 1), addDays(today, 365), now)
      .filter((e) => hasArtistMatch(e) && !cancelled(e))
      .slice(0, FURTHER_LIMIT),
    { now, today }
  );
  return { today, from: today, to, note: weekNote(days), curated: curatedInfo(now), picks, days, further };
}

// The last date anything is listed for, so the day page knows where "next" ends.
function lastListedDate(movies) {
  const shows = db.prepare('SELECT MAX(date) AS d FROM events WHERE hidden = 0').get().d || null;
  const films = [...theaterHorizons(movies).values()].sort().pop() || null;
  return [shows, films].filter(Boolean).sort().pop() || null;
}

// A day's own page: its picks, your other plans, then everything else in
// groups (Music, Comedy, At the movies, Around town), the weekly regulars
// folded away, and a strip of the days around it.
export function dayPage(date, { today = todayISO(), now = Date.now(), movies = getMovies() } = {}) {
  const inWeek = date >= today && date <= addDays(today, WEEK_DAYS - 1);
  let stripFrom = inWeek ? today : addDays(date, -3);
  if (stripFrom < today) stripFrom = today;
  const stripTo = addDays(stripFrom, WEEK_DAYS - 1);
  const prevDate = date > today ? addDays(date, -1) : null;
  const nextDate = addDays(date, 1);
  const from = prevDate && prevDate < stripFrom ? prevDate : stripFrom;
  const to = nextDate > stripTo ? nextDate : stripTo;
  const byDate = dressedDays(from, to, { today, now, movies });

  const summaries = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) summaries.set(d, summarize(d, byDate.get(d) || [], { today, now }));
  const day = summaries.get(date);
  const items = byDate.get(date) || [];
  const taken = new Set(day.picks.map((p) => p.id));

  const plans = items.filter((e) => !taken.has(e.id) && (e.going || e.interested)).sort(byTime);
  plans.forEach((e) => taken.add(e.id));

  // Today, a show that started an hour ago is mostly over. Its latest start
  // counts, as for the picks: a merged early/late pair stays while the late
  // show is still ahead.
  const started = date === today
    ? items.filter((e) => !taken.has(e.id) && e.kind !== 'film' && startedLongAgo(e, now))
    : [];
  started.forEach((e) => taken.add(e.id));

  const regulars = items.filter((e) => !taken.has(e.id) && e._regular).sort(byTime);
  regulars.forEach((e) => taken.add(e.id));

  const groups = GROUPS.map(([key, label]) => {
    const list = items.filter((e) => !taken.has(e.id) && e._group === key);
    const ordered = key === 'film' ? [...list].sort(filmOrder) : [...list].sort(byTime);
    const best = key === 'film' ? ordered : [...list].sort(byPick);
    return { key, label, total: list.length, shown: GROUP_SHOWN, showIds: best.slice(0, GROUP_SHOWN).map((e) => e.id), items: ordered };
  }).filter((g) => g.total);

  const last = lastListedDate(movies);
  const strip = [];
  for (let d = stripFrom; d <= stripTo; d = addDays(d, 1)) {
    const s = summaries.get(d);
    strip.push({ date: d, total: s.total, picks: s.picks.length, hasPick: s.hasPick });
  }
  return {
    date,
    today,
    dek: day.dek,
    counts: day.counts,
    strip,
    prev: prevDate ? { date: prevDate, picks: summaries.get(prevDate).picks.length } : null,
    next: last && nextDate <= last ? { date: nextDate, picks: summaries.get(nextDate).picks.length } : null,
    picks: day.picks,
    picksLabel: day.picksLabel,
    plans,
    groups,
    regulars,
    started: started.sort(byTime),
    curated: curatedInfo(now),
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

// What the show sheet says about each act on the bill before you open them:
// a descriptor, their genres, who they sound like, and a song to preview.
function lineupFeel(names, event, ctx) {
  const acts = names.map((name) => ({ title: name, _lineup: [name], category: event.category, kind: event.kind }));
  const facts = loadFacts(acts, ctx);
  const family = event._kind?.family || 'music';
  return names.map((name, i) => {
    const bill = names.filter((n) => n !== name);
    return {
      descriptor: descriptorOf(name, facts, { family }),
      tags: displayTags(acts[i], facts).tags.map((t) => t.tag),
      fans: fansOf(acts[i], facts, { limit: 3, exclude: bill }),
      preview: previewOf(name, facts, { family }),
    };
  });
}

// The show sheet: the show itself, who's on the bill, what else is on that
// night, and what's next at the same venue.
export function eventDetails(id, { today = todayISO(), now = Date.now() } = {}) {
  const row = getEventById(id);
  if (!row) return null;
  const ctx = buildContext(now);
  const [event] = annotate(scoreEvents([row], now).map((e) => ({ ...e, kind: e.category })), { now, today, ctx });
  const sameNight = annotate(
    scoredShows(row.date, row.date, now).filter(
      (e) => e.id !== row.id && !(row.headliner_key && e.headliner_key === row.headliner_key) && !cancelled(e)
    ),
    { now, today, ctx }
  )
    .sort(byPick)
    .slice(0, 4);
  const names = event._lineup || [];
  const feel = lineupFeel(names, event, ctx);
  return {
    event,
    lineup: names.map((name, i) => ({ ...artistSummary(name, ctx), ...feel[i] })),
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
  const upcoming = annotate(onePerShow(scoreEvents(rows, now)).map((e) => ({ ...e, kind: e.category })).slice(0, 20), { now, today, ctx });
  return {
    ...artistSummary(name, ctx),
    upcoming,
    profile: profileView(getArtistProfile(artistKey(name)), ctx),
  };
}

// The venue sheet: its next shows and how far it is from home.
export function venueView(name, { today = todayISO(), now = Date.now() } = {}) {
  const rows = queryEvents({ dateFrom: today, dateTo: addDays(today, 60) }, { sort: 'date' }).filter(
    (r) => r.venue === name
  );
  const upcoming = annotate(scoreEvents(rows, now).map((e) => ({ ...e, kind: e.category })).slice(0, 20), { now, today });
  const city = rows[0]?.city || null;
  return { name, city, home: distanceFromHome(city), upcoming };
}

// Saved: shows you're going to, and shows you've marked Maybe.
export function savedLists({ today = todayISO(), now = Date.now() } = {}) {
  const starred = annotate(
    scoreEvents(queryEvents({ dateFrom: today, onlyInterested: true }, { sort: 'date' }), now).map((e) => ({ ...e, kind: e.category })),
    { now, today }
  );
  return { going: starred.filter((e) => e.going), maybe: starred.filter((e) => !e.going) };
}
