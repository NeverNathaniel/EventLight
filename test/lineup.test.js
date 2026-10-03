// Tests for lineup parsing — pulling artist names out of scraped event titles.
// Every title here is a real listing captured from a seeded venue (2026-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLineup, artistKey, lineupKeys, isTribute } from '../src/lineup.js';

const cases = [
  // Promoter prefix, co-bill "x", off-site venue suffix.
  ['Tractor Presents: Dave Hause & The Mermaid x American Steel AT The Sunset',
    ['Dave Hause & The Mermaid', 'American Steel']],
  // Status noise + "An Evening with".
  ['SOLD OUT! An Evening with Carbon Leaf', ['Carbon Leaf']],
  // Tour subtitle after a colon, support act, night marker.
  ["SOLD OUT! Hiss Golden Messenger: I'm People Tour w/ Sam Amidon (NIGHT ONE)",
    ['Hiss Golden Messenger', 'Sam Amidon']],
  // "and the" stays inside a band name; commas split the support list.
  ['Radio Ranch w/ Evan Wallace, Brooklyn Del and the Revelators',
    ['Radio Ranch', 'Evan Wallace', 'Brooklyn Del and the Revelators']],
  // "Plus Special Guest:" is one marker, not a junk act.
  ['SOLD OUT! Dave Alvin: New and Old Songs w/ Chris Miller Plus Special Guest: Christy McWilson (partially seated)',
    ['Dave Alvin', 'Chris Miller', 'Christy McWilson']],
  // Dash + tour name.
  ['DEVON GILFILLIAN - Time Will Tell Tour', ['DEVON GILFILLIAN']],
  ['BLÜ EYES- Two People at Once Tour', ['BLÜ EYES']],
  // Dashes between bands are kept.
  ['Street Justice - The Meat Beaters - The Indicted',
    ['Street Justice', 'The Meat Beaters', 'The Indicted']],
  // Bullets, double slashes.
  ['MEDICINE BOWS • HIGH PRIORS • CLOSE • DATA KNIFE',
    ['MEDICINE BOWS', 'HIGH PRIORS', 'CLOSE', 'DATA KNIFE']],
  ['MYCON // BONNEY RUBBLE // ODACHI', ['MYCON', 'BONNEY RUBBLE', 'ODACHI']],
  // Anniversary-show wording is stripped from the headliner.
  ['Kultur Shock - 30th Anniversary Show w/ Nasalrod', ['Kultur Shock', 'Nasalrod']],
  // A "TOUR AT THE VALLEY" prefix must not swallow the support list.
  ['THE TROUBLESOME TOUR AT THE VALLEY with Truancy - Life Rips - Bassafras! - Triple Nickel',
    ['Truancy', 'Life Rips', 'Bassafras', 'Triple Nickel']],
  // "featuring" is not "feat" + "uring".
  ['Ballard Food Bank Benefit featuring Mike Frazier & Friends, Hosted by DJ Troy Nelson',
    ['Mike Frazier', 'DJ Troy Nelson']],
  // A two-part comma name is one act; three or more parts is a bill.
  ['The Army, The Navy', ['The Army, The Navy']],
  ['Former Jock, Mad King, Gwen', ['Former Jock', 'Mad King', 'Gwen']],
  // Promoter "Presents:" must not be mistaken for the band Ceremony.
  ["Ceremony Presents: Best Of The 80's & Beyond w/ DJ Evan Blackstone",
    ["Best Of The 80's & Beyond", 'DJ Evan Blackstone']],
];

for (const [title, expected] of cases) {
  test(`parseLineup: ${title}`, () => {
    assert.deepEqual(parseLineup(title), expected);
  });
}

test('parseLineup: non-artist events yield no lineup', () => {
  assert.deepEqual(parseLineup('Raised By TV Events Presents: all ages LOTR films Trivia Night'), []);
  assert.deepEqual(parseLineup('Disney Worlds Collide Concert Tour'), []);
});

test('parseLineup: API artist leads, support text is appended', () => {
  assert.deepEqual(parseLineup('JUNGLE', { support: 'RIO KOSTA' }), ['JUNGLE', 'RIO KOSTA']);
  assert.deepEqual(parseLineup('Failure', { support: 'with quannnic' }), ['Failure', 'quannnic']);
  assert.deepEqual(parseLineup('PUP - Morbid Stuff Tour', { artist: 'PUP' }), ['PUP']);
});

test('artistKey: case, punctuation, diacritics and a leading "The" are ignored', () => {
  assert.equal(artistKey('The Menzingers'), artistKey('MENZINGERS'));
  assert.equal(artistKey('alt-J'), artistKey('ALT-J'));
  assert.equal(artistKey('Carín León'), 'carin leon');
  assert.equal(artistKey('Mom Jeans.'), 'mom jeans');
  assert.equal(artistKey('Prince Daddy & The Hyena'), 'prince daddy and the hyena');
});

test('lineupKeys: "&" bills also match each act on its own', () => {
  const keys = lineupKeys('Dying Fetus & Sanguisugabogg');
  assert.ok(keys.includes('dying fetus'));
  assert.ok(keys.includes('sanguisugabogg'));
});

test('isTribute', () => {
  assert.equal(isTribute('The Valley of the Damned with Sick Boys — Social Distortion Tribute'), true);
  assert.equal(isTribute('Militarie Gun'), false);
});
