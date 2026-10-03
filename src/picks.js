// Top Picks, shared by the dashboard view and the weekly alert digest.
import { queryEvents } from './db/queries.js';
import { scoreEvents, hasArtistMatch } from './scoring/engine.js';
import { artistKey } from './lineup.js';
import { todayISO, addDays } from './dates.js';

// The same show is often listed by two sources (a promoter's site and the
// venue's own calendar) under slightly different venue names. For a ranked
// list, keep the first listing per date + headliner.
export function onePerShow(events) {
  const seen = new Set();
  return events.filter((e) => {
    const key = `${e.date}|${artistKey((e._lineup && e._lineup[0]) || e.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const shown = new Set(artists.map((e) => e.id));
  const events = onePerShow(
    scored
      .filter((e) => e.date <= to && e._score > 0 && !shown.has(e.id))
      .sort((a, b) => b._score - a._score || String(a.date).localeCompare(String(b.date)))
  ).slice(0, limit);
  return { from: today, to, artists, events };
}
