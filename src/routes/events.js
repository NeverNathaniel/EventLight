// Event listing, the five dashboard views, manual entry, and user actions.
import express from 'express';
import {
  queryEvents,
  countEvents,
  getEventById,
  upsertEvent,
  setInterested,
  setHidden,
  recordSignals,
  getDistinctCities,
  getDistinctSources,
  getAllTags,
} from '../db/queries.js';
import { scoreEvents, scoreAndRank } from '../scoring/engine.js';

const router = express.Router();

// ── Date helpers (server-local time; self-hosted in the target timezone) ──
function localISO(d) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}
function todayISO() {
  return localISO(new Date());
}
function weekBounds(ref = new Date()) {
  const d = new Date(ref);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: localISO(monday), to: localISO(sunday) };
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localISO(d);
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
router.get('/events', (req, res) => {
  const filters = parseFilters(req.query);
  const sort = ['date', 'venue', 'relevance'].includes(req.query.sort)
    ? req.query.sort
    : 'date';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const total = countEvents(filters);

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

  res.json({ events, total, page, pageSize, pages: Math.ceil(total / pageSize) });
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

// ── View: Top Picks (highest scored, next 30 days) ───────────────────────
router.get('/views/top-picks', (req, res) => {
  const today = todayISO();
  const filters = { ...parseFilters(req.query), dateFrom: today, dateTo: addDays(today, 30) };
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
  const events = scoreAndRank(queryEvents(filters)).slice(0, limit);
  res.json({ from: today, to: addDays(today, 30), events });
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

// ── Actions: Interested / Hide ───────────────────────────────────────────
router.post('/events/:id/interested', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const value = req.body?.value !== false; // default true
  const event = setInterested(id, value);
  if (!event) return res.status(404).json({ error: 'not found' });

  // Behavioral signal: when marking interested, record genre tags + artist.
  if (value) {
    const tags = String(event.genre_tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (event.artist) tags.push(event.artist);
    if (tags.length) recordSignals(tags);
  }
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
