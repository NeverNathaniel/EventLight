// Tests for the Week screen, the day page and the detail sheet: the rolling
// seven days, top picks, each day's picks, films alongside shows, Going /
// Maybe, and the show/artist lookups.
// Runs against a throwaway in-memory database.
import './helpers/memory-db.js'; // must stay the first import
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { upsertEvent, setManualGenre, setPlan, setInterested } = await import('../src/db/queries.js');
const { setFavoriteArtist } = await import('../src/db/artists.js');
const { weekBrief, dayPage, eventDetails, artistView, savedLists, filmsByDay, PICK_MIN } = await import(
  '../src/week.js'
);

migrate();
db.exec('DELETE FROM manual_genres; DELETE FROM favorite_artists; DELETE FROM preferences;');
setManualGenre('punk', 5);
setFavoriteArtist('PUP', 5);

// Saturday 5 January 2030.
const TODAY = '2030-01-05';
const NOW = new Date(2030, 0, 5, 8, 0).getTime();

function add(fields) {
  upsertEvent({
    source: 'scrape',
    source_name: 'test',
    venue: 'Test Hall',
    city: 'Seattle',
    category: 'music',
    time: '20:00',
    ...fields,
  });
  return db.prepare('SELECT * FROM events WHERE title = ? AND date = ?').get(fields.title, fields.date);
}

const yesterday = add({ title: 'Yesterday Band', date: '2030-01-04' });
const pupTonight = add({ title: 'PUP', date: '2030-01-05', genre_tags: 'punk' });
const quietShow = add({ title: 'Static Saints', date: '2030-01-07', genre_tags: 'garage' });
const lastDay = add({ title: 'Glass Harbor', date: '2030-01-11', genre_tags: 'punk' });
const nextWeek = add({ title: 'The Low Tides', date: '2030-01-12', genre_tags: 'punk' });
const pupLater = add({ title: 'PUP', date: '2030-03-14', venue: 'Showbox SoDo' });
const supportSlot = add({ title: 'Joyce Manor w/ PUP', date: '2030-02-02', venue: 'The Crocodile' });

// A one-night repertory screening and a regular run, as the cinema stores them.
const local = (d, h) => new Date(2030, 0, d, h, 0).toISOString();
const MOVIES = [
  { id: 1, title: 'Paris, Texas', theater: 'The Grand Cinema', city: 'Tacoma', rating: 'R', genre: 'Drama',
    release_date: '1984-05-19', showtimes: [local(6, 19)], peak_showings: 1, hidden: 0 },
  { id: 2, title: 'The Long Field', theater: 'The Grand Cinema', city: 'Tacoma', rating: 'PG-13', genre: 'Drama',
    release_date: '2029-11-01', showtimes: [5, 6, 7, 8, 9, 10].flatMap((d) => [local(d, 16), local(d, 19)]),
    peak_showings: 12, hidden: 0 },
];

test('the week is the next seven days from today, not Monday to Sunday', () => {
  const brief = weekBrief({ today: TODAY, now: NOW, movies: [] });
  assert.equal(brief.days.length, 7);
  assert.equal(brief.days[0].date, '2030-01-05');
  assert.equal(brief.days[6].date, '2030-01-11');
  const ids = brief.days.flatMap((d) => d.picks.map((e) => e.id));
  assert.ok(!ids.includes(yesterday.id), 'yesterday is gone');
  assert.ok(ids.includes(lastDay.id), 'the seventh day is in');
  assert.ok(!ids.includes(nextWeek.id), 'the eighth day is out');
});

test('top picks are strong matches in the week, best first, and light up their day', () => {
  const brief = weekBrief({ today: TODAY, now: NOW, movies: [] });
  assert.ok(brief.picks.length >= 1);
  assert.equal(brief.picks[0].id, pupTonight.id, 'a favorite headlining tops the list');
  assert.ok(brief.picks.every((e) => e._score >= PICK_MIN));
  assert.ok(brief.picks.every((e, i, all) => i === 0 || all[i - 1]._score >= e._score));
  assert.ok(!brief.picks.some((e) => e.id === quietShow.id));
  assert.equal(brief.days[0].hasPick, true);
  assert.equal(brief.days[2].hasPick, false);
});

test("a night with nothing that matches has an empty short list but still counts what's on", () => {
  const monday = weekBrief({ today: TODAY, now: NOW, movies: [] }).days[2];
  assert.deepEqual(monday.picks, []);
  assert.equal(monday.picksLabel, 'none');
  assert.equal(monday.total, 1);
  assert.equal(monday.more, 1);
});

test("further out lists your artists' shows after the week, including as support", () => {
  const brief = weekBrief({ today: TODAY, now: NOW, movies: [] });
  const ids = brief.further.map((e) => e.id);
  assert.ok(ids.includes(pupLater.id));
  assert.ok(ids.includes(supportSlot.id));
  assert.ok(!ids.includes(pupTonight.id), 'this week’s shows stay in the week');
  assert.ok(!ids.includes(nextWeek.id), 'no favorite on the bill');
});

test('films sit alongside shows: one entry per film per day, one-offs can be a pick', () => {
  const films = filmsByDay('2030-01-05', '2030-01-11', NOW, MOVIES);
  const sunday = films.get('2030-01-06');
  assert.equal(sunday.length, 2);
  const paris = sunday.find((f) => f.title === 'Paris, Texas');
  assert.equal(paris.kind, 'film');
  assert.equal(paris.special, true);
  assert.deepEqual(paris.times, ['19:00']);
  assert.equal(paris.upcoming, 1);
  const run = sunday.find((f) => f.title === 'The Long Field');
  assert.deepEqual(run.times, ['16:00', '19:00']);
  assert.equal(run.firstDate, '2030-01-05');
  assert.equal(run.lastDate, '2030-01-10');

  const brief = weekBrief({ today: TODAY, now: NOW, movies: MOVIES });
  const day = brief.days[1];
  const paris2 = day.picks.find((e) => e.title === 'Paris, Texas');
  assert.ok(paris2, 'the one-off screening is one of Sunday’s picks');
  assert.equal(paris2._role.label, 'The pick', 'the best thing on a quiet Sunday leads it, film or not');
  assert.ok(!day.picks.some((e) => e.title === 'The Long Field'), 'a regular run on an ordinary day is not');
  assert.equal(day.total, 2);
  assert.deepEqual(day.films, { count: 2, top: [{ id: 'film-2-2030-01-06', title: 'The Long Field', note: null }] },
    'the films line names the films that aren’t picks');
});

test('a day’s picks are the same on the Week screen and on its own page', () => {
  const brief = weekBrief({ today: TODAY, now: NOW, movies: MOVIES });
  for (const d of brief.days) {
    const page = dayPage(d.date, { today: TODAY, now: NOW, movies: MOVIES });
    assert.deepEqual(page.picks.map((e) => e.id), d.picks.map((e) => e.id), d.date);
    assert.equal(page.dek, d.dek);
  }
});

test('a day’s page: picks first, then everything else in groups, with the days around it', () => {
  add({ title: 'Open Mic', date: '2030-01-05', category: 'comedy' });
  const day = dayPage('2030-01-05', { today: TODAY, now: NOW, movies: MOVIES });
  assert.equal(day.picks[0].id, pupTonight.id);
  assert.equal(day.picks[0]._role.label, 'The pick');
  assert.equal(day.picks[0]._kind.label, 'Music');
  const group = (key) => day.groups.find((g) => g.key === key);
  assert.deepEqual(group('film').items.map((f) => f.title), ['The Long Field'], 'the regular run is listed under At the movies');
  assert.deepEqual(group('comedy').items.map((e) => e.title), ['Open Mic']);
  assert.ok(!day.groups.some((g) => g.items.some((e) => e.id === pupTonight.id)), 'a pick isn’t listed twice');
  assert.equal(day.prev, null, 'no going back before today');
  assert.equal(day.next.date, '2030-01-06');
  assert.deepEqual(day.strip.map((d) => d.date), ['2030-01-05', '2030-01-06', '2030-01-07', '2030-01-08', '2030-01-09', '2030-01-10', '2030-01-11']);
  assert.equal(day.strip[0].hasPick, true);
  assert.match(day.dek, /^A favorite at Test Hall/);

  // A day past the week centres the strip on it.
  const later = dayPage('2030-01-20', { today: TODAY, now: NOW, movies: [] });
  assert.equal(later.strip[0].date, '2030-01-17');
  assert.equal(later.prev.date, '2030-01-19');
});

test('on today’s page, a show that started over an hour ago is folded away', () => {
  add({ title: 'Matinee Band', date: '2030-01-05', time: '13:00' });
  const at = (h) => new Date(2030, 0, 5, h, 0).getTime();
  const early = dayPage('2030-01-05', { today: TODAY, now: at(12), movies: [] });
  assert.ok(!early.started.some((e) => e.title === 'Matinee Band'));
  const late = dayPage('2030-01-05', { today: TODAY, now: at(15), movies: [] });
  assert.ok(late.started.some((e) => e.title === 'Matinee Band'));
  assert.ok(!late.groups.some((g) => g.items.some((e) => e.title === 'Matinee Band')));
});

test('Going also stars a show; Maybe is the star alone; clearing drops both', () => {
  let ev = setPlan(lastDay.id, 'going');
  assert.equal(ev.going, 1);
  assert.equal(ev.interested, 1);
  ev = setPlan(lastDay.id, 'maybe');
  assert.equal(ev.going, 0);
  assert.equal(ev.interested, 1);
  ev = setPlan(lastDay.id, null);
  assert.equal(ev.going, 0);
  assert.equal(ev.interested, 0);
  setPlan(lastDay.id, 'going');
  ev = setInterested(lastDay.id, false);
  assert.equal(ev.going, 0, 'un-starring also drops Going');
});

test('Saved splits upcoming starred shows into Going and Maybe', () => {
  setPlan(pupTonight.id, 'going');
  setPlan(quietShow.id, 'maybe');
  setPlan(yesterday.id, 'going');
  const saved = savedLists({ today: TODAY, now: NOW });
  assert.deepEqual(saved.going.map((e) => e.id), [pupTonight.id]);
  assert.ok(saved.maybe.some((e) => e.id === quietShow.id));
  assert.ok(!saved.maybe.some((e) => e.id === pupTonight.id));
  setPlan(pupTonight.id, null);
  setPlan(quietShow.id, null);
  setPlan(yesterday.id, null);
});

test('show details name who is on the bill and what else is on that night', () => {
  const details = eventDetails(supportSlot.id, { today: TODAY, now: NOW });
  assert.deepEqual(details.lineup.map((a) => a.name), ['Joyce Manor', 'PUP']);
  assert.equal(details.lineup[1].favorite, true);
  assert.equal(details.lineup[0].favorite, false);
  assert.equal(details.event.kind, 'music');
  assert.equal(details.event._kind.label, 'Music');
  assert.ok('descriptor' in details.lineup[0] && Array.isArray(details.lineup[0].fans));
  assert.equal(details.home.nearby, false, 'Seattle is not close to a Tacoma home');

  const tonight = eventDetails(pupTonight.id, { today: TODAY, now: NOW });
  assert.ok(!tonight.sameNight.some((e) => e.id === pupTonight.id));
  assert.ok(tonight.sameNight.some((e) => e.title === 'Open Mic'));
  assert.equal(eventDetails(999999), null);
});

test("an artist's page lists every upcoming date, headlining or not", () => {
  const pup = artistView('PUP', { today: TODAY, now: NOW });
  assert.equal(pup.favorite, true);
  assert.deepEqual(pup.upcoming.map((e) => e.id), [pupTonight.id, supportSlot.id, pupLater.id]);
});
