// Your film taste on the screens: the Week screen and a day's page with a
// film-taste.json in place — your kind of film leads At the movies, the
// films line says who it's like, a favorite's screening is a pick and a
// ticket, and a run you'd love is a pick on its last day without the
// critics. In-memory database; no network.
import './helpers/memory-db.js'; // must stay the first import
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A profile on disk, set before src/config.js loads (the helper turned taste off).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film-taste-week-'));
const file = path.join(dir, 'film-taste.json');
fs.writeFileSync(
  file,
  JSON.stringify({
    favorites: { films: [{ title: 'Wind River', year: 2017, tmdb: '395834' }, { title: 'Sicario', year: 2015, tmdb: '273481' }] },
    people: [{ name: 'Taylor Sheridan', weight: 5, for: ['Sicario', 'Wind River'] }],
    genres: [{ genre: 'western', label: 'A western', weight: 5, for: ['Wind River'] }],
  })
);
process.env.EVENTLIGHT_FILM_TASTE = file;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { migrate } = await import('../src/db/migrate.js');
const { weekBrief, dayPage, movieGroups } = await import('../src/week.js');
migrate();

// Saturday 5 January 2030.
const TODAY = '2030-01-05';
const NOW = new Date(2030, 0, 5, 8, 0).getTime();
const local = (d, h) => new Date(2030, 0, d, h, 0).toISOString();
const days = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const movie = (fields) => ({
  theater: 'The Grand Cinema',
  city: 'Tacoma',
  rating: 'R',
  genre: 'Drama',
  hidden: 0,
  crew: {},
  ...fields,
  peak_showings: fields.showtimes.length,
});
const MOVIES = [
  // A run squarely your taste, without reviews, ending Thursday.
  movie({ id: 1, title: 'Badlands Run', genre: 'Western', director: 'Taylor Sheridan', release_date: '2029-12-01',
    showtimes: days(5, 10).flatMap((d) => [local(d, 16), local(d, 19)]) }),
  // A run the critics love that isn't your kind of film, ending the same day.
  movie({ id: 2, title: 'Critics Darling', mc_score: 90, release_date: '2029-12-01',
    showtimes: days(5, 10).flatMap((d) => [local(d, 15), local(d, 20)]) }),
  // One of your favorites, one night only (the theater calls it something else).
  movie({ id: 3, title: 'Wind River (2017)', tmdb_id: '395834', genre: 'Thriller', release_date: '2017-08-04',
    showtimes: [local(8, 19)] }),
  // A run that keeps the theater's posted schedule going past Thursday.
  movie({ id: 4, title: 'Later Run', release_date: '2029-12-01',
    showtimes: days(5, 20).map((d) => local(d, 18)) }),
];
const opts = { today: TODAY, now: NOW, movies: MOVIES };

test('At the movies leads with your kind of film, ahead of a better-reviewed run', () => {
  const page = dayPage('2030-01-06', opts);
  const films = page.groups.find((g) => g.key === 'film');
  const titles = films.items.map((f) => f.title);
  assert.ok(titles.indexOf('Badlands Run') < titles.indexOf('Critics Darling'), titles.join(', '));
  const run = films.items.find((f) => f.title === 'Badlands Run');
  assert.equal(run._feel.link.text, 'Like Sicario & Wind River');
  assert.equal(run._reasons[0].text, 'Directed by Taylor Sheridan (Sicario, Wind River)');
});

test("the Week's films line says who a film is like", () => {
  const sunday = weekBrief(opts).days[1];
  const top = sunday.films.top.find((f) => f.title === 'Badlands Run');
  assert.ok(top, JSON.stringify(sunday.films));
  assert.equal(top.note, 'like Sicario');
});

test("a favorite's one-night screening is the day's film pick and the week's film ticket", () => {
  const brief = weekBrief(opts);
  const tuesday = brief.days[3];
  const pick = tuesday.picks.find((e) => e.movie_id === 3);
  assert.ok(pick, 'Wind River is a pick on Tuesday');
  assert.equal(pick._feel.link.kind, 'favorite');
  assert.equal(pick._feel.link.pre, 'One night only');
  assert.ok(brief.picks.some((e) => e.movie_id === 3), 'and the week’s film ticket');
  // The day's sentence names it, not "a favorite at the Grand" (that's a band).
  assert.match(tuesday.dek, /Wind River on the big screen/);
});

test('a run squarely your taste is a pick on its last day even without reviews — over the critics’ choice', () => {
  const thursday = dayPage('2030-01-10', opts);
  const film = thursday.picks.find((e) => e.kind === 'film');
  assert.equal(film?.title, 'Badlands Run');
  assert.ok(film._flags.some((f) => f.key === 'last-chance'));
  // On an ordinary day of the run, it isn't.
  assert.ok(!dayPage('2030-01-07', opts).picks.some((e) => e.title === 'Badlands Run'));
});

test('Explore → Film lists your kind of film first', () => {
  const groups = movieGroups(opts);
  assert.equal(groups.nowPlaying[0].title, 'Badlands Run');
  assert.equal(groups.special[0]._feel.link.text, 'One of your favorites');
});
