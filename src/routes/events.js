// Event listing, the dashboard views, manual entry, and user actions.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import {
  queryEvents,
  countEvents,
  getEventById,
  upsertEvent,
  setInterested,
  setPlan,
  PLANS,
  setHidden,
  recordSignals,
  getDistinctCities,
  getDistinctSources,
  getAllTags,
} from '../db/queries.js';
import { scoreEvents, scoreAndRank } from '../scoring/engine.js';
import { localISO, todayISO, addDays } from '../dates.js';
import { topPicks } from '../picks.js';
import { annotate, groupsOf } from '../annotate.js';
import { filmsByDay, theaterHorizons } from '../week.js';
import { getMovies } from '../db/movies.js';
import { DAYS_AHEAD } from '../cinema/index.js';

const router = express.Router();

// ── Date helpers (server-local time; self-hosted in the target timezone) ──
function weekBounds(ref = new Date()) {
  const d = new Date(ref);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: localISO(monday), to: localISO(sunday) };
}
// Parse the persistent filter set from query params (shared by all views).
function parseFilters(q) {
  return {
    category: q.category || 'all',
    city: q.city || 'all',
    sources: q.sources ? String(q.sources).split(',').filter(Boolean) : [],
    genres: q.genres ? String(q.genres).split(',').filter(Boolean) : [],
    dateFrom: q.dateFrom || null,
    dateTo: q.dateTo || null,
    showHidden: q.showHidden === 'true' || q.showHidden === '1',
    onlyInterested: q.onlyInterested === 'true' || q.onlyInterested === '1',
    search: q.search || null,
  };
}

// ── Filter facets for the UI controls ────────────────────────────────────
router.get('/filters', (req, res) => {
  res.json({
    cities: getDistinctCities(),
    sources: getDistinctSources(),
    tags: getAllTags(),
  });
});

// ── Browse All (paginated, filterable, sortable) ─────────────────────────
// Films aren't events, so they come alongside: with `withFilms=1` (Explore's
// "Everything" list by date, or a search) the response also carries the
// films showing from `filmsFrom` (default: the requested start date) through
// the last date on this page — or through the end of the cinema listings on
// the last page — keyed by date, plus `filmsTo`. The client asks for the
// next page's films from the day after `filmsTo`, so each date gets its films
// exactly once. With a search, only films whose title, director or cast
// match it come along.
// A YYYY-MM-DD that is a real calendar day, else null. The films' date
// window is built with addDays, which throws on "2026-13-45" and rolls
// "2026-11-31" over — a hand-edited or stale link would be a 500.
function realDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  try {
    return addDays(value, 0) === value ? value : null;
  } catch {
    return null;
  }
}

function filmMatches(film, search) {
  if (!search) return true;
  const q = String(search).toLowerCase();
  return [film.title, film.director, film.starring].some((v) => String(v || '').toLowerCase().includes(q));
}

function filmsFor(filters, events, { from, last }) {
  const to = last ? addDays(todayISO(), DAYS_AHEAD) : events[events.length - 1]?.date;
  if (!to || to < from) return { films: {}, filmsTo: to && to > from ? to : addDays(from, -1) };
  const movies = getMovies();
  const films = {};
  const all = [];
  for (const [date, list] of filmsByDay(from, to, Date.now(), movies)) {
    const shown = list.filter((f) => (filters.city === 'all' || f.city === filters.city) && filmMatches(f, filters.search));
    if (shown.length) {
      films[date] = shown;
      all.push(...shown);
    }
  }
  annotate(all, { horizonByTheater: theaterHorizons(movies) });
  return { films, filmsTo: to };
}

// Explore's chips filter by the day page's groups, so a talk at a music
// venue is under Around town on both screens. `category` (the source's own
// music | comedy | other) still works for older clients.
const GROUPS = ['music', 'comedy', 'film', 'around'];

router.get('/events', (req, res) => {
  const filters = parseFilters(req.query);
  const sort = ['date', 'venue', 'relevance'].includes(req.query.sort)
    ? req.query.sort
    : 'date';
  const group = GROUPS.includes(req.query.group) ? req.query.group : null;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const slice = (list) => list.slice((page - 1) * pageSize, page * pageSize);

  let events;
  let total;
  if (group) {
    // A listing's group is worked out from its title and lineup, not
    // stored, so the whole filtered set is grouped (one batched lookup of
    // known artists) and paged here, as the relevance sort does.
    const rows = queryEvents(filters, { sort: sort === 'relevance' ? 'date' : sort });
    const groups = groupsOf(rows);
    const inGroup = rows.filter((_, i) => groups[i] === group);
    total = inGroup.length;
    events = sort === 'relevance' ? slice(scoreAndRank(inGroup)) : scoreEvents(slice(inGroup));
  } else if (sort === 'relevance') {
    // Scores are computed at query time, so rank the full filtered set, then page.
    total = countEvents(filters);
    events = slice(scoreAndRank(queryEvents(filters)));
  } else {
    total = countEvents(filters);
    events = scoreEvents(
      queryEvents(filters, { sort, limit: pageSize, offset: (page - 1) * pageSize })
    );
  }
  const pages = Math.ceil(total / pageSize);
  events = annotate(events.map((e) => ({ ...e, kind: e.category })));

  const body = { events, total, page, pageSize, pages };
  // Films come with the date-ordered list, unfiltered or searched; a chip
  // (category or group) or Best match brings none.
  if (req.query.withFilms === '1' && sort === 'date' && filters.category === 'all' && !group) {
    const from = realDay(req.query.filmsFrom) || realDay(filters.dateFrom) || todayISO();
    Object.assign(body, filmsFor(filters, events, { from, last: page >= pages }));
  }
  res.json(body);
});

// ── View: Tonight (today, sorted by time) ────────────────────────────────
router.get('/views/tonight', (req, res) => {
  const filters = { ...parseFilters(req.query), dateFrom: todayISO(), dateTo: todayISO() };
  const events = scoreEvents(queryEvents(filters, { sort: 'date' }));
  res.json({ date: todayISO(), events });
});

// ── View: This Week (Mon–Sun, grouped by day) ────────────────────────────
router.get('/views/week', (req, res) => {
  const { from, to } = weekBounds();
  const filters = { ...parseFilters(req.query), dateFrom: from, dateTo: to };
  const events = scoreEvents(queryEvents(filters, { sort: 'date' }));

  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(from, i);
    days.push({
      date,
      label: new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      }),
      events: events.filter((e) => e.date === date),
    });
  }
  res.json({ from, to, days });
});

// ── View: Top Picks (highest scored, next 30 days, plus Your Artists) ────
router.get('/views/top-picks', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
  res.json(topPicks({ filters: parseFilters(req.query), limit }));
});

// ── View: Curated (produced by the /curate Claude Code routine) ──────────
// Reads data/curated.json: { criteria, generated_at, events: [{ id, reason }] }.
export function curatedView(file = path.join(DATA_DIR, 'curated.json')) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { criteria: null, generated_at: null, events: [] };
  }
  const list = Array.isArray(doc.events) ? doc.events : [];
  // Resolve ids in the curated order, skipping anything since hidden/deleted.
  const resolved = list
    .map((entry) => {
      const ev = getEventById(entry.id);
      if (!ev || ev.hidden) return null;
      return { ...ev, _reason: entry.reason || null };
    })
    .filter(Boolean);
  // Dressed like every other list (kind, headline, feel line), each keeping
  // the curator's reason.
  const events = annotate(
    scoreEvents(resolved).map((e, i) => ({ ...e, kind: e.category, _reason: resolved[i]._reason }))
  );
  return { criteria: doc.criteria || null, generated_at: doc.generated_at || null, events };
}

router.get('/views/curated', (req, res) => {
  res.json(curatedView());
});

// ── View: This Month (calendar dots + events) ────────────────────────────
router.get('/views/month', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
    ? req.query.month
    : todayISO().slice(0, 7);
  // ISO dates compare lexicographically, so `${month}-31` is a safe upper bound.
  const filters = { ...parseFilters(req.query), dateFrom: `${month}-01`, dateTo: `${month}-31` };
  const group = GROUPS.includes(req.query.group) ? req.query.group : null;
  let events = scoreEvents(queryEvents(filters, { sort: 'date' }));
  // Explore's calendar counts what its list would show under the same chip.
  if (group) {
    const groups = groupsOf(events);
    events = events.filter((_, i) => groups[i] === group);
  }

  const counts = {};
  for (const e of events) counts[e.date] = (counts[e.date] || 0) + 1;
  // Each film counts once on each day it shows, as on the Week strip — and,
  // with a search, only the films that match it, as in the list.
  if (filters.category === 'all' && !group) {
    for (const [date, films] of filmsByDay(`${month}-01`, `${month}-31`)) {
      const n = films.filter((f) => (filters.city === 'all' || f.city === filters.city) && filmMatches(f, filters.search)).length;
      if (n) counts[date] = (counts[date] || 0) + n;
    }
  }
  res.json({ month, counts, events });
});

// ── Manual entry ──────────────────────────────────────────────────────────
router.post('/events', (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.date || !b.venue) {
    return res.status(400).json({ error: 'title, venue and date are required' });
  }
  const result = upsertEvent({
    source: 'manual',
    source_name: 'manual',
    title: b.title,
    artist: b.artist || null,
    venue: b.venue,
    city: b.city || null,
    date: b.date,
    time: b.time || null,
    doors_time: b.doors_time || null,
    category: b.category || 'other',
    genre_tags: b.tags || b.genre_tags || '',
    ticket_url: b.url || b.ticket_url || null,
    image_url: b.image_url || null,
    price_range: b.price_range || null,
  });
  res.status(result === 'added' ? 201 : 200).json({ result });
});

// ── Actions: Interested / Going / Hide ───────────────────────────────────
// Behavioral signal: when a show is newly starred, record its genre tags + artist.
function learnFrom(event) {
  const tags = String(event.genre_tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (event.artist) tags.push(event.artist);
  if (tags.length) recordSignals(tags);
}

router.post('/events/:id/interested', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const value = req.body?.value !== false; // default true
  const event = setInterested(id, value);
  if (!event) return res.status(404).json({ error: 'not found' });
  if (value) learnFrom(event);
  res.json({ event });
});

// Your plan for a show: { plan: 'going' | 'maybe' | null }.
router.post('/events/:id/plan', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = req.body?.plan ?? null;
  if (!PLANS.includes(plan)) return res.status(400).json({ error: "plan must be 'going', 'maybe' or null" });
  const before = getEventById(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const event = setPlan(id, plan);
  if (plan && !before.interested) learnFrom(event);
  res.json({ event });
});

router.post('/events/:id/hidden', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const value = req.body?.value !== false; // default true
  const event = setHidden(id, value);
  if (!event) return res.status(404).json({ error: 'not found' });
  res.json({ event });
});

router.get('/events/:id', (req, res) => {
  const event = getEventById(parseInt(req.params.id, 10));
  if (!event) return res.status(404).json({ error: 'not found' });
  res.json({ event });
});

export default router;
