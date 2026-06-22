// Ticketmaster Discovery API adapter.
// Queries by latlong + radius for Music and Comedy around Seattle & Tacoma.
import axios from 'axios';
import { getApiKeys, LOCATIONS, SEARCH_RADIUS_MILES, REQUEST_DELAY_MS, sleep } from '../config.js';
import { classify, toISODate, toTime } from './util.js';

const BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';
const CLASSIFICATIONS = ['Music', 'Comedy'];

export const meta = { id: 'ticketmaster', source: 'api', label: 'Ticketmaster' };

function mapEvent(e, defaultCity) {
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

  const attraction = e._embedded?.attractions?.[0]?.name || null;

  return {
    source: 'api',
    source_name: 'ticketmaster',
    title: e.name,
    artist: attraction,
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

  const events = [];
  try {
    for (const loc of LOCATIONS) {
      for (const classificationName of CLASSIFICATIONS) {
        const res = await axios.get(BASE, {
          params: {
            apikey: apiKey,
            latlong: loc.latlong,
            radius: SEARCH_RADIUS_MILES,
            unit: 'miles',
            classificationName,
            size: 100,
            sort: 'date,asc',
          },
          timeout: 20000,
        });
        const list = res.data?._embedded?.events || [];
        for (const e of list) {
          const mapped = mapEvent(e, loc.city);
          if (mapped.date) events.push(mapped);
        }
        await sleep(REQUEST_DELAY_MS); // respect rate limits
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
