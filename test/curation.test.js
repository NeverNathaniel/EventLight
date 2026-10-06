// Tests for curation: the film score, the editor's pick score, a day's picks
// and the week's tickets, the day's one-line dek and the week note, regular
// nights and runs, and the curated.json fold-in. Items are plain objects with
// the fields annotate() would add. In-memory database; no network.
import './helpers/memory-db.js'; // must stay the first import
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { upsertEvent } = await import('../src/db/queries.js');
const {
  filmScore,
  pickScore,
  chooseDayPicks,
  chooseWeekPicks,
  dayDek,
  weekNote,
  regularsIndex,
  loadCurated,
} = await import('../src/curation.js');

migrate();

// Friday 11 January 2030; "today" is the Thursday before, unless a test says so.
const D = '2030-01-11';
const TODAY = '2030-01-10';
const MORNING = new Date(2030, 0, 11, 9, 0).getTime();
const at = (opts = {}) => ({ now: MORNING, today: TODAY, date: D, ...opts });
const GRAND = 'The Grand Cinema';
const horizonByTheater = new Map([[GRAND, '2030-01-31']]);

// ── Item builders ───────────────────────────────────────────────────────────
let n = 0;
const KINDS = {
  music: { key: 'music', label: 'Music', family: 'music' },
  comedy: { key: 'comedy', label: 'Stand-up', family: 'comedy' },
  improv: { key: 'improv', label: 'Improv', family: 'comedy' },
  theater: { key: 'theater', label: 'Theater', family: 'stage' },
  trivia: { key: 'trivia', label: 'Trivia', family: 'night' },
  film: { key: 'film', label: 'Film', family: 'film' },
};

// A show. `pick` sets _pick; leave it undefined to have pickScore work it out.
function show(kind, pick, { tags = [], ...fields } = {}) {
  n += 1;
  const item = {
    id: n,
    kind: kind === 'comedy' || kind === 'improv' ? 'comedy' : kind === 'music' ? 'music' : 'other',
    title: `Act ${n}`,
    date: D,
    time: '20:00',
    venue: `Venue ${n}`,
    city: 'Tacoma',
    source: 'scrape',
    headliner_key: `act ${n}`,
    going: 0,
    interested: 0,
    _score: 0,
    _reasons: [],
    _lineup: [`Act ${n}`],
    _kind: KINDS[kind],
    _flags: [],
    _feel: { tags: tags.map((tag) => ({ tag, hit: false })), known: { similar: false, profile: false }, descriptor: null },
    _regular: null,
    _run: null,
    _curated: null,
    ...fields,
  };
  if (pick !== undefined) item._pick = pick;
  return item;
}
const music = (pick, fields) => show('music', pick, fields);
const comedy = (pick, fields) => show('comedy', pick, fields);

// A film for one date: a one-night screening unless `_film`/`_flags` say otherwise.
function film(pick, fields = {}) {
  n += 1;
  const item = {
    id: `film-${n}-${fields.date || D}`,
    kind: 'film',
    title: `Film ${n}`,
    date: D,
    time: '19:00',
    times: ['19:00'],
    venue: GRAND,
    city: 'Tacoma',
    _score: pick ?? 6,
    _reasons: [],
    _kind: KINDS.film,
    _flags: [{ key: 'one-night', label: 'One night only' }],
    _feel: { tags: [], known: { similar: false, profile: false } },
    _film: { score: pick ?? 6, eligible: true, flags: [], reasons: [] },
    ...fields,
  };
  if (pick !== undefined) item._pick = pick;
  return item;
}

const favorite = (name = 'PUP') => [{ kind: 'favorite', text: `${name} is a favorite` }];
const ids = (list) => list.map((e) => e.id);

// ── filmScore ───────────────────────────────────────────────────────────────
const runFilm = (fields) => ({
  title: 'Anora',
  venue: GRAND,
  date: D,
  special: false,
  peak: 24,
  upcoming: 18,
  firstDate: '2029-12-20',
  lastDate: '2030-01-24',
  mc_score: 88,
  ...fields,
});
const scoreOf = (fields, opts = {}) => filmScore(runFilm(fields), { today: TODAY, horizonByTheater, ...opts });

test('filmScore: a one-night screening with no reviews scores 6 and is a pick candidate', () => {
  const f = scoreOf({ special: true, upcoming: 1, peak: 1, mc_score: null, title: 'Paris, Texas' });
  assert.equal(f.score, 6);
  assert.equal(f.crit, null);
  assert.equal(f.eligible, true);
  assert.deepEqual(f.flags, [{ key: 'one-night', label: 'One night only' }]);
  assert.deepEqual(f.reasons.map((r) => r.text), ['One night only']);
});

test('filmScore: a one-night screening with Metacritic 90 scores 9 — enough for a week ticket', () => {
  const f = scoreOf({ special: true, upcoming: 1, peak: 1, mc_score: 90 });
  assert.equal(f.score, 9);
  assert.deepEqual(f.reasons.map((r) => r.text), ['One night only', 'Metacritic 90']);
});

test('filmScore: a special with several showtimes scores 5, says "Special screening" and has no flag', () => {
  const f = scoreOf({ special: true, upcoming: 3, peak: 3, mc_score: null });
  assert.equal(f.score, 5);
  assert.deepEqual(f.flags, []);
  assert.deepEqual(f.reasons.map((r) => r.text), ['Special screening']);
  assert.equal(f.eligible, true);
});

test('filmScore: a run with Metacritic 88 on an ordinary day scores 4 and is not a pick', () => {
  const f = scoreOf({});
  assert.equal(f.score, 4);
  assert.equal(f.eligible, false);
  assert.deepEqual(f.flags, []);
});

test('filmScore: the same run on its last day (or the day before) is LAST CHANCE and pick-eligible', () => {
  const last = scoreOf({ lastDate: D });
  assert.equal(last.score, 5.5);
  assert.equal(last.eligible, true);
  assert.deepEqual(last.flags, [{ key: 'last-chance', label: 'Last chance' }]);
  assert.deepEqual(last.reasons.map((r) => r.text), ['Last chance', 'Metacritic 88']);
  assert.equal(scoreOf({ lastDate: '2030-01-12' }).eligible, true);
  // Two days out isn't last chance yet.
  assert.equal(scoreOf({ lastDate: '2030-01-13' }).flags.length, 0);
  // A poorly reviewed last day gets the flag but isn't a pick.
  const weak = scoreOf({ lastDate: D, mc_score: 60 });
  assert.equal(weak.flags[0].key, 'last-chance');
  assert.equal(weak.eligible, false);
});

test('filmScore: a run ending at the edge of the posted schedule is not LAST CHANCE', () => {
  const edge = (horizon) => scoreOf({ lastDate: D }, { horizonByTheater: new Map([[GRAND, horizon]]) });
  assert.equal(edge('2030-01-11').flags.length, 0);
  assert.equal(edge('2030-01-13').flags.length, 0);
  assert.equal(edge('2030-01-14').flags[0].key, 'last-chance'); // three clear days beyond it
  // Nothing known about the theater's schedule: no claim either way.
  assert.equal(scoreOf({ lastDate: D }, { horizonByTheater: new Map() }).flags.length, 0);
});

test('filmScore: OPENS on a run\'s first date — never on today', () => {
  const opens = scoreOf({ firstDate: D });
  assert.equal(opens.score, 5);
  assert.equal(opens.eligible, true);
  assert.deepEqual(opens.flags, [{ key: 'opens', label: 'Opens' }]);
  assert.ok(opens.reasons.some((r) => r.text === 'Opens tonight'));
  const today = filmScore(runFilm({ firstDate: TODAY, date: TODAY }), { today: TODAY, horizonByTheater });
  assert.deepEqual(today.flags, []);
  assert.equal(today.eligible, false);
});

test('filmScore: restorations get +0.5; Rotten Tomatoes is scaled; the cap is 9', () => {
  assert.equal(scoreOf({ special: true, upcoming: 1, mc_score: null, title: 'Akira (4K restoration)' }).score, 6.5);
  assert.equal(scoreOf({ special: true, upcoming: 1, mc_score: null, title: 'Vertigo in 70mm' }).restored, true);
  const rt = scoreOf({ mc_score: null, rt_score: 96 });
  assert.equal(rt.crit, 82);
  assert.equal(rt.score, 3);
  assert.ok(rt.reasons.some((r) => r.text === 'Rotten Tomatoes 96%'));
  assert.equal(scoreOf({ special: true, upcoming: 1, mc_score: 99, title: 'Akira 4K' }).score, 9);
});

// ── pickScore ───────────────────────────────────────────────────────────────
test('pickScore: music adds known-act bonuses and a release-show bump, and docks an unparsed bill', () => {
  assert.equal(pickScore(music(undefined, { _score: 5 })), 5);
  assert.equal(pickScore(music(undefined, { _score: 5, _feel: { tags: [], known: { similar: true, profile: true } } })), 6);
  assert.equal(pickScore(music(undefined, { _score: 5, _lineup: [] })), 4);
  const release = [{ key: 'release', label: 'Release show' }];
  assert.equal(pickScore(music(undefined, { _score: 4, _flags: release })), 5.5);
  assert.equal(pickScore(music(undefined, { _score: 2, _flags: release })), 2);
  assert.equal(pickScore(music(undefined, { _score: 3, title: 'The Fall Farewell Tour' })), 4.5);
});

test('pickScore: comedy rewards a notable name and a run, docks open mics and nameless showcases, caps at 8', () => {
  assert.equal(pickScore(comedy(undefined, { source: 'api' })), 3);
  assert.equal(pickScore(comedy(undefined, { _feel: { tags: [], known: {}, descriptor: 'American stand-up comedian' } })), 3);
  assert.equal(pickScore(comedy(undefined, { source: 'api', _run: { text: 'Thu–Sat' } })), 4);
  assert.equal(pickScore(comedy(undefined, { _score: 4, _lineup: ['A', 'B', 'C', 'D'] })), 1);
  assert.equal(pickScore(comedy(undefined, { _score: 9, source: 'api' })), 8);
  assert.equal(pickScore(comedy(undefined, { _score: 14, source: 'api', _reasons: favorite('Hannibal Buress') })), 17);
});

test('pickScore: films use the film score, stage gets +1, other kinds keep _score', () => {
  assert.equal(pickScore(film(undefined, { _score: 0, _film: { score: 6.5, eligible: true } })), 6.5);
  assert.equal(pickScore(show('theater', undefined, { _score: 2 })), 3);
  assert.equal(pickScore(show('trivia', undefined, { _score: 2 })), 2);
});

test('pickScore: regulars, plans, curated, sold out and cancelled', () => {
  const weekly = { series: 'jazzbones|jazz jam', cadence: 'Every Tue' };
  assert.equal(pickScore(music(undefined, { _score: 6, _regular: weekly })), 1);
  assert.equal(pickScore(music(undefined, { _score: 12, _regular: weekly, _reasons: favorite() })), 12);
  assert.equal(pickScore(music(undefined, { _score: 4, going: 1, interested: 1 })), 9);
  assert.equal(pickScore(music(undefined, { _score: 4, interested: 1 })), 6);
  assert.equal(pickScore(music(undefined, { _score: 4, _curated: 'Loud and cheap' })), 7);
  const soldOut = [{ key: 'sold-out', label: 'Sold out' }];
  assert.equal(pickScore(music(undefined, { _score: 10, _flags: soldOut })), 3);
  assert.equal(pickScore(music(undefined, { _score: 10, _flags: soldOut, going: 1 })), 15);
  assert.equal(pickScore(music(undefined, { _score: 20, _flags: [{ key: 'cancelled', label: 'Cancelled' }] })), -Infinity);
});

test('a favorite (12 or more) always outranks any film (9 at most)', () => {
  const best = filmScore(
    { title: 'Akira 4K', special: true, upcoming: 1, mc_score: 99, date: D, venue: GRAND },
    { today: TODAY, horizonByTheater }
  );
  const screening = film(undefined, { _film: best });
  const fav = music(undefined, { _score: 12, _reasons: favorite() });
  assert.equal(pickScore(screening), 9);
  assert.ok(pickScore(fav) > pickScore(screening));
  const { picks } = chooseDayPicks([screening, fav], at());
  assert.equal(picks[0].id, fav.id);
  assert.equal(picks[0]._role.label, 'The pick');
});

// ── chooseDayPicks ──────────────────────────────────────────────────────────
test('day picks, the worked example: punk 12, 10, 9, a film 6 and comedy 3 → punk 12, punk 10, the film', () => {
  const a = music(12, { tags: ['punk'] });
  const b = music(10, { tags: ['punk'] });
  const c = music(9, { tags: ['punk'] });
  const f = film(6);
  const k = comedy(3);
  const { picks, label } = chooseDayPicks([c, k, f, b, a], at());
  assert.deepEqual(ids(picks), [a.id, b.id, f.id]);
  assert.deepEqual(picks.map((p) => p._role), [
    { key: 'pick', label: 'The pick' },
    { key: 'also', label: 'Also good' },
    { key: 'film', label: 'One night only' },
  ]);
  assert.equal(label, 'top');
  // Roles live on copies; the items themselves are untouched.
  assert.equal(a._role, undefined);
});

test('day picks: the same headliner is never picked twice', () => {
  const x = music(12, { headliner_key: 'pup', venue: 'Showbox SoDo' });
  const y = music(11, { headliner_key: 'pup', venue: 'Showbox Sodo Seattle' });
  const z = music(5);
  assert.deepEqual(ids(chooseDayPicks([x, y, z], at()).picks), [x.id, z.id]);
});

test('day picks: at most one film; a run off its first and last days is never a pick', () => {
  const f1 = film(9);
  const f2 = film(8.5);
  const run = film(8, { _flags: [], _film: { score: 8, eligible: false } });
  const m = music(4);
  const { picks } = chooseDayPicks([f2, run, f1, m], at());
  assert.deepEqual(ids(picks), [f1.id, m.id]);
  assert.equal(picks[0]._role.label, 'The pick');
  const later = film(7, { _flags: [] });
  const roles = chooseDayPicks([music(12), later], at()).picks.map((p) => p._role.label);
  assert.deepEqual(roles, ['The pick', 'At the movies']);
});

test('day picks: a sold-out show is never picked unless you are going', () => {
  const soldOut = [{ key: 'sold-out', label: 'Sold out' }];
  const fav = music(undefined, { _score: 20, _reasons: favorite(), _flags: soldOut });
  const other = music(4);
  assert.deepEqual(ids(chooseDayPicks([fav, other], at()).picks), [other.id]);
  const going = music(undefined, { _score: 20, _reasons: favorite(), _flags: soldOut, going: 1, interested: 1 });
  const { picks } = chooseDayPicks([going, other], at());
  assert.equal(picks[0].id, going.id);
  assert.equal(picks[0]._role.label, 'Your plan');
});

test('day picks: shows you are going to always come first, as "Your plan"', () => {
  const plan = music(1, { going: 1, interested: 1 });
  const a = music(12);
  const laugh = comedy(8);
  const maybe = music(2, { interested: 1 });
  const { picks } = chooseDayPicks([a, laugh, maybe, plan], at());
  assert.deepEqual(ids(picks), [plan.id, a.id, laugh.id]);
  assert.deepEqual(picks.map((p) => p._role.label), ['Your plan', 'The pick', 'For a laugh']);
  // A cancelled plan isn't one.
  const off = music(9, { going: 1, _flags: [{ key: 'cancelled', label: 'Cancelled' }] });
  assert.deepEqual(ids(chooseDayPicks([off, a], at()).picks), [a.id]);
});

test('day picks: regulars are never picks unless a favorite or starred act is on the bill', () => {
  const weekly = { series: 'swiss|trivia', cadence: 'Every Fri' };
  const trivia = show('trivia', 10, { _regular: weekly });
  const residency = music(14, { _regular: weekly, _reasons: favorite('Laura Stevenson') });
  const starred = music(9, { _regular: weekly, _reasons: [{ kind: 'learned', text: 'You starred Ezra Bell before' }] });
  assert.deepEqual(ids(chooseDayPicks([trivia, residency, starred], at()).picks), [residency.id, starred.id]);
  assert.deepEqual(chooseDayPicks([trivia], at()), { picks: [], label: 'regulars' });
  assert.deepEqual(chooseDayPicks([trivia, music(2)], at()), { picks: [], label: 'none' });
  assert.deepEqual(chooseDayPicks([], at()), { picks: [], label: 'none' });
});

test('day picks: on today, shows that started over an hour ago are left out — only on today', () => {
  const late = new Date(2030, 0, 11, 21, 30).getTime();
  const started = music(9, { time: '20:00' });
  const recent = music(8, { time: '21:00' });
  const twin = music(7, { time: '19:00', _times: ['19:00', '22:00'] });
  const plan = music(1, { time: '18:00', going: 1 });
  const tonight = chooseDayPicks([started, recent, twin, plan], { now: late, today: D, date: D });
  assert.deepEqual(ids(tonight.picks), [plan.id, recent.id, twin.id]);
  const ahead = chooseDayPicks([started, recent, twin], { now: late, today: TODAY, date: D });
  assert.ok(ids(ahead.picks).includes(started.id));
});

test('day picks: the floor applies after the penalties, so a weak item is never forced in', () => {
  const a = music(12, { venue: 'Neumos', tags: ['punk'] });
  const weak = music(4, { venue: 'Neumos', tags: ['punk'] });
  assert.deepEqual(ids(chooseDayPicks([a, weak], at()).picks), [a.id]);
  assert.deepEqual(ids(chooseDayPicks([weak], at()).picks), [weak.id]);
  assert.deepEqual(ids(chooseDayPicks([music(2.9)], at()).picks), []);
});

// ── chooseWeekPicks ─────────────────────────────────────────────────────────
test('week tickets: Going first, then best first — two a night, each act once, one film, two comedy', () => {
  const on = (date) => ({ date });
  const plan = music(2, { ...on('2030-01-10'), going: 1, interested: 1 });
  const pupSat = music(13, { ...on('2030-01-12'), headliner_key: 'pup' });
  const pupSun = music(12.5, { ...on('2030-01-13'), headliner_key: 'pup' });
  const fri1 = music(12, on('2030-01-11'));
  const fri2 = music(11, on('2030-01-11'));
  const fri3 = music(10, on('2030-01-11'));
  const film1 = film(9, on('2030-01-08'));
  const film2 = film(9, on('2030-01-09'));
  const weakFilm = film(10, { ...on('2030-01-10'), _film: { score: 7.5, eligible: true } });
  const c1 = comedy(9, on('2030-01-07'));
  const c2 = comedy(8.5, on('2030-01-08'));
  const c3 = comedy(8.2, on('2030-01-09'));
  const low = music(7.9, on('2030-01-10'));
  const sold = music(15, { ...on('2030-01-09'), _flags: [{ key: 'sold-out', label: 'Sold out' }] });
  const all = [low, c3, c2, c1, weakFilm, film2, film1, fri3, fri2, fri1, pupSun, pupSat, plan, sold];
  const picks = chooseWeekPicks(all, { max: 8, pickMin: 8 });
  assert.deepEqual(ids(picks), [plan.id, pupSat.id, fri1.id, fri2.id, c1.id, film1.id, c2.id]);

  const perDate = {};
  for (const p of picks) perDate[p.date] = (perDate[p.date] || 0) + 1;
  assert.ok(Object.values(perDate).every((count) => count <= 2));
  assert.equal(picks.filter((p) => p.kind === 'film').length, 1);
  assert.equal(picks.filter((p) => p._kind.family === 'comedy').length, 2);
  assert.deepEqual(ids(chooseWeekPicks(all, { max: 3, pickMin: 8 })), [plan.id, pupSat.id, fri1.id]);
});

// ── dayDek ──────────────────────────────────────────────────────────────────
const counts = { total: 12, music: 6, comedy: 2, film: 3, around: 1, regulars: 2 };
const dek = (picks) => dayDek(picks, { counts });

test('dek: a favorite, a one-night film and a comedian', () => {
  const fav = music(14, { venue: 'The Crocodile', _reasons: favorite() });
  const paris = film(6, { title: 'Paris, Texas', _headline: 'Paris, Texas' });
  const laugh = comedy(8, { city: 'Tacoma' });
  assert.equal(dek([fav, paris, laugh]), 'A favorite at the Crocodile, a one-night Paris, Texas and stand-up in Tacoma.');
});

test('dek: each kind of fragment', () => {
  const similar = (text) => music(9, { _reasons: [{ kind: 'similar', text }], _headline: 'Movements', venue: 'The Showbox' });
  assert.equal(dek([similar('Movements sounds like PUP')]), 'Movements, who sounds like PUP.');
  assert.equal(dek([similar('Movements shares fans with Joyce Manor & Tigers Jaw (≈ PUP)')]), 'Movements, who sounds like PUP.');
  // An opener's resemblance doesn't describe the night.
  assert.equal(dek([similar('Opener Teen Fears sounds like PUP')]), 'Movements at the Showbox.');

  const anora = { title: 'Anora', _headline: 'Anora' };
  assert.equal(dek([film(7, { ...anora, _flags: [{ key: 'last-chance', label: 'Last chance' }] })]), 'Last call for Anora.');
  assert.equal(dek([film(7, { ...anora, _flags: [] })]), 'Anora at the Grand.');
  assert.equal(dek([film(7, { ...anora, _flags: [], venue: 'SIFF Cinema Uptown' })]), 'Anora at SIFF Uptown.');

  assert.equal(dek([music(9, { going: 1, venue: 'The Showbox' })]), 'Your night at the Showbox.');
  const tagged = [{ tag: 'post punk', hit: false }, { tag: 'shoegaze', hit: true }];
  assert.equal(
    dek([music(9, { venue: 'New Frontier Lounge', _feel: { tags: tagged, known: {} } })]),
    'Shoegaze at New Frontier Lounge.'
  );
  assert.equal(dek([show('theater', 4, { _headline: 'Hamlet', venue: 'Tacoma Little Theatre' })]), 'Hamlet at Tacoma Little Theatre.');
  assert.equal(dek([show('improv', 4, { city: 'Seattle' })]), 'Improv in Seattle.');
});

test('dek: two fragments join with "and"; repeats collapse', () => {
  const a = comedy(8, { city: 'Tacoma' });
  const b = comedy(7, { city: 'Tacoma' });
  const c = music(6, { _headline: 'Static Saints', venue: 'Clock-Out Lounge' });
  assert.equal(dek([a, b, c]), 'Stand-up in Tacoma and Static Saints at Clock-Out Lounge.');
});

test('dek: your plan leads, and favorites or sound-alikes share a phrase', () => {
  const fav = (venue, extra = {}) => music(14, { venue, _reasons: favorite(), ...extra });
  assert.equal(dek([fav('Real Art Tacoma', { going: 1 })]), 'Your night at Real Art Tacoma.', 'Going beats favorite');
  assert.equal(dek([fav('Jazzbones'), fav('The Paramount Theatre')]), 'Favorites at Jazzbones and the Paramount Theatre.');
  assert.equal(dek([fav('Jazzbones'), fav('Jazzbones')]), 'Two favorites at Jazzbones.');
  const sounds = (name) => music(9, { _headline: name, _reasons: [{ kind: 'similar', text: `${name} sounds like Alvvays` }] });
  assert.equal(dek([sounds('Mossback'), sounds('Glass Harbor')]), 'Mossback and Glass Harbor, who sound like Alvvays.');
  assert.equal(
    dek([fav('Jazzbones'), fav('The Paramount Theatre'), comedy(8, { city: 'Tacoma' })]),
    'Favorites at Jazzbones and the Paramount Theatre, and stand-up in Tacoma.',
    'a comma keeps the last phrase from running into the first one’s "and"'
  );
  assert.equal(
    dek([sounds('Movements'), music(6, { venue: 'The Valley', _feel: { tags: [{ tag: 'indie rock', hit: true }], known: {} } })]),
    'Movements, who sounds like Alvvays, and indie rock at the Valley.'
  );
  const mic = show('open-mic', 4, { _headline: 'Songwriter Night', venue: 'The Valley', _feel: { tags: [{ tag: 'singer-songwriter', hit: true }], known: {} } });
  assert.equal(dek([mic]), 'Songwriter Night at the Valley.', 'a night is named, not described by a genre');
});

test('dek: trailing fragments are dropped to fit 110 characters', () => {
  const long = (name) => music(8, { _headline: name, venue: 'The Crocodile Ballroom Annex' });
  const picks = [long('The Extraordinarily Long Band Name'), long('Another Very Long Band Name Here'), long('Third')];
  // Two of these would be 136 characters.
  assert.equal(dek(picks), 'The Extraordinarily Long Band Name at the Crocodile Ballroom Annex.');
  const fits = dek([long('Rent Strike'), long('Glass Harbor'), long('The Extraordinarily Long Band Name')]);
  assert.equal(fits, 'Rent Strike at the Crocodile Ballroom Annex and Glass Harbor at the Crocodile Ballroom Annex.');
});

test('dek: nights with no picks', () => {
  assert.equal(dayDek([], { counts: { total: 0, regulars: 0 } }), 'Nothing listed yet.');
  assert.equal(dayDek([], {}), 'Nothing listed yet.');
  assert.equal(
    dayDek([], { counts: { total: 3, regulars: 3 }, regularKinds: ['trivia', 'karaoke', 'trivia'] }),
    'Quiet one: just the regulars (trivia, karaoke).'
  );
  assert.equal(dayDek([], { counts: { total: 2, regulars: 2 } }), 'Quiet one: just the regulars.');
  assert.equal(dayDek([], { counts: { total: 9, regulars: 2 } }), 'Nothing close to your taste. Everything on is below.');
});

// ── weekNote ────────────────────────────────────────────────────────────────
test('week note: the best night and the quiet ones', () => {
  const days = [
    { date: '2030-01-07', picks: [] },
    { date: '2030-01-08', picks: [] },
    { date: '2030-01-09', picks: [music(9, { _headline: 'Wet Leg' }), music(8)] },
    { date: '2030-01-10', picks: [music(12.5, { _headline: 'Alvvays' })] },
    { date: '2030-01-11', picks: [music(12, { _headline: 'PUP' }), music(4)] },
  ];
  assert.deepEqual(weekNote(days), {
    text: 'Best night: Friday (PUP). Quiet: Mon, Tue.',
    bestNight: '2030-01-11',
    quiet: ['2030-01-07', '2030-01-08'],
  });
  assert.equal(weekNote(days.slice(2)).text, 'Best night: Friday (PUP).');
  assert.equal(weekNote(days.slice(0, 2)), null);
  assert.equal(weekNote([]), null);
});

// ── regularsIndex ───────────────────────────────────────────────────────────
function add(title, venue, dates, fields = {}) {
  for (const date of dates) {
    upsertEvent({ source: 'scrape', source_name: venue, title, venue, city: 'Tacoma', time: '20:00', category: 'other', date, ...fields });
  }
  return dates.map((date) => db.prepare('SELECT id FROM events WHERE title = ? AND venue = ? AND date = ?').get(title, venue, date).id);
}

// Thursday 10 January 2030. History reaches back eight weeks.
const R_TODAY = '2030-01-10';
const songbook = add('Northwest Songbook', 'The Spar', ['2029-12-20', '2029-12-27', '2030-01-03', '2030-01-10'], { category: 'music' });
const swing = add('Swing Social', 'Spanish Ballroom', ['2029-12-13', '2029-12-27', '2030-01-10', '2030-01-24']);
const pubTrivia = add('Pub Trivia', 'The Swiss', ['2030-01-14', '2030-01-21']);
const twoGigs = add('Static Saints', 'Clock-Out Lounge', ['2030-01-14', '2030-01-21'], { category: 'music' });
const comic = add('Nate Bargatze', 'Tacoma Comedy Club', ['2030-01-10', '2030-01-11', '2030-01-12'], { category: 'comedy' });
const airport = add('Trivia Night', 'Airport Tavern', ['2030-01-08', '2030-01-15']);
const clockout = add('Trivia Night', 'Clock-Out Lounge', ['2030-01-09', '2030-01-16']);
const pickin = add('Old Time Pickin', 'Rhein Haus', ['2029-12-27', '2030-01-03', '2030-01-17'], { category: 'music' });
const karaoke = add('Karaoke Every Friday', 'Doyle’s Public House', ['2030-01-11']);
const swap = add('Vinyl Swap', 'Hello Records', ['2029-11-22', '2029-12-20', '2030-01-17']);
const hamlet = add('Hamlet', 'Tacoma Little Theatre', [
  '2030-01-10', '2030-01-11', '2030-01-12', '2030-01-13', '2030-01-17', '2030-01-18', '2030-01-19', '2030-01-20',
]);
const tooOld = add('Quiz Night', 'The Valley', ['2029-10-04', '2029-10-11', '2029-10-18']);

test('regulars: four Thursdays → "Every Thu"; fortnightly → "Every other Thu"; monthly', () => {
  const { regular } = regularsIndex(R_TODAY);
  assert.deepEqual(regular.get(songbook[3]), { series: 'spar|northwest songbook', cadence: 'Every Thu' });
  assert.equal(regular.get(swing[0]).cadence, 'Every other Thu');
  assert.equal(regular.get(swap[2]).cadence, 'Monthly');
});

test('regulars: two trivia nights a week apart are enough; two gigs a week apart are not', () => {
  const { regular } = regularsIndex(R_TODAY);
  assert.equal(regular.get(pubTrivia[1]).cadence, 'Every Mon');
  assert.equal(regular.get(twoGigs[0]), undefined);
  assert.equal(regular.get(karaoke[0]).cadence, 'Every Fri');
});

test('regulars: a comic\'s Thursday-to-Saturday is a run, not a regular', () => {
  const { regular, run } = regularsIndex(R_TODAY);
  for (const id of comic) {
    assert.equal(regular.get(id), undefined);
    assert.deepEqual(run.get(id), { text: 'Thu–Sat', dates: ['2030-01-10', '2030-01-11', '2030-01-12'] });
  }
  assert.equal(run.get(hamlet[5]).text, 'Until Jan 20');
  assert.equal(run.get(songbook[0]), undefined);
});

test('regulars: the same title at two venues is two series', () => {
  const { regular } = regularsIndex(R_TODAY);
  assert.deepEqual(regular.get(airport[0]), { series: 'airport tavern|trivia night', cadence: 'Every Tue' });
  assert.deepEqual(regular.get(clockout[1]), { series: 'clock out lounge|trivia night', cadence: 'Every Wed' });
});

test('regulars: past rows count, but only eight weeks back', () => {
  const { regular } = regularsIndex(R_TODAY);
  // Only one Pickin date is still ahead; the two before it make it a regular.
  assert.equal(regular.get(pickin[2]).cadence, 'Every Thu');
  assert.equal(regular.get(tooOld[0]), undefined);
});

test('regulars: memoized until the events table changes', () => {
  const first = regularsIndex(R_TODAY);
  assert.equal(regularsIndex(R_TODAY), first);
  const [extra] = add('Pub Trivia', 'The Swiss', ['2030-01-28']);
  const second = regularsIndex(R_TODAY);
  assert.notEqual(second, first);
  assert.equal(second.regular.get(extra).cadence, 'Every Mon');
});

// ── loadCurated ─────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlight-curated-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('curated.json: fresh lists give reasons by event id; a list over a week old is ignored', () => {
  const file = path.join(dir, 'curated.json');
  const now = Date.parse('2030-01-11T18:00:00Z');
  const write = (daysOld, extra = {}) => {
    const doc = {
      criteria: 'post-punk under $25',
      generated_at: new Date(now - daysOld * 86400000).toISOString(),
      events: [{ id: 42, reason: 'Wiry and cheap' }, { id: '7', reason: '' }],
      ...extra,
    };
    fs.writeFileSync(file, JSON.stringify(doc));
    // A distinct mtime each write, so the cache notices.
    const t = new Date(now - daysOld * 86400000);
    fs.utimesSync(file, t, t);
  };

  write(2);
  const fresh = loadCurated(now, { file });
  assert.equal(fresh.criteria, 'post-punk under $25');
  assert.equal(fresh.reasons.get(42), 'Wiry and cheap');
  assert.equal(fresh.reasons.get(7), 'Fits "post-punk under $25"');

  write(8);
  assert.equal(loadCurated(now, { file }), null);

  assert.equal(loadCurated(now, { file: path.join(dir, 'missing.json') }), null);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  assert.equal(loadCurated(now, { file: path.join(dir, 'broken.json') }), null);
});
