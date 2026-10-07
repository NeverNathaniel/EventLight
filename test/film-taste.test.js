// Tests for your film taste (src/cinema/taste.js): reading film-taste.json,
// recognising a favorite, scoring a film against the people, genres and
// themes you like, and how that feeds the film score, the picks and the
// listings. In-memory database; no network.
import './helpers/memory-db.js'; // must stay the first import
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { migrate } = await import('../src/db/migrate.js');
const {
  compileFilmTaste,
  loadFilmTaste,
  favoriteOf,
  filmTaste,
  titleCandidates,
  genreKey,
  STRONG_TASTE,
  TASTE,
} = await import('../src/cinema/taste.js');
const { filmScore, pickScore } = await import('../src/curation.js');
const { annotate } = await import('../src/annotate.js');
const { parseCrew } = await import('../src/cinema/wikidata.js');
const { ROOT_DIR } = await import('../src/config.js');

migrate();

// A small profile in the shape of film-taste.json.
const RAW = {
  favorites: {
    films: [
      { title: 'No Country for Old Men', short: 'No Country', year: 2007, tmdb: '6977' },
      { title: 'There Will Be Blood', year: 2007, tmdb: '7345' },
      { title: 'Phantom Thread', year: 2017, tmdb: '400617' },
      { title: 'Sicario', year: 2015, tmdb: '273481' },
      { title: 'Wind River', year: 2017, tmdb: '395834' },
      { title: 'Drive', year: 2011, tmdb: '64690' },
      { title: 'The Proposition', year: 2005 },
    ],
    tv: [{ title: 'Barry' }, { title: 'Succession' }],
  },
  people: [
    { name: 'Paul Thomas Anderson', weight: 5, for: ['There Will Be Blood', 'Phantom Thread'] },
    { name: 'Taylor Sheridan', weight: 5, for: ['Sicario', 'Wind River'] },
    { name: 'Jonny Greenwood', weight: 5, for: ['There Will Be Blood', 'Phantom Thread'] },
    { name: 'Josh Brolin', weight: 4, for: ['No Country for Old Men', 'Sicario'] },
    { name: 'S. Craig Zahler', aka: ['Steven Craig Zahler'], weight: 4, for: ['The Proposition'] },
    { name: 'Michael Bay', weight: -4 },
  ],
  genres: [
    { genre: 'western', label: 'A western', weight: 5, for: ['The Proposition'] },
    { genre: 'contemporary western', aka: ['neo western'], label: 'A neo-western', weight: 5, for: ['Wind River', 'No Country for Old Men'] },
    { genre: 'crime thriller', label: 'A crime thriller', weight: 4, for: ['Sicario'] },
    { genre: 'crime', label: 'A crime story', weight: 3, for: ['Wind River'] },
    { genre: 'thriller', label: 'A thriller', weight: 2, for: ['Sicario', 'Drive'] },
    { genre: 'romantic comedy', label: 'A romcom', weight: -3 },
  ],
  themes: [
    { label: 'Outlaws on the frontier', match: '\\b(?:frontier|outlaws?|ranch(?:ers?)?)\\b', weight: 4, for: ['The Proposition'] },
    { label: 'Crime on the border', match: '\\b(?:cartels?|the border)\\b', weight: 3, for: ['Sicario', 'No Country for Old Men'] },
    { label: 'Broken', match: '([', weight: 3 },
  ],
};
const P = compileFilmTaste(RAW);

// ── The profile ─────────────────────────────────────────────────────────────
test('compileFilmTaste: favorites, people (with aka), genres and themes; a broken entry is skipped, not fatal', () => {
  assert.equal(P.count, 9);
  assert.equal(P.favorites.length, 7);
  assert.ok(P.persons.has('s craig zahler'));
  assert.equal(P.persons.get('steven craig zahler').name, 'S. Craig Zahler');
  assert.equal(P.genres.length, 6);
  assert.equal(P.themes.length, 2);
  assert.deepEqual(P.skipped, ['Broken']);
  // A long title is quoted by its short name.
  assert.deepEqual(P.persons.get('josh brolin').for, ['No Country', 'Sicario']);
  assert.equal(compileFilmTaste(null), null);
});

test("the repo's film-taste.json compiles cleanly, and every `for` names one of its favorites", () => {
  const file = path.join(ROOT_DIR, 'film-taste.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const profile = compileFilmTaste(raw);
  assert.deepEqual(profile.skipped, []);
  assert.ok(profile.favorites.length >= 20);
  const all = [...raw.favorites.films, ...raw.favorites.tv];
  const names = new Set(all.flatMap((f) => [f.title, f.short].filter(Boolean)));
  for (const entry of [...raw.people, ...raw.genres, ...raw.themes]) {
    for (const name of entry.for || []) assert.ok(names.has(name), `${entry.name || entry.genre || entry.label}: "${name}" isn't a favorite`);
    assert.ok(Math.abs(entry.weight) >= 1 && Math.abs(entry.weight) <= 5, `${entry.name || entry.genre || entry.label} weight`);
  }
  for (const f of raw.favorites.films) assert.match(String(f.tmdb || ''), /^\d+$/, `${f.title} has a TMDB id`);
});

test('loadFilmTaste: re-reads the file when it changes; no file or bad JSON means no taste', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film-taste-'));
  const file = path.join(dir, 'film-taste.json');
  assert.equal(loadFilmTaste(file), null);
  assert.equal(loadFilmTaste(''), null);
  fs.writeFileSync(file, JSON.stringify({ favorites: { films: [{ title: 'Drive' }] } }));
  fs.utimesSync(file, new Date(2030, 0, 1), new Date(2030, 0, 1));
  assert.equal(loadFilmTaste(file).count, 1);
  fs.writeFileSync(file, JSON.stringify({ favorites: { films: [{ title: 'Drive' }, { title: 'Sicario' }] } }));
  fs.utimesSync(file, new Date(2030, 0, 2), new Date(2030, 0, 2));
  assert.equal(loadFilmTaste(file).count, 2);
  const warn = console.warn;
  console.warn = () => {};
  try {
    fs.writeFileSync(file, '{ not json');
    fs.utimesSync(file, new Date(2030, 0, 3), new Date(2030, 0, 3));
    assert.equal(loadFilmTaste(file), null);
  } finally {
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('genreKey: Wikidata and theater genres compare plainly', () => {
  assert.equal(genreKey('Western film'), 'western');
  assert.equal(genreKey('contemporary Western film'), 'contemporary western');
  assert.equal(genreKey('neo-noir'), 'neo noir');
  assert.equal(genreKey('comedy-drama film'), 'comedy drama');
  assert.equal(genreKey('post-apocalyptic television series'), 'post apocalyptic');
  assert.equal(genreKey('Science Fiction'), 'science fiction');
});

// ── Favorites ───────────────────────────────────────────────────────────────
test('titleCandidates: a part of the title counts only when nothing but screening noise follows it', () => {
  assert.ok(titleCandidates('Throwback Thursday: Drive').includes('drive'));
  assert.ok(titleCandidates('Drive (2011) in 35mm').includes('drive'));
  assert.ok(titleCandidates('No Country for Old Men + Q&A').includes('no country for old men'));
  assert.ok(titleCandidates('Come and See – 40th Anniversary 4K Restoration').includes('come and see'));
  assert.ok(!titleCandidates('Sicario: Day of the Soldado').includes('sicario'));
});

test('favoriteOf: by TMDB id, or by title when either side lacks one', () => {
  const fav = (film) => favoriteOf(film, P)?.title || null;
  assert.equal(fav({ title: 'Whatever the theater calls it', tmdb_id: '7345' }), 'There Will Be Blood');
  assert.equal(fav({ title: 'Power of the Dog' }), null);
  assert.equal(fav({ title: 'The Proposition (35mm)' }), 'The Proposition');
  assert.equal(fav({ title: 'Movie Night: Drive' }), 'Drive');
  // The id decides: a different film by the same name isn't the favorite.
  assert.equal(fav({ title: 'Drive', tmdb_id: '11111' }), null);
  // A sequel isn't the original; an older film of that name isn't either.
  assert.equal(fav({ title: 'Sicario: Day of the Soldado' }), null);
  assert.equal(fav({ title: 'Drive', year: 1997 }), null);
  // A re-release can carry a later date.
  assert.equal(fav({ title: 'Drive', release_date: '2026-10-09' }), 'Drive');
  // Shows aren't matched by title: "Barry" is also a film.
  assert.equal(fav({ title: 'Barry' }), null);
  assert.equal(favoriteOf({ title: 'Drive' }, null), null);
});

// ── Scoring ─────────────────────────────────────────────────────────────────
test('filmTaste: a new Paul Thomas Anderson film with a Jonny Greenwood score is squarely yours', () => {
  const t = filmTaste(
    {
      title: 'One Battle After Another',
      director: 'Paul Thomas Anderson',
      starring: 'Leonardo DiCaprio, Sean Penn, Benicio del Toro',
      wd_genres: 'black comedy film, thriller film, drama film',
      crew: { director: ['Paul Thomas Anderson'], writer: ['Paul Thomas Anderson'], composer: ['Jonny Greenwood'] },
    },
    P
  );
  assert.ok(t.strong);
  assert.ok(t.score >= STRONG_TASTE);
  assert.equal(t.favorite, null);
  // Director and writer are one person: credited once, as director.
  assert.deepEqual(t.reasons.slice(0, 2), [
    { kind: 'similar', text: 'Directed by Paul Thomas Anderson (There Will Be Blood, Phantom Thread)' },
    { kind: 'similar', text: 'Score by Jonny Greenwood (There Will Be Blood, Phantom Thread)' },
  ]);
  assert.deepEqual(t.link, { kind: 'similar', text: 'Like There Will Be Blood & Phantom Thread' });
});

test('filmTaste: a role weighs what it shapes — Sheridan directing counts more than Sheridan writing', () => {
  const directs = filmTaste({ title: 'X', crew: { director: ['Taylor Sheridan'], writer: ['Taylor Sheridan'] } }, P);
  const writes = filmTaste({ title: 'Y', crew: { writer: ['Taylor Sheridan'] } }, P);
  const acts = filmTaste({ title: 'Z', starring: 'Taylor Sheridan, Someone Else' }, P);
  assert.equal(directs.score, 5 * TASTE.role.director);
  assert.equal(writes.score, 5 * TASTE.role.writer);
  assert.equal(acts.score, Math.round(5 * TASTE.role.cast * 100) / 100);
  assert.equal(writes.reasons[0].text, 'Written by Taylor Sheridan (Sicario, Wind River)');
  assert.equal(acts.reasons[0].text, 'With Taylor Sheridan (Sicario, Wind River)');
  // The theater's director line works without Wikidata, and an aka matches.
  assert.equal(filmTaste({ title: 'W', director: 'Steven Craig Zahler' }, P).reasons[0].text, 'Directed by S. Craig Zahler (The Proposition)');
});

test('filmTaste: an unknown western on the frontier is your kind of film from its genre and synopsis', () => {
  const t = filmTaste(
    { title: 'Dust County', genre: 'Western', wd_genres: 'Western film, drama film', synopsis: 'An aging rancher hunts the outlaws who burned his homestead.' },
    P
  );
  assert.equal(t.score, 5 * TASTE.genre + 4 * TASTE.theme);
  assert.ok(t.strong);
  assert.deepEqual(t.reasons.map((r) => r.text), ['A western, like The Proposition', 'Outlaws on the frontier, like The Proposition']);
  assert.deepEqual(t.because, ['The Proposition']);
});

test('filmTaste: each genre tag counts once, toward its best match, with diminishing returns', () => {
  // "crime thriller" is a crime thriller, not also a crime story and a thriller.
  const one = filmTaste({ title: 'A', wd_genres: 'crime thriller film' }, P);
  assert.equal(one.score, 4 * TASTE.genre);
  const three = filmTaste({ title: 'B', wd_genres: 'crime thriller film, crime film, thriller film' }, P);
  assert.equal(three.score, Math.round((4 + 3 / 2 + 2 / 4) * TASTE.genre * 100) / 100);
  // A specific form of a genre counts partly: "revisionist western" is a western.
  assert.equal(filmTaste({ title: 'C', wd_genres: 'revisionist Western' }, P).score, 5 * TASTE.partialGenre * TASTE.genre);
  assert.ok(filmTaste({ title: 'D', wd_genres: Array(12).fill(0).map((_, i) => `western ${i}`).join(', ') }, P).score <= TASTE.genreMax);
});

test("filmTaste: a faint match makes no claim, a drama matches nothing, and what you don't like counts against", () => {
  const thriller = filmTaste({ title: 'A', wd_genres: 'thriller film' }, P);
  assert.equal(thriller.score, 2 * TASTE.genre);
  assert.equal(thriller.link, null);
  assert.equal(thriller.strong, false);
  const drama = filmTaste({ title: 'B', genre: 'Drama', wd_genres: 'drama film', synopsis: 'A family gathers for a wedding.' }, P);
  assert.deepEqual(drama, { score: 0, favorite: null, strong: false, reasons: [], because: [], link: null });
  const bay = filmTaste({ title: 'C', director: 'Michael Bay', wd_genres: 'romantic comedy film' }, P);
  assert.ok(bay.score < 0);
  assert.ok(bay.reasons.every((r) => r.kind === 'penalty'));
  assert.ok(bay.reasons.some((r) => r.text === 'A romcom — not your thing'));
  assert.ok(filmTaste({ title: 'D', director: 'Michael Bay', starring: 'Michael Bay' }, P).score >= TASTE.min);
  assert.deepEqual(filmTaste({ title: 'E' }, null).reasons, []);
});

test('filmTaste: the row names the favorites behind the strongest match — at a tie, what it is before who scored it', () => {
  const profile = compileFilmTaste({
    favorites: { films: [{ title: 'The Prestige' }, { title: 'There Will Be Blood' }], tv: [{ title: 'Atlanta' }, { title: 'Interview with the Vampire' }] },
    people: [
      { name: 'Christopher Nolan', weight: 4, for: ['The Prestige'] },
      { name: 'Ludwig Göransson', weight: 3, for: ['Atlanta'] },
    ],
    genres: [
      { genre: 'vampire', label: 'A vampire story', weight: 3, for: ['Interview with the Vampire'] },
      { genre: 'period drama', aka: ['historical'], label: 'A period piece', weight: 3, for: ['There Will Be Blood'] },
    ],
  });
  // A vampire story and a Göransson score both count 1.2.
  const sinners = filmTaste({ title: 'Sinners', wd_genres: 'vampire film', crew: { composer: ['Ludwig Goransson'] } }, profile);
  assert.equal(sinners.link.text, 'Like Interview with the Vampire');
  const oppenheimer = filmTaste(
    { title: 'Oppenheimer', wd_genres: 'historical film', crew: { director: ['Christopher Nolan'], composer: ['Ludwig Göransson'] } },
    profile
  );
  assert.equal(oppenheimer.link.text, 'Like The Prestige');
  assert.deepEqual(oppenheimer.because, ['The Prestige', 'There Will Be Blood', 'Atlanta']);
});

test('filmTaste: a synopsis adds to the score but never names favorites on the row', () => {
  const t = filmTaste({ title: 'X', synopsis: 'Outlaws and ranchers fight the cartels at the border.' }, P);
  assert.ok(t.score >= 1.5);
  assert.equal(t.link, null);
  assert.equal(t.reasons.length, 2);
  // With a genre behind it, the row names the genre's favorites, even when
  // the synopsis matched more strongly.
  const thriller = filmTaste({ title: 'Y', wd_genres: 'thriller film', synopsis: 'Outlaws and ranchers fight the cartels at the border.' }, P);
  assert.equal(thriller.reasons[0].text, 'Outlaws on the frontier, like The Proposition');
  assert.equal(thriller.link.text, 'Like Sicario & Drive');
  assert.deepEqual(thriller.because.slice(0, 2), ['Sicario', 'Drive']);
});

test('filmTaste: one of your favorites says so, and the total is capped', () => {
  const t = filmTaste(
    {
      title: 'There Will Be Blood',
      tmdb_id: '7345',
      director: 'Paul Thomas Anderson',
      wd_genres: 'Western film, crime thriller film',
      crew: { director: ['Paul Thomas Anderson'], composer: ['Jonny Greenwood'] },
      synopsis: 'A ruthless oil man on the frontier.',
    },
    P
  );
  assert.equal(t.favorite, 'There Will Be Blood');
  assert.equal(t.score, TASTE.max);
  assert.deepEqual(t.reasons[0], { kind: 'favorite', text: 'One of your favorites' });
  assert.deepEqual(t.link, { kind: 'favorite', text: 'One of your favorites' });
  // It isn't "like" itself: its reasons name your other favorites.
  assert.ok(!t.because.includes('There Will Be Blood'));
  assert.ok(t.reasons.some((r) => r.text === 'Directed by Paul Thomas Anderson (Phantom Thread)'), JSON.stringify(t.reasons));
});

// ── The film score and the picks ────────────────────────────────────────────
const D = '2030-01-11';
const TODAY = '2030-01-10';
const GRAND = 'The Grand Cinema';
const horizonByTheater = new Map([[GRAND, '2030-01-31']]);
const run = (fields) => ({
  title: 'A Run',
  venue: GRAND,
  date: D,
  special: false,
  peak: 24,
  upcoming: 18,
  firstDate: '2029-12-20',
  lastDate: '2030-01-24',
  mc_score: null,
  ...fields,
});
const score = (fields, taste = P) => filmScore(run(fields), { today: TODAY, horizonByTheater, taste });
const sheridan = { crew: { director: ['Taylor Sheridan'] }, wd_genres: 'contemporary Western film' };

test('filmScore: without a profile nothing changes', () => {
  const plain = score({ mc_score: 88 }, null);
  assert.equal(plain.score, 4);
  assert.equal(plain.eligible, false);
  assert.deepEqual(plain.taste, { score: 0, favorite: null, strong: false, because: [], link: null });
});

test('filmScore: your taste adds to the occasion and the reviews, and leads the reasons', () => {
  const f = score({ mc_score: 88, ...sheridan });
  const t = filmTaste(run(sheridan), P);
  assert.equal(f.score, 4 + t.score);
  assert.equal(f.reasons[0].text, 'Directed by Taylor Sheridan (Sicario, Wind River)');
  assert.ok(f.reasons.some((r) => r.text === 'Metacritic 88'));
  assert.ok(f.taste.strong);
});

test('filmScore: squarely your kind of film is a pick on its last day even without the critics; a faint match is not', () => {
  const lastDay = { lastDate: D };
  assert.equal(score({ ...lastDay, ...sheridan }).eligible, true);
  assert.equal(score({ ...lastDay, wd_genres: 'thriller film' }).eligible, false);
  // …and still not on an ordinary day of its run.
  assert.equal(score(sheridan).eligible, false);
});

test('filmScore: a favorite back on the big screen is a pick any day, and tops out under a favorite band', () => {
  const fav = { title: 'Wind River', tmdb_id: '395834', ...sheridan };
  assert.equal(score(fav).eligible, true);
  const oneNight = score({ ...fav, special: true, upcoming: 1, peak: 1, mc_score: 99, title: 'Wind River (35mm)' });
  assert.equal(oneNight.score, 11);
  assert.ok(pickScore({ kind: 'film', _kind: { family: 'film' }, _film: oneNight, _flags: [] }) < 12);
});

test('filmScore: a run you would avoid sinks, but never below zero', () => {
  const f = score({ mc_score: 70, director: 'Michael Bay', wd_genres: 'romantic comedy film' });
  assert.ok(f.score < 2);
  assert.ok(f.score >= 0);
  assert.ok(f.reasons.some((r) => r.kind === 'penalty'));
});

// ── Dressing a list ─────────────────────────────────────────────────────────
test('annotate: a film carries its taste on the row; a movie night showing a favorite becomes a pick', () => {
  const film = {
    id: 'film-1-2030-01-11',
    kind: 'film',
    title: 'Dust County',
    date: D,
    time: '19:00',
    times: ['19:00'],
    venue: GRAND,
    special: true,
    upcoming: 1,
    peak: 1,
    wd_genres: 'Western film',
    synopsis: 'Outlaws ride for the frontier.',
    _score: 0,
    _reasons: [],
  };
  const night = {
    id: 9001,
    kind: 'other',
    category: 'other',
    title: 'Movie Night: No Country for Old Men',
    date: D,
    time: '19:30',
    venue: 'Tracyton Movie House',
    source: 'feed',
    _score: 0,
    _reasons: [],
    _lineup: [],
  };
  const items = annotate([film, night], { today: TODAY, horizonByTheater, filmTaste: P, curated: null });
  assert.equal(film._feel.link.kind, 'similar');
  assert.equal(film._feel.link.text, 'Like The Proposition');
  assert.equal(film._feel.link.pre, 'One night only');
  assert.ok(film._pick > 6);

  assert.equal(night._kind.family, 'film');
  assert.equal(night._score, 8);
  assert.deepEqual(night._reasons[0], { kind: 'favorite', text: 'No Country for Old Men is one of your favorite films' });
  assert.equal(night._feel.link.kind, 'favorite');
  assert.ok(night._pick >= 8);
  // Dressing the same list again doesn't count it twice.
  annotate(items, { today: TODAY, horizonByTheater, filmTaste: P, curated: null });
  assert.equal(night._score, 8);
  assert.equal(night._reasons.filter((r) => r.kind === 'favorite').length, 1);
});

// ── Wikidata ────────────────────────────────────────────────────────────────
test('parseCrew: rows of (film, role, person) become each film’s crew, deduplicated', () => {
  const row = (tmdb, role, name) => ({ tmdb: { value: tmdb }, role: { value: role }, name: { value: name } });
  const crew = parseCrew([
    row('7345', 'director', 'Paul Thomas Anderson'),
    row('7345', 'writer', 'Paul Thomas Anderson'),
    row('7345', 'composer', 'Jonny Greenwood'),
    row('7345', 'composer', 'Jonny Greenwood'),
    row('273481', 'cinematographer', 'Roger Deakins'),
    row('273481', 'producer', 'Someone'),
    { tmdb: { value: '1' } },
  ]);
  assert.deepEqual(crew.get('7345'), {
    director: ['Paul Thomas Anderson'],
    writer: ['Paul Thomas Anderson'],
    composer: ['Jonny Greenwood'],
  });
  assert.deepEqual(crew.get('273481'), { cinematographer: ['Roger Deakins'] });
  assert.equal(crew.has('1'), false);
});

test('the crew is stored with the film facts; a failed crew lookup is asked again, a film Wikidata lacks is not', async () => {
  const { replaceTheaterMovies, saveMovieFacts, moviesNeedingFacts, getMovies } = await import('../src/db/movies.js');
  replaceTheaterMovies('crew-test', [{ theater_id: 'crew-test', source_id: '1', theater: 'Crew Test', title: 'A Film', tmdb_id: '7345', showtimes: ['2030-01-01T03:00:00.000Z'] }]);
  const row = getMovies().find((m) => m.theater_id === 'crew-test');
  const pending = () => moviesNeedingFacts().some((m) => m.id === row.id);
  assert.ok(pending());
  saveMovieFacts(row.id, { genres: ['drama film'], series: null, rt: null, mc: null, crew: null });
  assert.ok(pending(), 'the crew query failed: ask again');
  saveMovieFacts(row.id, { genres: ['drama film'], series: null, rt: null, mc: null, crew: { composer: ['Jonny Greenwood'] } });
  assert.ok(!pending());
  assert.deepEqual(getMovies().find((m) => m.id === row.id).crew, { composer: ['Jonny Greenwood'] });
  saveMovieFacts(row.id, null);
  assert.ok(!pending(), 'unknown to Wikidata: not asked again until the week is up');
  assert.deepEqual(getMovies().find((m) => m.id === row.id).crew, {});
});
