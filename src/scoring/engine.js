// Preference engine — two layers, computed at query time (never stored).
//
//   Layer 1 (manual):     base score = Σ manual genre weights for matched genres
//   Layer 2 (behavioral): boost      = Σ decayed signal counts for matched tags
//   Combined score sorts "Top Picks" and the relevance sort option.
import { getManualGenres, getPreferences } from '../db/queries.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function parseTags(genreTags) {
  return String(genreTags || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

// Tolerant token match: equal, or one contains the other (e.g. "indie" ~ "indie rock").
function tokenMatches(token, key) {
  if (!token || !key) return false;
  return token === key || token.includes(key) || key.includes(token);
}

// Decay a behavioral signal: signal_count / weeks-since-last-signal, divisor floored at 1.
function decayedSignal(pref, now = Date.now()) {
  const last = Date.parse(`${pref.last_signal}Z`) || Date.parse(pref.last_signal) || now;
  const weeks = (now - last) / WEEK_MS;
  const divisor = Math.max(1, weeks);
  return pref.signal_count / divisor;
}

// Build a reusable scoring context (loads weights + signals once).
export function buildContext(now = Date.now()) {
  const manualGenres = getManualGenres(); // [{ genre, weight }]
  const prefs = getPreferences().map((p) => ({
    tag: p.tag,
    decayed: decayedSignal(p, now),
  }));
  return { manualGenres, prefs };
}

// Score a single event against a context. Returns { base, boost, score, matched }.
export function scoreEvent(event, ctx) {
  const tags = parseTags(event.genre_tags);
  // Behavioral layer also considers the artist name as a matchable token.
  const behavioralTokens = [...tags];
  if (event.artist) behavioralTokens.push(String(event.artist).trim().toLowerCase());

  let base = 0;
  const matched = new Set();
  for (const { genre, weight } of ctx.manualGenres) {
    if (tags.some((t) => tokenMatches(t, genre))) {
      base += weight;
      matched.add(genre);
    }
  }

  let boost = 0;
  for (const { tag, decayed } of ctx.prefs) {
    if (behavioralTokens.some((t) => tokenMatches(t, tag))) {
      boost += decayed;
      matched.add(tag);
    }
  }

  const score = base + boost;
  return { base, boost, score, matched: [...matched] };
}

// Attach a `_score` (and breakdown) to each event. Does not sort.
export function scoreEvents(events, now = Date.now()) {
  const ctx = buildContext(now);
  return events.map((ev) => {
    const s = scoreEvent(ev, ctx);
    return { ...ev, _score: s.score, _base: s.base, _boost: s.boost, _matched: s.matched };
  });
}

// Score then sort descending by combined score (ties broken by soonest date).
export function scoreAndRank(events, now = Date.now()) {
  return scoreEvents(events, now).sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return String(a.date).localeCompare(String(b.date));
  });
}
