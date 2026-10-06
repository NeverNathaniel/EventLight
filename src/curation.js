// Curation: which few things on a night are worth leading with, and the one
// sentence that sums the night up. `_score` says how well a show fits your
// taste; `_pick` (pickScore) is the editor's view on top of it — a known act
// over an unknown one, a one-night film over a long run, your plans first,
// and the same trivia night every week kept out of the way.
//
// Everything here is a pure function over annotated items (src/annotate.js),
// except two small indexes read from SQLite and the curated.json file. No
// network.
import fs from 'node:fs';
import path from 'node:path';
import db from './db/index.js';
import { DATA_DIR } from './config.js';
import { kindOf, seriesKey, cleanTitle } from './kinds.js';
import { artistKey } from './lineup.js';
import { hasArtistMatch } from './scoring/engine.js';
import { todayISO, addDays, localISO } from './dates.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Dates are calendar days in server-local time, so they're parsed as local.
const weekdayOf = (iso) => new Date(`${iso}T00:00:00`).getDay();
// Rounded, so a daylight-saving change (a 23- or 25-hour day) still counts as one.
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / DAY_MS);

const hasFlag = (item, key) => (item._flags || []).some((f) => f.key === key);
const familyOf = (item) => (item._kind || kindOf(item)).family;
const pickOf = (item) => item._pick ?? pickScore(item);
const titleOf = (item) => item._headline || cleanTitle(item.title);
// Films have no headliner; two listings of one act on a night are one show.
const headlinerOf = (item) =>
  item.kind === 'film' ? null : item.headliner_key || (item._lineup?.[0] ? artistKey(item._lineup[0]) : null);

// ── Films ───────────────────────────────────────────────────────────────────
// A film listed this many times or more is a run (cinema/group.js calls three
// or fewer a special screening).
const RUN_MIN_PEAK = 4;
const FILM_MAX = 9;
const RESTORED_RE = /\b4k\b|restor|35\s?mm|70\s?mm|anniversary/i;

// The critics' score on Metacritic's scale. Rotten Tomatoes percentages run
// high (a 96% is a Metacritic 80-something), so they're scaled down.
function criticScore(film) {
  if (film.mc_score != null) return Number(film.mc_score);
  if (film.rt_score != null) return Math.round(Number(film.rt_score) * 0.85);
  return null;
}

// Is the run's first listed date really its opening? The stored showtimes
// are only the ones still ahead when the theater was last fetched — each
// fetch replaces them — so a film that has been running but doesn't play
// today (weekends only, a dark Wednesday, a matinee that was over by the
// evening refresh) would look like it opens on its next date. Two pieces of
// evidence are required instead:
//   - the release date: an opening is within a day before (Thursday
//     previews) or two after it. A film with no release date, a repertory
//     title or a run that reached this theater weeks after release is never
//     called an opening — a missing "Opens" costs less than a false one;
//   - nothing has dropped off the list: once a showing passes, the most
//     showtimes ever listed (peak) is more than what's left, so the run has
//     already played here.
const OPENS_BEFORE_RELEASE = 1;
const OPENS_AFTER_RELEASE = 2;
function opensNear(film) {
  const release = String(film.release_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(release)) return false;
  const offset = daysBetween(release, film.date);
  if (!(offset >= -OPENS_BEFORE_RELEASE && offset <= OPENS_AFTER_RELEASE)) return false;
  return film.peak == null || film.upcoming == null || film.peak <= film.upcoming;
}

// How much a film on a given date deserves a place among the picks. Films
// aren't matched against your taste, so it's what makes a screening an
// occasion: one night only, the last days of a well-reviewed run, an opening.
//   film: a filmsByDay() item (special, upcoming, peak, firstDate, lastDate,
//         release_date…)
//   horizonByTheater: theater → the last date it has posted showtimes for
export function filmScore(film, { today = todayISO(), horizonByTheater = new Map() } = {}) {
  const special = Boolean(film.special);
  const upcoming = film.upcoming ?? (film.times || []).length;
  const oneNight = special && upcoming === 1;
  const crit = criticScore(film);
  const flags = [];
  const reasons = [];
  let score = special ? (oneNight ? 6 : 5) : 1;
  if (special) reasons.push({ kind: 'film', text: oneNight ? 'One night only' : 'Special screening' });
  if (oneNight) flags.push({ key: 'one-night', label: 'One night only' });

  // A run "ends" when the theater has posted nothing later — but the theater
  // posts only a few weeks ahead, and every run looks like it ends at that
  // edge. So the last date only counts when the theater has listed at least
  // three more days beyond it.
  const run = !special;
  const horizon = horizonByTheater.get(film.venue);
  const lastChance =
    run &&
    (film.peak ?? 0) >= RUN_MIN_PEAK &&
    Boolean(film.lastDate) &&
    (film.lastDate === film.date || film.lastDate === addDays(film.date, 1)) &&
    Boolean(horizon) &&
    film.lastDate <= addDays(horizon, -3);
  // Today's first showing may already be trimmed away, so a run can't be
  // told apart from an opening on today itself.
  const opens = run && Boolean(film.firstDate) && film.firstDate === film.date && film.date > today && opensNear(film);
  if (lastChance) {
    score += 1.5;
    flags.push({ key: 'last-chance', label: 'Last chance' });
    reasons.push({ kind: 'film', text: 'Last chance' });
  }
  if (opens) {
    score += 1;
    flags.push({ key: 'opens', label: 'Opens' });
    reasons.push({ kind: 'film', text: 'Opens tonight' });
  }

  if (crit != null && crit >= 65) {
    score += crit >= 85 ? 3 : crit >= 75 ? 2 : 1;
    reasons.push({
      kind: 'film',
      text: film.mc_score != null ? `Metacritic ${film.mc_score}` : `Rotten Tomatoes ${film.rt_score}%`,
    });
  }
  const restored = RESTORED_RE.test(film.title || '');
  if (restored) score += 0.5;

  return {
    score: Math.min(FILM_MAX, score),
    crit,
    flags,
    // A run is only worth a pick on its first or last days, and only if it's good.
    eligible: special || (crit != null && crit >= 75 && (lastChance || opens)),
    restored,
    reasons,
  };
}

// ── Pick score ──────────────────────────────────────────────────────────────
const MILESTONE_RE = /farewell|reunion|anniversary/i;
// A comedy show's ceiling without a favorite or starred act: a notable
// comedian is worth seeing, but not over a band you love.
const COMEDY_MAX = 8;

// A cancelled show's pick score: below anything real, and finite so it
// survives JSON (−Infinity would arrive as null, and a list falling back to
// _score would star a cancelled favorite).
export const CANCELLED_PICK = -100;

// The editor's score: `_score` plus what the taste match can't see. Uses
// _score, _kind, _flags, _regular, _run, _feel.known, _feel.descriptor,
// _curated, going, interested, source, _lineup and _film.
export function pickScore(item) {
  if (hasFlag(item, 'cancelled')) return CANCELLED_PICK;
  const kind = item._kind || kindOf(item);
  const score = Number(item._score) || 0;
  const lineup = item._lineup || [];
  const yours = hasArtistMatch(item);
  let value;
  switch (kind.family) {
    case 'music': {
      // An act with a ListenBrainz list or a Wikipedia line is a band people
      // know; a bill we couldn't parse a single name from is a guess.
      const known = item._feel?.known || {};
      value = score + (known.similar ? 0.5 : 0) + (known.profile ? 0.5 : 0) - (lineup.length ? 0 : 1);
      if (score >= 3 && (hasFlag(item, 'release') || MILESTONE_RE.test(item.title || ''))) value += 1.5;
      break;
    }
    case 'comedy': {
      // Comedy has no genre tags to match, so a touring name (Ticketmaster
      // only lists the big rooms) or a comedian with a Wikipedia line is
      // the signal. Nameless showcases go to the back.
      const notable = item.source === 'api' || Boolean(item._feel?.descriptor);
      value = score + (notable ? 3 : 0) + (item._run ? 1 : 0);
      if (lineup.length >= 4 && !notable) value -= 3;
      if (!yours) value = Math.min(value, COMEDY_MAX);
      break;
    }
    case 'film':
      value = item._film ? item._film.score : score;
      break;
    case 'stage':
      // A play or a drag show is an evening out even when it matches no tags.
      value = 1 + score;
      break;
    default:
      value = score;
  }
  // Open mics go to the back, comedy or music: an open mic is a night family
  // kind (a comedy one only carries domain 'comedy'), so this sits outside
  // the switch. A genre hit makes "Songwriter Night" look like a show.
  if (kind.key === 'open-mic' && !yours) value -= 3;
  // The same night every week is never news, unless it's your band's residency.
  if (item._regular && !yours) value = Math.min(value, 1);
  if (item.going) value += 5;
  else if (item.interested) value += 2;
  if (item._curated) value += 3;
  if (hasFlag(item, 'sold-out') && !item.going) value *= 0.3;
  return Math.round(value * 100) / 100;
}

// ── Day picks ───────────────────────────────────────────────────────────────
// Below this (after the diversity penalties) nothing is a pick: a quiet night
// gets fewer picks, never filler.
const PICK_FLOOR = 3;
const STARTED_MS = 60 * 60 * 1000;

// The latest start among an item's showtimes: an early show that's over
// doesn't rule out the late one.
export function lastStart(item) {
  const times = [item.time, ...(item._times || []), ...(item.times || [])].filter((t) =>
    /^\d{1,2}:\d{2}/.test(t || '')
  );
  return times.map((t) => t.padStart(5, '0').slice(0, 5)).sort().pop() || null;
}

// True when an item's last start was over an hour before `now`. Callers
// decide which day it applies to (only today).
export function startedLongAgo(item, now) {
  const t = lastStart(item);
  if (!t) return false;
  return now - new Date(`${item.date}T${t}:00`).getTime() > STARTED_MS;
}

// Picking a second punk show at the same club is less useful than a film or
// a comedian, even when the punk show scores a little higher.
function diversity(item, chosen) {
  const family = familyOf(item);
  const venue = artistKey(item.venue);
  const genre = item._feel?.tags?.[0]?.tag || null;
  let factor = 0.7 ** chosen.filter((c) => familyOf(c) === family).length;
  if (venue && chosen.some((c) => artistKey(c.venue) === venue)) factor *= 0.5;
  if (genre && chosen.some((c) => c._feel?.tags?.[0]?.tag === genre)) factor *= 0.85;
  return factor;
}

function dayRole(item, first) {
  if (item.going) return { key: 'plan', label: 'Your plan' };
  if (first) return { key: 'pick', label: 'The pick' };
  const family = familyOf(item);
  if (family === 'film') return { key: 'film', label: hasFlag(item, 'one-night') ? 'One night only' : 'At the movies' };
  if (family === 'comedy') return { key: 'laugh', label: 'For a laugh' };
  return { key: 'also', label: 'Also good' };
}

const byPick = (a, b) => pickOf(b) - pickOf(a);

// Up to `k` picks for one day: shows you're going to first, then a greedy
// pass that takes the best `_pick` after penalties for repeating a family,
// a venue or a genre. Never picked: cancelled or sold-out shows, regulars
// (unless a favorite or starred act), a film run off its first or last
// days, a second film, an act already picked, and on today anything that
// started over an hour ago. Returns copies carrying `_role` (so the same
// item in the day's groups has none), Going first, then strongest first,
// plus a label: 'top' when there are picks, 'started' when nothing is left
// to pick only because tonight's best has already started, 'regulars' when
// the only things on are the weekly regulars, else 'none'.
export function chooseDayPicks(items, { k = 3, now = Date.now(), today = localISO(new Date(now)), date } = {}) {
  const live = items.filter((e) => !hasFlag(e, 'cancelled'));
  // A plan stays a plan once it starts; everything else that began an hour
  // ago is too late to recommend.
  const plans = live.filter((e) => e.going).sort(byPick);
  const late = (e) => (date ?? e.date) === today && startedLongAgo(e, now);
  const open = live.filter((e) => !e.going && !late(e));
  const isRegular = (e) => Boolean(e._regular) && !hasArtistMatch(e);
  const filmOk = (e) => e.kind !== 'film' || Boolean(e._film?.eligible);
  // ×0.3 alone would still let a sold-out favorite through; you can't buy in.
  const pickable = (e) => !isRegular(e) && filmOk(e) && !hasFlag(e, 'sold-out') && pickOf(e) >= PICK_FLOOR;
  const candidates = open.filter(pickable);

  const chosen = plans.slice(0, k);
  while (chosen.length < k) {
    let best = null;
    for (const e of candidates) {
      if (chosen.includes(e)) continue;
      const head = headlinerOf(e);
      if (head && chosen.some((c) => headlinerOf(c) === head)) continue;
      if (familyOf(e) === 'film' && chosen.some((c) => familyOf(c) === 'film')) continue;
      const value = pickOf(e) * diversity(e, chosen);
      if (value >= PICK_FLOOR && (!best || value > best.value)) best = { e, value };
    }
    if (!best) break;
    chosen.push(best.e);
  }

  const others = chosen.filter((e) => !e.going).sort(byPick);
  const picks = [...chosen.filter((e) => e.going), ...others].map((e) => ({
    ...e,
    _role: dayRole(e, e === others[0]),
  }));
  let label = 'none';
  if (picks.length) label = 'top';
  else if (live.some((e) => !e.going && late(e) && pickable(e))) label = 'started';
  else if (open.length && open.every(isRegular)) label = 'regulars';
  return { picks, label };
}

// ── Week tickets ────────────────────────────────────────────────────────────
// The week's top picks: shows you're going to, then the strongest of the
// rest (`_pick` ≥ pickMin, not sold out) with a spread — at most two a
// night, each act once (its best night), one film (a strong one) and two
// comedy shows. Best first. As with the day's picks, tonight's shows that
// started over an hour ago are left out (plans stay), so the tickets and
// the day's sentence agree.
export function chooseWeekPicks(items, { max = 8, pickMin = 8, now = Date.now(), today = localISO(new Date(now)) } = {}) {
  const byPickThenDate = (a, b) =>
    pickOf(b) - pickOf(a) ||
    String(a.date).localeCompare(String(b.date)) ||
    String(a.time || '').localeCompare(String(b.time || ''));
  const live = items.filter((e) => !hasFlag(e, 'cancelled'));
  const plans = live.filter((e) => e.going).sort(byPickThenDate);
  const filmOk = (e) => e.kind !== 'film' || (Boolean(e._film?.eligible) && e._film.score >= 8);
  const late = (e) => e.date === today && startedLongAgo(e, now);
  const rest = live
    .filter((e) => !e.going && !late(e) && !hasFlag(e, 'sold-out') && pickOf(e) >= pickMin && filmOk(e))
    .sort(byPickThenDate);

  const chosen = [];
  const perDate = new Map();
  const heads = new Set();
  const counts = { film: 0, comedy: 0 };
  const take = (e) => {
    chosen.push(e);
    perDate.set(e.date, (perDate.get(e.date) || 0) + 1);
    const head = headlinerOf(e);
    if (head) heads.add(head);
    const family = familyOf(e);
    if (family in counts) counts[family] += 1;
  };
  for (const e of plans) if (chosen.length < max) take(e);
  for (const e of rest) {
    if (chosen.length >= max) break;
    const family = familyOf(e);
    if ((perDate.get(e.date) || 0) >= 2) continue;
    if (heads.has(headlinerOf(e))) continue;
    if (family === 'film' && counts.film >= 1) continue;
    if (family === 'comedy' && counts.comedy >= 2) continue;
    take(e);
  }
  return chosen;
}

// ── Day dek ─────────────────────────────────────────────────────────────────
const DEK_MAX = 110;
const COMEDY_WORDS = { improv: 'improv', podcast: 'a podcast taping' };

// "The Crocodile" mid-sentence reads "the Crocodile".
const venueName = (venue) => String(venue || '').trim().replace(/^the\s+/i, 'the ');
// "The Grand Cinema" → "the Grand", "SIFF Cinema Uptown" → "SIFF Uptown".
function theaterName(venue) {
  const short = String(venue || '')
    .replace(/\b(?:cinemas?|theat(?:er|re)s?|movie ?house|film center)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return venueName(short || venue);
}

// The headliner and the favorite they sound like, from the engine's reason
// ("Movements sounds like PUP", "Movements shares fans with A & B (≈ PUP)").
// An opener's resemblance doesn't describe the show.
function soundsLike(item) {
  const reason = (item._reasons || []).find((r) => r.kind === 'similar');
  if (!reason || /^Opener /.test(reason.text)) return null;
  const m =
    /^(.+?) shares fans with .+ \(≈ (.+)\)$/.exec(reason.text) || /^(.+?) sounds like (.+)$/.exec(reason.text);
  return m ? { name: m[1], seed: m[2] } : null;
}

// What one pick adds to the day's sentence. Favorites and sound-alikes come
// back as parts so two of them can share a phrase ("favorites at A and B",
// "X and Y, who sound like Z").
function dekPart(p) {
  const kind = p._kind || kindOf(p);
  const venue = venueName(p.venue);
  if (p.going || p._role?.key === 'plan') return { text: `your night at ${venue}` };
  if ((p._reasons || []).some((r) => r.kind === 'favorite')) return { type: 'favorite', venue };
  const similar = soundsLike(p);
  if (similar) return { type: 'similar', ...similar };
  if (kind.family === 'film') {
    if (hasFlag(p, 'one-night')) return { text: `a one-night ${titleOf(p)}` };
    if (hasFlag(p, 'last-chance')) return { text: `last call for ${titleOf(p)}` };
    return { text: `${titleOf(p)} at ${theaterName(p.venue)}` };
  }
  if (kind.family === 'comedy') {
    const what = COMEDY_WORDS[kind.key] || 'stand-up';
    return { text: p.city ? `${what} in ${p.city}` : `${what} at ${venue}` };
  }
  // A band is described by its sound; a night (an open mic, a DJ night) by its name.
  const hit = kind.family === 'music' && (p._feel?.tags || []).find((t) => t.hit);
  if (hit) return { text: `${hit.tag} at ${venue}` };
  return { text: `${titleOf(p)} at ${venue}` };
}

const andList = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0]);

// The picks' parts as phrases, with favorites and same-seed sound-alikes
// sharing one, and repeats dropped.
function dekPhrases(picks) {
  const parts = [];
  for (const part of picks.slice(0, 3).map(dekPart)) {
    const same = parts.find((x) => x.type && x.type === part.type && (part.type === 'favorite' || x.seed === part.seed));
    if (same) {
      if (part.type === 'favorite') same.venues.push(part.venue);
      else same.names.push(part.name);
      continue;
    }
    if (part.text && parts.some((x) => x.text === part.text)) continue;
    parts.push(part.type === 'favorite' ? { ...part, venues: [part.venue] } : part.type === 'similar' ? { ...part, names: [part.name] } : part);
  }
  return parts.map((x) => {
    if (x.type === 'favorite') {
      const venues = [...new Set(x.venues)];
      if (x.venues.length === 1) return `a favorite at ${venues[0]}`;
      return venues.length === 1 ? `${x.venues.length === 2 ? 'two' : 'three'} favorites at ${venues[0]}` : `favorites at ${andList(venues)}`;
    }
    if (x.type === 'similar') {
      return x.names.length > 1 ? `${andList(x.names)}, who sound like ${x.seed}` : `${x.name}, who sounds like ${x.seed}`;
    }
    return x.text;
  });
}

// "A, B and C." with the first letter capitalised — or "A, and B." when a
// phrase has its own "and" or a "who…" clause, so the last one doesn't run
// into it ("Movements, who sounds like PUP, and indie rock at the Valley").
function sentence(parts) {
  let body = parts[0];
  if (parts.length > 1) {
    const inner = parts.some((x) => / and |, who /.test(x));
    body = `${parts.slice(0, -1).join(', ')}${inner ? ', and ' : ' and '}${parts[parts.length - 1]}`;
  }
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}

// One sentence about the day, from its picks in order — the same picks
// always give the same sentence. At most 110 characters: trailing phrases
// are dropped to fit.
//   counts: { total, regulars, … } for the whole day (shows and films)
//   regularKinds: lowercase kind labels of the day's regulars ('trivia', …)
//   label: chooseDayPicks' label ('started' says why there are no picks)
export function dayDek(picks, { counts, regularKinds = [], label } = {}) {
  if (!picks.length) {
    const total = counts?.total || 0;
    if (!total) return 'Nothing listed yet.';
    if (label === 'started') return 'Tonight’s best has already started.';
    if ((counts.regulars || 0) >= total) {
      const kinds = [...new Set(regularKinds)].slice(0, 3);
      return kinds.length ? `Quiet one: just the regulars (${kinds.join(', ')}).` : 'Quiet one: just the regulars.';
    }
    return 'Nothing close to your taste. Everything on is below.';
  }
  const parts = dekPhrases(picks);
  while (parts.length > 1 && sentence(parts).length > DEK_MAX) parts.pop();
  const text = sentence(parts);
  if (text.length <= DEK_MAX) return text;
  // One very long title: cut at a word and say so.
  return `${text.slice(0, DEK_MAX - 1).replace(/\s+\S*$/, '').replace(/[\s,]+$/, '')}…`;
}

// ── Week note ───────────────────────────────────────────────────────────────
// One line under the Week's dates: the strongest night (its best pick, plus
// half the second so a night with two good shows beats one with one) and the
// nights with nothing to pick. Null when the whole week is quiet. Tonight
// with no picks left only because its best shows have started isn't quiet:
// the day's own sentence says "Tonight’s best has already started".
//   days: [{ date, picks, picksLabel }]
export function weekNote(days) {
  let best = null;
  const quiet = [];
  for (const day of days || []) {
    const picks = day.picks || [];
    if (!picks.length) {
      if (day.picksLabel !== 'started') quiet.push(day.date);
      continue;
    }
    const value = (picks[0]._pick || 0) + 0.5 * (picks[1]?._pick || 0);
    if (!best || value > best.value) best = { date: day.date, value, name: titleOf(picks[0]) };
  }
  if (!best) return null;
  let text = `Best night: ${LONG_DAYS[weekdayOf(best.date)]} (${best.name}).`;
  if (quiet.length) text += ` Quiet: ${quiet.map((d) => SHORT_DAYS[weekdayOf(d)]).join(', ')}.`;
  return { text, bestNight: best.date, quiet };
}

// ── Regulars and runs ───────────────────────────────────────────────────────
// Recurring nights are found from history as well as listings: past rows are
// kept (pruning only drops future ones), so a trivia night that has run every
// Thursday for two months is known even if the venue lists one week at a time.
const REGULAR_BACK_DAYS = 56;
const REGULAR_AHEAD_DAYS = 42;
const RUN_MAX_GAP = 4;
const CADENCE_WORD_RE = /\b(?:every|weekly|monthly|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/i;

const isWeekly = (g) => g >= 6 && g <= 8;
const isFortnightly = (g) => g >= 13 && g <= 15;
const isMonthly = (g) => g >= 27 && g <= 36;
// The lower middle, so one skipped week ([7, 14]) still reads as weekly.
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor((list.length - 1) / 2)];

// Weekdays in the order a week is read, Monday first.
const weekOrder = (day) => (day + 6) % 7;

// "Tue & Thu", "Mon, Wed & Fri", "Thu–Sun" (three or more days in a row).
function dayList(days) {
  const sorted = [...days].sort((a, b) => weekOrder(a) - weekOrder(b));
  const spans = [];
  for (const day of sorted) {
    const last = spans[spans.length - 1];
    if (last && weekOrder(day) === weekOrder(last[last.length - 1]) + 1) last.push(day);
    else spans.push([day]);
  }
  const parts = spans.flatMap((span) =>
    span.length >= 3 ? [`${SHORT_DAYS[span[0]]}–${SHORT_DAYS[span[span.length - 1]]}`] : span.map((d) => SHORT_DAYS[d])
  );
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}` : parts[0];
}

// The weekdays on which a series keeps a steady interval of its own: three
// dates a week, a fortnight or a month apart, or — for trivia, karaoke and
// open mics — two a week or a fortnight apart. Each weekday is checked on
// its own because two nights a week interleave: a Tuesday-and-Thursday
// karaoke night's gaps run 2, 5, 2, 5 and read as no cadence at all.
//   → [{ day, gap }], Monday first
function steadyWeekdays(dates, { night }) {
  const byDay = new Map();
  for (const d of dates) {
    const day = weekdayOf(d);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(d);
  }
  const out = [];
  for (const [day, list] of byDay) {
    const gaps = list.slice(1).map((d, i) => daysBetween(list[i], d));
    if (!gaps.length) continue;
    const gap = median(gaps);
    const steady = list.length >= 3 && (isWeekly(gap) || isFortnightly(gap) || isMonthly(gap));
    if (steady || (night && gaps.some((g) => g === 7 || g === 14))) out.push({ day, gap });
  }
  return out.sort((a, b) => weekOrder(a.day) - weekOrder(b.day));
}

function cadenceOf(dates, titles, steady) {
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
  const gap = gaps.length ? median(gaps) : null;
  if ((gap != null && isMonthly(gap)) || (gap == null && titles.some((t) => /\bmonthly\b/i.test(t)))) return 'Monthly';
  if (steady.length === 7) return 'Every night';
  if (steady.length > 1) return `Every ${dayList(steady.map((s) => s.day))}`;
  if (steady.length === 1) {
    const { day, gap: own } = steady[0];
    if (isMonthly(own)) return 'Monthly';
    return isFortnightly(own) ? `Every other ${SHORT_DAYS[day]}` : `Every ${SHORT_DAYS[day]}`;
  }
  const weekdays = new Set(dates.map(weekdayOf));
  if (weekdays.size !== 1) return 'Weekly';
  const day = SHORT_DAYS[weekdayOf(dates[0])];
  return gap != null && isFortnightly(gap) ? `Every other ${day}` : `Every ${day}`;
}

// A play's performances fall on the same weekdays week after week (Thursday
// to Sunday for a month) and are a run, not a regular — so the weekday check
// isn't used for stage kinds, or for untagged listings ('event'), which is
// where an unlabelled play lands. A weekly drag brunch on one day still
// counts through the whole-series check.
const weekdaysCount = (kind) => kind.family !== 'stage' && kind.key !== 'event';

function findRegulars(rows, kinds) {
  const bySeries = new Map();
  for (const r of rows) {
    const series = seriesKey(r, kinds.get(r.id));
    // A title that was nothing but dates and numbers has no stem to match on.
    if (series.endsWith('|')) continue;
    if (!bySeries.has(series)) bySeries.set(series, []);
    bySeries.get(series).push(r);
  }
  const out = new Map();
  for (const [series, list] of bySeries) {
    const dates = [...new Set(list.map((r) => r.date))].sort();
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const gap = gaps.length ? median(gaps) : null;
    const listKinds = list.map((r) => kinds.get(r.id));
    // Trivia and open mics are regulars by nature: two listings a week or a
    // fortnight apart, or a title that says so ("every Tuesday"), is enough.
    const night = listKinds.some((k) => k.family === 'night');
    const steady = listKinds.every(weekdaysCount) ? steadyWeekdays(dates, { night }) : [];
    const regular =
      (dates.length >= 3 && (isWeekly(gap) || isFortnightly(gap) || isMonthly(gap))) ||
      steady.length > 0 ||
      (night && list.some((r) => CADENCE_WORD_RE.test(r.title || '')));
    if (!regular) continue;
    const info = { series, cadence: cadenceOf(dates, list.map((r) => r.title || ''), steady) };
    for (const r of list) out.set(r.id, info);
  }
  return out;
}

// "Thu–Sat" for a few nights in a row; "Until Oct 26" for a longer stretch.
function runText(dates) {
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (daysBetween(first, last) <= 6) return `${SHORT_DAYS[weekdayOf(first)]}–${SHORT_DAYS[weekdayOf(last)]}`;
  const d = new Date(`${last}T00:00:00`);
  return `Until ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// A band or a comedian on more nights in a row than this is a house night
// whose "run" would end wherever the listings do, not a run.
const RUN_MAX_SPAN = 7;

// The same act at the same venue on nights a few days apart: a comedian's
// Thursday-to-Saturday weekend, a band's two-night stand, a play's run.
// Regulars are decided first and never become runs, and a night (a jam, a
// karaoke night) is never a run: its Tuesday and Thursday aren't one stretch.
function findRuns(rows, kinds, regular) {
  const byAct = new Map();
  for (const r of rows) {
    if (!r.headliner_key || regular.has(r.id) || kinds.get(r.id).family === 'night') continue;
    const key = `${artistKey(r.venue)}|${r.headliner_key}`;
    if (!byAct.has(key)) byAct.set(key, []);
    byAct.get(key).push(r);
  }
  const out = new Map();
  for (const list of byAct.values()) {
    const dates = [...new Set(list.map((r) => r.date))].sort();
    if (dates.length < 2) continue;
    const act = ['music', 'comedy'].includes(kinds.get(list[0].id).family);
    const stretches = [[dates[0]]];
    for (const d of dates.slice(1)) {
      const current = stretches[stretches.length - 1];
      if (daysBetween(current[current.length - 1], d) <= RUN_MAX_GAP) current.push(d);
      else stretches.push([d]);
    }
    for (const stretch of stretches) {
      if (stretch.length < 2) continue;
      if (act && daysBetween(stretch[0], stretch[stretch.length - 1]) > RUN_MAX_SPAN) continue;
      const info = { text: runText(stretch), dates: stretch };
      for (const r of list) if (stretch.includes(r.date)) out.set(r.id, info);
    }
  }
  return out;
}

const eventsSignature = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS at, SUM(hidden) AS hidden FROM events');
const windowRows = db.prepare(
  `SELECT id, title, venue, date, time, category, genre_tags, lineup, headliner_key
   FROM events WHERE hidden = 0 AND date BETWEEN ? AND ?`
);
let regularsCache = { key: null, value: null };

// Which events are a regular night and which are part of a run, for events
// from eight weeks back to six weeks ahead of `today`:
//   { regular: Map<eventId, { series, cadence }>, run: Map<eventId, { text, dates }> }
// Rebuilt only when the events table changes (or the day does).
export function regularsIndex(today = todayISO()) {
  const sig = eventsSignature.get();
  const key = `${today}|${sig.n}|${sig.at}|${sig.hidden}`;
  if (regularsCache.key === key) return regularsCache.value;
  const rows = windowRows.all(addDays(today, -REGULAR_BACK_DAYS), addDays(today, REGULAR_AHEAD_DAYS));
  const kinds = new Map(rows.map((r) => [r.id, kindOf(r)]));
  // Regulars first: a Tuesday-and-Thursday jam is a regular, not a
  // "Tue–Thu" run, and a nightly happy hour isn't a run "until" the last
  // date anyone has listed.
  const regular = findRegulars(rows, kinds);
  const run = findRuns(rows, kinds, regular);
  regularsCache = { key, value: { regular, run } };
  return regularsCache.value;
}

// ── curated.json ────────────────────────────────────────────────────────────
// The /curate routine (.claude/commands/curate.md) writes a hand-picked list
// with a reason for each show. A week-old list was made for a different set
// of listings, so it's dropped rather than trusted.
const CURATED_MAX_AGE_MS = 7 * DAY_MS;
let curatedCache = { file: null, mtimeMs: null, value: null };

function readCurated(file, mtimeMs) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!doc || !Array.isArray(doc.events)) return null;
  const criteria = doc.criteria || null;
  const reasons = new Map();
  for (const entry of doc.events) {
    if (entry?.id == null) continue;
    // Event ids are integers; the file may spell them as strings.
    const id = /^\d+$/.test(String(entry.id)) ? Number(entry.id) : entry.id;
    reasons.set(id, entry.reason || (criteria ? `Fits "${criteria}"` : 'Curated'));
  }
  const generatedAt = Date.parse(doc.generated_at || '');
  return {
    at: Number.isFinite(generatedAt) ? generatedAt : mtimeMs,
    curated: { criteria, generated_at: doc.generated_at || null, reasons },
  };
}

// → { criteria, generated_at, reasons: Map<eventId, reason> } | null.
// Re-read only when the file changes.
export function loadCurated(now = Date.now(), { file = path.join(DATA_DIR, 'curated.json') } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (curatedCache.file !== file || curatedCache.mtimeMs !== stat.mtimeMs) {
    curatedCache = { file, mtimeMs: stat.mtimeMs, value: readCurated(file, stat.mtimeMs) };
  }
  const value = curatedCache.value;
  if (!value || now - value.at > CURATED_MAX_AGE_MS) return null;
  return value.curated;
}
