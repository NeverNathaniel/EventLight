// Tests for a row's "feel": the genre line, venue habits, the bill fallback,
// "for fans of", descriptors, previews, the one "is it for us" line, and the
// film line. Runs against a throwaway in-memory database.
import './helpers/memory-db.js'; // must stay the first import
import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { upsertEvent, setManualGenre, setInterested } = await import('../src/db/queries.js');
const { setFavoriteArtist, saveArtist, replaceSimilarArtists, saveArtistProfile } = await import(
  '../src/db/artists.js'
);
const { buildContext } = await import('../src/scoring/engine.js');
const { artistKey } = await import('../src/lineup.js');
const { addDays } = await import('../src/dates.js');
const {
  loadFacts, headlinerFound, displayTags, fansOf, descriptorOf, previewOf, venueHabits, attachFeel, DESCRIPTOR_RE,
} = await import('../src/feel.js');

migrate();
// Start from a known taste rather than the repo's taste-profile.json.
db.exec('DELETE FROM manual_genres; DELETE FROM favorite_artists; DELETE FROM preferences;');
setManualGenre('emo', 4);
setManualGenre('indie rock', 4);
setManualGenre('singer-songwriter', 3);
setFavoriteArtist('PUP', 5);
setFavoriteArtist('Big Thief', 4);

const TODAY = '2030-01-05';

// Mal Blum becomes a starred (learned) artist: the headliner of a show you
// marked Interested.
upsertEvent({ source: 'scrape', source_name: 'test', title: 'Mal Blum', venue: 'Elsewhere', date: '2029-12-01', category: 'music' });
setInterested(db.prepare("SELECT id FROM events WHERE title = 'Mal Blum'").get().id, true);

const tagged = (name, tags, status = 'found') => saveArtist({ key: artistKey(name), name, tags, status });
tagged('Joyce Manor', ['punk', 'pop punk', 'emo', 'indie rock']);
tagged('Glass Harbor', ['indie', 'shoegaze', 'dream pop']);
tagged('Folk Only', ['folk']);
tagged('Many Rocks', ['rock', 'pop', 'jazz']);
tagged('Slow Hands', ['shoegaze', 'noise pop', 'slowcore', 'emo']);
tagged('Long Tags', ['singer-songwriter', 'chamber pop', 'baroque pop']);
tagged('Known Opener', ['black metal', 'doom metal']);
tagged('Place Band', ['canadian', 'seattle', 'seen live', '90s', 'a very long tag that goes on', 'indie rock']);
tagged('Comic Tagged', ['comedy', 'stand-up comedy']);
tagged('Teen Fears', ['emo']);
tagged('Not Found Band', [], 'not_found');
tagged('Rock Punk', ['rock', 'punk']);
// A metal band that shares a play's name, and a country singer who hosts a
// quiz night: their tags belong to neither the play nor the quiz.
tagged('Hamlet', ['metal', 'hardcore']);
tagged('Jen Ray', ['country']);

// Similar lists. Radiohead sits on 13 of 15 lists — a hub — while Turnover is
// on PUP's list as well as Joyce Manor's.
const sim = (key, name, score) => ({ key, name, score });
replaceSimilarArtists('joyce manor', 'Joyce Manor', [
  sim('radiohead', 'Radiohead', 1),
  sim('an extremely long band name', 'An Extremely Long Band Name', 0.95),
  sim('teen fears', 'Teen Fears', 0.9),
  sim('music of nirvana', 'The Music of Nirvana', 0.85),
  sim('mal blum', 'Mal Blum', 0.3),
  sim('turnover', 'Turnover', 0.4),
  sim('big thief', 'Big Thief', 0.4),
  sim('modern baseball', 'Modern Baseball', 0.35),
]);
replaceSimilarArtists('pup', 'PUP', [sim('turnover', 'Turnover', 0.5), sim('static saints', 'Static Saints', 0.6)]);
for (let i = 1; i <= 12; i += 1) {
  replaceSimilarArtists(`filler ${i}`, `Filler ${i}`, [
    sim('radiohead', 'Radiohead', 0.5),
    sim(`neighbour ${i}`, `Neighbour ${i}`, 0.4),
    ...(i === 1 ? [sim('static saints', 'Static Saints', 0.9)] : []),
  ]);
}
replaceSimilarArtists('dj foo', 'DJ Foo', [sim('dj bar', 'DJ Bar', 0.8), sim('house crew', 'House Crew', 0.6)]);

// Cached profiles, as src/enrich/profile.js stores them.
const song = (title) => ({ title, preview: `https://audio.example/${encodeURIComponent(title)}.m4a` });
const profile = (name, data) => saveArtistProfile(artistKey(name), name, 'found', { name, ...data });
profile('PUP', { description: 'Canadian punk rock band', apple: { genre: 'Punk', songs: [song('DVP')] } });
profile('Low', { description: 'American rock band', apple: { genre: 'Rock', match: 'mb', songs: [song('Lullaby')] } });
profile('Joyce Manor', { description: 'American pop punk band (formed 2008)', apple: { genre: 'Alternative', songs: [song('Constant Headache')] } });
profile('Funny Business', { description: 'American comedy troupe', apple: { genre: 'Comedy', songs: [song('Bit One')] } });
profile('Comic Person', { apple: { genre: 'Alternative', match: 'name', songs: [song('Wrong Guy')] } });
profile('Mal Blum', { apple: { genre: "Children's Music", match: 'name', songs: [song('Kids Song')] } });
profile('Hannibal Buress', { type: 'Person', description: 'American comedian (born 1983)', apple: { genre: 'Comedy', songs: [song('Animal Furnace')] } });
profile('Some Actor', { type: 'Person', from: 'Chicago, United States', description: 'American actor' });
profile('Alvvays', {
  type: 'Group', from: 'Toronto, Canada', since: '2011',
  description: 'Canadian band formed in Toronto by childhood friends from Cape Breton Island',
});
profile('Ended Band', { type: 'Group', from: 'Olympia, United States', since: '2001', until: '2010' });
profile('Lowercase', { description: 'punk band from Ohio' });
profile('No Facts', { description: 'Ice hockey player' });
profile('Lyric Smith', { apple: { genre: 'Hip-Hop/Rap', songs: [] } });
profile('Ka', { apple: { genre: 'Hip-Hop/Rap', songs: [] } });
// MusicBrainz's life span for a person is a birth and a death.
profile('Born Person', { type: 'Person', from: 'Tacoma, United States', since: '1983', until: '2020' });
// A stand-up's lookup that found a namesake musician.
profile('Namesake Comic', { type: 'Person', from: 'Austin, United States', description: 'US singer-songwriter' });
profile('Troupe', { type: 'Group', from: 'Chicago, United States', since: '1999' });
// Guard words in descriptions of someone (or something) else.
profile('Strip Band', { description: 'American comic strip' });
profile('Fighter', { description: 'American martial artist' });
profile('Producer Comic', { description: 'American comedian and film producer' });

// Venue habits: one room books punk, one is all over the place, one has too
// few tagged shows to judge.
let showN = 0;
function show(venue, headliner, tags, date = addDays(TODAY, (showN % 60) - 30), extra = {}) {
  showN += 1;
  const name = `${headliner} ${showN}`;
  if (tags) tagged(name, tags);
  upsertEvent({ source: 'scrape', source_name: 'test', title: name, lineup: [name], venue, date, category: 'music', ...extra });
}
for (let i = 0; i < 5; i += 1) show('Garage Bar', 'Garage Band', ['garage rock', 'punk']);
for (let i = 0; i < 3; i += 1) show('Garage Bar', 'Punk Band', ['punk']);
for (let i = 0; i < 2; i += 1) show('Garage Bar', 'Folk Band', ['folk']);
show('Garage Bar', 'Untagged Band', null);
show('Garage Bar', 'Far Future', ['folk'], addDays(TODAY, 200)); // outside the window
for (let i = 0; i < 7; i += 1) show('Seven Club', 'Seven Band', ['garage rock']);
for (let i = 0; i < 8; i += 1) show('Eight Club', 'Eight Band', ['garage rock']);
for (const tags of [['surf rock'], ['surf rock'], ['surf rock'], ['surf rock'], ['jazz'], ['jazz'], ['metal'], ['metal'], ['house'], ['house']]) {
  show('Edge Room', 'Edge Band', tags);
}
for (const tags of [['jazz'], ['jazz'], ['jazz'], ['folk'], ['folk'], ['folk'], ['metal'], ['metal'], ['house'], ['house']]) {
  show('Mixed Room', 'Mixed Band', tags);
}
// The window's edges: 120 days back and ahead are in, 121 are out.
for (let i = 0; i < 6; i += 1) show('Window Edge', 'Edge Act', ['bluegrass']);
show('Window Edge', 'Edge Act', ['bluegrass'], addDays(TODAY, -120));
show('Window Edge', 'Edge Act', ['bluegrass'], addDays(TODAY, 120));
for (let i = 0; i < 6; i += 1) show('Past Edge', 'Past Act', ['bluegrass']);
show('Past Edge', 'Past Act', ['bluegrass'], addDays(TODAY, -121));
show('Past Edge', 'Past Act', ['bluegrass'], addDays(TODAY, 121));
// A weekly quiz hosted by that country singer, listed by a music venue.
for (let i = 0; i < 8; i += 1) {
  upsertEvent({
    source: 'scrape', source_name: 'test', title: 'Trivia Night hosted by Jen Ray', lineup: ['Jen Ray'],
    venue: 'Quiz Bar', date: addDays(TODAY, i * 7 - 28), category: 'music',
  });
}

const facts = loadFacts([], buildContext(), { today: TODAY });

// A scored show, as attachFeel sees it.
function item(fields) {
  const lineup = fields._lineup || [fields.title];
  return { category: 'music', venue: 'Test Hall', genre_tags: '', _reasons: [], ...fields, _lineup: lineup, kind: fields.category || 'music' };
}
const factsFor = (items) => loadFacts(items, buildContext(), { today: TODAY });
const tagsOf = (it, f = factsFor([it])) => displayTags(it, f).tags.map((t) => t.tag);

// ── Facts ───────────────────────────────────────────────────────────────────

test('loadFacts reads artists, both directions of the similar lists, and slim profiles', () => {
  const joyce = item({ title: 'Joyce Manor', _lineup: ['Joyce Manor', 'Teen Fears'] });
  const f = factsFor([joyce]);
  assert.deepEqual(f.artists.get('joyce manor'), { status: 'found', tags: ['punk', 'pop punk', 'emo', 'indie rock'] });
  assert.ok(f.artists.has('teen fears'), 'support acts are read too');
  assert.equal(f.similarBySeed.get('joyce manor')[0].name, 'Radiohead', 'closest first');
  assert.deepEqual(f.profiles.get('joyce manor').apple, { genre: 'Alternative', match: null, songs: [song('Constant Headache')] });
  assert.equal(f.df.get('radiohead'), 13);
  assert.equal(f.n, 15);
  assert.ok(f.favorites.has('pup') && f.learned.has('mal blum'));
  assert.ok(f.venueHabits instanceof Map);
});

test('loadFacts batches big lineups in chunks', () => {
  const items = Array.from({ length: 1200 }, (_, i) => item({ title: `Nobody ${i}` }));
  items.push(item({ title: 'Joyce Manor' }));
  const f = factsFor(items);
  assert.equal(headlinerFound(items.at(-1), f), true, 'a key in the last chunk still resolves');
  assert.equal(headlinerFound(items[0], f), false);
});

test('headlinerFound: only a found artist row counts', () => {
  const f = factsFor([item({ title: 'Not Found Band' })]);
  assert.equal(headlinerFound(item({ title: 'Joyce Manor' }), factsFor([item({ title: 'Joyce Manor' })])), true);
  assert.equal(headlinerFound(item({ title: 'Not Found Band' }), f), false);
  assert.equal(headlinerFound(item({ title: 'Trivia', _lineup: [] }), f), false);
});

// ── Genres ──────────────────────────────────────────────────────────────────

test('a specific tag replaces the broader one in place: punk goes once pop punk is in', () => {
  const joyce = item({ title: 'Joyce Manor' });
  const shown = displayTags(joyce, factsFor([joyce]));
  assert.deepEqual(shown.tags, [
    { tag: 'pop punk', hit: false },
    { tag: 'emo', hit: true },
    { tag: 'indie rock', hit: true },
  ]);
  assert.equal(shown.from, 'artist');
  // Specific first, broad second: the broad one never gets in.
  assert.deepEqual(tagsOf(item({ title: 'Nobody Known', genre_tags: 'pop punk, punk' })), ['pop punk']);
});

test('a coarse tag goes last, only one of them, and stays when it is alone', () => {
  assert.deepEqual(tagsOf(item({ title: 'Glass Harbor' })), ['shoegaze', 'dream pop', 'indie']);
  assert.deepEqual(tagsOf(item({ title: 'Folk Only' })), ['folk']);
  assert.deepEqual(tagsOf(item({ title: 'Many Rocks' })), ['rock']);
  // Of two broad tags, the one you weighted is the one kept.
  const both = item({ title: 'Rock Punk' });
  const f = factsFor([both]);
  assert.deepEqual(tagsOf(both, f), ['rock']);
  const punkFan = { ...f, manualGenres: [{ genre: 'punk', key: 'punk', weight: 4 }] };
  assert.deepEqual(displayTags(both, punkFan).tags, [{ tag: 'punk', hit: true }]);
});

test('a genre you weighted beyond slot 3 is swapped into slot 3', () => {
  const slow = item({ title: 'Slow Hands' });
  const f = factsFor([slow]);
  assert.deepEqual(displayTags(slow, f).tags, [
    { tag: 'shoegaze', hit: false },
    { tag: 'noise pop', hit: false },
    { tag: 'emo', hit: true },
  ]);
  assert.deepEqual(tagsOf(slow, { ...f, manualGenres: [] }), ['shoegaze', 'noise pop', 'slowcore']);
});

test('the genre line fits 34 characters by dropping whole tags from the end', () => {
  const tags = tagsOf(item({ title: 'Long Tags' }));
  assert.deepEqual(tags, ['singer-songwriter', 'chamber pop']);
  assert.ok(tags.join(' · ').length <= 34);
});

test("an unknown headliner never borrows the opener's tags", () => {
  const it = item({
    title: 'Mystery Headliner w/ Known Opener',
    _lineup: ['Mystery Headliner', 'Known Opener'],
    artist_tags: 'black metal, doom metal', // the event rollup: the opener's tags
  });
  const shown = displayTags(it, factsFor([it]));
  assert.deepEqual(shown.tags, []);
  assert.deepEqual(shown, { tags: [], from: 'bill', text: 'local bill · 2 acts' });
});

test("title-led rows never take a namesake's or a host's tags", () => {
  // Enrichment found a metal band called Hamlet; the play shows no genres.
  const play = item({ title: 'Hamlet', category: 'other', genre_tags: 'Theatre', _lineup: ['Hamlet'] });
  assert.deepEqual(displayTags(play, factsFor([play])), { tags: [], from: null });
  const quiz = item({ title: 'Trivia Night hosted by Jen Ray', category: 'music', _lineup: ['Jen Ray'] });
  assert.deepEqual(displayTags(quiz, factsFor([quiz])), { tags: [], from: null });
  // A night's own source tags still say what it is.
  const jam = item({ title: 'Sunday Jazz Jam', genre_tags: 'jazz', _lineup: [] });
  assert.deepEqual(displayTags(jam, factsFor([jam])), { tags: [{ tag: 'jazz', hit: false }], from: 'source' });
  // A movie night's "lineup" is the film, so it gets no fans or descriptor.
  const movie = item({ title: 'Movie Night: Static Saints', category: 'other', _lineup: ['Static Saints'] });
  const feel = attachFeel([movie], { facts: factsFor([movie]) })[0]._feel;
  assert.deepEqual(feel.fans, []);
  assert.equal(feel.descriptor, null);
});

test('places, listener habits, decades, long tags and kind echoes are not genres', () => {
  assert.deepEqual(tagsOf(item({ title: 'Place Band' })), ['indie rock']);
  assert.deepEqual(tagsOf(item({ title: 'Hamlet', category: 'other', genre_tags: 'Theatre, Other, undefined' })), []);
  assert.deepEqual(tagsOf(item({ title: 'Nobody Known', genre_tags: 'Music, Live Music, Concerts' })), []);
});

test('synonyms fold sources together, and Apple\'s genre is the last resort', () => {
  assert.deepEqual(tagsOf(item({ title: 'Nobody Known', genre_tags: 'Dance/Electronic, Electronica' })), ['electronic']);
  const lyric = item({ title: 'Lyric Smith' });
  assert.deepEqual(displayTags(lyric, factsFor([lyric])), { tags: [{ tag: 'hip hop', hit: false }], from: 'apple' });
  // A short single-word name could be anyone on Apple.
  assert.deepEqual(tagsOf(item({ title: 'Ka' })), []);
  // Source tags come after the artist's own.
  const mixed = item({ title: 'Folk Only', genre_tags: 'americana' });
  assert.deepEqual(displayTags(mixed, factsFor([mixed])).from, 'artist');
  assert.deepEqual(tagsOf(mixed), ['americana', 'folk']);
});

test('comedy rows carry no genre tags, even from the artist row', () => {
  assert.deepEqual(tagsOf(item({ title: 'Comic Tagged', category: 'comedy', genre_tags: 'comedy, stand-up' })), []);
  assert.deepEqual(tagsOf(item({ title: 'Joyce Manor', category: 'comedy' })), []);
});

// ── Venue habits and the bill fallback ──────────────────────────────────────

test('venue habits: 8+ tagged shows and a top tag on 40% of them', () => {
  const habits = venueHabits({ today: TODAY });
  // punk on 8 of 10 tagged shows, garage rock on 5; folk (2 of 10) is too rare
  // to mention, and the show 200 days out doesn't count.
  assert.deepEqual(habits.get('Garage Bar'), { tags: ['punk', 'garage rock'] });
  assert.equal(habits.has('Seven Club'), false, '7 tagged shows are too few');
  assert.deepEqual(habits.get('Eight Club'), { tags: ['garage rock'] }, '8 are enough');
  assert.equal(habits.has('Mixed Room'), false, 'no tag on 40% of the shows');
  // Exactly 40% is enough; a second tag on only 20% isn't named.
  assert.deepEqual(habits.get('Edge Room'), { tags: ['surf rock'] });
});

test('venue habits: 120 days back to 120 days ahead, both ends included', () => {
  const habits = venueHabits({ today: TODAY });
  assert.deepEqual(habits.get('Window Edge'), { tags: ['bluegrass'] }, 'shows on the edge days count');
  assert.equal(habits.has('Past Edge'), false, 'shows a day past either edge do not');
});

test("venue habits: a quiz night's host isn't what the room books", () => {
  assert.equal(venueHabits({ today: TODAY }).has('Quiz Bar'), false);
  const band = item({ title: 'Nobody Known', venue: 'Quiz Bar' });
  assert.deepEqual(displayTags(band, factsFor([band])), { tags: [], from: null });
});

test('the habit line only fills in for a music row with no genres', () => {
  const unknown = item({ title: 'Nobody Known', venue: 'Garage Bar' });
  assert.deepEqual(displayTags(unknown, facts), { tags: [], from: 'venue', text: 'usually punk · garage rock here' });
  const folk = item({ title: 'Folk Only', venue: 'Garage Bar' });
  assert.equal(displayTags(folk, factsFor([folk])).from, 'artist');
  assert.deepEqual(displayTags(item({ title: 'Some Comic', category: 'comedy', venue: 'Garage Bar' }), facts), { tags: [], from: null });
  // A habit beats the bill fallback.
  const bill = item({ title: 'A w/ B', _lineup: ['Nobody A', 'Nobody B'], venue: 'Garage Bar' });
  assert.equal(displayTags(bill, facts).from, 'venue');
});

test('a bill of unknowns says how many acts, and one unknown act says nothing', () => {
  const three = item({ title: 'A, B, C', _lineup: ['Nobody A', 'Nobody B', 'Nobody C'], venue: 'Seven Club' });
  assert.deepEqual(displayTags(three, facts), { tags: [], from: 'bill', text: 'local bill · 3 acts' });
  assert.deepEqual(displayTags(item({ title: 'Nobody Known', venue: 'Seven Club' }), facts), { tags: [], from: null });
});

// ── For fans of ──────────────────────────────────────────────────────────────

test('fansOf: names you know lead, hubs sink, and the bill, tributes and long names are left out', () => {
  const joyce = item({ title: 'Joyce Manor w/ Teen Fears', _lineup: ['Joyce Manor', 'Teen Fears'] });
  const f = factsFor([joyce]);
  const fans = fansOf(joyce, f, { limit: 6 });
  assert.deepEqual(fans.map((x) => x.name), ['Big Thief', 'Mal Blum', 'Turnover', 'Modern Baseball', 'Radiohead']);
  assert.deepEqual(fans[0], { name: 'Big Thief', favorite: true, starred: false });
  assert.deepEqual(fans[1], { name: 'Mal Blum', favorite: false, starred: true });
  assert.equal(fansOf(joyce, f).length, 3, 'three by default');
  assert.deepEqual(fansOf(joyce, f, { exclude: ['Big Thief'] }).map((x) => x.name), ['Mal Blum', 'Turnover', 'Modern Baseball']);
});

test('fansOf: hubs are only demoted once there are 10+ lists', () => {
  const joyce = item({ title: 'Joyce Manor w/ Teen Fears', _lineup: ['Joyce Manor', 'Teen Fears'] });
  const f = factsFor([joyce]);
  assert.deepEqual(fansOf(joyce, { ...f, n: 5 }).map((x) => x.name), ['Big Thief', 'Radiohead', 'Mal Blum']);
});

test("fansOf: without its own list, an act borrows the lists it's on", () => {
  const saints = item({ title: 'Static Saints' });
  const fans = fansOf(saints, factsFor([saints]));
  assert.deepEqual(fans, [
    { name: 'PUP', favorite: true, starred: false },
    { name: 'Filler 1', favorite: false, starred: false },
  ]);
  assert.deepEqual(fansOf(item({ title: 'Nobody Known' }), facts), []);
  assert.deepEqual(fansOf(item({ title: 'Trivia', _lineup: [] }), facts), []);
});

// ── Descriptor and preview ──────────────────────────────────────────────────

test('descriptor: a performer-like description, asides removed', () => {
  const f = factsFor([]);
  const names = ['Hannibal Buress', 'Joyce Manor', 'PUP', 'Lowercase', 'Some Actor', 'Alvvays', 'Ended Band', 'No Facts'];
  const all = factsFor(names.map((title) => item({ title })));
  assert.equal(descriptorOf('Hannibal Buress', all), 'American comedian');
  assert.equal(descriptorOf('Joyce Manor', all), 'American pop punk band');
  assert.equal(descriptorOf('Lowercase', all), 'Punk band from Ohio');
  // Not a performer's description: built from MusicBrainz facts instead, or none.
  assert.equal(descriptorOf('Some Actor', all), 'Musician from Chicago, United States');
  assert.equal(descriptorOf('Some Actor', all, { family: 'comedy' }), 'Comedian from Chicago, United States');
  assert.equal(descriptorOf('No Facts', all), null);
  // Too long for a row.
  assert.equal(descriptorOf('Alvvays', all), 'Band from Toronto, Canada · since 2011');
  assert.equal(descriptorOf('Ended Band', all), 'Band from Olympia, United States · 2001–2010');
  assert.equal(descriptorOf('Nobody Known', f), null);
  assert.ok(DESCRIPTOR_RE.test('American stand-up comedian') && !DESCRIPTOR_RE.test('1984 film'));
});

test("descriptor: a person's life span isn't a career, and a row wants its own kind of act", () => {
  const names = ['Born Person', 'Namesake Comic', 'Troupe', 'Strip Band', 'Fighter', 'Producer Comic', 'Hannibal Buress', 'Alvvays'];
  const all = factsFor(names.map((title) => item({ title })));
  // MusicBrainz's 1983–2020 for a person is a birth and a death.
  assert.equal(descriptorOf('Born Person', all), 'Musician from Tacoma, United States');
  // A musician's description on a stand-up row means a namesake: nothing,
  // not even a "Comedian from Austin" built from the namesake's facts.
  assert.equal(descriptorOf('Namesake Comic', all, { family: 'comedy' }), null);
  assert.equal(descriptorOf('Namesake Comic', all, { family: 'music' }), 'US singer-songwriter');
  assert.equal(descriptorOf('Hannibal Buress', all, { family: 'music' }), null);
  assert.equal(descriptorOf('Hannibal Buress', all, { family: 'comedy' }), 'American comedian');
  assert.equal(descriptorOf('Alvvays', all, { family: 'comedy' }), null);
  assert.equal(descriptorOf('Troupe', all, { family: 'music' }), 'Band from Chicago, United States · since 1999');
  assert.equal(descriptorOf('Troupe', all, { family: 'comedy' }), null);
  // Guard words in someone else's description don't count…
  assert.equal(descriptorOf('Strip Band', all), null);
  assert.equal(descriptorOf('Fighter', all), null);
  // …but a comedian who also produces films is still a comedian.
  assert.equal(descriptorOf('Producer Comic', all, { family: 'comedy' }), 'American comedian and film producer');
  // On a music row, a comedian's profile is neither described nor "known".
  const it = item({ title: 'Hannibal Buress' });
  const feel = attachFeel([it], { facts: factsFor([it]) })[0]._feel;
  assert.equal(feel.descriptor, null);
  assert.equal(feel.known.profile, false);
  assert.equal(feel.preview, null);
});

test('preview: only from a confident Apple match', () => {
  const names = ['PUP', 'Low', 'Joyce Manor', 'Funny Business', 'Comic Person', 'Mal Blum', 'Hannibal Buress'];
  const f = factsFor(names.map((title) => item({ title })));
  // "PUP" is too short to trust a name match; MusicBrainz's link makes "Low" sure.
  assert.equal(previewOf('PUP', f), null);
  assert.deepEqual(previewOf('Low', f), { url: song('Lullaby').preview, title: 'Lullaby', artist: 'Low' });
  // Older profiles have no match field: two words and a music genre will do.
  assert.equal(previewOf('Joyce Manor', f).title, 'Constant Headache');
  // A comedy record on a band's row is the wrong artist, and vice versa.
  assert.equal(previewOf('Funny Business', f, { family: 'music' }), null);
  assert.equal(previewOf('Funny Business', f, { family: 'comedy' }).title, 'Bit One');
  assert.equal(previewOf('Comic Person', f, { family: 'comedy' }), null);
  assert.equal(previewOf('Mal Blum', f, { family: 'music' }), null);
  assert.equal(previewOf('Hannibal Buress', f, { family: 'comedy' }).title, 'Animal Furnace');
  assert.equal(previewOf('Nobody Known', f), null);
});

// ── The link line and the whole _feel ───────────────────────────────────────

const linkOf = (it) => attachFeel([it], { facts: factsFor([it]) })[0]._feel.link;

test('the link line takes the first of curated, favorite, starred, sounds-like', () => {
  const favorite = { kind: 'favorite', text: 'Joyce Manor is a favorite' };
  const learned = { kind: 'learned', text: 'You starred Joyce Manor before' };
  const similar = { kind: 'similar', text: 'Joyce Manor sounds like PUP' };
  const base = { title: 'Joyce Manor' };
  assert.deepEqual(linkOf(item({ ...base, _curated: 'Loud and fast, like you asked', _reasons: [similar, favorite] })), {
    kind: 'curated', text: 'Loud and fast, like you asked',
  });
  assert.deepEqual(linkOf(item({ ...base, _reasons: [similar, learned, favorite] })), favorite);
  assert.deepEqual(linkOf(item({ ...base, _reasons: [similar, learned] })), learned);
  assert.deepEqual(linkOf(item({ ...base, _reasons: [similar] })), { kind: 'similar', text: 'Sounds like PUP' });
  const shared = { kind: 'similar', text: 'Joyce Manor shares fans with Turnover & Citizen (≈ PUP)' };
  assert.deepEqual(linkOf(item({ ...base, _reasons: [shared] })), { kind: 'similar', text: 'Sounds like PUP' });
  const opener = { kind: 'similar', text: 'Opener Teen Fears sounds like PUP' };
  assert.deepEqual(linkOf(item({ ...base, _reasons: [opener] })).text, 'Opener Teen Fears sounds like PUP');
});

test('the sounds-like favorite is not repeated in the fans line', () => {
  const it = item({ title: 'Joyce Manor', _reasons: [{ kind: 'similar', text: 'Joyce Manor sounds like Big Thief' }] });
  const feel = attachFeel([it], { facts: factsFor([it]) })[0]._feel;
  assert.equal(feel.link.text, 'Sounds like Big Thief');
  assert.ok(!feel.fans.some((x) => x.name === 'Big Thief'));
});

test('then "for fans of" for music, then the rest of the bill', () => {
  const joyce = item({ title: 'Joyce Manor w/ Teen Fears', _lineup: ['Joyce Manor', 'Teen Fears'] });
  assert.deepEqual(linkOf(joyce), { kind: 'fans', text: 'For fans of ♥ Big Thief, Mal Blum' });
  // Off the bill, Teen Fears is fair game again.
  assert.equal(linkOf(item({ title: 'Joyce Manor' })).text, 'For fans of ♥ Big Thief, Teen Fears');
  assert.deepEqual(linkOf(item({ title: 'X', _lineup: ['Nobody A', 'Nobody B'] })), { kind: 'with', text: 'with Nobody B' });
  assert.deepEqual(linkOf(item({ title: 'X', _lineup: ['Nobody A', 'Nobody B', 'Nobody C'] })), {
    kind: 'with', text: 'with Nobody B & Nobody C',
  });
  assert.deepEqual(linkOf(item({ title: 'X', _lineup: ['A1', 'B1', 'C1', 'D1', 'E1'] })), { kind: 'with', text: 'with B1, C1 +2' });
  // Comedy doesn't get "for fans of" on the row, but does get its bill.
  assert.deepEqual(linkOf(item({ title: 'Joyce Manor', category: 'comedy', _lineup: ['Joyce Manor', 'Nobody B'] })), {
    kind: 'with', text: 'with Nobody B',
  });
  assert.equal(linkOf(item({ title: 'Nobody Known' })), null);
});

test('nights, talks and the like name their host, not the title again', () => {
  assert.deepEqual(linkOf(item({ title: 'Trivia Night hosted by Jen Ray', category: 'other', _lineup: ['Jen Ray'] })), {
    kind: 'host', text: 'hosted by Jen Ray',
  });
  assert.deepEqual(linkOf(item({ title: 'Karaoke with Bob Lee', category: 'other', _lineup: ['Bob Lee'] })), {
    kind: 'host', text: 'with Bob Lee',
  });
  assert.equal(linkOf(item({ title: 'Author Talk: Jess Walter', category: 'other', _lineup: ['Author Talk'] })), null);
  assert.equal(linkOf(item({ title: 'Hamlet', category: 'other', genre_tags: 'theatre', _lineup: ['Hamlet'] })), null);
});

test('a full show _feel: tags, descriptor, fans, preview and what we know', () => {
  const it = item({ title: 'Joyce Manor w/ Teen Fears', _lineup: ['Joyce Manor', 'Teen Fears'] });
  const [out] = attachFeel([it], { facts: factsFor([it]) });
  assert.equal(out, it, 'decorated in place');
  assert.deepEqual(out._feel, {
    tags: [{ tag: 'pop punk', hit: false }, { tag: 'emo', hit: true }, { tag: 'indie rock', hit: true }],
    tagsFrom: 'artist',
    habit: null,
    bill: null,
    descriptor: 'American pop punk band',
    fans: [
      { name: 'Big Thief', favorite: true, starred: false },
      { name: 'Mal Blum', favorite: false, starred: true },
      { name: 'Turnover', favorite: false, starred: false },
    ],
    link: { kind: 'fans', text: 'For fans of ♥ Big Thief, Mal Blum' },
    preview: { url: song('Constant Headache').preview, title: 'Constant Headache', artist: 'Joyce Manor' },
    known: { similar: true, profile: true },
  });
  const saints = item({ title: 'Static Saints' });
  const feel = attachFeel([saints], { facts: factsFor([saints]) })[0]._feel;
  assert.deepEqual(feel.known, { similar: false, profile: false }, 'borrowed lists and no profile');
  assert.deepEqual(feel.link, { kind: 'fans', text: 'For fans of ♥ PUP, Filler 1' });
});

test('a habit or bill fallback lands in its own field', () => {
  const [habit, bill] = attachFeel(
    [item({ title: 'Nobody Known', venue: 'Garage Bar' }), item({ title: 'X', _lineup: ['Nobody A', 'Nobody B', 'Nobody C'] })],
    { facts }
  );
  assert.equal(habit._feel.habit, 'usually punk · garage rock here');
  assert.equal(habit._feel.tagsFrom, 'venue');
  assert.equal(bill._feel.bill, 'local bill · 3 acts');
  assert.equal(bill._feel.habit, null);
});

test('DJ nights get fans of their DJs', () => {
  const it = item({ title: 'DJ Foo + DJ Baz', category: 'music', _lineup: ['DJ Foo', 'DJ Baz'] });
  const feel = attachFeel([it], { facts: factsFor([it]) })[0]._feel;
  assert.deepEqual(feel.fans.map((x) => x.name), ['DJ Bar', 'House Crew']);
  assert.deepEqual(feel.link, { kind: 'fans', text: 'For fans of DJ Bar, House Crew' });
  // A lone DJ named in the title is the act, not just the title again.
  const solo = item({ title: 'DJ Foo', _lineup: ['DJ Foo'] });
  const soloFeel = attachFeel([solo], { facts: factsFor([solo]) })[0]._feel;
  assert.deepEqual(soloFeel.link, { kind: 'fans', text: 'For fans of DJ Bar, House Crew' });
});

test('a comedian row: descriptor and a Comedy preview, no genres', () => {
  const it = item({ title: 'Hannibal Buress', category: 'comedy', genre_tags: 'comedy' });
  const feel = attachFeel([it], { facts: factsFor([it]) })[0]._feel;
  assert.deepEqual(feel.tags, []);
  assert.equal(feel.descriptor, 'American comedian');
  assert.equal(feel.preview.title, 'Animal Furnace');
  assert.deepEqual(feel.known, { similar: false, profile: true });
});

// ── Films ───────────────────────────────────────────────────────────────────

function film(fields) {
  return {
    id: 'film-1-2030-01-06', kind: 'film', title: 'Paris, Texas', date: '2030-01-06', venue: 'The Grand Cinema',
    genre: 'Drama', year: 1984, runtime: 145, mc_score: 88, rt_score: 95, director: 'Wim Wenders',
    synopsis: 'Dr. Travis Henderson walks out of the Texas desert after four years. His brother takes him home.',
    _flags: [{ key: 'one-night', label: 'One night only' }],
    ...fields,
  };
}

test('a film _feel: the film line, the first sentence and the flag with its director', () => {
  const [paris] = attachFeel([film({})], { facts });
  assert.deepEqual(paris._feel, {
    tags: [],
    tagsFrom: null,
    habit: null,
    bill: null,
    line: 'drama · 1984 · 2h 25m · MC 88',
    synopsis: 'Dr. Travis Henderson walks out of the Texas desert after four years.',
    descriptor: null,
    fans: [],
    link: { kind: 'film', text: 'One night only · dir. Wim Wenders' },
    director: 'Wim Wenders',
    preview: null,
    known: { similar: false, profile: false },
  });
});

test('film lines: Rotten Tomatoes without Metacritic, short runtimes, long synopses, no flag', () => {
  const [a, b, c] = attachFeel(
    [
      film({ mc_score: null, rt_score: 96, runtime: 60, genre: 'Documentary, Music' }),
      film({ _flags: [], synopsis: `A ${'very '.repeat(40)}long sentence that never seems to end at all.` }),
      film({ _flags: [], director: null, runtime: null, year: null, mc_score: null, rt_score: null }),
    ],
    { facts }
  );
  assert.equal(a._feel.line, 'documentary · 1984 · 1h · RT 96%');
  assert.deepEqual(b._feel.link, { kind: 'film', text: 'dir. Wim Wenders' });
  assert.ok(b._feel.synopsis.length <= 110 && b._feel.synopsis.endsWith('…'));
  assert.ok(!/\s…$/.test(b._feel.synopsis), 'cut at a word');
  assert.equal(c._feel.line, 'drama');
  assert.equal(c._feel.link, null);
});

// ── No network ──────────────────────────────────────────────────────────────

test('attachFeel loads its own facts when none are passed, and never touches the network', () => {
  const saved = { get: axios.get, post: axios.post, request: axios.request };
  const boom = () => {
    throw new Error('network!');
  };
  Object.assign(axios, { get: boom, post: boom, request: boom });
  try {
    const items = [item({ title: 'Joyce Manor' }), film({})];
    attachFeel(items);
    assert.ok(items.every((it) => it._feel));
    assert.equal(items[0]._feel.tags[0].tag, 'pop punk');
  } finally {
    Object.assign(axios, saved);
  }
});
