// Bandsintown adapter — artist-level lookup.
// Used to resolve upcoming shows for known artists. On a scheduled run it
// resolves your favorite artists plus the artists of events you've marked
// "interested", and pulls their upcoming Washington-area dates — so a
// favorite's show is found even at a venue EventLight doesn't scrape.
import axios from 'axios';
import db from '../db/index.js';
import { getFavoriteArtists } from '../db/artists.js';
import { getApiKeys, REQUEST_DELAY_MS, sleep } from '../config.js';
import { toISODate, toTime } from './util.js';

const BASE = 'https://rest.bandsintown.com/artists';
const LOCAL_REGIONS = new Set(['WA', 'Washington']);

export const meta = { id: 'bandsintown', source: 'api', label: 'Bandsintown' };

function mapEvent(e, artistName) {
  const venue = e.venue || {};
  return {
    source: 'api',
    source_name: 'bandsintown',
    title: e.title || artistName,
    artist: artistName,
    lineup: Array.isArray(e.lineup) && e.lineup.length ? e.lineup : [artistName],
    venue: venue.name || 'Unknown Venue',
    city: venue.city || null,
    date: toISODate(e.datetime),
    time: toTime(e.datetime),
    doors_time: null,
    category: 'music',
    genre_tags: ['music'],
    ticket_url: e.offers?.[0]?.url || e.url || null,
    image_url: e.artist?.image_url || null,
    price_range: null,
  };
}

// Resolve a single artist's upcoming events. Exported for on-demand use.
export async function lookupArtist(artistName, appId) {
  const app_id = appId || getApiKeys().bandsintown;
  if (!app_id) return [];
  const res = await axios.get(`${BASE}/${encodeURIComponent(artistName)}/events`, {
    params: { app_id, date: 'upcoming' },
    timeout: 20000,
  });
  const list = Array.isArray(res.data) ? res.data : [];
  return list
    .filter((e) => LOCAL_REGIONS.has(e.venue?.region))
    .map((e) => mapEvent(e, artistName))
    .filter((m) => m.date);
}

// Artists the user cares about: favorites first, then distinct artists on
// interested events (case-insensitively deduplicated).
function artistsToResolve() {
  const names = [
    ...getFavoriteArtists().map((f) => f.name),
    ...db
      .prepare(
        `SELECT DISTINCT artist FROM events
         WHERE interested = 1 AND artist IS NOT NULL AND artist != ''`
      )
      .all()
      .map((r) => r.artist),
  ];
  const seen = new Set();
  return names.filter((n) => {
    const k = n.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function run() {
  const { bandsintown: appId } = getApiKeys();
  if (!appId) {
    return { status: 'skipped', error_msg: 'No BANDSINTOWN_APP_ID set', events: [] };
  }

  const artists = artistsToResolve();
  if (artists.length === 0) {
    return {
      status: 'ok',
      events: [],
      note: 'No favorite or interested artists to resolve yet.',
    };
  }

  const events = [];
  let lastError = null;
  for (const artist of artists) {
    try {
      const resolved = await lookupArtist(artist, appId);
      events.push(...resolved);
    } catch (err) {
      lastError = err.response ? `HTTP ${err.response.status} for ${artist}` : err.message;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  return {
    status: lastError && events.length === 0 ? 'error' : 'ok',
    error_msg: lastError,
    events,
  };
}
