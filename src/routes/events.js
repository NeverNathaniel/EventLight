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
import { annotate } from '../annotate.js';
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
// "Everything" list by date) the response also carries the films showing
// from `filmsFrom` (default: the requested start date) through the last date
// on this page — or through the end of the cinema listings on the last page —
// keyed by date, plus `filmsTo`. The client asks for the next page's films
// from the day after `filmsTo`, so each date gets its films exactly once.
function filmsFor(filters, events, { from, last }) {
  const to = last ? addDays(todayISO(), DAYS_AHEAD) : events[events.length - 1]?.date;
  if (!to || to < from) return { films: {}, filmsTo: to && to > from ? to : addDays(from, -1) };
  const movies = getMovies();
  const films = {};
  const all = [];
  for (const [date, list] of filmsByDay(from, to, Date.now(), movies)) {
    const shown = list.filter((f) => filters.city === 'all' || f.city === filters.city);
    if (shown.length) {
      films[date] = shown;
      all.push(...shown);
    }
  }
  annotate(all, { horizonByTheater: theaterHorizons(movies) });
  return { films, filmsTo: to };
}

router.get('/events', (req, res) => {
  const filters = parseFilters(req.query);
  const sort = ['date', 'venue', 'relevance'].includes(req.query.sort)
    ? req.query.sort
    : 'date';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const total = countEvents(filters);
  const pages = Math.ceil(total / pageSize);

  let events;
  if (sort === 'relevance') {
    // Scores are computed at query time, so rank the full filtered set, then page.
    const ranked = scoreAndRank(queryEvents(filters));
    events = ranked.slice((page - 1) * pageSize, page * pageSize);
  } else {
    events = scoreEvents(
      queryEvents(filters, { sort, limit: pageSize, offset: (page - 1) * pageSize })
    );
  }
  events = annotate(events.map((e) => ({ ...e, kind: e.category })));

  const body = { events, total, page, pageSize, pages };
  if (req.query.withFilms === '1' && sort === 'date' && filters.category === 'all' && !filters.search) {
    const asked = /^\d{4}-\d{2}-\d{2}$/.test(req.query.filmsFrom || '') ? req.query.filmsFrom : null;
    const from = asked || filters.dateFrom || todayISO();
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
router.get('/views/curated', (req, res) => {
  const file = path.join(DATA_DIR, 'curated.json');
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return res.json({ criteria: null, generated_at: null, events: [] });
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
  const events = scoreEvents(resolved).map((e, i) => ({ ...e, _reason: resolved[i]._reason }));
  res.json({ criteria: doc.criteria || null, generated_at: doc.generated_at || null, events });
});

// ── View: This Month (calendar dots + events) ────────────────────────────
router.get('/views/month', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
    ? req.query.month
    : todayISO().slice(0, 7);
  // ISO dates compare lexicographically, so `${month}-31` is a safe upper bound.
  const filters = { ...parseFilters(req.query), dateFrom: `${month}-01`, dateTo: `${month}-31` };
  const events = scoreEvents(queryEvents(filters, { sort: 'date' }));

  const counts = {};
  for (const e of events) counts[e.date] = (counts[e.date] || 0) + 1;
  // Each film counts once on each day it shows, as on the Week strip.
  if (filters.category === 'all' && !filters.search) {
    for (const [date, films] of filmsByDay(`${month}-01`, `${month}-31`)) {
      const n = films.filter((f) => filters.city === 'all' || f.city === filters.city).length;
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
