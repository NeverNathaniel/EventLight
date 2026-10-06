// Artist enrichment — runs after ingestion.
//
// Scraped listings only say "music", so on their own they can't match a genre
// weight or tell you that tonight's opener sounds like your favorite band.
// This step fills that gap, within a bounded per-run budget of API calls:
//   1. Look up your favorite (and starred) artists on MusicBrainz and pull
//      the artists that sound like them from ListenBrainz.
//   2. For upcoming music events: headliners' genre tags (MusicBrainz), then
//      headliners' own similar lists (ListenBrainz), then support acts' tags.
//   3. Roll the tags up onto each event row (events.artist_tags).
// Everything is cached in SQLite, so later runs only spend lookups on new names.
import { ENRICH_ARTISTS, ENRICH_MAX_LOOKUPS, sleep } from '../config.js';
import { artistKey, lineupKeys } from '../lineup.js';
import {
  getFavoriteArtists,
  getLearnedArtists,
  getArtist,
  saveArtist,
  getFreshArtistKeys,
  getUpcomingLineups,
  syncEventArtistTags,
  replaceSimilarArtists,
  getFreshSimilarSeeds,
} from '../db/artists.js';
import { lookupArtist } from './musicbrainz.js';
import { similarArtists } from './listenbrainz.js';
import { mbTurn } from './limits.js';

const LB_DELAY_MS = 400;
const HORIZON_DAYS = 120; // only enrich events this far ahead
const SEED_SIMILAR_DAYS = 14; // refresh favorites' similar lists every two weeks
const EVENT_SIMILAR_DAYS = 45; // touring headliners change slowly

function isoDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// MusicBrainz answers 503 when a client briefly exceeds its rate limit; back
// off and retry once rather than caching a spurious error.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    const status = err.response?.status;
    if (status && status !== 503 && status !== 429 && status < 500) throw err;
    await sleep(3000);
    return fn();
  }
}

// Resolve one artist through the cache, spending a MusicBrainz lookup on a
// miss. Returns the cached/saved row. `budget` is decremented in place.
async function resolveArtist(name, budget, fresh) {
  const key = artistKey(name);
  if (!key) return null;
  if (fresh.has(key)) return getArtist(key);
  if (budget.left <= 0) return getArtist(key) || null;
  budget.left -= 1;
  budget.lookups += 1;
  const previous = getArtist(key);
  let row;
  try {
    // MusicBrainz's one-a-second limit is shared with the artist sheet and
    // the profile prefetch (limits.js); enrichment holds back while someone
    // is waiting on a sheet.
    const found = await withRetry(async () => {
      await mbTurn({ background: true });
      return lookupArtist(name);
    });
    row = found
      ? { key, name: found.name, mbid: found.mbid, tags: found.tags, status: 'found' }
      : { key, name, status: 'not_found' };
    if (found) budget.found += 1;
  } catch (err) {
    budget.errors += 1;
    budget.lastError = err.response ? `MusicBrainz HTTP ${err.response.status}` : err.message;
    row = { key, name, status: 'error' };
  }
  // A failed re-check of an artist we already know shouldn't wipe its tags —
  // keep the old data and just restart its freshness clock.
  if (previous?.status === 'found' && row.status !== 'found') {
    row = {
      key,
      name: previous.name,
      mbid: previous.mbid,
      tags: previous.tags ? previous.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      status: 'found',
    };
  }
  saveArtist(row);
  fresh.add(key);
  return getArtist(key);
}

export async function enrichArtists({ maxLookups = ENRICH_MAX_LOOKUPS } = {}) {
  if (!ENRICH_ARTISTS) {
    return { status: 'skipped', error_msg: 'ENRICH_ARTISTS=false' };
  }
  const budget = { left: maxLookups, lookups: 0, found: 0, errors: 0, lastError: null };
  const fresh = getFreshArtistKeys();

  // Fetch (and cache) one artist's similar list; counts against the budget.
  let similarFetched = 0;
  const fetchSimilar = async (key, name, mbid) => {
    if (!mbid || budget.left <= 0) return;
    budget.left -= 1;
    try {
      replaceSimilarArtists(key, name, await withRetry(() => similarArtists(mbid)));
      similarFetched += 1;
    } catch (err) {
      budget.errors += 1;
      budget.lastError = err.response ? `ListenBrainz HTTP ${err.response.status}` : err.message;
    }
    await sleep(LB_DELAY_MS);
  };

  // 1. Your favorite (then starred) artists, and who sounds like them.
  const favorites = getFavoriteArtists();
  const favoriteKeys = new Set(favorites.map((f) => f.artist_key));
  const seeds = [
    ...favorites.map((f) => ({ key: f.artist_key, name: f.name })),
    ...getLearnedArtists().filter((a) => !favoriteKeys.has(a.artist_key)),
  ];
  const freshSeeds = getFreshSimilarSeeds(SEED_SIMILAR_DAYS);
  for (const seed of seeds) {
    const row = await resolveArtist(seed.name, budget, fresh);
    if (!freshSeeds.has(seed.key)) await fetchSimilar(seed.key, seed.name, row?.mbid);
  }

  // 2. Upcoming music lineups. Spend the budget where it matters most:
  // headliners' genre tags, then headliners' similar lists (which link a
  // touring band to your favorites through shared listeners), then support
  // acts' tags — each pass soonest-show first.
  const events = getUpcomingLineups(isoDay(0), isoDay(HORIZON_DAYS)).filter(
    (e) => e.category === 'music'
  );
  const queued = new Set();
  const slotNames = (slots) => {
    const names = [];
    for (const slot of slots) {
      for (const e of events) {
        const name = e.lineup[slot];
        const key = artistKey(name);
        if (!name || !key || queued.has(key)) continue;
        queued.add(key);
        names.push(name);
      }
    }
    return names;
  };
  const resolveAll = async (names) => {
    for (const name of names) {
      if (budget.left <= 0) break;
      const row = await resolveArtist(name, budget, fresh);
      // "Dying Fetus & Sanguisugabogg" isn't one artist — try each act.
      if (row?.status === 'not_found' && /\s&\s/.test(name)) {
        for (const part of lineupKeys(name).slice(1)) {
          if (budget.left <= 0) break;
          await resolveArtist(part, budget, fresh);
        }
      }
    }
  };

  const headliners = slotNames([0]);
  await resolveAll(headliners);

  const freshLists = getFreshSimilarSeeds(EVENT_SIMILAR_DAYS);
  for (const name of headliners) {
    if (budget.left <= 0) break;
    const key = artistKey(name);
    if (freshLists.has(key) || favoriteKeys.has(key)) continue;
    const row = getArtist(key);
    if (row?.status === 'found') await fetchSimilar(key, row.name, row.mbid);
  }

  const support = slotNames([1, 2]);
  await resolveAll(support);
  const queue = [...headliners, ...support];

  // 3. Roll tags up onto events.
  const eventsTagged = syncEventArtistTags(isoDay(-1));
  const pending = queue.filter((n) => !fresh.has(artistKey(n))).length;

  const status = budget.errors && !budget.found && !similarFetched ? 'error' : 'ok';
  return {
    status,
    lookups: budget.lookups + similarFetched,
    found: budget.found,
    similarFetched,
    eventsTagged,
    pending,
    error_msg:
      budget.errors > 0
        ? `${budget.errors} lookup error(s); last: ${budget.lastError}`
        : pending > 0
          ? `${pending} artist(s) left for the next refresh (ENRICH_MAX_LOOKUPS=${maxLookups})`
          : null,
  };
}
