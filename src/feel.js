// What a show is, before you tap it: a row's genre line, who the act is
// ("Canadian punk rock band"), who they're for ("For fans of Joyce Manor,
// Jeff Rosenstock"), the one line that says why it's for you, and a song to
// play when we're sure it's the right artist.
//
// Everything here reads SQLite only — the artist lookups that fill those
// tables run in the background (src/enrich/prefetch.js) or when someone opens
// an artist sheet — so a list render never waits on the network. loadFacts()
// reads what a set of rows needs in a handful of batched queries, and the
// rest are pure functions over those facts.
//
// The rule that runs through all of it: a wrong fact is worse than none. Tags
// come from the headliner's own row, never the event's tag rollup (when the
// headliner is unknown, those tags belong to an opener); a description must
// read like a performer's; a preview plays only when the Apple match is sure.
import db from './db/index.js';
import { lineupTags, parseLineupColumn, similarArtistsVersion } from './db/artists.js';
import { buildContext, normTag, tagMatch } from './scoring/engine.js';
import { artistKey, lineupKeys, isTribute } from './lineup.js';
import { kindOf, usesTitle } from './kinds.js';
import { todayISO, addDays } from './dates.js';

const CHUNK = 500;
const MAX_TAGS = 3;
// A phone row's genre line; tags are dropped from the end to fit, never cut.
const TAG_BUDGET = 34;
const MAX_TAG_LENGTH = 22;
// The headliner's strongest tags; MusicBrainz lists them most-voted first and
// the tail is noise.
const ARTIST_TAGS = 6;
const MAX_FAN_NAME = 22;
const MAX_DESCRIPTOR = 48;
const HABIT_DAYS = 120;
const HABIT_MIN_SHOWS = 8;
const HABIT_TOP_SHARE = 0.4;
// The second habit tag has to be common too, or "usually punk · folk here"
// would rest on one folk night.
const HABIT_SECOND_SHARE = 0.25;

// Category labels adapters put on everything (as in scoring/engine.js).
const GENERIC_TAGS = new Set(['music', 'other', 'live music', 'concert', 'concerts', 'event', 'events']);
// Tags that only repeat the kind tag beside them ("STAND-UP · comedy").
const KIND_ECHOES = new Set([
  'comedy', 'stand up', 'standup', 'stand up comedy', 'comedian', 'improv', 'open mic', 'film', 'films',
  'movie', 'movies', 'theatre', 'theater', 'arts & theatre', 'other', 'undefined', 'live', 'drag', 'trivia',
  'karaoke', 'burlesque', 'miscellaneous',
]);
// Where an act is from isn't what it sounds like.
const PLACE_TAGS = new Set([
  'american', 'british', 'english', 'canadian', 'australian', 'irish', 'scottish', 'welsh', 'french', 'german',
  'swedish', 'norwegian', 'danish', 'finnish', 'icelandic', 'dutch', 'belgian', 'japanese', 'korean', 'mexican',
  'brazilian', 'usa', 'us', 'uk', 'united states', 'united kingdom', 'england', 'scotland', 'ireland', 'canada',
  'australia', 'new zealand', 'seattle', 'tacoma', 'olympia', 'portland', 'spokane', 'washington',
  'pacific northwest', 'pnw', 'northwest', 'california', 'los angeles', 'new york', 'brooklyn', 'chicago',
  'texas', 'austin', 'nashville', 'london', 'manchester', 'toronto', 'montreal', 'vancouver', 'west coast',
  'east coast',
]);
// Listener habits, not genres.
const NOT_GENRES = new Set(['seen live', 'female vocalists', 'male vocalists', 'favorites', 'favourites']);
const DECADE_RE = /^(?:\d{2}|\d{4})s$/;
// Broad tags say little next to a specific one: at most one, and it goes last.
const COARSE = new Set([
  'rock', 'pop', 'indie', 'alternative', 'electronic', 'folk', 'metal', 'punk', 'jazz', 'hip hop', 'country',
  'soul', 'blues', 'experimental',
]);
// Different sources' names for the same thing (Apple's "Hip-Hop/Rap",
// Ticketmaster's "Dance/Electronic").
const SYNONYMS = new Map([
  ['hip hop rap', 'hip hop'],
  ['hiphop', 'hip hop'],
  ['dance electronic', 'electronic'],
  ['electronica', 'electronic'],
  ['r&b soul', 'r&b'],
]);
// normTag takes the hyphens out for matching; these read better with them.
const DISPLAY = new Map([
  ['singer songwriter', 'singer-songwriter'],
  ['anti folk', 'anti-folk'],
  ['post punk', 'post-punk'],
  ['post hardcore', 'post-hardcore'],
  ['post rock', 'post-rock'],
  ['lo fi', 'lo-fi'],
  ['alt country', 'alt-country'],
  ['k pop', 'k-pop'],
]);

// A description that reads like a performer's: "Canadian punk rock band",
// "American stand-up comedian". Anything else ("1984 film", "American actor")
// is more likely someone else with the same name.
export const DESCRIPTOR_RE =
  /\b(?:band|musician|singer|rapper|songwriter|duo|trio|group|dj|producer|composer|ensemble|orchestra|comedian|comic|humorist|podcaster|quartet|quintet|collective|artist)s?\b/i;
// Apple genres that mean the name matched a comedian, an audiobook or a kids'
// record rather than the band.
const NOT_MUSIC_GENRES = new Set(['Comedy', 'Spoken Word', "Children's Music", 'Fitness & Workout']);

// ── Small helpers ───────────────────────────────────────────────────────────

function lineupOf(item) {
  if (Array.isArray(item._lineup)) return item._lineup;
  if (Array.isArray(item.lineup)) return item.lineup;
  return parseLineupColumn(item.lineup);
}

function splitList(text) {
  return String(text || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

// A tag's matching key: normalised, synonyms folded, and dropped (null) when
// it isn't a genre worth showing.
function tagKey(raw) {
  let key = normTag(raw);
  key = SYNONYMS.get(key) || key;
  if (!key || key.length > MAX_TAG_LENGTH) return null;
  if (GENERIC_TAGS.has(key) || KIND_ECHOES.has(key) || PLACE_TAGS.has(key) || NOT_GENRES.has(key)) return null;
  if (DECADE_RE.test(key)) return null;
  return key;
}

const displayTag = (key) => DISPLAY.get(key) || key;
const overlaps = (a, b) => tagMatch(a, b) > 0 || tagMatch(b, a) > 0;

// "A", "A & B", "A, B +3".
function nameList(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

// Run `sql` (with one "IN (?)") over `keys` in chunks SQLite will take.
function selectIn(sql, keys) {
  const list = [...keys];
  const rows = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    rows.push(...db.prepare(sql.replace('IN (?)', `IN (${chunk.map(() => '?').join(', ')})`)).all(...chunk));
  }
  return rows;
}

function pushTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function parseJSON(text) {
  try {
    return text == null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Facts ───────────────────────────────────────────────────────────────────

// How many similar lists each artist is on, and which artists sit on a
// favorite's list. Both change only when the lists or favorites do.
let listCache = { signature: null, df: new Map(), n: 0, nearFavorite: new Set() };

function listStats(favorites) {
  const signature = `${similarArtistsVersion()}#${[...favorites.keys()].join(',')}`;
  if (listCache.signature !== signature) {
    const df = new Map(
      db.prepare('SELECT artist_key, COUNT(*) AS n FROM similar_artists GROUP BY artist_key').all()
        .map((r) => [r.artist_key, r.n])
    );
    const { n } = db.prepare('SELECT COUNT(DISTINCT seed_key) AS n FROM similar_artists').get();
    const nearFavorite = new Set(
      selectIn('SELECT DISTINCT artist_key FROM similar_artists WHERE seed_key IN (?)', favorites.keys())
        .map((r) => r.artist_key)
    );
    listCache = { signature, df, n, nearFavorite };
  }
  return listCache;
}

// Everything the rows in `items` need, read in a few batched queries.
// `today` only moves the venue-habit window (tests pin it).
export function loadFacts(items, ctx = buildContext(), { today = todayISO() } = {}) {
  const actKeys = new Set();
  const headKeys = new Set();
  const profileKeys = new Set();
  for (const item of items || []) {
    if (item.kind === 'film') continue;
    lineupOf(item).forEach((name, slot) => {
      for (const key of lineupKeys(name)) {
        actKeys.add(key);
        if (slot === 0) headKeys.add(key);
      }
      const key = artistKey(name);
      if (key) profileKeys.add(key);
    });
  }

  const artists = new Map();
  for (const r of selectIn('SELECT artist_key, status, tags FROM artists WHERE artist_key IN (?)', actKeys)) {
    artists.set(r.artist_key, { status: r.status, tags: splitList(r.tags) });
  }

  const similarBySeed = new Map();
  const bySeed = selectIn(
    'SELECT seed_key, artist_key, name, score FROM similar_artists WHERE seed_key IN (?) ORDER BY score DESC',
    headKeys
  );
  for (const r of bySeed) pushTo(similarBySeed, r.seed_key, { artist_key: r.artist_key, name: r.name, score: r.score });

  const similarByArtist = new Map();
  const byArtist = selectIn(
    'SELECT artist_key, seed_key, seed_name, score FROM similar_artists WHERE artist_key IN (?) ORDER BY score DESC',
    headKeys
  );
  for (const r of byArtist) {
    pushTo(similarByArtist, r.artist_key, { seed_key: r.seed_key, seed_name: r.seed_name, score: r.score });
  }

  // Only the fields a row uses: the cached bio, links and song list stay put.
  // json_valid keeps one corrupt row from failing the whole query.
  const profiles = new Map();
  const profileRows = selectIn(
    `SELECT artist_key,
       json_extract(data, '$.name') AS name,
       json_extract(data, '$.description') AS description,
       json_extract(data, '$.type') AS type,
       json_extract(data, '$.from') AS place,
       json_extract(data, '$.since') AS since,
       json_extract(data, '$.until') AS until,
       json_type(data, '$.apple') AS apple_type,
       json_extract(data, '$.apple.genre') AS apple_genre,
       json_extract(data, '$.apple.match') AS apple_match,
       json_extract(data, '$.apple.songs[0]') AS apple_song
     FROM artist_profiles WHERE json_valid(data) AND artist_key IN (?)`,
    profileKeys
  );
  for (const r of profileRows) {
    const song = parseJSON(r.apple_song);
    profiles.set(r.artist_key, {
      name: r.name,
      description: r.description,
      type: r.type,
      from: r.place,
      since: r.since == null ? null : String(r.since),
      until: r.until == null ? null : String(r.until),
      apple: r.apple_type === 'object'
        ? { genre: r.apple_genre, match: r.apple_match, songs: song ? [song] : [] }
        : null,
    });
  }

  const stats = listStats(ctx.favorites);
  return {
    artists,
    similarBySeed,
    similarByArtist,
    profiles,
    df: stats.df,
    n: stats.n,
    nearFavorite: stats.nearFavorite,
    favorites: ctx.favorites,
    learned: ctx.learned,
    manualGenres: ctx.manualGenres,
    venueHabits: venueHabits({ today }),
  };
}

// Found artists' tags in the shape lineupTags() takes, built once per facts.
const tagMaps = new WeakMap();
function tagsByKey(facts) {
  let map = tagMaps.get(facts.artists);
  if (!map) {
    map = new Map();
    for (const [key, a] of facts.artists) if (a.status === 'found' && a.tags.length) map.set(key, a.tags);
    tagMaps.set(facts.artists, map);
  }
  return map;
}

export function headlinerFound(item, facts) {
  const head = lineupOf(item)[0];
  return Boolean(head) && facts.artists.get(artistKey(head))?.status === 'found';
}

const kindFor = (item, facts) => item._kind || kindOf(item, { headlinerFound: headlinerFound(item, facts) });
// Rows whose genre line comes from the acts: music, and DJ nights.
const musicLike = (kind) => kind.family === 'music' || kind.key === 'dj';

// ── Genres ──────────────────────────────────────────────────────────────────

// Candidates ({ key, from }) in order → at most three tags for the row.
function chooseTags(candidates, manualGenres) {
  let chosen = [];
  for (const c of candidates) {
    if (chosen.some((x) => tagMatch(c.key, x.key) > 0)) continue; // same, or broader than one we have
    const broader = chosen.findIndex((x) => tagMatch(x.key, c.key) > 0);
    if (broader < 0) {
      chosen.push(c);
      continue;
    }
    // "pop punk" after "punk": the specific tag takes the broad one's place.
    chosen[broader] = c;
    chosen = chosen.filter((x, i) => i === broader || tagMatch(x.key, c.key) === 0);
  }
  const coarse = chosen.find((x) => COARSE.has(x.key));
  const list = chosen.filter((x) => !COARSE.has(x.key));
  if (coarse) list.push(coarse);

  const weights = (manualGenres || []).map((g) => SYNONYMS.get(g.key) || g.key);
  for (const x of list) x.hit = weights.some((g) => tagMatch(g, x.key) > 0);
  // A genre you weighted is worth a slot over one you didn't.
  if (list.length > MAX_TAGS && !list[MAX_TAGS - 1].hit) {
    const j = list.findIndex((x, i) => i >= MAX_TAGS && x.hit);
    if (j > 0) [list[MAX_TAGS - 1], list[j]] = [list[j], list[MAX_TAGS - 1]];
  }
  const out = list.slice(0, MAX_TAGS).map((x) => ({ tag: displayTag(x.key), hit: x.hit, from: x.from }));
  while (out.length > 1 && out.map((x) => x.tag).join(' · ').length > TAG_BUDGET) out.pop();
  return out;
}

function tagCandidates(item, facts) {
  const head = lineupOf(item)[0];
  const raw = [];
  if (head) for (const t of lineupTags(head, tagsByKey(facts)).slice(0, ARTIST_TAGS)) raw.push([t, 'artist']);
  for (const t of splitList(item.genre_tags)) raw.push([t, 'source']);
  const profile = head && facts.profiles.get(artistKey(head));
  if (profile?.apple?.genre && appleConfident(profile, 'music')) raw.push([profile.apple.genre, 'apple']);

  const seen = new Set();
  const out = [];
  for (const [t, from] of raw) {
    const key = tagKey(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, from });
  }
  return out;
}

const ORIGINS = ['artist', 'source', 'apple'];

// The row's genre line: { tags: [{ tag, hit }], from, text? }. With no
// genres, a music row falls back to what the venue usually books, then to
// the size of the bill; `text` carries that line.
export function displayTags(item, facts) {
  const kind = kindFor(item, facts);
  // A comedian's source tag is just "comedy"; a film's line is built apart.
  if (kind.family === 'comedy' || kind.family === 'film' || item.kind === 'film') return { tags: [], from: null };
  const chosen = chooseTags(tagCandidates(item, facts), facts.manualGenres);
  if (chosen.length) {
    const from = ORIGINS.find((o) => chosen.some((x) => x.from === o));
    return { tags: chosen.map(({ tag, hit }) => ({ tag, hit })), from };
  }
  if (!musicLike(kind)) return { tags: [], from: null };
  const habit = facts.venueHabits?.get(item.venue);
  if (habit?.tags.length) return { tags: [], from: 'venue', text: `usually ${habit.tags.join(' · ')} here` };
  const lineup = lineupOf(item);
  if (lineup.length >= 2) return { tags: [], from: 'bill', text: `local bill · ${lineup.length} acts` };
  return { tags: [], from: null };
}

// ── Venue habits ────────────────────────────────────────────────────────────

let habitCache = { signature: null, value: new Map() };

// What each venue usually books, from its headliners' own tags over four
// months either side of today: Map venue → { tags: [top, second?] }. Only for
// venues with 8+ tagged shows whose top tag covers at least 40% of them, so
// one odd booking doesn't label a room. Every spelling of a venue seen in the
// window is a key. Rebuilt when the events (or artist tags) change.
export function venueHabits({ today = todayISO() } = {}) {
  const ev = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM events').get();
  const ar = db.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS at FROM artists').get();
  const signature = [today, ev.n, ev.at, ar.n, ar.at].join('|');
  if (habitCache.signature === signature) return habitCache.value;

  const tags = new Map(
    db.prepare("SELECT artist_key, tags FROM artists WHERE status = 'found' AND tags != ''").all()
      .map((r) => [r.artist_key, splitList(r.tags)])
  );
  const rows = db
    .prepare("SELECT venue, date, lineup FROM events WHERE hidden = 0 AND lineup != '[]' AND date >= ? AND date <= ?")
    .all(addDays(today, -HABIT_DAYS), addDays(today, HABIT_DAYS));

  const venues = new Map();
  for (const r of rows) {
    const head = parseLineupColumn(r.lineup)[0];
    if (!head) continue;
    const keys = [...new Set(lineupTags(head, tags).map(tagKey).filter(Boolean))].slice(0, MAX_TAGS);
    if (!keys.length) continue;
    const vk = artistKey(r.venue);
    if (!venues.has(vk)) venues.set(vk, { names: new Set(), shows: new Set(), counts: new Map() });
    const v = venues.get(vk);
    v.names.add(r.venue);
    // The same show listed by two sources counts once.
    const show = `${r.date}|${artistKey(head)}`;
    if (v.shows.has(show)) continue;
    v.shows.add(show);
    for (const k of keys) v.counts.set(k, (v.counts.get(k) || 0) + 1);
  }

  const out = new Map();
  for (const v of venues.values()) {
    const total = v.shows.size;
    if (total < HABIT_MIN_SHOWS) continue;
    const ranked = [...v.counts].sort(
      (a, b) => b[1] - a[1] || COARSE.has(a[0]) - COARSE.has(b[0]) || a[0].localeCompare(b[0])
    );
    const [top, topCount] = ranked[0];
    if (topCount / total < HABIT_TOP_SHARE) continue;
    const second = ranked.find(([k, n]) => k !== top && n / total >= HABIT_SECOND_SHARE && !overlaps(k, top));
    const habit = { tags: [top, second?.[0]].filter(Boolean).map(displayTag) };
    for (const name of v.names) out.set(name, habit);
  }
  habitCache = { signature, value: out };
  return out;
}

// ── Similar artists ─────────────────────────────────────────────────────────

// The headliner's own ListenBrainz list, or else the lists it appears on.
function similarPool(name, facts) {
  const keys = lineupKeys(name);
  for (const key of keys) {
    const own = facts.similarBySeed.get(key);
    if (own?.length) return own.map((r) => ({ key: r.artist_key, name: r.name, score: r.score }));
  }
  const best = new Map();
  for (const key of keys) {
    for (const r of facts.similarByArtist.get(key) || []) {
      const prev = best.get(r.seed_key);
      if (!prev || r.score > prev.score) best.set(r.seed_key, { key: r.seed_key, name: r.seed_name, score: r.score });
    }
  }
  return [...best.values()];
}

function hasOwnList(name, facts) {
  return lineupKeys(name).some((key) => facts.similarBySeed.get(key)?.length > 0);
}

// Artists on nearly every list (the Radioheads) say little about this one.
function hubFactor(key, facts) {
  if (!(facts.n >= 10)) return 1;
  const share = (facts.df?.get(key) || 0) / facts.n;
  if (share <= 0.15) return 1;
  return share <= 0.35 ? 0.5 : 0.2;
}

// Names you know make the line worth reading.
function knownFactor(key, facts) {
  if (facts.favorites?.has(key)) return 3;
  if (facts.learned?.has(key)) return 2;
  if (facts.nearFavorite?.has(key)) return 1.3;
  return 1;
}

// "For fans of …": the headliner's closest similar artists, leaning towards
// ones you know, never anyone on the bill. → [{ name, favorite, starred }]
export function fansOf(item, facts, { limit = 3, exclude = [] } = {}) {
  const lineup = lineupOf(item);
  if (!lineup[0]) return [];
  const skip = new Set([...lineup.flatMap((n) => lineupKeys(n)), ...exclude.map((n) => artistKey(n))]);
  return similarPool(lineup[0], facts)
    .filter((c) => c.key && !skip.has(c.key) && !isTribute(c.name) && c.name.length <= MAX_FAN_NAME)
    .map((c) => ({ ...c, weight: c.score * hubFactor(c.key, facts) * knownFactor(c.key, facts) }))
    .sort((a, b) => b.weight - a.weight || b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((c) => ({ name: c.name, favorite: Boolean(facts.favorites?.has(c.key)), starred: Boolean(facts.learned?.has(c.key)) }));
}

// ── Descriptor and preview ──────────────────────────────────────────────────

// A cached description, if it reads like a performer's and fits a row:
// "(born 1983)" and other asides removed.
function performerDescription(text) {
  const d = String(text || '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/,?\s+born\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '');
  if (!d || d.length > MAX_DESCRIPTOR || !DESCRIPTOR_RE.test(d)) return null;
  return d[0].toUpperCase() + d.slice(1);
}

const BUILT_NOUN = { Group: 'Band', Person: 'Musician', Orchestra: 'Orchestra', Choir: 'Choir' };

// Who an act is, in a few words: "Canadian punk rock band", or built from
// MusicBrainz's facts ("Band from Toronto, Canada · since 2011"). A person in
// the comedy family is a comedian, not a musician. null when we can't say.
export function descriptorOf(name, facts, { family } = {}) {
  const p = facts.profiles.get(artistKey(name));
  if (!p) return null;
  const described = performerDescription(p.description);
  if (described) return described;
  if (!p.from) return null;
  const noun = family === 'comedy' && p.type === 'Person' ? 'Comedian' : BUILT_NOUN[p.type];
  if (!noun) return null;
  let span = '';
  if (p.since && !p.until) span = ` · since ${p.since}`;
  else if (p.since && p.until && p.until !== 'ended') span = ` · ${p.since}–${p.until}`;
  return `${noun} from ${p.from}${span}`;
}

// The Apple artist is ours if MusicBrainz linked it, or the name is too
// distinctive to collide (two words, or nine letters: not "PUP" or "Low").
function appleNameSure(profile) {
  if (profile.apple?.match === 'mb') return true;
  const key = artistKey(profile.name || '');
  return key.split(' ').length >= 2 || key.length >= 9;
}

function appleConfident(profile, family) {
  if (profile.apple?.match === 'mb') return true;
  if (!appleNameSure(profile)) return false;
  const genre = profile.apple.genre;
  return family === 'comedy' ? genre === 'Comedy' : !NOT_MUSIC_GENRES.has(genre);
}

// A song to play from the row: the cached top song, only when the Apple match
// is confident. → { url, title, artist } | null
export function previewOf(name, facts, { family = 'music' } = {}) {
  const p = facts.profiles.get(artistKey(name));
  const song = p?.apple?.songs?.[0];
  if (!song?.preview || !appleConfident(p, family)) return null;
  return { url: song.preview, title: song.title || null, artist: p.name || name };
}

// ── The "is it for us" line ─────────────────────────────────────────────────

function curatedText(curated) {
  if (!curated) return null;
  if (typeof curated === 'string') return curated;
  return curated.reason || curated.text || null;
}

// "PUP sounds like Joyce Manor" or "… shares fans with A & B (≈ Joyce Manor)"
// → the favorite it sounds like. The shared neighbours aren't shown on rows.
function similarLink(reason) {
  const text = String(reason.text || '');
  const seed = (text.match(/ sounds like (.+)$/) || text.match(/\(≈ (.+)\)$/))?.[1]?.trim();
  if (!seed) return null;
  // An opener's link mustn't read as the headliner's.
  const opener = text.match(/^Opener (.+?) (?:sounds like|shares fans with) /)?.[1];
  return { kind: 'similar', text: opener ? `Opener ${opener} sounds like ${seed}` : `Sounds like ${seed}`, seed };
}

// The first of: a curated reason, a favorite or starred act on the bill, the
// favorite it sounds like (engine reasons, in that order).
function tasteLink(item) {
  const curated = curatedText(item._curated);
  if (curated) return { kind: 'curated', text: curated };
  const reasons = item._reasons || [];
  for (const kind of ['favorite', 'learned']) {
    const r = reasons.find((x) => x.kind === kind);
    if (r) return { kind, text: r.text };
  }
  const similar = reasons.find((x) => x.kind === 'similar');
  return similar ? similarLink(similar) : null;
}

// A lineup entry that is just the title again ("Author Talk" for "Author
// Talk: Jess Walter", "Hamlet" for "Hamlet") names nobody.
function echoesTitle(name, title) {
  const n = artistKey(name);
  const t = artistKey(title);
  return !n || t === n || t.startsWith(`${n} `);
}

function billLink(item, kind, lineup) {
  if (['night', 'stage', 'other'].includes(kind.family) && usesTitle(kind, lineup)) {
    const acts = lineup.filter((n) => !echoesTitle(n, item.title));
    if (!acts.length) return null;
    const lead = /hosted by/i.test(item.title || '') ? 'hosted by' : 'with';
    return { kind: 'host', text: `${lead} ${nameList(acts)}` };
  }
  if (lineup.length >= 2) return { kind: 'with', text: `with ${nameList(lineup.slice(1))}` };
  return null;
}

// ── Attaching ───────────────────────────────────────────────────────────────

function runtimeText(minutes) {
  const m = Number(minutes);
  if (!m || m <= 0) return null;
  const h = Math.floor(m / 60);
  return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
}

// The synopsis's first sentence, cut at a word to fit one line. "Dr." and
// initials ("J. R. R.") don't end a sentence.
function firstSentence(text, max = 110) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  let end = t.length;
  for (const m of t.matchAll(/[.!?]["”’)]*(?=\s+["“‘(]?[A-Z0-9])/g)) {
    const word = t.slice(0, m.index).split(' ').pop();
    if (/^(?:mrs?|ms|dr|st|jr|sr|mt|vs|no|vol|[a-z](?:\.[a-z])*)$/i.test(word)) continue;
    end = m.index + m[0].length;
    break;
  }
  const s = t.slice(0, end);
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}

function filmFeel(item) {
  const genre = String(item.genre || '').split(/\s*[,/|]\s*/)[0].trim().toLowerCase() || null;
  const crit = item.mc_score != null ? `MC ${item.mc_score}` : item.rt_score != null ? `RT ${item.rt_score}%` : null;
  const curated = curatedText(item._curated);
  const filmText = [item._flags?.[0]?.label, item.director && `dir. ${item.director}`].filter(Boolean).join(' · ');
  let link = null;
  if (curated) link = { kind: 'curated', text: curated };
  else if (filmText) link = { kind: 'film', text: filmText };
  return {
    tags: [],
    tagsFrom: null,
    habit: null,
    bill: null,
    line: [genre, item.year, runtimeText(item.runtime), crit].filter(Boolean).join(' · ') || null,
    synopsis: firstSentence(item.synopsis),
    descriptor: null,
    fans: [],
    link,
    director: item.director || null,
    preview: null,
    known: { similar: false, profile: false },
  };
}

function showFeel(item, facts) {
  const lineup = lineupOf(item);
  const kind = kindFor(item, facts);
  const head = lineup[0] || null;
  // Night, stage and "other" rows lead with their title; the parsed lineup
  // may be a host or just the title again, so it isn't described or played.
  // A DJ night's named DJs are the exception ("Velvet Static (DJ set)"),
  // unless the lineup is the whole title ("Emo Night").
  const performer = Boolean(head) &&
    (!usesTitle(kind, lineup) || (kind.key === 'dj' && artistKey(head) !== artistKey(item.title)));
  const playable = performer && (musicLike(kind) || kind.family === 'comedy');
  const shown = displayTags({ ...item, _kind: kind }, facts);

  const taste = tasteLink(item);
  const fans = performer ? fansOf(item, facts, { exclude: taste?.seed ? [taste.seed] : [] }) : [];
  let link = taste && { kind: taste.kind, text: taste.text };
  if (!link && musicLike(kind) && fans.length) {
    const names = fans.slice(0, 2).map((f) => (f.favorite ? `♥ ${f.name}` : f.name));
    link = { kind: 'fans', text: `For fans of ${names.join(', ')}` };
  }
  if (!link) link = billLink(item, kind, lineup);

  const profile = head ? facts.profiles.get(artistKey(head)) : null;
  return {
    tags: shown.tags,
    tagsFrom: shown.from,
    habit: shown.from === 'venue' ? shown.text : null,
    bill: shown.from === 'bill' ? shown.text : null,
    descriptor: performer ? descriptorOf(head, facts, { family: kind.family }) : null,
    fans,
    link,
    preview: playable ? previewOf(head, facts, { family: kind.family }) : null,
    known: {
      similar: Boolean(head) && hasOwnList(head, facts),
      profile: Boolean(profile && performerDescription(profile.description)),
    },
  };
}

// Set item._feel on each show and film (in place) and return the items.
export function attachFeel(items, { facts } = {}) {
  const f = facts || loadFacts(items, buildContext());
  for (const item of items) item._feel = item.kind === 'film' ? filmFeel(item) : showFeel(item, f);
  return items;
}
