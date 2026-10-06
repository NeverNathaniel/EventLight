// Artist profiles for the coming shows, looked up in the background after
// each refresh, so a row can say what an act is ("Canadian punk rock band",
// a song to play) before anyone opens it. Lists never fetch anything
// themselves (src/feel.js reads the cache), so this is how most profiles
// get there.
//
// The free services allow only so much (iTunes about 18 calls a minute, a
// profile takes 2–3), so each run spends a small budget on the headliners
// you're most likely to look at, soonest show first within each tier:
//   1. music headliners in the next 7 days that score as a good match, and
//      comedy headliners in the next 14 days (comedians are found on
//      Wikipedia by name, so they get the comedy hint)
//   2. the week's other music headliners MusicBrainz knows
//   3. good matches 8 to 30 days out
// Recurring nights (trivia, karaoke, DJ nights, a band's weekly residency)
// and profiles we already have are skipped; a few nights in a row (a
// comedian's Thursday-to-Saturday) are a run, not a regular, and are looked
// up. A run stops at its budget, its deadline, or the first sign Apple is
// rate limiting us; the rest wait for the next refresh.
import db from '../db/index.js';
import { queryEvents, logRun } from '../db/queries.js';
import { scoreEvents } from '../scoring/engine.js';
import { kindOf } from '../kinds.js';
import { regularsIndex } from '../curation.js';
import { artistKey } from '../lineup.js';
import { todayISO, addDays } from '../dates.js';
import { PROFILE_PREFETCH_MAX } from '../config.js';
import { getArtistProfile } from '../db/artists.js';
import { artistProfile, SOURCES, wikipediaWouldAsk } from './profile.js';

const DEADLINE_MS = 10 * 60 * 1000;
// A show worth a look: the score the Week lists stop dimming at (GOOD_MIN in
// src/week.js).
const GOOD_SCORE = 3;
const WEEK_DAYS = 7;
const COMEDY_DAYS = 14;
const FAR_DAYS = 30;
// Two Wikimedia 429s in a row and Wikipedia is left alone for the rest of
// the run.
const WIKI_429_LIMIT = 2;

const state = { running: false, startedAt: null, finishedAt: null, last: null };

export function prefetchState() {
  return { ...state };
}

const statusOf = (err) => err?.response?.status;
const timeOf = (e) => e.time || '99:99';

// MusicBrainz status by artist key, for the kind rules (a known act is Music)
// and tier 2.
function artistStatuses(keys) {
  if (!keys.length) return new Map();
  const rows = db
    .prepare('SELECT artist_key, status FROM artists WHERE artist_key IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(keys));
  return new Map(rows.map((r) => [r.artist_key, r.status]));
}

// Keys whose cached profile needn't be fetched again yet: found within 30
// days, a miss within a week, and a failed or partly failed lookup within 6
// hours. (An open sheet retries those after an hour; the background is
// gentler.)
function settledProfiles(keys) {
  if (!keys.length) return new Set();
  const rows = db
    .prepare(
      `SELECT artist_key FROM artist_profiles
       WHERE artist_key IN (SELECT value FROM json_each(?)) AND (
         (status = 'found' AND fetched_at > datetime('now', '-30 days')) OR
         (status = 'not_found' AND fetched_at > datetime('now', '-7 days')) OR
         (status IN ('partial', 'error') AND fetched_at > datetime('now', '-6 hours'))
       )`
    )
    .all(JSON.stringify(keys));
  return new Set(rows.map((r) => r.artist_key));
}

// Who to look up, best first: [{ name, key, hint, tier, date }], plus how
// many headliners were skipped because their profile is still good. `now`
// (ms) is the moment the shows are scored at.
export function prefetchQueue({ today = todayISO(), now = Date.now() } = {}) {
  const weekEnd = addDays(today, WEEK_DAYS - 1);
  const comedyEnd = addDays(today, COMEDY_DAYS - 1);
  const farEnd = addDays(today, FAR_DAYS - 1);
  const events = scoreEvents(queryEvents({ dateFrom: today, dateTo: farEnd }, { sort: 'date' }), now);
  // A regular ("Cumbia Night" every Sunday) is skipped whatever its kind: its
  // "headliner" is the night's name. The day pages' own index decides, so a
  // run of nights (Thu–Sat at the comedy club) isn't mistaken for one just
  // because it has three dates.
  const { regular } = regularsIndex(today);

  const headliners = events
    .map((e) => ({ e, name: e._lineup?.[0], key: artistKey(e._lineup?.[0]) }))
    .filter((h) => h.name && h.key);
  const statuses = artistStatuses([...new Set(headliners.map((h) => h.key))]);

  const best = new Map();
  for (const { e, name, key } of headliners) {
    if (regular.has(e.id)) continue;
    const kind = kindOf(e, { headlinerFound: statuses.get(key) === 'found' });
    let tier = null;
    let hint = null;
    if (kind.family === 'comedy' && e.category === 'comedy') {
      if (e.date <= comedyEnd) [tier, hint] = [1, 'comedy'];
    } else if (kind.family === 'music') {
      if (e.date <= weekEnd) tier = e._score >= GOOD_SCORE ? 1 : statuses.get(key) === 'found' ? 2 : null;
      else if (e._score >= GOOD_SCORE) tier = 3;
    }
    // Everything else, the night family (trivia, karaoke, DJ nights) among
    // them, is left alone.
    if (!tier) continue;
    const seen = best.get(key);
    if (!seen || tier < seen.tier) best.set(key, { name, key, hint, tier, date: e.date, time: timeOf(e) });
  }

  const settled = settledProfiles([...best.keys()]);
  const queue = [...best.values()]
    .filter((c) => !settled.has(c.key))
    .sort((a, b) => a.tier - b.tier || a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  return { queue, skipped: best.size - queue.length };
}

// The profile sources, with this run's circuit breakers in front: once Apple
// answers 403 or 429 the run stops (the profile that hit it is saved as
// partial and retried later), and after two Wikimedia 429s in a row Wikipedia
// is skipped, leaving profiles partial so a later run fills them in — only
// those that would have asked it, though: a band MusicBrainz knows with no
// Wikipedia link is complete without it.
function guarded(sources, breakers) {
  return {
    ...sources,
    async apple(...args) {
      if (breakers.itunes) throw new Error('Apple Music paused for this run');
      try {
        return await sources.apple(...args);
      } catch (err) {
        if (statusOf(err) === 403 || statusOf(err) === 429) breakers.itunes = true;
        throw err;
      }
    },
    async wikipedia(...args) {
      if (breakers.wikiOff) {
        const [mb, name, job] = args;
        if (!wikipediaWouldAsk(mb, name, job?.hint)) return null;
        throw new Error('Wikipedia paused for this run');
      }
      try {
        const page = await sources.wikipedia(...args);
        breakers.wiki429 = 0;
        return page;
      } catch (err) {
        breakers.wiki429 = statusOf(err) === 429 ? breakers.wiki429 + 1 : 0;
        if (breakers.wiki429 >= WIKI_429_LIMIT) breakers.wikiOff = true;
        throw err;
      }
    },
  };
}

async function run({ max, deadlineMs, today, now, sources }) {
  const started = now();
  const { queue, skipped } = prefetchQueue({ today, now: started });
  const breakers = { itunes: false, wiki429: 0, wikiOff: false };
  const lookups = guarded(sources, breakers);
  const out = { fetched: 0, found: 0, partial: 0, skipped, left: 0, stoppedBy: 'done', errors: 0, wikipediaPaused: false };

  for (let i = 0; i < queue.length; i += 1) {
    const stop = out.fetched >= max ? 'max' : now() - started >= deadlineMs ? 'deadline' : null;
    if (stop) {
      out.stoppedBy = stop;
      out.left = queue.length - i;
      break;
    }
    const { name, key, hint } = queue[i];
    // Opened (and so fetched) since the run started.
    if (getArtistProfile(key)?.fresh) {
      out.skipped += 1;
      continue;
    }
    try {
      const p = await artistProfile(name, { sources: lookups, hint, background: true });
      out.fetched += 1;
      if (p?.status === 'found') out.found += 1;
      else if (p?.status === 'partial') out.partial += 1;
      else if (p?.status === 'error') out.errors += 1;
    } catch (err) {
      out.fetched += 1;
      out.errors += 1;
      out.lastError = err.message;
    }
    if (breakers.itunes) {
      out.stoppedBy = 'itunes';
      out.left = queue.length - i - 1;
      break;
    }
  }
  out.wikipediaPaused = breakers.wikiOff;
  return out;
}

function logMessage(r) {
  const notes = [];
  if (r.stoppedBy === 'itunes') notes.push(`Apple Music is rate limiting; ${r.left} left for the next refresh`);
  if (r.stoppedBy === 'deadline') notes.push(`out of time; ${r.left} left for the next refresh`);
  if (r.stoppedBy === 'max') notes.push(`${r.left} left for the next refresh (PROFILE_PREFETCH_MAX)`);
  if (r.wikipediaPaused) notes.push('Wikipedia rate limited, skipped for the rest of the run');
  if (r.errors) notes.push(`${r.errors} lookup error(s)${r.lastError ? `; last: ${r.lastError}` : ''}`);
  return notes.length ? notes.join('; ') : null;
}

// One background run. Returns { fetched, found, partial, skipped, left,
// stoppedBy: 'done'|'max'|'deadline'|'itunes'|'running' }. `now` is a clock
// (a function returning ms), so tests can move time on.
export async function prefetchProfiles({
  max = PROFILE_PREFETCH_MAX,
  deadlineMs = DEADLINE_MS,
  today = todayISO(),
  now = Date.now,
  sources = SOURCES,
} = {}) {
  if (state.running) return { fetched: 0, found: 0, partial: 0, skipped: 0, left: 0, stoppedBy: 'running' };
  state.running = true;
  state.startedAt = new Date().toISOString();
  try {
    const r = await run({ max, deadlineMs, today, now, sources });
    // Apple backing us off is a planned pause, not a broken source: the
    // lookup that ran into it doesn't count against the run (the note stays
    // in error_msg for Settings), so the header doesn't flag it for hours.
    const errors = r.errors - (r.stoppedBy === 'itunes' && r.errors ? 1 : 0);
    logRun({
      source: 'enrich',
      source_name: 'profiles',
      status: errors && !r.found && !r.partial ? 'error' : 'ok',
      // Logged as found = profiles looked up, added = profiles with something to show.
      events_found: r.fetched,
      events_added: r.found + r.partial,
      error_msg: logMessage(r),
    });
    state.last = r;
    return r;
  } catch (err) {
    logRun({ source: 'enrich', source_name: 'profiles', status: 'error', error_msg: err.message });
    throw err;
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}
