// Tests for onePerShow (one row per show in a ranked list) and Top Picks,
// which the dashboard and the weekly alert digest share. In-memory database.
import './helpers/memory-db.js'; // must stay the first import
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { upsertEvent, setManualGenre, setPlan } = await import('../src/db/queries.js');
const { onePerShow, topPicks } = await import('../src/picks.js');

migrate();
db.exec('DELETE FROM manual_genres; DELETE FROM favorite_artists; DELETE FROM preferences; DELETE FROM events;');

const D = '2030-01-08';
let n = 0;
// A scored row as onePerShow sees it: the events columns plus _lineup.
const row = (fields) => {
  n += 1;
  const lineup = fields._lineup || [];
  return {
    id: n,
    date: D,
    time: '20:00',
    city: 'Tacoma',
    headliner_key: lineup[0] ? lineup[0].toLowerCase() : null,
    going: 0,
    interested: 0,
    _lineup: lineup,
    ...fields,
  };
};
const ids = (list) => list.map((e) => e.id);

test('two venues\' "Trivia Night" on the same date are two shows', () => {
  const a = row({ title: 'Trivia Night', venue: 'Airport Tavern' });
  const b = row({ title: 'Trivia Night', venue: 'Clock-Out Lounge' });
  assert.deepEqual(ids(onePerShow([a, b])), [a.id, b.id]);
  // …but the same venue's listing twice is one.
  const again = row({ title: 'Trivia Night', venue: 'The Airport Tavern' });
  assert.deepEqual(ids(onePerShow([a, b, again])), [a.id, b.id]);
});

test('an early and a late show at one venue become one row with both times', () => {
  const late = row({ title: 'Nate Bargatze (late show)', venue: 'Tacoma Comedy Club', time: '21:30', _lineup: ['Nate Bargatze'] });
  const early = row({ title: 'Nate Bargatze (early show)', venue: 'Tacoma Comedy Club', time: '19:00', _lineup: ['Nate Bargatze'] });
  const other = row({ title: 'Static Saints', venue: 'Clock-Out Lounge', _lineup: ['Static Saints'] });
  const out = onePerShow([late, other, early]);
  assert.deepEqual(ids(out), [late.id, other.id]);
  assert.deepEqual(out[0]._times, ['19:00', '21:30']);
  assert.equal(out[0].time, '21:30');
  assert.equal(out[1]._times, undefined);
  // The input rows are left as they were, and running it again changes nothing.
  assert.equal(late._times, undefined);
  assert.deepEqual(onePerShow(out)[0]._times, ['19:00', '21:30']);
});

test('if you are going to the late show, the late show is the row kept', () => {
  const early = row({ title: 'Hannibal Buress', venue: 'Tacoma Comedy Club', time: '19:00', _lineup: ['Hannibal Buress'] });
  const late = row({ title: 'Hannibal Buress', venue: 'Tacoma Comedy Club', time: '21:30', _lineup: ['Hannibal Buress'], going: 1, interested: 1 });
  const [kept] = onePerShow([early, late]);
  assert.equal(kept.id, late.id);
  assert.equal(kept.going, 1);
  assert.deepEqual(kept._times, ['19:00', '21:30']);
});

test('a show two sources list under different venue names still collapses to one', () => {
  const venueSite = row({ title: 'PUP', venue: 'Showbox SoDo', time: '20:00', _lineup: ['PUP'] });
  const ticketing = row({ title: 'PUP w/ Joyce Manor', venue: 'Showbox Sodo Seattle', time: '19:00', _lineup: ['PUP', 'Joyce Manor'] });
  const out = onePerShow([venueSite, ticketing]);
  assert.deepEqual(ids(out), [venueSite.id]);
  assert.equal(out[0]._times, undefined);
  // The same act on another night is another show.
  const nextNight = row({ title: 'PUP', venue: 'Showbox SoDo', date: '2030-01-09', _lineup: ['PUP'] });
  assert.equal(onePerShow([venueSite, ticketing, nextNight]).length, 2);
});

test('rows without a headliner_key column fall back to the parsed headliner', () => {
  const a = { id: 'a', date: D, title: 'Rent Strike', venue: 'Real Art Tacoma', time: '20:00', _lineup: ['Rent Strike'] };
  const b = { id: 'b', date: D, title: 'Rent Strike (late)', venue: 'Real Art Tacoma', time: '22:00', _lineup: ['Rent Strike'] };
  const out = onePerShow([a, b]);
  assert.deepEqual(ids(out), ['a']);
  assert.deepEqual(out[0]._times, ['20:00', '22:00']);
});

test('topPicks: still ranks shows, once each, with early and late shows merged', () => {
  setManualGenre('punk', 5);
  const add = (fields) =>
    upsertEvent({ source: 'scrape', source_name: 'test', city: 'Seattle', category: 'music', genre_tags: 'punk', ...fields });
  add({ title: 'PUP', venue: 'The Crocodile', date: '2030-01-10', time: '18:00' });
  add({ title: 'PUP (late show)', venue: 'The Crocodile', date: '2030-01-10', time: '21:00' });
  add({ title: 'Trivia Night', venue: 'Airport Tavern', date: '2030-01-10', time: '19:00', category: 'other' });
  add({ title: 'Trivia Night', venue: 'Clock-Out Lounge', date: '2030-01-10', time: '19:00', category: 'other' });
  add({ title: 'Joyce Manor', venue: 'Neumos', date: '2030-01-12' });
  const late = db.prepare("SELECT id FROM events WHERE title = 'PUP (late show)'").get().id;
  setPlan(late, 'going');

  // Going makes PUP a starred artist, so the show moves up to `artists` —
  // and its early-show twin must not reappear among `events`.
  const { artists, events } = topPicks({ today: '2030-01-09', days: 30 });
  const pup = [...artists, ...events].filter((e) => e.headliner_key === 'pup');
  assert.equal(pup.length, 1);
  assert.equal(pup[0].id, late);
  assert.deepEqual(pup[0]._times, ['18:00', '21:00']);
  assert.equal(events.filter((e) => e.title === 'Trivia Night').length, 2);
  assert.ok(events.some((e) => e.title === 'Joyce Manor'));
});
