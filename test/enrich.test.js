// Tests for the artist-enrichment and structured-source parsers. Network calls
// are not made — each test feeds a captured response shape to the parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickArtist, cleanTags } from '../src/enrich/musicbrainz.js';
import { normalizeSimilar } from '../src/enrich/listenbrainz.js';
import { orderArtists, mapVenuePilotEvent } from '../src/adapters/venuepilot.js';
import { isTicketingExtra, mapEvent as mapTicketmaster } from '../src/adapters/ticketmaster.js';
import { findVenuePilotAccount } from '../src/discovery.js';

test('MusicBrainz: exact-name match only, most-tagged namesake wins', () => {
  const candidates = [
    { id: 'de', name: 'Movements', score: 100, tags: [] },
    { id: 'us', name: 'Movements', score: 100, tags: [{ name: 'post-hardcore', count: 3 }, { name: 'emo', count: 2 }] },
    { id: 'se', name: 'The Movements', score: 91, tags: [{ name: 'garage rock', count: 1 }] },
  ];
  const hit = pickArtist('MOVEMENTS', candidates);
  assert.equal(hit.mbid, 'us');
  assert.deepEqual(hit.tags, ['post-hardcore', 'emo']);
  assert.equal(pickArtist('Movement', candidates), null);
});

test('MusicBrainz: aliases count as exact matches', () => {
  const hit = pickArtist('alt-J', [{ id: 'a', name: 'alt‐J', aliases: [{ name: 'Alt-J' }], tags: [] }]);
  assert.equal(hit.mbid, 'a');
});

test('MusicBrainz: non-genre tags are dropped', () => {
  const tags = [
    { name: 'punk', count: 5 },
    { name: 'canadian', count: 4 },
    { name: 'seen live', count: 3 },
    { name: 'pup', count: 2 },
    { name: '2010s', count: 2 },
    { name: 'emo', count: 1 },
    { name: 'downvoted', count: -1 },
  ];
  assert.deepEqual(cleanTags(tags, 'PUP'), ['punk', 'emo']);
});

test('ListenBrainz: scores are normalised to the closest match and filtered', () => {
  const body = [
    { name: 'Jeff Rosenstock', score: 657 },
    { name: 'Joyce Manor', score: 571 },
    { name: 'Faint Signal', score: 50 }, // < 20% of the top score
  ];
  const out = normalizeSimilar(body);
  assert.deepEqual(out.map((a) => a.name), ['Jeff Rosenstock', 'Joyce Manor']);
  assert.equal(out[0].score, 1);
  assert.equal(out[0].key, 'jeff rosenstock');
  // Dataset-wrapped responses are accepted too.
  assert.equal(normalizeSimilar([{ type: 'dataset', data: body }]).length, 2);
  assert.deepEqual(normalizeSimilar({ error: 'nope' }), []);
});

test('VenuePilot: artists are ordered by billing in the title', () => {
  assert.deepEqual(
    orderArtists('Rylan Fischer, Tricky FM, & glass egg', ['Tricky FM', 'glass egg', 'Rylan Fischer']),
    ['Rylan Fischer', 'Tricky FM', 'glass egg']
  );
});

test('VenuePilot: events map to EventLight rows', () => {
  const ev = mapVenuePilotEvent(
    {
      name: 'Joel Gibson Jr with Huligan',
      date: '2026-10-03',
      startTime: '20:00:00',
      doorTime: '19:00:00',
      ticketsUrl: 'https://tickets.venuepilot.com/e/x',
      images: ['https://img/x.jpg'],
      artists: [{ name: 'Joel Gibson Jr.' }, { name: 'Hüligan' }],
    },
    { id: 'jazzbones', venue: 'Jazzbones', city: 'Tacoma', category: 'music' }
  );
  assert.equal(ev.date, '2026-10-03');
  assert.equal(ev.time, '20:00');
  assert.equal(ev.venue, 'Jazzbones');
  assert.deepEqual(ev.lineup, ['Joel Gibson Jr.', 'Hüligan']);
});

test('discovery: VenuePilot account id is read from the page settings', () => {
  const html = `<script>window.venuepilotSettings = {
      general: {
        // required
        accountIds: [194],
        server: 'https://www.venuepilot.co/',`;
  assert.equal(findVenuePilotAccount(html), 194);
  assert.equal(findVenuePilotAccount('<html></html>'), null);
});

test('Ticketmaster: add-on listings are not shows', () => {
  assert.equal(isTicketingExtra('Parking: Taking Back Sunday'), true);
  assert.equal(isTicketingExtra('PUP - VIP Package Upgrade'), true);
  assert.equal(isTicketingExtra('Taking Back Sunday'), false);
});

test('Ticketmaster: every billed attraction lands in the lineup', () => {
  const ev = mapTicketmaster(
    {
      name: 'PUP: Who Will Look After the Dogs? Tour',
      dates: { start: { localDate: '2030-01-10', localTime: '19:30:00' } },
      classifications: [{ segment: { name: 'Music' }, genre: { name: 'Rock' }, subGenre: { name: 'Punk' } }],
      _embedded: {
        venues: [{ name: 'The Showbox', city: { name: 'Seattle' } }],
        attractions: [{ name: 'PUP' }, { name: 'Illuminati Hotties' }],
      },
    },
    'Seattle'
  );
  assert.equal(ev.artist, 'PUP');
  assert.deepEqual(ev.lineup, ['PUP', 'Illuminati Hotties']);
  assert.deepEqual(ev.genre_tags, ['rock', 'punk']);
});
