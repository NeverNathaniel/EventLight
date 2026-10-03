// Tests for the preference engine: favorites, sound-alikes, genre matching,
// penalties and the reasons attached to each score. Runs against a throwaway
// in-memory database.
import './helpers/memory-db.js'; // must stay the first import
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { upsertEvent, setManualGenre, setInterested, setHidden } = await import('../src/db/queries.js');
const { setFavoriteArtist, replaceSimilarArtists, saveArtist } = await import('../src/db/artists.js');
const { scoreEvents, scoreEvent, buildSimilarity, tagMatch, normTag, hasArtistMatch } = await import(
  '../src/scoring/engine.js'
);

migrate();
// Start from a known taste rather than the repo's taste-profile.json.
db.exec('DELETE FROM manual_genres; DELETE FROM favorite_artists; DELETE FROM preferences;');
setManualGenre('punk', 5);
setManualGenre('indie rock', 4);
setManualGenre('pop', 3);
setManualGenre('comedy', 3);
setFavoriteArtist('PUP', 5);

let n = 0;
function addEvent(fields) {
  n += 1;
  upsertEvent({
    source: 'scrape',
    source_name: 'test',
    venue: 'Test Hall',
    date: '2030-01-01',
    category: 'music',
    genre_tags: ['music'],
    title: `Event ${n}`,
    ...fields,
  });
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
}
const score = (ev) => scoreEvents([db.prepare('SELECT * FROM events WHERE id = ?').get(ev.id)])[0];

test('normTag / tagMatch: directional, whole-word matching', () => {
  assert.equal(normTag('Post-Hardcore'), 'post hardcore');
  assert.equal(tagMatch('punk', 'punk'), 1);
  assert.ok(tagMatch('punk', 'pop punk') > 0); // a "punk" weight covers pop punk…
  assert.equal(tagMatch('indie rock', 'rock'), 0); // …but "indie rock" doesn't cover plain rock
  assert.equal(tagMatch('pop', 'popular'), 0); // whole words only
});

test('a favorite headlining a scraped show is a strong pick, with a reason', () => {
  const ev = addEvent({ title: 'Tractor Presents: PUP w/ Illuminati Hotties AT The Sunset' });
  const s = score(ev);
  assert.ok(s._score >= 20, `expected a big score, got ${s._score}`);
  assert.equal(s._reasons[0].kind, 'favorite');
  assert.match(s._reasons[0].text, /PUP is a favorite/);
  assert.ok(hasArtistMatch(s));
});

test('a favorite opening counts too, but less than headlining', () => {
  const head = score(addEvent({ title: 'PUP' }));
  const open = score(addEvent({ title: 'Joyce Manor w/ PUP' }));
  assert.ok(open._score > 0 && open._score < head._score);
  assert.match(open._reasons[0].text, /on the bill/);
});

test('short favorite names need a lineup match, not a substring ("Puppy" is not PUP)', () => {
  const s = score(addEvent({ title: 'Puppy Angst' }));
  assert.equal(s._reasons.filter((r) => r.kind === 'favorite').length, 0);
});

test('a favorite\'s name inside another act\'s name is not a match', () => {
  setFavoriteArtist('Cannons', 4);
  const s = score(addEvent({ title: 'Dearheart, The Requisite, Glass Cannons' }));
  assert.ok(!hasArtistMatch(s), JSON.stringify(s._reasons));
  // …but a favorite the parser missed is still found in the title.
  const missed = score(addEvent({ title: 'Big Night feat. Cannons and friends', lineup: ['Big Night'] }));
  assert.ok(hasArtistMatch(missed), JSON.stringify(missed._reasons));
});

test('tribute nights never count as the real favorite', () => {
  const s = score(addEvent({ title: 'PUP Tribute Night' }));
  assert.ok(!hasArtistMatch(s));
  assert.ok(s._reasons.some((r) => r.text === 'Tribute act'));
});

test('genre: looked-up artist tags make scraped shows matchable', () => {
  saveArtist({ key: 'militarie gun', name: 'Militarie Gun', tags: ['hardcore punk', 'indie rock'], status: 'found' });
  const ev = addEvent({ title: 'Militarie Gun' });
  db.prepare('UPDATE events SET artist_tags = ? WHERE id = ?').run('hardcore punk, indie rock', ev.id);
  const s = score(ev);
  assert.ok(s._base > 4, `genre base ${s._base}`);
  assert.deepEqual(s._matched.slice(0, 2), ['indie rock', 'punk']);
});

test('genre: a generic "pop" tag no longer outscores a squarely matching show', () => {
  // The old engine matched substrings both ways, so plain "pop" scored as
  // pop + indie pop + synth pop + dream pop + pop punk.
  setManualGenre('indie pop', 4);
  setManualGenre('synth pop', 4);
  setManualGenre('pop punk', 4);
  const generic = score(addEvent({ title: 'Arena Pop Star', genre_tags: ['pop'] }));
  const punk = score(addEvent({ title: 'Some Punk Band', genre_tags: ['punk'] }));
  assert.ok(punk._score > generic._score, `${punk._score} vs ${generic._score}`);
});

test('category tags ("music") carry no taste signal', () => {
  const s = score(addEvent({ title: 'Unknown Local Band' }));
  assert.equal(s._score, 0);
});

test('hiding a show demotes other shows by the same headliner', () => {
  const first = addEvent({ title: 'Nickel Rock Band', genre_tags: ['punk'], date: '2030-02-01' });
  const before = score(addEvent({ title: 'Nickel Rock Band', genre_tags: ['punk'], date: '2030-02-02' }));
  setHidden(first.id, true);
  const after = scoreEvents([db.prepare('SELECT * FROM events WHERE id = ?').get(before.id)])[0];
  assert.ok(after._score < before._score);
  assert.ok(after._reasons.some((r) => r.kind === 'penalty'));
});

test('starring a show makes its headliner a learned favorite', () => {
  const starred = addEvent({ title: 'Remo Drive', date: '2030-03-01' });
  setInterested(starred.id, true);
  const later = score(addEvent({ title: 'Remo Drive w/ Mom Jeans.', date: '2030-04-01' }));
  assert.ok(later._reasons.some((r) => r.kind === 'learned'));
});

test('sounds-like: an act on a favorite\'s similar list gets a boost and a reason', () => {
  saveArtist({ key: 'pup', name: 'PUP', mbid: 'x', status: 'found' });
  replaceSimilarArtists('pup', 'PUP', [
    { key: 'jeff rosenstock', name: 'Jeff Rosenstock', score: 1 },
    { key: 'radiohead', name: 'Radiohead', score: 0.6 },
  ]);
  const s = score(addEvent({ title: 'Jeff Rosenstock' }));
  const sim = s._reasons.find((r) => r.kind === 'similar');
  assert.ok(sim, JSON.stringify(s._reasons));
  assert.match(sim.text, /Jeff Rosenstock sounds like PUP/);
});

test('buildSimilarity: shared distinctive neighbors link a band to a favorite; hubs do not', () => {
  const favorites = new Map([['pup', { name: 'PUP', weight: 5 }]]);
  const learned = new Map();
  const row = (seed, artist, score) => ({ seed_key: seed, seed_name: seed, artist_key: artist, name: artist, score });
  const hubs = ['radiohead', 'the beatles', 'nirvana'];
  const rows = [
    // PUP's neighbors: two distinctive bands plus the hubs.
    row('pup', 'joyce manor', 1), row('pup', 'modern baseball', 0.9),
    ...hubs.map((h) => row('pup', h, 0.8)),
    // Movements shares PUP's distinctive neighbors.
    row('movements', 'joyce manor', 1), row('movements', 'modern baseball', 1),
    row('movements', 'turnover', 0.9),
    // A jam band that only shares the hubs.
    row('jam band', 'radiohead', 1), row('jam band', 'the beatles', 1), row('jam band', 'nirvana', 1),
    row('jam band', 'phish', 1),
    // Other lists that make the hubs hubs.
    ...['a', 'b', 'c', 'd', 'e', 'f'].flatMap((x) => [...hubs.map((h) => row(x, h, 1)), row(x, `${x} pal`, 1)]),
  ];
  const sim = buildSimilarity(rows, favorites, learned);
  const movements = sim.get('movements');
  assert.ok(movements, 'Movements should link to PUP');
  assert.equal(movements.seed, 'PUP');
  assert.deepEqual(movements.via, ['joyce manor', 'modern baseball']);
  const jam = sim.get('jam band');
  assert.ok(!jam || jam.strength < movements.strength / 2, `hub-only link too strong: ${jam?.strength}`);
});

test('scoreEvent works on a bare context (no DB) for callers that build their own', () => {
  const ctx = {
    manualGenres: [{ genre: 'emo', key: 'emo', weight: 5 }],
    favorites: new Map(),
    learned: new Map(),
    similar: new Map(),
    hidden: new Set(),
    prefs: [],
  };
  const s = scoreEvent({ title: 'X', lineup: '["X"]', genre_tags: 'emo', artist_tags: '' }, ctx);
  assert.equal(s.score, 5);
});
