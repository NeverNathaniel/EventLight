// Events from the website builders small venues actually use — both expose
// their event listings as JSON, which beats scraping their HTML:
//
//   squarespace  A Squarespace events page plus `?format=json` returns the
//                collection with an `upcoming` array (title, start/end as
//                epoch ms, location, image, URL).
//                feeds.json: { "type": "squarespace", "url": <events page> }
//
//   tribe        WordPress sites running The Events Calendar plugin serve
//                /wp-json/tribe/events/v1/events (paged, with venue,
//                categories, cost). Optional "categories": ["Music"] keeps
//                only events in those categories.
//                feeds.json: { "type": "tribe", "url": <site> }
//
// Both are complete calendars, so missing shows are pruned like scrapes.
import axios from 'axios';
import { USER_AGENT } from '../config.js';
import { classify, htmlToText, zonedDateTime, absoluteUrl } from './util.js';

const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
const MAX_TRIBE_PAGES = 8;

function baseEvent(feed) {
  return {
    source: 'rss',
    source_name: feed.id || feed.name,
    artist: null,
    city: feed.city || null,
    doors_time: null,
    genre_tags: feed.category ? [feed.category] : [],
    price_range: null,
  };
}

// ── Squarespace ─────────────────────────────────────────────────────────
export function mapSquarespaceEvent(e, feed) {
  const title = htmlToText(e.title);
  const { date, time } = zonedDateTime(e.startDate, feed.tz);
  return {
    ...baseEvent(feed),
    title,
    venue: feed.venue || e.location?.addressTitle || feed.name,
    date,
    time,
    category: classify(title, feed.category || 'music'),
    ticket_url: absoluteUrl(e.fullUrl || e.sourceUrl, feed.url),
    image_url: absoluteUrl(e.assetUrl, feed.url),
  };
}

export async function fetchSquarespaceEvents(feed) {
  const url = new URL(feed.url);
  url.searchParams.set('format', 'json');
  const res = await axios.get(url.href, { headers: HEADERS, timeout: 20000 });
  const upcoming = res.data?.upcoming;
  if (!Array.isArray(upcoming)) {
    throw new Error('No "upcoming" list — is the url a Squarespace events page?');
  }
  return upcoming.map((e) => mapSquarespaceEvent(e, feed)).filter((e) => e.title && e.date);
}

// ── WordPress: The Events Calendar ──────────────────────────────────────
export function mapTribeEvent(e, feed) {
  const title = htmlToText(e.title);
  // start_date is already in the venue's own timezone ("2026-10-05 19:00:00").
  const [date, clock] = String(e.start_date || '').split(' ');
  const labels = [...(e.categories || []), ...(e.tags || [])]
    .map((c) => htmlToText(c?.name).toLowerCase())
    .filter(Boolean);
  return {
    ...baseEvent(feed),
    title,
    venue: feed.venue || htmlToText(e.venue?.venue) || feed.name,
    city: feed.city || e.venue?.city || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : null,
    time: !e.all_day && /^\d{2}:\d{2}/.test(clock || '') ? clock.slice(0, 5) : null,
    category: classify(`${title} ${labels.join(' ')}`, feed.category || 'music', title),
    genre_tags: [...new Set([...(feed.category ? [feed.category] : []), ...labels])],
    ticket_url: absoluteUrl(e.website, feed.url) || absoluteUrl(e.url, feed.url),
    image_url: e.image?.url ? absoluteUrl(e.image.url, feed.url) : null,
    price_range: htmlToText(e.cost) || null,
  };
}

export function tribeEndpoint(siteUrl, today) {
  const origin = new URL(siteUrl).origin;
  return `${origin}/wp-json/tribe/events/v1/events?per_page=50&start_date=${today}`;
}

export async function fetchTribeEvents(feed, { today = zonedDateTime(new Date(), feed.tz).date } = {}) {
  const wanted = (feed.categories || []).map((c) => String(c).toLowerCase());
  const events = [];
  let next = tribeEndpoint(feed.url, today);
  for (let page = 0; next && page < MAX_TRIBE_PAGES; page += 1) {
    const res = await axios.get(next, { headers: HEADERS, timeout: 20000 });
    if (!Array.isArray(res.data?.events)) {
      // Hosts like SiteGround answer automated clients with a captcha page.
      throw new Error(
        typeof res.data === 'string' && /captcha/i.test(res.data)
          ? 'The site answered with a bot check (captcha) instead of its events API'
          : 'Not a The Events Calendar REST response'
      );
    }
    for (const e of res.data.events) {
      if (wanted.length) {
        const cats = (e.categories || []).map((c) => String(c.name || '').toLowerCase());
        if (!cats.some((c) => wanted.includes(c))) continue;
      }
      events.push(mapTribeEvent(e, feed));
    }
    next = res.data.next_rest_url || null;
  }
  const listed = events.filter((e) => e.title && e.date);
  // Stopped at the page cap with more to come: not the whole calendar, so
  // the run mustn't prune shows past the cutoff.
  if (next) listed.truncated = true;
  return listed;
}
