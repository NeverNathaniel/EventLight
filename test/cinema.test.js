// Tests for the Movies feature: the kids / vapid-action filter, the Indy
// Systems mapping (The Grand Cinema) and Wikidata parsing. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMovie } from '../src/cinema/filter.js';
import { mapIndyMovie, plainText } from '../src/cinema/indy.js';
import { parseBindings, parseScore } from '../src/cinema/wikidata.js';

const film = (fields) => ({ title: 'A Film', rating: 'R', genre: 'Drama', wd_genres: '', ...fields });
const verdict = (fields) => classifyMovie(film(fields));

test('arthouse fare is kept', () => {
  assert.equal(verdict({ title: 'Primetime', genre: 'Crime' }).hidden, false);
  assert.equal(verdict({ title: 'Filipiñana', rating: null, genre: 'Drama' }).hidden, false);
  assert.equal(verdict({ title: 'Kwaidan (4K Restoration)', rating: null, genre: 'Horror' }).hidden, false);
});

test("kids' movies are filtered, with a reason", () => {
  assert.deepEqual(verdict({ title: 'Muppet Treasure Island', rating: 'G', genre: 'Adventure' }), {
    hidden: true,
    kind: 'kids',
    reason: 'Rated G',
  });
  // Casper is PG fantasy — only Wikidata knows it's a children's film.
  const casper = verdict({ title: 'Casper', rating: 'PG', genre: 'Fantasy', wd_genres: "ghost film, children's film, family film" });
  assert.equal(casper.kind, 'kids');
  assert.match(casper.reason, /children's film/);
  assert.equal(verdict({ title: 'Shorts4Shorties', rating: null, genre: null }).kind, 'kids');
  assert.equal(verdict({ title: 'TFF Cereal Cinema', rating: null, genre: null }).kind, 'kids');
  assert.equal(verdict({ title: 'Free Family Flick: Paddington', rating: 'PG' }).kind, 'kids');
  assert.equal(verdict({ title: 'Toy Story', rating: 'G', genre: 'Animation' }).kind, 'kids');
  assert.equal(verdict({ title: 'Some Cartoon', rating: 'PG', genre: 'Animation' }).kind, 'kids');
});

test('titles that merely mention kids or children are kept', () => {
  assert.equal(verdict({ title: 'The Kid', rating: null, genre: 'Comedy' }).hidden, false);
  assert.equal(verdict({ title: 'Children of Men', rating: 'R' }).hidden, false);
  assert.equal(verdict({ title: "The Children's Hour", rating: null }).hidden, false);
  assert.equal(verdict({ title: 'The Kids Are All Right', rating: 'R', genre: 'Comedy' }).hidden, false);
  assert.equal(verdict({ title: 'A Family Drama', wd_genres: 'family drama film' }).hidden, false);
});

test('grown-up animation and PG fantasy without a kids tag are kept', () => {
  assert.equal(verdict({ title: 'Wildwood', rating: 'PG-13', genre: 'Animation' }).hidden, false);
  assert.equal(verdict({ title: 'Legend', rating: 'PG', genre: 'Adventure', wd_genres: 'fantasy film, adventure film' }).hidden, false);
  // An R-rated film Wikidata happens to call a "family film" isn't for kids.
  assert.equal(verdict({ title: 'Grim Fairy Tale', rating: 'R', wd_genres: 'family film' }).hidden, false);
});

test('vapid action is filtered: franchise and superhero films need real acclaim', () => {
  const fastX = verdict({ title: 'Fast X', rating: 'PG-13', genre: 'Action', wd_genres: 'action film', wd_series: 'Fast & Furious', rt_score: 56, mc_score: 56 });
  assert.equal(fastX.kind, 'action');
  assert.equal(fastX.reason, 'Franchise action (Fast & Furious) · Metacritic 56, RT 56%');
  const endgame = verdict({ title: 'Avengers: Endgame', rating: 'PG-13', wd_genres: 'superhero film, action film', wd_series: 'Marvel Cinematic Universe', rt_score: 94, mc_score: 78 });
  assert.equal(endgame.kind, 'action');
  assert.match(endgame.reason, /^Superhero movie/);
});

test('acclaimed action is kept', () => {
  assert.equal(
    verdict({ title: 'The Dark Knight', rating: 'PG-13', wd_genres: 'superhero film, action film', wd_series: 'Batman in film', rt_score: 94, mc_score: 85 }).hidden,
    false
  );
  assert.equal(verdict({ title: 'Indie Heist', rating: 'R', genre: 'Action', rt_score: 92 }).hidden, false);
});

test('non-franchise action with no scores gets the benefit of the doubt', () => {
  assert.equal(verdict({ title: 'Hong Kong Restoration', rating: null, genre: 'Action' }).hidden, false);
  assert.equal(verdict({ title: 'Generic Shootout', rating: 'R', genre: 'Action', rt_score: 41 }).kind, 'action');
});

test('Indy Systems movies map to rows with links, poster and sorted showtimes', () => {
  const row = mapIndyMovie(
    {
      id: '146259',
      name: 'Primetime ',
      urlSlug: 'primetime',
      synopsis: 'In 2006, <i>To Catch a Predator </i>host Chris Hansen sets out.<div><br></div>',
      rating: 'R',
      duration: 110,
      genre: 'Crime',
      posterImage: '9eqoq2f6sli3m3rl5a6jezo80zzp',
      trailerYoutubeId: '5fHXyqQOKL8',
      directedBy: 'Lance Oppenheim',
      tmdbId: 1375441,
    },
    ['2026-10-04T21:20:00.000Z', '2026-10-04T18:30:00.000Z', '2026-10-04T18:30:00.000Z'],
    { id: 'grand-cinema', name: 'The Grand Cinema', url: 'https://grandcinema.com', city: 'Tacoma' }
  );
  assert.equal(row.title, 'Primetime');
  assert.equal(row.url, 'https://grandcinema.com/movie/primetime/');
  assert.match(row.poster_url, /^https:\/\/indy-systems\.imgix\.net\/9eqoq2f6sli3m3rl5a6jezo80zzp\?/);
  assert.equal(row.trailer_url, 'https://www.youtube.com/watch?v=5fHXyqQOKL8');
  assert.equal(row.synopsis, 'In 2006, To Catch a Predator host Chris Hansen sets out.');
  assert.deepEqual(row.showtimes, ['2026-10-04T18:30:00.000Z', '2026-10-04T21:20:00.000Z']);
  assert.equal(row.first_showing, '2026-10-04T18:30:00.000Z');
  assert.equal(row.tmdb_id, '1375441');
  assert.equal(plainText('A &amp; B<br>C'), 'A & B C');
});

test('Wikidata scores and facts parse', () => {
  assert.equal(parseScore('59%|5.7/10', 'rt'), 59);
  assert.equal(parseScore('49/100', 'mc'), 49);
  assert.equal(parseScore('5.7/10', 'rt'), null);
  const facts = parseBindings([
    {
      tmdb: { value: '385687' },
      genres: { value: 'action film' },
      series: { value: 'Fast & Furious' },
      rts: { value: '56%' },
      mcs: { value: '56/100' },
    },
  ]);
  assert.deepEqual(facts.get('385687'), { genres: ['action film'], series: 'Fast & Furious', rt: 56, mc: 56 });
});

test('groupMovies: runs, special screenings, coming soon, filtered, hidden', async () => {
  const { groupMovies } = await import('../src/cinema/group.js');
  const now = Date.parse('2026-10-03T19:00:00Z');
  const at = (days, hour = 3) => new Date(now + days * 86400000 + hour * 3600000).toISOString();
  const row = (id, title, times, extra = {}) => ({ id, title, rating: 'R', genre: 'Drama', hidden: 0, showtimes: times, release_date: '2026-09-01', ...extra });
  const g = groupMovies(
    [
      row(1, 'Long Run', [at(0), at(1), at(2), at(9)]),
      row(2, 'Leaving Soon', [at(0), at(0, 5), at(1), at(1, 5)]),
      row(3, 'Kwaidan', [at(5)], { release_date: '1965-01-06' }),
      row(4, 'Opens Later', [at(10), at(11), at(12), at(13)]),
      row(5, 'Muppets', [at(3)], { rating: 'G' }),
      row(6, 'Not For Me', [at(1), at(2), at(3), at(4)], { hidden: 1 }),
      row(7, 'Already Over', [at(-2)]),
    ],
    now
  );
  assert.deepEqual(g.nowPlaying.map((m) => m.title), ['Leaving Soon', 'Long Run']);
  assert.deepEqual(g.special.map((m) => m.title), ['Kwaidan']);
  assert.equal(g.special[0].year, 1965);
  assert.deepEqual(g.comingSoon.map((m) => m.title), ['Opens Later']);
  assert.deepEqual(g.filtered.map((m) => [m.title, m._filter.reason]), [['Muppets', 'Rated G']]);
  assert.deepEqual(g.hidden.map((m) => m.title), ['Not For Me']);
});

test('replaceTheaterMovies keeps your ✕ and cached facts, drops films no longer showing', async () => {
  process.env.EVENTLIGHT_DB = ':memory:';
  const { default: db } = await import('../src/db/index.js');
  const { replaceTheaterMovies, setMovieHidden, saveMovieFacts, getMovies } = await import('../src/db/movies.js');
  const base = { theater_id: 'grand-cinema', theater: 'The Grand Cinema', title: 'X', showtimes: ['2030-01-01T03:00:00.000Z'] };
  replaceTheaterMovies('grand-cinema', [{ ...base, source_id: '1', title: 'Keep' }, { ...base, source_id: '2', title: 'Gone' }]);
  const keep = db.prepare("SELECT id FROM movies WHERE source_id = '1'").get().id;
  setMovieHidden(keep, true);
  saveMovieFacts(keep, { genres: ['drama film'], series: null, rt: 90, mc: 80 });
  const result = replaceTheaterMovies('grand-cinema', [{ ...base, source_id: '1', title: 'Keep (updated)' }]);
  assert.deepEqual(result, { saved: 1, removed: 1 });
  const [m] = getMovies();
  assert.equal(m.title, 'Keep (updated)');
  assert.equal(m.hidden, 1);
  assert.equal(m.rt_score, 90);
  assert.deepEqual(m.showtimes, ['2030-01-01T03:00:00.000Z']);
});
