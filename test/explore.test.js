// Tests for the listings API behind Explore and the day page: films arrive
// with the shows, a page's worth of days at a time and each date once, the
// calendar counts them, every listing says what it is, and a past day's page
// is today's. Runs against a throwaway in-memory database and real dates.
import './helpers/memory-db.js'; // must stay the first import
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { upsertEvent } = await import('../src/db/queries.js');
const { todayISO, addDays } = await import('../src/dates.js');
const { default: eventsRouter } = await import('../src/routes/events.js');
const { default: weekRouter } = await import('../src/routes/week.js');

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
db.prepare(`INSERT INTO movies (theater_id, source_id, theater, city, title, rating, runtime, genre, release_date, showtimes, first_showing, last_showing, peak_showings, mc_score)
  VALUES ('grand', '1', 'The Grand Cinema', 'Tacoma', 'Paris, Texas', 'R', 145, 'Drama', '1984-05-19', ?, ?, ?, 2, 88)`)
  .run(JSON.stringify(showtimes), showtimes[0], showtimes[1]);

const app = express();
app.use('/api', eventsRouter);
app.use('/api', weekRouter);
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

test('filtered lists (a category, a search) carry no films', async () => {
  const music = await get(`/events?dateFrom=${T}&category=music&withFilms=1`);
  assert.equal(music.films, undefined);
  const search = await get(`/events?dateFrom=${T}&search=band&withFilms=1`);
  assert.equal(search.films, undefined);
});

test('the month calendar counts films on the days they show', async () => {
  const month = addDays(T, 2).slice(0, 7);
  const r = await get(`/views/month?month=${month}`);
  assert.equal(r.counts[addDays(T, 2)], 1);
  const music = await get(`/views/month?month=${month}&category=music`);
  assert.equal(music.counts[addDays(T, 2)], undefined);
});

test('a day’s page: a past or malformed date gets today’s page', async () => {
  const past = await get('/views/day?date=1999-01-01');
  assert.equal(past.date, T);
  const junk = await get('/views/day?date=tomorrow');
  assert.equal(junk.date, T);
  const later = await get(`/views/day?date=${addDays(T, 2)}`);
  assert.equal(later.date, addDays(T, 2));
  const listed = [...later.picks, ...later.groups.flatMap((g) => g.items)];
  assert.ok(listed.some((f) => f.title === 'Paris, Texas'), 'a day with only a film still lists it');
});
