// Ticketmaster Discovery API adapter.
// Queries by latlong + radius for Music and Comedy around Seattle & Tacoma,
// paging through the next ~6 months (one page of 100 used to cover barely a
// week or two of a busy metro), and drops ticketing add-ons like parking.
import axios from 'axios';
import { getApiKeys, LOCATIONS, SEARCH_RADIUS_MILES, REQUEST_DELAY_MS, sleep } from '../config.js';
import { classify, toISODate, toTime } from './util.js';

const BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';
const CLASSIFICATIONS = ['Music', 'Comedy'];
const PAGE_SIZE = 200;
// The Discovery API refuses to page past the 1000th result (size × page < 1000).
const MAX_PAGES = 5;
const WINDOW_DAYS = 180;

// Listings that are add-ons to a show, not a show.
const NOT_A_SHOW_RE =
  /\b(?:parking|vip (?:package|upgrade|experience|lounge)|upgrade|add-on|shuttle|locker|suite rental|premium seating|meet (?:&|and) greet|fast lane|early entry|club access|lounge access|gift card|merch(?:andise)? bundle)\b/i;

export function isTicketingExtra(name) {
  return NOT_A_SHOW_RE.test(String(name || ''));
}

export const meta = { id: 'ticketmaster', source: 'api', label: 'Ticketmaster' };

export function mapEvent(e, defaultCity) {
  const venueObj = e._embedded?.venues?.[0];
  const venue = venueObj?.name || 'Unknown Venue';
  const city = venueObj?.city?.name || defaultCity;

  const dateLocal = e.dates?.start?.localDate;
  const timeLocal = e.dates?.start?.localTime;

  const classification = e.classifications?.[0] || {};
  const segment = classification.segment?.name || '';
  const genre = classification.genre?.name;
  const subGenre = classification.subGenre?.name;
  const genre_tags = [genre, subGenre]
    .filter((g) => g && g !== 'Undefined')
    .map((g) => g.toLowerCase());

  // Prefer a wide, sharp image.
  const image = (e.images || [])
    .filter((i) => i.url)
    .sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;

  const priceRange = e.priceRanges?.[0]
    ? `$${e.priceRanges[0].min}–$${e.priceRanges[0].max}`
    : null;

  // Every billed act, headliner first — the lineup feeds favorite matching.
  const lineup = (e._embedded?.attractions || []).map((a) => a.name).filter(Boolean);

  return {
    source: 'api',
    source_name: 'ticketmaster',
    title: e.name,
    artist: lineup[0] || null,
    lineup,
    venue,
    city,
    date: toISODate(dateLocal),
    time: toTime(timeLocal),
    doors_time: null,
    category: classify(`${segment} ${genre_tags.join(' ')}`, 'music'),
    genre_tags,
    ticket_url: e.url || null,
    image_url: image,
    price_range: priceRange,
  };
}

export async function run() {
  const { ticketmaster: apiKey } = getApiKeys();
  if (!apiKey) {
    return { status: 'skipped', error_msg: 'No TICKETMASTER_API_KEY set', events: [] };
  }

  const now = new Date();
  const until = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const tmDate = (d) => `${d.toISOString().slice(0, 19)}Z`;

  const events = [];
  const seen = new Set(); // Seattle and Tacoma radii overlap — skip repeats
  try {
    for (const loc of LOCATIONS) {
      for (const classificationName of CLASSIFICATIONS) {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const res = await axios.get(BASE, {
            params: {
              apikey: apiKey,
              latlong: loc.latlong,
              radius: SEARCH_RADIUS_MILES,
              unit: 'miles',
              classificationName,
              startDateTime: tmDate(now),
              endDateTime: tmDate(until),
              size: PAGE_SIZE,
              page,
              sort: 'date,asc',
            },
            timeout: 20000,
          });
          const list = res.data?._embedded?.events || [];
          for (const e of list) {
            if (seen.has(e.id) || isTicketingExtra(e.name)) continue;
            seen.add(e.id);
            const mapped = mapEvent(e, loc.city);
            if (mapped.date) events.push(mapped);
          }
          await sleep(REQUEST_DELAY_MS); // respect rate limits
          const totalPages = res.data?.page?.totalPages ?? 0;
          if (list.length < PAGE_SIZE || page + 1 >= totalPages) break;
        }
      }
    }
    return { status: 'ok', events };
  } catch (err) {
    const msg = err.response
      ? `HTTP ${err.response.status}: ${err.response.statusText}`
      : err.message;
    return { status: 'error', error_msg: msg, events };
  }
}
