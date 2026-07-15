// Source auto-discovery API. Paste a venue URL → probe for RSS/iCal/JSON-LD,
// fall back to a scraper template, then save the chosen source.
import express from 'express';
import { discoverSource } from '../discovery.js';
import { readFeeds, writeFeeds, readScrapers, writeScrapers } from '../configFiles.js';

const router = express.Router();

function normalizeUrl(input) {
  let url = String(input || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

// Probe a URL and report what was found.
router.post('/discover', async (req, res) => {
  const url = normalizeUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: 'A valid URL is required' });
  try {
    const result = await discoverSource(url);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save a discovered source to feeds.json or scrapers.json.
// Body: { target: 'feeds'|'scrapers', config: {...} }
router.post('/discover/add', (req, res) => {
  const { target, config } = req.body || {};
  if (!config || !config.url || !config.name) {
    return res.status(400).json({ error: 'config with name and url is required' });
  }
  config.id = config.id || config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  if (target === 'scrapers') {
    const scrapers = readScrapers();
    if (scrapers.some((s) => s.id === config.id)) {
      return res.status(409).json({ error: 'A scraper with this id already exists' });
    }
    scrapers.push({ enabled: true, category: 'music', ...config });
    writeScrapers(scrapers);
    return res.status(201).json({ target, id: config.id });
  }

  const feeds = readFeeds();
  if (feeds.some((f) => f.id === config.id)) {
    return res.status(409).json({ error: 'A feed with this id already exists' });
  }
  feeds.push({ enabled: true, type: 'rss', category: 'music', ...config });
  writeFeeds(feeds);
  res.status(201).json({ target, id: config.id });
});

export default router;
