// Dress a list of shows and films for the screens: what each one is (kind,
// flags, a regular night or a run of nights), how it reads in a list (the
// headline and the feel line — genres, sounds-like, a preview), and how
// strongly it belongs among the picks (_pick). Everything comes from SQLite
// and memoized indexes; nothing here touches the network.
//
// Order matters: the feel line names a film's flag and a curated reason, and
// the pick score reads the feel (is the act known, is a comedian notable).
import { kindOf, groupOf, usesTitle, cleanTitle, flagsOf, sortFlags } from './kinds.js';
import { loadFacts, attachFeel, headlinerFound } from './feel.js';
import { filmScore, pickScore, regularsIndex, loadCurated } from './curation.js';
import { buildContext } from './scoring/engine.js';
import { todayISO } from './dates.js';

export function annotate(items, {
  now = Date.now(),
  today = todayISO(),
  ctx = buildContext(now),
  horizonByTheater = new Map(),
  curated = loadCurated(now),
  regulars = regularsIndex(today),
} = {}) {
  if (!items.length) return items;
  const facts = loadFacts(items, ctx);
  for (const item of items) {
    const film = item.kind === 'film';
    const lineup = item._lineup || [];
    const kind = kindOf(item, { headlinerFound: !film && headlinerFound(item, facts) });
    item._kind = kind;
    item._group = groupOf(item, kind);
    item._headline = film
      ? item.title
      : usesTitle(kind, lineup) ? cleanTitle(item.title) : lineup[0] || cleanTitle(item.title);
    let flags = film ? [] : flagsOf(item);
    if (film) {
      item._film = filmScore(item, { today, horizonByTheater });
      flags = flags.concat(item._film.flags);
      item._reasons = item._film.reasons;
      item._score = item._film.score;
      item._regular = null;
      item._run = null;
    } else {
      item._regular = regulars.regular.get(item.id) || null;
      item._run = regulars.run.get(item.id) || null;
    }
    item._flags = sortFlags(flags);
    item._curated = (!film && curated?.reasons.get(item.id)) || null;
  }
  attachFeel(items, { facts });
  for (const item of items) item._pick = pickScore(item);
  return items;
}
