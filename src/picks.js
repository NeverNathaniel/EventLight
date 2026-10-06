// Top Picks, shared by the dashboard view and the weekly alert digest.
import { queryEvents } from './db/queries.js';
import { scoreEvents, hasArtistMatch } from './scoring/engine.js';
import { artistKey } from './lineup.js';
import { todayISO, addDays } from './dates.js';

const headlinerOf = (e) => e.headliner_key || (e._lineup && e._lineup[0] ? artistKey(e._lineup[0]) : null);
// Which show a row is: date + headliner, or — for nights with no named act —
// date + venue + title, so two venues' "Trivia Night" are two shows.
function showKey(e) {
  const head = headlinerOf(e);
  return head ? `${e.date}|${head}` : `${e.date}|${artistKey(e.venue)}|${artistKey(e.title)}`;
}
const commitment = (e) => (e.going ? 2 : e.interested ? 1 : 0);

// Every start time of a show, earliest first: '19:00' and '21:30'.
function showTimes(...events) {
  const times = events.flatMap((e) => e._times || [e.time]).filter(Boolean);
  return [...new Set(times)].sort();
}

// One row per show for a ranked list. The same show is often listed twice:
// by two sources (a promoter's site and the venue's own calendar) under
// slightly different venue names, or as an early and a late show (see
// showKey). The first listing is kept; an early/late pair at the same venue
// becomes one row with both times in `_times` (and if you starred the second
// one, that copy is the one kept, so your plan isn't lost).
export function onePerShow(events) {
  const kept = new Map(); // show key → index in out
  const out = [];
  for (const e of events) {
    const key = showKey(e);
    const venue = artistKey(e.venue);
    const i = kept.get(key);
    if (i === undefined) {
      kept.set(key, out.length);
      out.push(e);
      continue;
    }
    const first = out[i];
    // The same headliner under another venue name is a cross-listing.
    if (artistKey(first.venue) !== venue) continue;
    const base = commitment(e) > commitment(first) ? e : first;
    const times = showTimes(first, e);
    if (times.length > 1) out[i] = { ...base, _times: times };
    else if (base !== first) out[i] = base;
  }
  return out;
}

// The best-scoring shows in the next `days`, plus `artists`: shows by your
// favorite or starred artists over the next year — tours announce months
// out, and those are the ones that sell out.
export function topPicks({ filters = {}, today = todayISO(), days = 30, limit = 50 } = {}) {
  const to = addDays(today, days);
  const scored = scoreEvents(
    queryEvents({ ...filters, dateFrom: today, dateTo: addDays(today, 365) }, { sort: 'date' })
  );
  const artists = onePerShow(scored.filter(hasArtistMatch)).slice(0, 30);
  // By show, not by row: the other half of a merged early/late pair is
  // already shown too.
  const shown = new Set(artists.map(showKey));
  const events = onePerShow(
    scored
      .filter((e) => e.date <= to && e._score > 0 && !shown.has(showKey(e)))
      .sort((a, b) => b._score - a._score || String(a.date).localeCompare(String(b.date)))
  ).slice(0, limit);
  return { from: today, to, artists, events };
}
