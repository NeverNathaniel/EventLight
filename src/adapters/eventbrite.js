// Eventbrite API adapter.
// Eventbrite deprecated its public event search endpoint; this adapter targets
// the v3 events search and degrades gracefully if the account lacks access.
import axios from 'axios';
import { getApiKeys, LOCATIONS, REQUEST_DELAY_MS, sleep } from '../config.js';
import { classify, toISODate, toTime } from './util.js';

const BASE = 'https://www.eventbriteapi.com/v3/events/search/';
const CATEGORIES = [
  { name: 'music', id: '103' },
  { name: 'comedy', id: '105' }, // Performing & Visual Arts parent; filtered by query too
];

export const meta = { id: 'eventbrite', source: 'api', label: 'Eventbrite' };

function mapEvent(e, category, defaultCity) {
  const venue = e.venue?.name || 'Unknown Venue';
  const city = e.venue?.address?.city || defaultCity;
  const start = e.start?.local || e.start?.utc;
  return {
    source: 'api',
    source_name: 'eventbrite',
    title: e.name?.text || 'Untitled',
    artist: null,
    venue,
    city,
    date: toISODate(start),
    time: toTime(start),
    doors_time: null,
    category: classify(`${category} ${e.name?.text || ''}`, category),
    genre_tags: [category],
    ticket_url: e.url || null,
    image_url: e.logo?.url || null,
    price_range: e.is_free ? 'Free' : null,
  };
}

export async function run() {
  const { eventbrite: token } = getApiKeys();
  if (!token) {
    return { status: 'skipped', error_msg: 'No EVENTBRITE_API_KEY set', events: [] };
  }

  const events = [];
  try {
    for (const loc of LOCATIONS) {
      for (const cat of CATEGORIES) {
        const res = await axios.get(BASE, {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            'location.address': `${loc.city}, ${loc.stateCode}`,
            'location.within': '30mi',
            categories: cat.id,
            q: cat.name,
            expand: 'venue,logo',
            'start_date.keyword': 'this_month',
          },
          timeout: 20000,
        });
        const list = res.data?.events || [];
        for (const e of list) {
          const mapped = mapEvent(e, cat.name, loc.city);
          if (mapped.date) events.push(mapped);
        }
        await sleep(REQUEST_DELAY_MS);
      }
    }
    return { status: 'ok', events };
  } catch (err) {
    const msg = err.response
      ? `HTTP ${err.response.status}: ${err.response.data?.error_description || err.response.statusText}`
      : err.message;
    return { status: 'error', error_msg: msg, events };
  }
}
