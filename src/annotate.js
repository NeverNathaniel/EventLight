// Dress a list of shows and films for the screens: what each one is (kind,
// flags, a regular night or a run of nights), how it reads in a list (the
// headline and the feel line — genres, sounds-like, a preview), and how
// strongly it belongs among the picks (_pick). Everything comes from SQLite
// and memoized indexes; nothing here touches the network.
//
// Order matters: the feel line names a film's flag and a curated reason, and
// the pick score reads the feel (is the act known, is a comedian notable).
import db from './db/index.js';
import { parseLineupColumn } from './db/artists.js';
import { kindOf, groupOf, usesTitle, cleanTitle, flagsOf, sortFlags } from './kinds.js';
import { artistKey } from './lineup.js';
import { loadFacts, attachFeel, headlinerFound } from './feel.js';
import { filmScore, pickScore, regularsIndex, loadCurated } from './curation.js';
import { buildContext } from './scoring/engine.js';
import { loadFilmTaste, favoriteOf } from './cinema/taste.js';
import { todayISO } from './dates.js';

// A screening of one of your favorite films at a venue that isn't a cinema
// (a movie house's VenuePilot calendar, a bar's movie night) scores like a
// show by an artist you like.
const FAVORITE_SCREENING = 8;

export function annotate(items, {
  now = Date.now(),
  today = todayISO(),
  ctx = buildContext(now),
  horizonByTheater = new Map(),
  curated = loadCurated(now),
  regulars = regularsIndex(today),
  filmTaste = loadFilmTaste(),
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
      item._film = filmScore(item, { today, horizonByTheater, taste: filmTaste });
      flags = flags.concat(item._film.flags);
      item._reasons = item._film.reasons;
      item._score = item._film.score;
      item._regular = null;
      item._run = null;
    } else {
      item._regular = regulars.regular.get(item.id) || null;
      item._run = regulars.run.get(item.id) || null;
      // Once per item, should a list be dressed twice.
      const favorite = kind.family === 'film' && !item._favoriteFilm ? favoriteOf({ title: cleanTitle(item.title) }, filmTaste) : null;
      if (favorite) {
        item._favoriteFilm = favorite.title;
        item._score = (Number(item._score) || 0) + FAVORITE_SCREENING;
        item._reasons = [{ kind: 'favorite', text: `${favorite.title} is one of your favorite films` }, ...(item._reasons || [])];
      }
    }
    item._flags = sortFlags(flags);
    item._curated = (!film && curated?.reasons.get(item.id)) || null;
  }
  attachFeel(items, { facts });
  for (const item of items) item._pick = pickScore(item);
  return items;
}

const foundIn = db.prepare(
  "SELECT artist_key FROM artists WHERE status = 'found' AND artist_key IN (SELECT value FROM json_each(?))"
);

// The day page's group (music, comedy, film or around) for each of a list of
// event rows, in order — what annotate() puts in _group, without the rest of
// the dressing, so Explore can filter a whole result set before paging it.
// Which headliners MusicBrainz knows is read in one query.
export function groupsOf(rows) {
  const lineups = rows.map((r) => (Array.isArray(r._lineup) ? r._lineup : parseLineupColumn(r.lineup)));
  const heads = [...new Set(lineups.map((l) => (l[0] ? artistKey(l[0]) : null)).filter(Boolean))];
  const found = new Set(heads.length ? foundIn.all(JSON.stringify(heads)).map((r) => r.artist_key) : []);
  return rows.map((r, i) => {
    const item = { ...r, _lineup: lineups[i] };
    const head = lineups[i][0];
    return groupOf(item, kindOf(item, { headlinerFound: Boolean(head) && found.has(artistKey(head)) }));
  });
}
