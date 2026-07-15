// RSS / iCal feed adapter. Iterates enabled entries in feeds.json.
// Each feed is run independently and reported as its own sub-run so failures
// are isolated and logged per-source.
import Parser from 'rss-parser';
import ical from 'node-ical';
import { readFeeds } from '../configFiles.js';
import { REQUEST_DELAY_MS, sleep } from '../config.js';
import { fetchJsonLdEvents } from '../discovery.js';
import { classify, toISODate, toTime, clean } from './util.js';

export const meta = { id: 'rss', source: 'rss', label: 'RSS / iCal / JSON-LD feeds' };

const parser = new Parser({ timeout: 20000 });

function mapRssItem(item, feed) {
  const text = `${item.title || ''} ${item.contentSnippet || ''}`;
  // Prefer a date parsed from the title/content; fall back to the publish date.
  const date = toISODate(item.title) || toISODate(item.isoDate) || toISODate(item.pubDate);
  return {
    source: 'rss',
    source_name: feed.id || feed.name,
    title: clean(item.title) || feed.name,
    artist: null,
    venue: feed.venue || feed.name,
    city: feed.city || null,
    date,
    time: toTime(item.title) || toTime(item.isoDate),
    doors_time: null,
    category: classify(text, feed.category || 'music'),
    genre_tags: feed.category ? [feed.category] : [],
    ticket_url: item.link || null,
    image_url: item.enclosure?.url || null,
    price_range: null,
  };
}

function mapIcalEvent(ev, feed) {
  return {
    source: 'rss',
    source_name: feed.id || feed.name,
    title: clean(ev.summary) || feed.name,
    artist: null,
    venue: feed.venue || ev.location || feed.name,
    city: feed.city || null,
    date: toISODate(ev.start),
    time: toTime(ev.start),
    doors_time: null,
    category: classify(`${ev.summary || ''} ${ev.description || ''}`, feed.category || 'music'),
    genre_tags: feed.category ? [feed.category] : [],
    ticket_url: ev.url || null,
    image_url: null,
    price_range: null,
  };
}

async function runFeed(feed) {
  const source_name = feed.id || feed.name;
  try {
    let events = [];
    if (feed.type === 'jsonld') {
      // Schema.org Event data embedded in a venue page (discovered via URL).
      const found = await fetchJsonLdEvents(feed.url);
      events = found
        .map((ev) => ({
          ...ev,
          source: 'rss',
          source_name,
          venue: ev.venue || feed.venue || feed.name,
          city: ev.city || feed.city || null,
          category: ev.category || feed.category || 'music',
          genre_tags: feed.category ? [feed.category] : ev.genre_tags || [],
        }))
        .filter((m) => m.date);
    } else if (feed.type === 'ical') {
      const data = await ical.async.fromURL(feed.url);
      events = Object.values(data)
        .filter((v) => v.type === 'VEVENT')
        .map((ev) => mapIcalEvent(ev, feed))
        .filter((m) => m.date);
    } else {
      const parsed = await parser.parseURL(feed.url);
      events = (parsed.items || [])
        .map((item) => mapRssItem(item, feed))
        .filter((m) => m.date);
    }
    return { source: 'rss', source_name, status: 'ok', events };
  } catch (err) {
    return {
      source: 'rss',
      source_name,
      status: 'error',
      error_msg: `${feed.url} — ${err.message}`,
      events: [],
    };
  }
}

export async function run() {
  const feeds = readFeeds().filter((f) => f.enabled !== false);
  const runs = [];
  for (const feed of feeds) {
    runs.push(await runFeed(feed));
    await sleep(REQUEST_DELAY_MS);
  }
  return { runs };
}
