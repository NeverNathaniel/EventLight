// Source auto-discovery: given a venue website URL, probe for the cleanest
// ingestion method in order of preference:
//
//   1. RSS / Atom feed   (autodiscovery <link> tags, then common paths)
//   2. iCal feed         (.ics links / webcal)
//   3. JSON-LD           (schema.org Event structured data embedded in the page)
//   4. Scrape            (fallback — return a ready-to-edit scraper template)
//
// Steps 1–3 are lightweight (axios + parsing, no browser); only the fallback
// needs Playwright at ingestion time.
import axios from 'axios';
import Parser from 'rss-parser';
import ical from 'node-ical';
import { classify, toISODate, toTime, clean, absoluteUrl } from './adapters/util.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const parser = new Parser({ timeout: 12000, headers: { 'User-Agent': UA } });

// Common feed locations to try when a page has no autodiscovery links.
const RSS_PATHS = ['/feed', '/feed/', '/rss', '/rss/', '/events/feed/', '/?feed=rss2', '/feed/rss'];
const ICAL_PATHS = ['/events.ics', '/calendar.ics', '/events/feed/ical', '/?ical=1'];

// Third-party ticketing/listing providers worth flagging to the user.
const PROVIDERS = [
  ['eventbrite', 'eventbrite.com'],
  ['bandsintown', 'bandsintown.com'],
  ['songkick', 'songkick.com'],
  ['ticketmaster', 'ticketmaster.com'],
  ['dice', 'dice.fm'],
  ['seetickets', 'seetickets.'],
  ['ticketweb', 'ticketweb.'],
  ['prekindle', 'prekindle.com'],
  ['axs', 'axs.com'],
];

async function fetchHtml(url) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const finalUrl = res.request?.res?.responseUrl || url;
  const html = typeof res.data === 'string' ? res.data : '';
  return { html, finalUrl };
}

// Extract feed URLs from <link rel="alternate"> autodiscovery tags and anchors.
function findFeedLinks(html, baseUrl) {
  const rss = new Set();
  const icalLinks = new Set();

  // <link ... type="application/rss+xml|atom+xml" ... href="...">
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const type = (tag.match(/type=["']([^"']+)["']/i) || [])[1] || '';
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    if (/application\/(rss|atom)\+xml/i.test(type)) rss.add(absoluteUrl(href, baseUrl));
    if (/text\/calendar/i.test(type) || /\.ics(\?|$)/i.test(href)) icalLinks.add(absoluteUrl(href, baseUrl));
  }

  // Anchor hrefs that look like feeds.
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const href of hrefs) {
    if (/\.ics(\?|$)/i.test(href) || /^webcal:/i.test(href)) icalLinks.add(absoluteUrl(href.replace(/^webcal:/i, 'https:'), baseUrl));
    if (/\/(feed|rss)(\/|$|\?)/i.test(href) && !/comment/i.test(href)) rss.add(absoluteUrl(href, baseUrl));
  }

  return { rss: [...rss], ical: [...icalLinks] };
}

// Validate an RSS/Atom URL by actually parsing it; return item count or null.
async function tryRss(url) {
  try {
    const feed = await parser.parseURL(url);
    const count = (feed.items || []).length;
    return count > 0 ? { url, count } : null;
  } catch {
    return null;
  }
}

async function tryIcal(url) {
  try {
    const data = await ical.async.fromURL(url);
    const count = Object.values(data).filter((v) => v.type === 'VEVENT').length;
    return count > 0 ? { url, count } : null;
  } catch {
    return null;
  }
}

// ── JSON-LD (schema.org Event) ────────────────────────────────────────────
// Events are not always top-level or under @graph — venues commonly publish a
// Place/Organization node with the events nested in an arbitrary property
// (e.g. Place.Events[...]), so walk every object value (depth-capped).
function collectEventNodes(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectEventNodes(n, out, depth + 1));
    return;
  }
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === 'string' && /Event/i.test(t))) out.push(node);
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectEventNodes(v, out, depth + 1);
  }
}

function mapJsonLdEvent(node, baseUrl) {
  const start = node.startDate || node.startTime;
  const date = toISODate(start);
  if (!date) return null;

  let venue = null;
  let city = null;
  const loc = node.location;
  if (loc) {
    const l = Array.isArray(loc) ? loc[0] : loc;
    venue = clean(l?.name) || null;
    const addr = l?.address;
    if (addr) city = clean(typeof addr === 'string' ? addr : addr.addressLocality) || null;
  }

  let price = null;
  const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
  if (offers?.price) price = `$${offers.price}`;

  const image = Array.isArray(node.image) ? node.image[0] : node.image;
  const ticketUrl = offers?.url || node.url || null;
  const title = clean(node.name);
  if (!title) return null;

  // The schema type itself is a strong category signal (ComedyEvent, MusicEvent).
  const typeText = (Array.isArray(node['@type']) ? node['@type'] : [node['@type']])
    .filter(Boolean)
    .join(' ');

  return {
    title,
    artist: clean(node.performer?.name) || null,
    venue,
    city,
    date,
    time: toTime(start),
    doors_time: toTime(node.doorTime),
    // No fallback here: an unclassified event stays null so the consumer
    // (e.g. a feed's configured category) can supply the default.
    category: classify(`${typeText} ${title} ${node.description || ''}`, '') || null,
    genre_tags: [],
    ticket_url: ticketUrl ? absoluteUrl(ticketUrl, baseUrl) : null,
    image_url: image ? absoluteUrl(typeof image === 'string' ? image : image.url, baseUrl) : null,
    price_range: price,
  };
}

function extractJsonLd(html, baseUrl) {
  const scripts = [
    ...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  ];
  const nodes = [];
  for (const m of scripts) {
    try {
      collectEventNodes(JSON.parse(m[1].trim()), nodes);
    } catch {
      /* malformed JSON-LD block — skip */
    }
  }
  return nodes.map((n) => mapJsonLdEvent(n, baseUrl)).filter(Boolean);
}

// Fetch a page and return its JSON-LD events (used by the rss adapter for the
// 'jsonld' feed type, and by discovery for previews).
export async function fetchJsonLdEvents(url) {
  const { html, finalUrl } = await fetchHtml(url);
  return extractJsonLd(html, finalUrl);
}

// Guess a friendly venue name from the page <title> / og:site_name / hostname.
function guessName(html, url) {
  const og = (html.match(/property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i) || [])[1];
  if (og) return clean(og);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  if (title) return clean(title).split(/[|\-–—:]/)[0].trim();
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function detectProviders(html) {
  const found = [];
  for (const [name, needle] of PROVIDERS) {
    if (html.toLowerCase().includes(needle)) found.push(name);
  }
  return found;
}

// Main entry: probe a URL and return what was found + a recommended source config.
export async function discoverSource(url) {
  let html = '';
  let finalUrl = url;
  try {
    ({ html, finalUrl } = await fetchHtml(url));
  } catch (err) {
    return { url, error: `Could not fetch the page: ${err.message}` };
  }

  const name = guessName(html, finalUrl);
  const id = slugify(name) || slugify(new URL(finalUrl).hostname);
  const links = findFeedLinks(html, finalUrl);
  const providers = detectProviders(html);
  const result = { url, finalUrl, name, providers, rss: null, ical: null, jsonld: null, recommended: null };

  // 1. RSS — autodiscovery links first, then common paths.
  for (const candidate of [...links.rss, ...RSS_PATHS.map((p) => absoluteUrl(p, finalUrl))]) {
    const hit = await tryRss(candidate);
    if (hit) { result.rss = hit; break; }
  }

  // 2. iCal.
  for (const candidate of [...links.ical, ...ICAL_PATHS.map((p) => absoluteUrl(p, finalUrl))]) {
    const hit = await tryIcal(candidate);
    if (hit) { result.ical = hit; break; }
  }

  // 3. JSON-LD structured data already on the page.
  const jsonldEvents = extractJsonLd(html, finalUrl);
  if (jsonldEvents.length) {
    result.jsonld = { count: jsonldEvents.length, sample: jsonldEvents.slice(0, 5) };
  }

  // Recommend the best available method.
  const base = { id, name, venue: name, city: '', category: 'music', enabled: true };
  if (result.rss) {
    result.recommended = {
      method: 'rss',
      target: 'feeds',
      config: { ...base, url: result.rss.url, type: 'rss' },
      sampleCount: result.rss.count,
    };
  } else if (result.ical) {
    result.recommended = {
      method: 'ical',
      target: 'feeds',
      config: { ...base, url: result.ical.url, type: 'ical' },
      sampleCount: result.ical.count,
    };
  } else if (result.jsonld) {
    result.recommended = {
      method: 'jsonld',
      target: 'feeds',
      config: { ...base, url: finalUrl, type: 'jsonld' },
      sampleCount: result.jsonld.count,
      sample: result.jsonld.sample,
    };
  } else {
    // Scrape fallback — a template the user tunes in Settings.
    result.recommended = {
      method: 'scrape',
      target: 'scrapers',
      config: {
        ...base,
        url: finalUrl,
        waitFor: '.event, article, .eventlist-event',
        selectors: {
          item: '.event, article, .eventlist-event',
          name: '.event-title, .eventlist-title, h2, h3',
          date: 'time, .event-date, .eventlist-meta-date',
          ticketLink: "a[href*='ticket'], a",
          image: 'img',
          price: '.price',
        },
      },
      note: 'No feed or structured data found — added as a scraper template. Tune the selectors and run it from Settings.',
    };
  }

  return result;
}
