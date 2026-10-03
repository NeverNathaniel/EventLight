// Preference engine — computed at query time (never stored).
//
// An event's score is a sum of independent, explainable parts:
//
//   favorite artist  a favorite is headlining / on the bill (never decays)   6–20
//   starred artist   headliner of an event you marked Interested             4–8
//   sounds like      a lineup act is similar to a favorite (ListenBrainz)    0.7–9
//   genre            your genre weights vs. the event's tags                 0–8.75
//   learned tags     decayed signals from events you marked Interested       0–4
//   penalties        headliner you hid before (−6), tribute act (−3)
//
// The total is then scaled up for shows near your home city (Settings →
// Close to Home: up to +100%, full within 8 mi, none past 18 mi). Only a
// positive total is scaled, so being nearby never makes a pick by itself.
//
// Every part that fires adds a human-readable reason, so the UI can say *why*
// something is a pick ("PUP is a favorite", "Joyce Manor sounds like PUP").
//
// Genre matching is directional and whole-word: a "punk" weight matches an
// event tagged "pop punk", but an "indie rock" weight does NOT match a show
// tagged plain "rock". Matched weights are combined with diminishing returns
// (best + ½·second + ¼·third), so a show with many loosely-related tags can't
// outscore one that squarely fits.
import { getManualGenres, getPreferences, getHomeSetting } from '../db/queries.js';
import {
  getFavoriteArtists,
  getLearnedArtists,
  getHiddenHeadlinerKeys,
  getSimilarArtists,
  similarArtistsVersion,
  parseLineupColumn,
} from '../db/artists.js';
import { artistKey, lineupKeys, isTribute } from '../lineup.js';
import { proximity } from './home.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNAL_HALF_LIFE_WEEKS = 8;
// Cosine between neighbor vectors at which a link counts as fully similar
// (Movements ~ PUP is ≈0.25; unrelated acts sit under ~0.05).
const FULL_SIMILARITY_COSINE = 0.3;
const MIN_SIMILARITY = 0.15;
// Category labels adapters attach to every event — they say nothing about taste.
const GENERIC_TAGS = new Set(['music', 'other', 'live music', 'concert', 'concerts', 'event', 'events']);

export const WEIGHTS = {
  favoriteHeadliner: (w) => 10 + 2 * w,
  favoriteSupport: (w) => 5 + w,
  learnedHeadliner: 8,
  learnedSupport: 4,
  similarHeadliner: (s) => 9 * s,
  similarSupportFactor: 0.5,
  partialGenreMatch: 0.7,
  behavioralCap: 4,
  hiddenHeadliner: -6,
  tribute: -3,
};

// "Post-Hardcore" → "post hardcore", "synth-pop" → "synth pop".
export function normTag(tag) {
  return String(tag || '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTags(list) {
  return String(list || '')
    .split(',')
    .map(normTag)
    .filter((t) => t && !GENERIC_TAGS.has(t));
}

// How well a preference key covers a tag: 1 for an exact match, partial when
// the tag is a more specific form of the key ("punk" ⊂ "pop punk"), 0 otherwise.
export function tagMatch(key, tag) {
  if (!key || !tag) return 0;
  if (key === tag) return 1;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^| )${escaped}(?: |$)`).test(tag) ? WEIGHTS.partialGenreMatch : 0;
}

// Behavioral signal with an 8-week half-life (it used to be count/weeks,
// which dropped a fresh signal to a third of its value in three weeks).
function decayedSignal(pref, now) {
  const last = Date.parse(`${String(pref.last_signal).replace(' ', 'T')}Z`) || Date.parse(pref.last_signal) || now;
  const weeks = Math.max(0, (now - last) / WEEK_MS);
  return pref.signal_count * 0.5 ** (weeks / SIGNAL_HALF_LIFE_WEEKS);
}

// How strongly each artist links to your taste, from the similar-artist rows
// (see similar_artists in schema.sql). Returns Map artist_key →
// { strength 0..1, seed, via[] }.
//
// Each artist with a fetched list is a vector over its neighbors (plus itself),
// and is compared to each favorite's vector by cosine similarity. That covers
// every kind of link at once — X on a favorite's list, a favorite on X's list,
// or the two sharing neighbors ("Movements' listeners also play Joyce Manor
// and Modern Baseball, both close to PUP"). Neighbors are weighted by inverse
// document frequency: hub artists like Radiohead sit on nearly every list, so
// sharing them says little. Artists we only know as a favorite's neighbor
// (no list of their own yet) get that direct score instead.
export function buildSimilarity(rows, favorites, learned) {
  const seeds = new Map();
  for (const [key, f] of favorites) seeds.set(key, { factor: 0.5 + 0.1 * f.weight, name: f.name });
  for (const [key, l] of learned) seeds.set(key, { factor: 0.7, name: l.name });

  const lists = new Map();
  const nameOf = new Map();
  for (const row of rows) {
    if (!lists.has(row.seed_key)) lists.set(row.seed_key, []);
    lists.get(row.seed_key).push(row);
    nameOf.set(row.artist_key, row.name);
    nameOf.set(row.seed_key, row.seed_name);
  }
  const df = new Map();
  for (const row of rows) df.set(row.artist_key, (df.get(row.artist_key) || 0) + 1);
  const n = lists.size;
  // Smoothed to 0..1: 1 for an artist on a single list, ~0.2 for one on two
  // thirds of them — and stable when only a handful of lists exist yet.
  const idf = (key) => Math.log(1 + n / Math.max(1, df.get(key) || 0)) / Math.log(1 + n);

  const vector = (key) => {
    const v = new Map([[key, 1]]);
    for (const row of lists.get(key) || []) v.set(row.artist_key, row.score * idf(row.artist_key));
    let norm = 0;
    for (const x of v.values()) norm += x * x;
    return { v, norm: Math.sqrt(norm) };
  };
  const seedVectors = [...seeds]
    .filter(([key]) => lists.has(key))
    .map(([key, seed]) => ({ key, ...seed, ...vector(key) }));

  const out = new Map();
  const keep = (key, link) => {
    if (seeds.has(key) || link.strength < MIN_SIMILARITY) return;
    const prev = out.get(key);
    if (!prev || link.strength > prev.strength) out.set(key, link);
  };

  // Direct: on a favorite's list, scaled by how distinctive the artist is.
  for (const s of seedVectors) {
    for (const row of lists.get(s.key)) {
      keep(row.artist_key, {
        strength: row.score * Math.sqrt(idf(row.artist_key)) * s.factor,
        seed: s.name,
        via: [],
      });
    }
  }

  // Cosine: any artist whose own list we've fetched.
  for (const key of lists.keys()) {
    if (seeds.has(key)) continue;
    const a = vector(key);
    for (const s of seedVectors) {
      let dot = 0;
      const shared = [];
      for (const [k, x] of a.v) {
        const y = s.v.get(k);
        if (!y) continue;
        dot += x * y;
        if (k !== key && k !== s.key) shared.push({ k, c: x * y });
      }
      if (!dot) continue;
      const cos = dot / (a.norm * s.norm);
      const strength = Math.min(1, cos / FULL_SIMILARITY_COSINE) * s.factor;
      // Name the shared neighbors only when they, not a direct link, carry it.
      const direct = (a.v.get(s.key) || 0) * (s.v.get(s.key) || 0) + (a.v.get(key) || 0) * (s.v.get(key) || 0);
      const via = direct >= dot / 2
        ? []
        : shared.sort((p, q) => q.c - p.c).slice(0, 2).map((x) => nameOf.get(x.k));
      keep(key, { strength, seed: s.name, via });
    }
  }
  return out;
}

let similarityCache = { signature: null, value: null };

// Build a reusable scoring context (loads weights, artists and signals once).
export function buildContext(now = Date.now()) {
  const manualGenres = getManualGenres()
    .map((g) => ({ genre: g.genre, key: normTag(g.genre), weight: g.weight }))
    .filter((g) => g.key);

  const favorites = new Map(
    getFavoriteArtists().map((f) => [f.artist_key, { name: f.name, weight: f.weight }])
  );
  const learned = new Map();
  for (const a of getLearnedArtists()) {
    if (!favorites.has(a.artist_key)) learned.set(a.artist_key, { name: a.name });
  }

  // The similarity model is the expensive part; rebuild it only when the
  // similar lists, favorites or starred artists change.
  const signature = [
    similarArtistsVersion(),
    [...favorites].map(([k, f]) => `${k}:${f.weight}`).join(','),
    [...learned.keys()].join(','),
  ].join('#');
  if (similarityCache.signature !== signature) {
    similarityCache = { signature, value: buildSimilarity(getSimilarArtists(), favorites, learned) };
  }
  const similar = similarityCache.value;

  const hidden = getHiddenHeadlinerKeys();
  for (const key of favorites.keys()) hidden.delete(key);

  const prefs = getPreferences()
    .map((p) => ({ tag: normTag(p.tag), decayed: decayedSignal(p, now) }))
    .filter((p) => p.tag && !GENERIC_TAGS.has(p.tag) && p.decayed > 0.05);

  return { manualGenres, favorites, learned, similar, hidden, prefs, home: getHomeSetting() };
}

function eventLineup(event) {
  if (Array.isArray(event.lineup)) return event.lineup;
  return parseLineupColumn(event.lineup);
}

// Whole-word, case-insensitive containment of an artist name in a title. Used
// as a fallback for favorites the lineup parser missed; short names ("PUP")
// are too collision-prone and must come through the parsed lineup instead.
function titleMentions(paddedTitleKey, key) {
  if (key.length < 5 && !key.includes(' ')) return false;
  return paddedTitleKey.includes(` ${key} `);
}

// Score a single event. Returns { score, base, boost, matched, reasons, tags }.
export function scoreEvent(event, ctx) {
  const reasons = [];
  const lineup = eventLineup(event);
  const keysBySlot = lineup.map((name) => lineupKeys(name));
  const tribute = isTribute(event.title);

  // ── Artists ───────────────────────────────────────────────────────────
  let artistScore = 0;
  const seen = new Set();
  keysBySlot.forEach((keys, slot) => {
    const headliner = slot === 0;
    for (const key of keys) {
      if (seen.has(key)) continue;
      const fav = ctx.favorites.get(key);
      if (fav && !tribute) {
        seen.add(key);
        artistScore += headliner ? WEIGHTS.favoriteHeadliner(fav.weight) : WEIGHTS.favoriteSupport(fav.weight);
        reasons.push({
          kind: 'favorite',
          text: headliner ? `${fav.name} is a favorite` : `Favorite ${fav.name} is on the bill`,
        });
        return;
      }
      const learned = ctx.learned.get(key);
      if (learned && !tribute) {
        seen.add(key);
        artistScore += headliner ? WEIGHTS.learnedHeadliner : WEIGHTS.learnedSupport;
        reasons.push({ kind: 'learned', text: `You starred ${learned.name} before` });
        return;
      }
    }
  });

  // Favorites the parser didn't isolate ("… feat. Laura Stevenson & friends").
  // A mention inside another act's parsed name doesn't count: "Glass Cannons"
  // on the bill is not the band Cannons.
  if (!tribute) {
    const titleKey = ` ${artistKey(event.title)} `;
    const actKeys = keysBySlot.flat().map((k) => ` ${k} `);
    for (const [key, fav] of ctx.favorites) {
      if (seen.has(key) || !titleMentions(titleKey, key)) continue;
      if (actKeys.some((a) => a.includes(` ${key} `))) continue;
      seen.add(key);
      artistScore += WEIGHTS.favoriteSupport(fav.weight);
      reasons.push({ kind: 'favorite', text: `Favorite ${fav.name} is on the bill` });
    }
  }

  // Best "sounds like" link on the bill (headliner counts full, support half).
  let bestSimilar = null;
  keysBySlot.forEach((keys, slot) => {
    for (const key of keys) {
      const sim = ctx.similar.get(key);
      if (!sim || seen.has(key)) continue;
      const value =
        WEIGHTS.similarHeadliner(sim.strength) * (slot === 0 ? 1 : WEIGHTS.similarSupportFactor);
      if (!bestSimilar || value > bestSimilar.value) {
        bestSimilar = { value, sim, headliner: slot === 0, name: lineup[slot] };
      }
    }
  });
  if (bestSimilar && !tribute) {
    artistScore += bestSimilar.value;
    const { sim, name } = bestSimilar;
    const who = `${bestSimilar.headliner ? '' : 'Opener '}${name}`;
    reasons.push({
      kind: 'similar',
      text: sim.via.length
        ? `${who} shares fans with ${sim.via.join(' & ')} (≈ ${sim.seed})`
        : `${who} sounds like ${sim.seed}`,
    });
  }

  // ── Genres ────────────────────────────────────────────────────────────
  // Source tags (e.g. Ticketmaster's) count fully; looked-up artist tags are
  // ordered strongest-first, so later ones count a little less.
  const sourceTags = parseTags(event.genre_tags);
  const artistTags = parseTags(event.artist_tags);
  const weighted = [
    ...sourceTags.map((tag) => ({ tag, f: 1 })),
    ...artistTags.map((tag, i) => ({ tag, f: i < 3 ? 1 : i < 6 ? 0.75 : 0.5 })),
  ];
  const genreHits = [];
  for (const g of ctx.manualGenres) {
    let best = 0;
    for (const { tag, f } of weighted) best = Math.max(best, tagMatch(g.key, tag) * f);
    if (best > 0) genreHits.push({ genre: g.genre, value: g.weight * best });
  }
  genreHits.sort((a, b) => b.value - a.value);
  const base = genreHits.slice(0, 3).reduce((sum, h, i) => sum + h.value / 2 ** i, 0);
  if (genreHits.length) {
    reasons.push({ kind: 'genre', text: genreHits.slice(0, 3).map((h) => h.genre).join(' · ') });
  }

  // ── Learned tags (decayed) ────────────────────────────────────────────
  let behavioral = 0;
  const behavioralHits = [];
  const allTags = weighted.map((w) => w.tag);
  for (const p of ctx.prefs) {
    if (allTags.some((t) => tagMatch(p.tag, t) > 0)) {
      behavioral += p.decayed;
      behavioralHits.push(p.tag);
    }
  }
  behavioral = Math.min(WEIGHTS.behavioralCap, behavioral);
  if (behavioralHits.length) {
    reasons.push({ kind: 'learned-tags', text: `Like shows you starred: ${behavioralHits.slice(0, 2).join(', ')}` });
  }

  // ── Penalties ─────────────────────────────────────────────────────────
  let penalty = 0;
  const headKeys = keysBySlot[0] || [];
  if (headKeys.some((k) => ctx.hidden.has(k))) {
    penalty += WEIGHTS.hiddenHeadliner;
    reasons.push({ kind: 'penalty', text: `You hid ${lineup[0]} before` });
  }
  if (tribute) {
    penalty += WEIGHTS.tribute;
    reasons.push({ kind: 'penalty', text: 'Tribute act' });
  }

  const boost = artistScore + behavioral;
  let total = base + boost + penalty;

  // ── Close to home ─────────────────────────────────────────────────────
  // Scales a show you'd like anyway; it never lifts a show with no match.
  if (total > 0 && ctx.home?.boost > 0) {
    const near = proximity(event.city, ctx.home.city);
    if (near.factor > 0) {
      total *= 1 + (ctx.home.boost / 100) * near.factor;
      reasons.push({
        kind: 'nearby',
        text: near.miles == null ? `Close to home (${event.city})` : `Close to home (${event.city}, ${near.miles} mi)`,
      });
    }
  }
  const score = Math.round(total * 100) / 100;
  const tags = [...new Set([...sourceTags, ...artistTags])];
  return { score, base, boost, matched: genreHits.map((h) => h.genre), reasons, tags, lineup };
}

// Attach `_score` (with breakdown and reasons) to each event. Does not sort.
export function scoreEvents(events, now = Date.now()) {
  const ctx = buildContext(now);
  return events.map((ev) => {
    const s = scoreEvent(ev, ctx);
    return {
      ...ev,
      _score: s.score,
      _base: s.base,
      _boost: s.boost,
      _matched: s.matched,
      _reasons: s.reasons,
      _tags: s.tags,
      _lineup: s.lineup,
    };
  });
}

// Score then sort descending by combined score (ties broken by soonest date).
export function scoreAndRank(events, now = Date.now()) {
  return scoreEvents(events, now).sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return String(a.date).localeCompare(String(b.date));
  });
}

// True when a favorite or starred artist is on the bill — these deserve a
// heads-up no matter how far out the show is.
export function hasArtistMatch(scored) {
  return (scored._reasons || []).some((r) => r.kind === 'favorite' || r.kind === 'learned');
}
