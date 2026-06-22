// Settings API: API keys, manual genre weights, feed/scraper management,
// clear-hidden, and the .ics export of interested events.
import express from 'express';
import {
  getManualGenres,
  setManualGenre,
  deleteManualGenre,
  clearHidden,
  queryEvents,
  getPreferences,
} from '../db/queries.js';
import { readFeeds, writeFeeds, readScrapers, writeScrapers } from '../configFiles.js';
import { updateEnv } from '../envFile.js';
import { getApiKeys, HEADLESS, REFRESH_CRON } from '../config.js';
import { buildIcs } from '../ics.js';

const router = express.Router();

// ── Overview ──────────────────────────────────────────────────────────────
// Never return raw key values — only whether each is configured.
router.get('/settings', (req, res) => {
  const keys = getApiKeys();
  res.json({
    apiKeys: {
      ticketmaster: Boolean(keys.ticketmaster),
      bandsintown: Boolean(keys.bandsintown),
      eventbrite: Boolean(keys.eventbrite),
    },
    headless: HEADLESS,
    cron: REFRESH_CRON,
    genres: getManualGenres(),
    preferences: getPreferences(),
    feeds: readFeeds(),
    scrapers: readScrapers(),
  });
});

// ── API keys (written to .env) ─────────────────────────────────────────────
router.post('/settings/keys', (req, res) => {
  const { ticketmaster, bandsintown, eventbrite } = req.body || {};
  const updates = {};
  if (ticketmaster !== undefined) updates.TICKETMASTER_API_KEY = ticketmaster;
  if (bandsintown !== undefined) updates.BANDSINTOWN_APP_ID = bandsintown;
  if (eventbrite !== undefined) updates.EVENTBRITE_API_KEY = eventbrite;
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No keys provided' });
  }
  updateEnv(updates);
  res.json({ ok: true });
});

// ── Manual genre weights ───────────────────────────────────────────────────
router.get('/settings/genres', (req, res) => {
  res.json({ genres: getManualGenres() });
});

router.post('/settings/genres', (req, res) => {
  const { genre, weight } = req.body || {};
  if (!genre) return res.status(400).json({ error: 'genre is required' });
  setManualGenre(genre, weight);
  res.json({ genres: getManualGenres() });
});

router.delete('/settings/genres/:genre', (req, res) => {
  deleteManualGenre(req.params.genre);
  res.json({ genres: getManualGenres() });
});

// ── Feed management (feeds.json) ───────────────────────────────────────────
router.get('/settings/feeds', (req, res) => res.json({ feeds: readFeeds() }));

router.post('/settings/feeds', (req, res) => {
  const feed = req.body || {};
  if (!feed.url || !feed.name) {
    return res.status(400).json({ error: 'name and url are required' });
  }
  const feeds = readFeeds();
  feed.id = feed.id || feed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (feeds.some((f) => f.id === feed.id)) {
    return res.status(409).json({ error: 'A feed with this id already exists' });
  }
  feeds.push({ enabled: true, type: 'rss', category: 'music', ...feed });
  writeFeeds(feeds);
  res.status(201).json({ feeds });
});

router.put('/settings/feeds/:id', (req, res) => {
  const feeds = readFeeds();
  const idx = feeds.findIndex((f) => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'feed not found' });
  feeds[idx] = { ...feeds[idx], ...req.body, id: feeds[idx].id };
  writeFeeds(feeds);
  res.json({ feeds });
});

router.delete('/settings/feeds/:id', (req, res) => {
  const feeds = readFeeds().filter((f) => f.id !== req.params.id);
  writeFeeds(feeds);
  res.json({ feeds });
});

// ── Scraper management (scrapers.json) ─────────────────────────────────────
router.get('/settings/scrapers', (req, res) => res.json({ scrapers: readScrapers() }));

router.post('/settings/scrapers', (req, res) => {
  const scraper = req.body || {};
  if (!scraper.url || !scraper.name) {
    return res.status(400).json({ error: 'name and url are required' });
  }
  const scrapers = readScrapers();
  scraper.id = scraper.id || scraper.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (scrapers.some((s) => s.id === scraper.id)) {
    return res.status(409).json({ error: 'A scraper with this id already exists' });
  }
  scrapers.push({
    enabled: true,
    category: 'music',
    selectors: { item: '', name: '', date: '', ticketLink: '', image: '', price: '' },
    ...scraper,
  });
  writeScrapers(scrapers);
  res.status(201).json({ scrapers });
});

router.put('/settings/scrapers/:id', (req, res) => {
  const scrapers = readScrapers();
  const idx = scrapers.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'scraper not found' });
  scrapers[idx] = { ...scrapers[idx], ...req.body, id: scrapers[idx].id };
  writeScrapers(scrapers);
  res.json({ scrapers });
});

router.delete('/settings/scrapers/:id', (req, res) => {
  const scrapers = readScrapers().filter((s) => s.id !== req.params.id);
  writeScrapers(scrapers);
  res.json({ scrapers });
});

// ── Maintenance ────────────────────────────────────────────────────────────
router.post('/settings/clear-hidden', (req, res) => {
  const cleared = clearHidden();
  res.json({ cleared });
});

// ── Export interested events as .ics ───────────────────────────────────────
router.get('/export/ics', (req, res) => {
  const events = queryEvents({ onlyInterested: true, showHidden: true }, { sort: 'date' });
  const ics = buildIcs(events);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="eventlight-interested.ics"');
  res.send(ics);
});

export default router;
