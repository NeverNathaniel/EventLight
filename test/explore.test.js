// Tests for the listings API behind Explore and the day page: films arrive
// with the shows, a page's worth of days at a time and each date once, the
// calendar counts them, every listing says what it is, and a past day's page
// is today's. Runs against a throwaway in-memory database and real dates.
import './helpers/memory-db.js'; // must stay the first import
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { upsertEvent } = await import('../src/db/queries.js');
const { todayISO, addDays } = await import('../src/dates.js');
const { default: eventsRouter, curatedView } = await import('../src/routes/events.js');
const { default: weekRouter } = await import('../src/routes/week.js');
const { default: moviesRouter } = await import('../src/routes/movies.js');
const { saveArtist } = await import('../src/db/artists.js');
const { DAYS_AHEAD } = await import('../src/cinema/index.js');

migrate();
const T = todayISO();

for (const [d, title, category] of [
  [0, 'Early Band', 'music'], [0, 'Late Band', 'music'],
  [1, 'Tuesday Band', 'music'],
  [3, 'Thursday Band', 'music'], [3, 'Geeks Who Drink Trivia', 'other'],
]) {
  upsertEvent({ source: 'scrape', source_name: 'test', title, venue: 'Test Hall', city: 'Tacoma', category, date: addDays(T, d), time: '20:00' });
}
// A film showing on days 2 and 3 (none on the days with only shows).
const at = (d, h) => {
  const x = new Date(`${addDays(T, d)}T00:00:00`);
  x.setHours(h, 0);
  return x.toISOString();
};
const showtimes = [at(2, 19), at(3, 19)];
db.prepare(`INSERT INTO movies (theater_id, source_id, theater, city, title, rating, runtime, genre, director, starring, release_date, showtimes, first_showing, last_showing, peak_showings, mc_score)
  VALUES ('grand', '1', 'The Grand Cinema', 'Tacoma', 'Paris, Texas', 'R', 145, 'Drama', 'Wim Wenders', 'Harry Dean Stanton, Nastassja Kinski', '1984-05-19', ?, ?, ?, 2, 88)`)
  .run(JSON.stringify(showtimes), showtimes[0], showtimes[1]);

const app = express();
app.use('/api', eventsRouter);
app.use('/api', weekRouter);
app.use('/api', moviesRouter);
const server = app.listen(0);
after(() => server.close());
const base = `http://localhost:${server.address().port}/api`;
const get = async (path) => (await fetch(`${base}${path}`)).json();

test('Explore by date brings each day’s films along, each date exactly once across pages', async () => {
  const seen = [];
  let filmsFrom = null;
  const titles = [];
  for (let page = 1; page <= 3; page += 1) {
    const q = new URLSearchParams({ dateFrom: T, sort: 'date', page, pageSize: 2, withFilms: '1' });
    if (filmsFrom) q.set('filmsFrom', filmsFrom);
    const r = await get(`/events?${q}`);
    assert.equal(r.pages, 3);
    titles.push(...r.events.map((e) => e.title));
    for (const date of Object.keys(r.films)) {
      assert.ok(!seen.includes(date), `${date} came twice`);
      seen.push(date);
      for (const f of r.films[date]) assert.equal(f._kind.label, 'Film');
    }
    filmsFrom = addDays(r.filmsTo, 1);
  }
  assert.equal(titles.length, 5);
  assert.deepEqual(seen.sort(), [addDays(T, 2), addDays(T, 3)], 'a day with films and no shows is included');
});

test('every listing says what it is', async () => {
  const r = await get(`/events?dateFrom=${T}&pageSize=50`);
  const trivia = r.events.find((e) => e.title === 'Geeks Who Drink Trivia');
  assert.equal(trivia._kind.label, 'Trivia');
  assert.equal(trivia._headline, 'Geeks Who Drink Trivia');
  assert.equal(r.events.find((e) => e.title === 'Early Band')._kind.label, 'Music');
  assert.equal(r.films, undefined, 'films only when asked for');
});

test('a chip (category or group) or Best match carries no films', async () => {
  const music = await get(`/events?dateFrom=${T}&category=music&withFilms=1`);
  assert.equal(music.films, undefined);
  const group = await get(`/events?dateFrom=${T}&group=around&withFilms=1`);
  assert.equal(group.films, undefined);
  const ranked = await get(`/events?dateFrom=${T}&sort=relevance&search=wenders&withFilms=1`);
  assert.equal(ranked.films, undefined);
});

test('a search brings the films whose title, director or cast match it, any case', async () => {
  const dates = [addDays(T, 2), addDays(T, 3)];
  for (const q of ['wenders', 'PARIS, tex', 'harry dean']) {
    const r = await get(`/events?dateFrom=${T}&search=${encodeURIComponent(q)}&withFilms=1`);
    assert.deepEqual(r.events, [], q);
    assert.deepEqual(Object.keys(r.films).sort(), dates, q);
    const film = r.films[dates[0]][0];
    assert.equal(film.title, 'Paris, Texas');
    assert.equal(film._kind.label, 'Film');
    assert.equal(r.filmsTo, addDays(T, DAYS_AHEAD), 'no shows match, so this is the last page: films through the listings');
  }
  const bands = await get(`/events?dateFrom=${T}&search=band&withFilms=1`);
  assert.equal(bands.events.length, 4);
  assert.deepEqual(bands.films, {}, 'no film matches "band"');
});

test('a broken date in an Explore link still gets the list and its films, never a 500', async () => {
  const year = Number(T.slice(0, 4)) + 1;
  for (const q of [`filmsFrom=${year}-13-45`, `filmsFrom=${year}-02-30`, 'filmsFrom=soon']) {
    const r = await fetch(`${base}/events?dateFrom=${T}&withFilms=1&${q}`);
    assert.equal(r.status, 200, q);
    const body = await r.json();
    assert.ok(body.films[addDays(T, 2)], `${q}: films from the list's own start`);
  }
  for (const from of ['garbage', `${year}-13-45`]) {
    const r = await fetch(`${base}/events?dateFrom=${from}&withFilms=1`);
    assert.equal(r.status, 200, from);
    assert.equal(typeof (await r.json()).filmsTo, 'string', from);
  }
});

test('the month calendar counts films on the days they show — under a search, the films that match', async () => {
  const month = addDays(T, 2).slice(0, 7);
  const r = await get(`/views/month?month=${month}`);
  assert.equal(r.counts[addDays(T, 2)], 1);
  const music = await get(`/views/month?month=${month}&category=music`);
  assert.equal(music.counts[addDays(T, 2)], undefined);
  const group = await get(`/views/month?month=${month}&group=music`);
  assert.equal(group.counts[addDays(T, 2)], undefined, 'a group chip counts no films');
  const wenders = await get(`/views/month?month=${month}&search=wenders`);
  assert.equal(wenders.counts[addDays(T, 2)], 1);
  const band = await get(`/views/month?month=${month}&search=band`);
  assert.equal(band.counts[addDays(T, 2)], undefined);
});

test('a day’s page: a past or malformed date gets today’s page', async () => {
  const past = await get('/views/day?date=1999-01-01');
  assert.equal(past.date, T);
  const junk = await get('/views/day?date=tomorrow');
  assert.equal(junk.date, T);
  // Well formed but not a real day, or absurdly far off: today, never a 500.
  const year = Number(T.slice(0, 4)) + 1;
  for (const date of [`${year}-11-31`, `${year}-02-30`, `${year}-12-32`, `${year}-13-01`, '9999-12-31', addDays(T, 500)]) {
    const r = await fetch(`${base}/views/day?date=${date}`);
    assert.equal(r.status, 200, date);
    assert.equal((await r.json()).date, T, date);
  }
  const later = await get(`/views/day?date=${addDays(T, 2)}`);
  assert.equal(later.date, addDays(T, 2));
  const listed = [...later.picks, ...later.groups.flatMap((g) => g.items)];
  assert.ok(listed.some((f) => f.title === 'Paris, Texas'), 'a day with only a film still lists it');
});

test('Explore’s groups match the day page: a talk or cabaret at a music venue is Around town, a known band filed as other is Music', async () => {
  const day = addDays(T, 1);
  const show = (title, category) =>
    upsertEvent({ source: 'scrape', source_name: 'test', title, venue: 'Jazzbones', city: 'Tacoma', category, date: day, time: '19:00' });
  show('Story Slam: Tales of the Sound', 'music');
  show('Sunday Cabaret', 'music');
  show('Film School', 'other');
  saveArtist({ key: 'film school', name: 'Film School', status: 'found' });

  const titles = async (q) => (await get(`/events?dateFrom=${T}&pageSize=50&${q}`)).events.map((e) => e.title);
  const around = await titles('group=around');
  assert.deepEqual(around.sort(), ['Geeks Who Drink Trivia', 'Story Slam: Tales of the Sound', 'Sunday Cabaret']);
  const music = await titles('group=music');
  assert.ok(music.includes('Film School'));
  assert.ok(!music.includes('Story Slam: Tales of the Sound') && !music.includes('Sunday Cabaret'));
  // The day page puts them in the same places.
  const page = await get(`/views/day?date=${day}`);
  const groupOf = (title) => [...page.picks, ...page.groups.flatMap((g) => g.items.map((e) => ({ ...e, _group: g.key })))]
    .find((e) => e.title === title)?._group;
  assert.equal(groupOf('Story Slam: Tales of the Sound'), 'around');
  assert.equal(groupOf('Film School'), 'music');
  // The old category filter still answers older clients.
  assert.ok((await titles('category=music')).includes('Sunday Cabaret'));
  assert.deepEqual(await titles('group=comedy'), []);
  // The calendar under a chip counts the same listings.
  const month = await get(`/views/month?month=${day.slice(0, 7)}&group=around`);
  assert.equal(month.counts[day], 2, 'the story slam and the cabaret');

  // Grouped before paging: totals and pages count the group, and pages don't overlap.
  const first = await get(`/events?dateFrom=${T}&group=music&pageSize=2&page=1`);
  assert.equal(first.total, music.length);
  assert.equal(first.pages, Math.ceil(music.length / 2));
  const paged = [];
  for (let p = 1; p <= first.pages; p += 1) paged.push(...(await get(`/events?dateFrom=${T}&group=music&pageSize=2&page=${p}`)).events.map((e) => e.title));
  assert.deepEqual(paged, music);
  const ranked = await get(`/events?dateFrom=${T}&group=around&sort=relevance`);
  assert.equal(ranked.total, 3);
  assert.ok(ranked.events.every((e) => e._group === 'around'));
});

test('the curated view dresses its rows like every other list, keeping the curator’s reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlight-curated-view-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = (title) => db.prepare('SELECT id FROM events WHERE title = ?').get(title).id;
  const file = path.join(dir, 'curated.json');
  fs.writeFileSync(file, JSON.stringify({
    criteria: 'something different',
    generated_at: new Date().toISOString(),
    events: [{ id: id('Story Slam: Tales of the Sound'), reason: 'True stories, cheap' }, { id: id('Geeks Who Drink Trivia'), reason: 'A team night' }],
  }));
  const view = curatedView(file);
  assert.equal(view.criteria, 'something different');
  assert.deepEqual(view.events.map((e) => e._reason), ['True stories, cheap', 'A team night']);
  assert.deepEqual(view.events.map((e) => e._kind.label), ['Talk', 'Trivia']);
  assert.equal(view.events[0]._headline, 'Story Slam: Tales of the Sound');
  assert.ok(view.events.every((e) => e._feel && 'link' in e._feel && typeof e._pick === 'number'));
  assert.deepEqual(curatedView(path.join(dir, 'missing.json')), { criteria: null, generated_at: null, events: [] });
});

test('the Film list carries flags, the feel line and _pick for each film’s next showing, best first in each group', async () => {
  const run = (sourceId, title, days, extra = {}) => {
    const times = days.map((d) => at(d, 19));
    db.prepare(`INSERT INTO movies (theater_id, source_id, theater, city, title, rating, genre, director, release_date, showtimes, first_showing, last_showing, peak_showings, mc_score)
      VALUES ('grand', ?, 'The Grand Cinema', 'Tacoma', ?, 'R', 'Drama', ?, ?, ?, ?, ?, ?, ?)`)
      .run(sourceId, title, extra.director ?? null, extra.release_date ?? '2020-01-01', JSON.stringify(times), times[0], times[times.length - 1],
        extra.peak ?? times.length, extra.mc_score ?? null);
  };
  // The theater posts through day 20, so a run whose only showing left is
  // tomorrow is on its last chance.
  run('2', 'Acclaimed Run', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { mc_score: 90 });
  run('3', 'Leaving Soon', [1, 2, 3, 4], { mc_score: 60 });
  run('4', 'Last Day', [1], { mc_score: 80, peak: 10, director: 'Kit Moreau' });
  run('5', 'Horizon', [16, 17, 18, 19, 20], { mc_score: 50 });
  run('6', 'Kwaidan', [1], { release_date: '1965-01-06' });

  const m = await get('/views/movies');
  // Soonest-ending first would be Last Day, Leaving Soon, Acclaimed Run.
  assert.deepEqual(m.nowPlaying.map((f) => f.title), ['Last Day', 'Acclaimed Run', 'Leaving Soon']);
  const last = m.nowPlaying[0];
  assert.deepEqual(last._flags.map((f) => f.key), ['last-chance']);
  assert.equal(last._feel.link.text, 'Last chance · dir. Kit Moreau');
  assert.equal(last._kind.label, 'Film');
  assert.equal(last._pick, 4.5);
  assert.deepEqual(m.nowPlaying.map((f) => f._pick), [4.5, 4, 1]);
  // Specials: Paris, Texas (MC 88) above Kwaidan (one night, no reviews), though Kwaidan is sooner.
  assert.deepEqual(m.special.map((f) => f.title), ['Paris, Texas', 'Kwaidan']);
  assert.deepEqual(m.special[1]._flags.map((f) => f.key), ['one-night']);
  assert.ok(m.special[0]._pick > m.special[1]._pick);
  assert.deepEqual(m.comingSoon.map((f) => f.title), ['Horizon']);
});
