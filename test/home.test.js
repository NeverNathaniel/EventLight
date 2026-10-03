// Tests for the close-to-home boost: distances from the home city and how the
// engine scales scores near it. Runs against a throwaway in-memory database.
import './helpers/memory-db.js'; // must stay the first import
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { proximity, cityKey } = await import('../src/scoring/home.js');
const { scoreEvent } = await import('../src/scoring/engine.js');
const { migrate } = await import('../src/db/migrate.js');
const { setSetting, getHomeSetting } = await import('../src/db/queries.js');

migrate();

test('proximity: full near home, fading out, none for Seattle from Tacoma', () => {
  assert.deepEqual(proximity('Tacoma', 'Tacoma'), { factor: 1, miles: null });
  assert.equal(proximity('tacoma, WA', 'Tacoma').factor, 1);
  assert.equal(proximity('Federal Way', 'Tacoma').factor, 1);
  assert.ok(proximity('Puyallup', 'Tacoma').factor > 0.9);
  const kent = proximity('Kent', 'Tacoma');
  assert.ok(kent.factor > 0.3 && kent.factor < 0.7, `Kent ${kent.factor}`);
  assert.equal(kent.miles, 13);
  assert.equal(proximity('Seattle', 'Tacoma').factor, 0);
  assert.equal(proximity('Olympia', 'Tacoma').factor, 0);
  // Off the map: only counts when it is the home city itself.
  assert.equal(proximity('Spokane', 'Tacoma').factor, 0);
  assert.equal(proximity('Spokane', 'spokane').factor, 1);
  assert.equal(proximity('', 'Tacoma').factor, 0);
  assert.equal(cityKey(' Gig  Harbor, Washington '), 'gig harbor');
});

const ctx = (home) => ({
  manualGenres: [{ genre: 'punk', key: 'punk', weight: 4 }],
  favorites: new Map(),
  learned: new Map(),
  similar: new Map(),
  hidden: new Set(),
  prefs: [],
  home,
});
const punkShow = (city) => ({ title: 'X', lineup: '["X"]', genre_tags: 'punk', artist_tags: '', city });

test('the boost scales a liked show by distance and says why', () => {
  const home = { city: 'Tacoma', boost: 50 };
  const seattle = scoreEvent(punkShow('Seattle'), ctx(home));
  const tacoma = scoreEvent(punkShow('Tacoma'), ctx(home));
  const kent = scoreEvent(punkShow('Kent'), ctx(home));
  assert.equal(seattle.score, 4);
  assert.ok(!seattle.reasons.some((r) => r.kind === 'nearby'));
  assert.equal(tacoma.score, 6);
  assert.deepEqual(tacoma.reasons.at(-1), { kind: 'nearby', text: 'Close to home (Tacoma)' });
  assert.ok(kent.score > 4 && kent.score < 6);
  assert.equal(kent.reasons.at(-1).text, 'Close to home (Kent, 13 mi)');
});

test('being nearby never makes a pick on its own, and Off turns it off', () => {
  const nothing = { title: 'Y', lineup: '["Y"]', genre_tags: 'polka', artist_tags: '', city: 'Tacoma' };
  assert.equal(scoreEvent(nothing, ctx({ city: 'Tacoma', boost: 100 })).score, 0);
  assert.equal(scoreEvent(punkShow('Tacoma'), ctx({ city: 'Tacoma', boost: 0 })).score, 4);
  assert.equal(scoreEvent(punkShow('Tacoma'), ctx(undefined)).score, 4);
});

test('the home setting defaults to Tacoma / +50% and is saved in settings', () => {
  assert.deepEqual(getHomeSetting(), { city: 'Tacoma', boost: 50 });
  setSetting('home_city', 'Seattle');
  setSetting('home_boost', 100);
  assert.deepEqual(getHomeSetting(), { city: 'Seattle', boost: 100 });
  setSetting('home_boost', 0);
  assert.equal(getHomeSetting().boost, 0);
});
