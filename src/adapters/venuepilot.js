// VenuePilot — the ticketing widget behind Jazzbones, Conor Byrne Pub,
// Tracyton Movie House and many small rooms. The widget renders client-side,
// so there's nothing to scrape, but it reads from a public GraphQL endpoint
// that returns clean structured events, including the billed artists.
//
// feeds.json entry: { "type": "venuepilot", "accountId": 194, "url": <venue page>, … }
// The account id is in the venue page's `venuepilotSettings` script.
import axios from 'axios';
import { USER_AGENT } from '../config.js';
import { artistKey } from '../lineup.js';
import { classify, toTime } from './util.js';

const GRAPHQL_URL = 'https://www.venuepilot.co/graphql';
const QUERY = `query ($accountIds: [Int!]!, $startDate: String!, $limit: Int) {
  publicEvents(accountIds: $accountIds, startDate: $startDate, limit: $limit) {
    id name date startTime doorTime support status ticketsUrl images
    artists { name }
    venue { name }
  }
}`;

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The artists list isn't in billing order — order it by where each name
// appears in the title, so the headliner comes first.
export function orderArtists(title, names) {
  const t = artistKey(title);
  const pos = (n) => {
    const i = t.indexOf(artistKey(n));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...names].sort((a, b) => pos(a) - pos(b));
}

export function mapVenuePilotEvent(e, feed) {
  const title = String(e.name || '').trim();
  const artists = (e.artists || []).map((a) => a?.name).filter(Boolean);
  return {
    source: 'rss',
    source_name: feed.id || feed.name,
    title,
    lineup: orderArtists(title, artists),
    support: e.support || null,
    venue: feed.venue || e.venue?.name || feed.name,
    city: feed.city || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : null,
    time: toTime(e.startTime) || toTime(e.doorTime),
    doors_time: toTime(e.doorTime),
    category: classify(title, feed.category || 'music'),
    genre_tags: feed.category ? [feed.category] : [],
    ticket_url: e.ticketsUrl || feed.url || null,
    image_url: Array.isArray(e.images) ? e.images[0] || null : null,
    price_range: null,
  };
}

export async function fetchVenuePilotEvents(feed) {
  const accountId = parseInt(feed.accountId, 10);
  if (!accountId) throw new Error('venuepilot feed needs an accountId');
  const res = await axios.post(
    GRAPHQL_URL,
    { query: QUERY, variables: { accountIds: [accountId], startDate: todayISO(), limit: 250 } },
    { headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  if (res.data?.errors?.length) throw new Error(res.data.errors[0].message);
  return (res.data?.data?.publicEvents || [])
    .filter((e) => !/cancel/i.test(e.status || ''))
    .map((e) => mapVenuePilotEvent(e, feed))
    .filter((e) => e.title && e.date);
}
