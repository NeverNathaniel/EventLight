// Film taste: how close a film is to the films and shows you love. The
// profile is film-taste.json: your favorites, and the people, genres and
// themes read from them, each naming the favorites it comes from so a film's
// reason can say "Written by Taylor Sheridan (Sicario, Wind River)". It's
// re-read whenever the file changes.
//
// A film's taste score is a sum of explainable parts:
//
//   favorite  the film is one of your favorites                          4
//   people    a director, writer, composer, cinematographer or actor    0–3.5
//             you like: weight × how much the role shapes a film
//             (directing most, then writing, the score or the camera,
//             then acting)
//   genres    Wikidata's genres and the theater's, against your genres   0–2.5
//   themes    the synopsis, against your themes (the frontier, cartels…) 0–1.5
//
// Within a part, matches combine with diminishing returns (best + ½·second +
// ¼·third), so a film that brushes many loose matches can't outscore one
// that squarely fits. Negative weights steer away. The total runs −3 to 6.
// Pure functions apart from loadFilmTaste(); no network.
import fs from 'node:fs';
import { FILM_TASTE_PATH } from '../config.js';
import { artistKey } from '../lineup.js';

export const TASTE = {
  favorite: 4,
  role: { director: 0.6, writer: 0.5, composer: 0.4, cinematographer: 0.4, cast: 0.35 },
  peopleMax: 3.5,
  genre: 0.4,
  partialGenre: 0.8,
  genreMax: 2.5,
  theme: 0.3,
  themeMax: 1.5,
  min: -3,
  max: 6,
};
// A film this close is squarely your kind of film: it says who it's like on
// its row, and a run can be a pick on its opening or last-chance day even
// without the critics behind it.
export const STRONG_TASTE = 3;
// A film's row says who it's like ("Like Sicario & Wind River") from this
// score, and only on a person or a genre worth LINK_HIT — a lone "thriller"
// isn't "like Sicario", and nor is a synopsis that happens to say "cowboy".
export const LINK_TASTE = 1.5;
const LINK_HIT = 0.8;

const ROLE_ORDER = ['director', 'writer', 'composer', 'cinematographer', 'cast'];
const ROLE_TEXT = {
  director: 'Directed by',
  writer: 'Written by',
  composer: 'Score by',
  cinematographer: 'Shot by',
  cast: 'With',
};

// Titles and names compare the way artist names do: no accents, case,
// punctuation or leading "The" ("The Power of the Dog" = "Power of the Dog").
const nameKey = (s) => artistKey(s);

// "Western film" → "western", "neo-noir" → "neo noir", "comedy-drama film" →
// "comedy drama", "post-apocalyptic television series" → "post apocalyptic".
export function genreKey(tag) {
  return String(tag || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\b(?:films?|movies?|television (?:series|programs?)|tv series)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 1 for the same genre, partial when the tag is a more specific form of it
// ("western" ⊂ "contemporary western"), 0 otherwise.
function genreMatch(key, tag) {
  if (!key || !tag) return 0;
  if (key === tag) return 1;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^| )${escaped}(?: |$)`).test(tag) ? TASTE.partialGenre : 0;
}

// best + ½·second + ¼·third…, positives and negatives apart (a film you'd
// like for one reason and not another keeps both).
function combine(values) {
  const sum = (list) => list.reduce((acc, v, i) => acc + v / 2 ** i, 0);
  const pos = values.filter((v) => v > 0).sort((a, b) => b - a);
  const neg = values.filter((v) => v < 0).sort((a, b) => a - b);
  return sum(pos) + sum(neg);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v) => Math.round(v * 100) / 100;
const weightOf = (w, fallback = 3) => (Number.isFinite(Number(w)) ? clamp(Number(w), -5, 5) : fallback);

// Brackets, years and screening words around a title: "Drive (2011) in 35mm",
// "Come and See — 4K Restoration", "No Country for Old Men + Q&A".
const BRACKETS_RE = /\([^)]*\)|\[[^\]]*\]/g;
const SCREENING_WORDS_RE =
  /\b(?:in\s+)?(?:35|70)\s?mm\b|\b4k\b|\b(?:new\s+)?restor(?:ed|ation)\b|\b\d+(?:st|nd|rd|th)\s+anniversary(?:\s+screening)?\b|\bdirector['’]?s\s+cut\b|\bspecial\s+screening\b/gi;
const PART_SPLIT_RE = /\s*(?::|\s[–—-]\s|\s\+\s|\s\|\s|\bpresents\b)\s*/i;
const NOISE_PART_RE =
  /^(?:q ?(?:and|&) ?a|q ?a|talkback|discussion|intro(?:duction)?|double feature|screening|anniversary|sing along|live score|with live score|encore|re ?release|director in person)$/i;

// The ways a listing's title might name a film: the whole title, or one part
// of it as long as nothing after that part is more than screening noise —
// "Throwback Thursday: Drive" names Drive, "Sicario: Day of the Soldado"
// doesn't name Sicario.
export function titleCandidates(title) {
  const clean = String(title || '').replace(BRACKETS_RE, ' ').replace(SCREENING_WORDS_RE, ' ');
  const parts = clean.split(PART_SPLIT_RE).map((p) => p.trim()).filter(Boolean);
  const keys = new Set();
  const whole = nameKey(clean);
  if (whole) keys.add(whole);
  for (let i = 0; i < parts.length; i += 1) {
    const rest = parts.slice(i + 1);
    if (rest.every((p) => NOISE_PART_RE.test(nameKey(p)))) {
      const k = nameKey(parts[i]);
      if (k) keys.add(k);
    }
  }
  return [...keys];
}

const yearOf = (film) => {
  if (Number.isFinite(Number(film.year)) && film.year) return Number(film.year);
  const m = String(film.release_date || '').match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
};

function list(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value || '')
    .split(/\s*(?:,|;|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Names in a credit line: "Joel Coen, Ethan Coen", "Jeff Bridges & Chris Pine".
const people = (value) => list(value).flatMap((s) => s.split(/\s+(?:&|and)\s+/i)).filter(Boolean);

// ── The profile ─────────────────────────────────────────────────────────────
// Compile film-taste.json into lookups. Entries without a name or with a
// theme pattern that doesn't compile are skipped (and listed in `skipped`),
// so one typo can't switch the whole profile off.
export function compileFilmTaste(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const skipped = [];
  const favorites = [];
  for (const [kind, entries] of [['film', raw.favorites?.films], ['tv', raw.favorites?.tv]]) {
    for (const f of entries || []) {
      const title = typeof f === 'string' ? f : f?.title;
      if (!title) continue;
      favorites.push({
        kind,
        title: String(title),
        short: (typeof f === 'object' && f.short) || String(title),
        year: Number(f?.year) || null,
        tmdb: f?.tmdb ? String(f.tmdb) : null,
        key: nameKey(title),
      });
    }
  }
  // A title quoted in a `for` list is shown by its short name.
  const shortOf = new Map();
  for (const f of favorites) shortOf.set(f.key, f.short);
  const cite = (names) => [...new Set(list(names).map((n) => shortOf.get(nameKey(n)) || n))];

  const persons = new Map();
  for (const p of raw.people || []) {
    if (!p?.name) {
      skipped.push(JSON.stringify(p));
      continue;
    }
    const entry = { name: String(p.name), weight: weightOf(p.weight), for: cite(p.for) };
    for (const n of [p.name, ...list(p.aka)]) {
      const k = nameKey(n);
      if (k) persons.set(k, entry);
    }
  }

  const genres = [];
  for (const g of raw.genres || []) {
    const keys = [g?.genre, ...list(g?.aka)].map(genreKey).filter(Boolean);
    if (!keys.length) {
      skipped.push(JSON.stringify(g));
      continue;
    }
    genres.push({ keys, label: g.label || g.genre, weight: weightOf(g.weight), for: cite(g.for) });
  }

  const themes = [];
  for (const t of raw.themes || []) {
    try {
      if (!t?.match) throw new Error('no match');
      themes.push({ re: new RegExp(t.match, 'i'), label: t.label || t.match, weight: weightOf(t.weight), for: cite(t.for) });
    } catch {
      skipped.push(t?.label || JSON.stringify(t));
    }
  }

  return {
    favorites: favorites.filter((f) => f.kind === 'film'),
    // TMDB numbers films and series separately, so only films go by id.
    byTmdb: new Map(favorites.filter((f) => f.kind === 'film' && f.tmdb).map((f) => [f.tmdb, f])),
    // Shows aren't matched by title: a one-word series name ("Barry", "Silo")
    // is too often a film's title as well.
    byTitle: new Map(favorites.filter((f) => f.kind === 'film').map((f) => [f.key, f])),
    persons,
    genres,
    themes,
    count: favorites.length,
    skipped,
  };
}

let cached = { path: null, mtime: null, profile: null };

// The compiled profile, re-read when the file changes. null when there's no
// file (or EVENTLIGHT_FILM_TASTE is set to an empty string, as in tests) or
// it isn't valid JSON — films then score on reviews and occasion alone.
export function loadFilmTaste(file = FILM_TASTE_PATH) {
  if (!file) return null;
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (cached.path === file && cached.mtime === mtime) return cached.profile;
  let profile = null;
  try {
    profile = compileFilmTaste(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (profile?.skipped.length) console.warn(`[film-taste] skipped ${profile.skipped.length} entries:`, profile.skipped.join('; '));
  } catch (err) {
    console.warn(`[film-taste] ${file} is not valid JSON — films score without your taste:`, err.message);
  }
  cached = { path: file, mtime, profile };
  return profile;
}

// ── Matching ────────────────────────────────────────────────────────────────
// Which favorite a film is, if any. The TMDB id decides when both sides have
// one (so a remake or a sequel never passes for the original); otherwise the
// title, and a known year can't be well before the favorite's (a theater's
// "release date" for a repertory screening may be the re-release).
export function favoriteOf(film, profile) {
  if (!profile) return null;
  const tmdb = film.tmdb_id ? String(film.tmdb_id) : null;
  if (tmdb && profile.byTmdb.has(tmdb)) return profile.byTmdb.get(tmdb);
  const year = yearOf(film);
  for (const key of titleCandidates(film.title)) {
    const fav = profile.byTitle.get(key);
    if (!fav) continue;
    if (tmdb && fav.tmdb) continue;
    if (year && fav.year && year < fav.year - 1) continue;
    return fav;
  }
  return null;
}

// Everyone credited on a film, by role: the theater's director and cast, and
// Wikidata's crew (directors, writers, composers, cinematographers).
function credits(film) {
  const crew = film.crew || {};
  return {
    director: [...people(film.director), ...list(crew.director)],
    writer: list(crew.writer),
    composer: list(crew.composer),
    cinematographer: list(crew.cinematographer),
    cast: people(film.starring),
  };
}

// "There Will Be Blood and Phantom Thread"
const andList = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '');
// "A western, like The Proposition and Bone Tomahawk"; "Gothic — not your thing".
const sayLike = (label, weight) => (names) =>
  weight < 0 ? `${label} — not your thing` : names.length ? `${label}, like ${andList(names)}` : label;

function peoplePart(film, profile) {
  const byRole = credits(film);
  const best = new Map(); // person → { role, points }
  for (const role of ROLE_ORDER) {
    for (const name of byRole[role]) {
      const person = profile.persons.get(nameKey(name));
      if (!person || best.has(person)) continue;
      best.set(person, { role, points: person.weight * TASTE.role[role] });
    }
  }
  const hits = [...best].map(([person, { role, points }]) => ({
    part: 'people',
    role,
    points,
    for: person.for,
    say: (names) =>
      points < 0 ? `${person.name} isn't for you` : `${ROLE_TEXT[role]} ${person.name}${names.length ? ` (${names.join(', ')})` : ''}`,
  }));
  return { score: clamp(combine(hits.map((h) => h.points)), TASTE.min, TASTE.peopleMax), hits };
}

function genrePart(film, profile) {
  const tags = [...new Set([...list(film.wd_genres), ...list(film.genre)].map(genreKey).filter(Boolean))];
  // Each tag counts toward its single best genre, so "crime thriller" isn't
  // also counted as "crime" and as "thriller".
  const best = new Map(); // genre → match
  for (const tag of tags) {
    let top = null;
    for (const g of profile.genres) {
      const m = Math.max(...g.keys.map((k) => genreMatch(k, tag)));
      if (m > 0 && (!top || m * Math.abs(g.weight) > top.m * Math.abs(top.g.weight))) top = { g, m };
    }
    if (top && (best.get(top.g) ?? 0) < top.m) best.set(top.g, top.m);
  }
  const hits = [...best].map(([g, m]) => ({
    part: 'genre',
    points: g.weight * m * TASTE.genre,
    for: g.for,
    say: sayLike(g.label, g.weight),
  }));
  return { score: clamp(combine(hits.map((h) => h.points)), TASTE.min, TASTE.genreMax), hits };
}

function themePart(film, profile) {
  const text = String(film.synopsis || '');
  if (!text) return { score: 0, hits: [] };
  const hits = profile.themes
    .filter((t) => t.re.test(text))
    .map((t) => ({
      part: 'theme',
      points: t.weight * TASTE.theme,
      for: t.for,
      say: sayLike(t.label, t.weight),
    }));
  return { score: clamp(combine(hits.map((h) => h.points)), TASTE.min, TASTE.themeMax), hits };
}

// How close a film is to your taste. `film` is a movies row or a film item:
// title, tmdb_id, year / release_date, director, starring, genre, wd_genres,
// crew ({ director, writer, composer, cinematographer }) and synopsis — any
// may be missing. Returns:
//   score     −3..6
//   favorite  the favorite it is, or null
//   strong    score ≥ STRONG_TASTE
//   reasons   [{ kind: 'favorite' | 'similar' | 'penalty', text }], strongest first
//   because   the favorites behind the score: people's and genres' first
//   link      the row's line ({ kind, text }: "One of your favorites",
//             "Like Sicario & Wind River"), or null for a faint match
export function filmTaste(film, profile) {
  const none = { score: 0, favorite: null, strong: false, reasons: [], because: [], link: null };
  if (!profile || !film) return none;
  const favorite = favoriteOf(film, profile);
  const parts = [peoplePart(film, profile), genrePart(film, profile), themePart(film, profile)];
  const score = round(clamp((favorite ? TASTE.favorite : 0) + parts.reduce((a, p) => a + p.score, 0), TASTE.min, TASTE.max));

  // Strongest first; at a tie, who made it, then what it is, then what it's
  // about, then who's in it or on the score ("Sinners": a vampire story
  // before a Ludwig Göransson score).
  const tier = (h) => (h.part === 'people' && (h.role === 'director' || h.role === 'writer') ? 0 : h.part === 'genre' ? 1 : h.part === 'theme' ? 2 : 3);
  const hits = parts.flatMap((p) => p.hits).sort((a, b) => b.points - a.points || tier(a) - tier(b));

  // A favorite's reasons and "like" name your other favorites, never itself.
  const notItself = (name) => !favorite || name !== favorite.short;
  const cited = (h) => h.for.filter(notItself);
  const reasons = [];
  if (favorite) reasons.push({ kind: 'favorite', text: 'One of your favorites' });
  for (const h of hits) {
    if (h.points) reasons.push({ kind: h.points > 0 ? 'similar' : 'penalty', text: h.say(cited(h).slice(0, 2)) });
  }
  // The favorites behind it: people's and genres' first, then themes'.
  const positive = hits.filter((h) => h.points > 0);
  const because = [...new Set([...positive.filter((h) => h.part !== 'theme'), ...positive.filter((h) => h.part === 'theme')].flatMap(cited))];

  // The row names the favorites behind the strongest person or genre match
  // ("Like The Prestige" for a Christopher Nolan film, not "& Atlanta" for
  // its composer). A synopsis is softer evidence: it adds to the score and
  // the reasons, but never names the favorites on the row.
  const lead = positive.find((h) => h.part !== 'theme' && h.points >= LINK_HIT && cited(h).length);
  let link = null;
  if (favorite) link = { kind: 'favorite', text: 'One of your favorites' };
  else if (score >= LINK_TASTE && lead) link = { kind: 'similar', text: `Like ${cited(lead).slice(0, 2).join(' & ')}` };

  return { score, favorite: favorite ? favorite.title : null, strong: score >= STRONG_TASTE, reasons: reasons.slice(0, 5), because, link };
}
