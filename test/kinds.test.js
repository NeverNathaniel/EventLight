// Tests for what a listing is (src/kinds.js): kinds from real-style titles,
// band names that look like kinds, flags, and the title stems that tie a
// recurring night's dates together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, groupOf, usesTitle, cleanTitle, flagsOf, sortFlags, titleStem, seriesKey } from '../src/kinds.js';
import { parseLineup } from '../src/lineup.js';

const kind = (title, { category = 'music', tags = '', lineup = [], found = false } = {}) =>
  kindOf({ title, category, genre_tags: tags, _lineup: lineup }, { headlinerFound: found });

test('kinds from titles, first rule wins', () => {
  const cases = [
    ['Live Band Karaoke', 'music', 'karaoke'],
    ['Queeraoke Tuesdays', 'other', 'karaoke'],
    ['Geeks Who Drink Trivia', 'other', 'trivia'],
    ['Drag Bingo with Aleksa Manila', 'other', 'drag'],
    ['Drag Show: Queens of the South Sound', 'other', 'drag'],
    ['The Glitter Revue: Burlesque', 'other', 'cabaret'],
    ['Emo Night', 'music', 'dj'],
    ['Velvet Static (DJ set)', 'music', 'dj'],
    ['Sunday Jazz Jam', 'music', 'jam'],
    ['Bluegrass Jam', 'music', 'jam'],
    ['Songwriter Night', 'music', 'open-mic'],
    ['Square Dance with The Tallboys', 'music', 'dance'],
    ['Movie Night: The Goonies', 'other', 'screening'],
    ['Author Talk: Jess Walter', 'other', 'talk'],
    ['Tacoma Night Market', 'other', 'market'],
    ['Paint Night', 'other', 'class'],
    ['Kumail Nanjiani', 'comedy', 'comedy'],
    ['The Tacoma Improv Collective', 'comedy', 'improv'],
    ['My Favorite Murder (Live Podcast)', 'comedy', 'podcast'],
    ['Wet Leg', 'music', 'music'],
    ['Something Undefined', 'other', 'event'],
  ];
  for (const [title, category, expected] of cases) assert.equal(kind(title, { category }).key, expected, title);
});

test('band names that look like kinds stay Music', () => {
  assert.equal(kind('Pearl Jam').key, 'music', 'a bare "jam" needs a qualifier');
  assert.equal(kind('The Jam').key, 'music');
  assert.equal(kind('Trivium').key, 'music');
  assert.equal(kind('Bingo Players', { lineup: ['Bingo Players'], found: true }).key, 'music', 'a known act’s own name doesn’t count');
  assert.equal(kind('Film School', { category: 'other', lineup: ['Film School'], found: true }).key, 'music', 'a known act misfiled as other is Music');
  assert.equal(kind('DJ Shadow', { lineup: ['DJ Shadow'], found: true }).key, 'music');
  assert.equal(kind('DJ Foo + DJ Bar', { lineup: ['DJ Foo', 'DJ Bar'] }).key, 'dj', 'unknown DJs are a DJ night');
  assert.equal(kind('Pearl Jam Tribute Night: Ten').key, 'tribute');
});

test("a support act's name doesn't make a known headliner's show another kind", () => {
  // The lineup the parser really produces, with the headliner known to MusicBrainz.
  const billed = (title, category = 'music') => {
    const e = { title, category, _lineup: parseLineup(title) };
    const k = kindOf(e, { headlinerFound: true });
    return [k.key, groupOf(e, k)];
  };
  assert.deepEqual(billed('Joyce Manor w/ Movie Star Junkies'), ['music', 'music']);
  assert.deepEqual(billed('Wet Leg w/ Black Market Karma'), ['music', 'music']);
  assert.deepEqual(billed('Wet Leg with Middle Class Rut'), ['music', 'music']);
  assert.deepEqual(billed('Alvvays w/ Cabaret Voltaire'), ['music', 'music']);
  assert.deepEqual(billed('The Jam w/ Market Hotel'), ['music', 'music']);
  // Event words aren't acts, so they survive the names coming out.
  assert.deepEqual(billed('Movie Night: The Goonies', 'other'), ['screening', 'film']);
  assert.deepEqual(billed('Trivia Night hosted by Jen Ray', 'other'), ['trivia', 'around']);
  assert.deepEqual(billed('Velvet Static (DJ set)'), ['dj', 'music']);
  // A scraped "Bingo Players" parses to no act at all ("bingo" is an event
  // word), so nothing says it's a band: it reads as a bingo night. With a
  // structured lineup (Ticketmaster's attractions) it's Music, as above.
  assert.deepEqual(parseLineup('Bingo Players'), []);
  assert.equal(kindOf({ title: 'Bingo Players', category: 'music', _lineup: parseLineup('Bingo Players') }).key, 'bingo');
});

test('tags decide theater and classical, and a big festival bill is a Festival', () => {
  assert.equal(kind('Hamlet', { category: 'other', tags: 'Theatre' }).key, 'theater');
  assert.equal(kind('Wicked', { category: 'music', tags: 'Musical, Arts' }).key, 'theater', 'a musical filed as music');
  assert.equal(kind('Kaskade', { tags: 'dance/electronic' }).key, 'music', '"dance/electronic" is not theater');
  assert.equal(kind('Tacoma Symphony: Brahms 4', { tags: 'classical' }).key, 'classical');
  assert.equal(kind('Summer Fest', { lineup: ['A', 'B', 'C', 'D'] }).key, 'festival');
  assert.equal(kind('Summer Fest', { lineup: ['A'] }).key, 'music');
});

test('a comedy open mic is an open mic in the comedy group; other nights are Around town', () => {
  const mic = { title: 'Open Mic Monday', category: 'comedy' };
  const k = kindOf(mic);
  assert.equal(k.key, 'open-mic');
  assert.equal(k.domain, 'comedy');
  assert.equal(groupOf(mic, k), 'comedy');
  const trivia = { title: 'Trivia Night', category: 'other' };
  assert.equal(groupOf(trivia), 'around');
  const jam = { title: 'Sunday Jazz Jam', category: 'music' };
  assert.equal(groupOf(jam), 'music', 'a jam at a music venue stays with the music');
  assert.equal(groupOf({ kind: 'film', title: 'Anora' }), 'film');
  assert.equal(groupOf({ title: 'Movie Night: Jaws', category: 'other' }), 'film', 'a scraped screening goes with the films');
});

test('night and stage listings lead with their title; a drag show with a named queen leads with her', () => {
  assert.equal(usesTitle(kindOf({ title: 'Trivia Night', category: 'other' })), true);
  assert.equal(usesTitle(kindOf({ title: 'Hamlet', category: 'other', genre_tags: 'theatre' })), true);
  assert.equal(usesTitle(kindOf({ title: 'Drag Brunch', category: 'other' }), ['Aleksa Manila']), false);
  assert.equal(usesTitle(kindOf({ title: 'PUP', category: 'music' })), false);
  assert.equal(cleanTitle('SOLD OUT! Trivia Night'), 'Trivia Night');
  assert.equal(cleanTitle('Cancelled: Karaoke'), 'Karaoke');
  assert.equal(cleanTitle('ALMOST SOLD OUT: Trivia Night'), 'Trivia Night');
  assert.equal(cleanTitle('Nearly Sold Out - Drag Brunch'), 'Drag Brunch');
});

test('flags: cancelled, sold out, few left, release show, free — and "Free Throw" is a band', () => {
  const keys = (title, price = '') => flagsOf({ title, price_range: price }).map((f) => f.key);
  assert.deepEqual(keys('Hiss Golden Messenger (CANCELLED)'), ['cancelled']);
  assert.equal(flagsOf({ title: 'PUP - Postponed' })[0].label, 'Postponed');
  assert.deepEqual(keys('SOLD OUT! PUP'), ['sold-out']);
  assert.deepEqual(keys('PUP', 'Sold Out'), ['sold-out']);
  assert.deepEqual(keys('Low Tickets: Wet Leg'), ['low-tix']);
  assert.deepEqual(keys('Mossback Album Release Show'), ['release']);
  assert.deepEqual(keys('Jazz Jam', 'Free'), ['free']);
  assert.deepEqual(keys('Jazz Jam (free)'), ['free']);
  assert.deepEqual(keys('Free Throw w/ Hot Mulligan', '$20'), []);
  // "Almost" and "nearly" sold out still have tickets: Few left, in the title or the price.
  assert.deepEqual(keys('ALMOST SOLD OUT: Wet Leg'), ['low-tix']);
  assert.deepEqual(keys('Wet Leg (Almost Sold Out)'), ['low-tix']);
  assert.deepEqual(keys('Wet Leg (Nearly Sold Out)'), ['low-tix']);
  assert.deepEqual(keys('Wet Leg - Almost  Sold-Out!'), ['low-tix']);
  assert.deepEqual(keys('Hollow Coast', '$25 · Almost Sold Out'), ['low-tix']);
  assert.deepEqual(keys('Hollow Coast', 'Nearly sold out'), ['low-tix']);
  assert.deepEqual(keys('Wet Leg - SOLD OUT!'), ['sold-out']);
  assert.deepEqual(keys('Sold Out: Wet Leg'), ['sold-out']);
  assert.deepEqual(
    sortFlags([{ key: 'free' }, { key: 'one-night' }, { key: 'sold-out' }]).map((f) => f.key),
    ['sold-out', 'one-night', 'free']
  );
});

test('title stems drop what changes from week to week', () => {
  assert.equal(titleStem('Trivia Night #12 – Thursday, Oct 9'), 'trivia night');
  assert.equal(titleStem('Trivia Night #13 – Thursday, Oct 16'), 'trivia night');
  assert.equal(titleStem('Every Thursday: Jazz Jam 7pm'), 'jazz jam');
  assert.equal(titleStem('Open Mic Monday'), 'open mic');
  assert.equal(titleStem('Taco Tuesday Trivia'), 'taco tuesday trivia', 'a weekday inside the name stays');
  assert.equal(titleStem('Tractor Presents: Bob Sumner'), 'bob sumner');
  assert.equal(titleStem('Comedy Showcase Vol. 3'), 'comedy showcase');
  assert.equal(seriesKey({ title: 'Trivia Night #12', venue: 'The Swiss' }), seriesKey({ title: 'Trivia Night #13', venue: 'The Swiss' }));
  // A night's host changes every week; a band's support act doesn't make it a series.
  const mic = (host) => seriesKey({ title: `Comedy Open Mic hosted by ${host}`, venue: 'Tacoma Comedy Club', category: 'comedy' });
  assert.equal(mic('Jen Ray'), mic('Sam Lee'));
  assert.equal(mic('Jen Ray'), 'tacoma comedy club|comedy open mic');
  assert.equal(seriesKey({ title: 'Trivia w/Sam Lee', venue: 'The Swiss', category: 'other' }), 'swiss|trivia');
  assert.equal(titleStem('Joyce Manor w/ PUP'), 'joyce manor w pup', 'only nights lose the tail');
  assert.notEqual(seriesKey({ title: 'Trivia Night', venue: 'The Swiss' }), seriesKey({ title: 'Trivia Night', venue: 'Doyle’s' }));
});
