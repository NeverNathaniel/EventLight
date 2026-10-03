// Tests for the Squarespace / WordPress (The Events Calendar) feed mappers and
// the shared time/text helpers. Fixtures are trimmed real API responses.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mapSquarespaceEvent, mapTribeEvent, tribeEndpoint, fetchTribeEvents } from '../src/adapters/cms.js';
import { zonedDateTime, htmlToText } from '../src/adapters/util.js';

const PT = 'America/Los_Angeles';

test('zonedDateTime: venue-local date and time regardless of server timezone', () => {
  // 02:00 UTC on Oct 6 is 7pm on Oct 5 in Tacoma.
  assert.deepEqual(zonedDateTime(Date.parse('2026-10-06T02:00:00.026Z'), PT), { date: '2026-10-05', time: '19:00' });
  assert.deepEqual(zonedDateTime('nonsense', PT), { date: null, time: null });
});

test('htmlToText: tags and entities', () => {
  assert.equal(htmlToText('Rock &amp; Roll &#8211; <i>Live</i>&nbsp;Tonight&#8217;s<br>show'), 'Rock & Roll – Live Tonight’s show');
});

test('Squarespace events map with local time, venue and absolute links', () => {
  const ev = mapSquarespaceEvent(
    {
      title: 'Dennis Jones Band (California)',
      startDate: 1791252000026,
      fullUrl: '/new-events-1/2026/6/24/dennis-jones-band-california',
      assetUrl: 'https://images.squarespace-cdn.com/content/v1/x/IMG_0861.jpeg',
      location: { addressTitle: 'The Valley' },
    },
    { id: 'the-valley', url: 'https://www.thevalleytacoma.com/new-events-1', city: 'Tacoma', category: 'music', tz: PT }
  );
  assert.equal(ev.date, '2026-10-05');
  assert.equal(ev.time, '19:00');
  assert.equal(ev.venue, 'The Valley');
  assert.equal(ev.ticket_url, 'https://www.thevalleytacoma.com/new-events-1/2026/6/24/dennis-jones-band-california');
  assert.equal(ev.source_name, 'the-valley');
});

test('The Events Calendar events map with venue, categories as tags and cost', () => {
  const ev = mapTribeEvent(
    {
      title: 'Ray Skjelbred &#8211; Solo Piano',
      start_date: '2026-10-03 16:30:00',
      all_day: false,
      url: 'https://www.earshot.org/event/ray-skjelbred-solo-piano/',
      website: '',
      image: false,
      cost: 'Free',
      venue: { venue: 'Oxbow Bakery', city: 'Seattle' },
      categories: [{ name: 'Jazz' }],
      tags: [],
    },
    { id: 'earshot', url: 'https://www.earshot.org/', category: 'music' }
  );
  assert.equal(ev.title, 'Ray Skjelbred – Solo Piano');
  assert.equal(ev.date, '2026-10-03');
  assert.equal(ev.time, '16:30');
  assert.equal(ev.venue, 'Oxbow Bakery');
  assert.equal(ev.city, 'Seattle');
  assert.deepEqual(ev.genre_tags, ['music', 'jazz']);
  assert.equal(ev.ticket_url, 'https://www.earshot.org/event/ray-skjelbred-solo-piano/');
  assert.equal(ev.price_range, 'Free');
  assert.equal(mapTribeEvent({ title: 'Fest', start_date: '2026-10-04 00:00:00', all_day: true }, { url: 'https://x.org' }).time, null);
  assert.equal(
    tribeEndpoint('https://venue.example/events/', '2026-10-03'),
    'https://venue.example/wp-json/tribe/events/v1/events?per_page=50&start_date=2026-10-03'
  );
});

// A fake The Events Calendar API. tribeEndpoint always asks the site's origin
// for /wp-json/…, so the host tells the two calendars apart: 127.0.0.1 has
// two pages, localhost never runs out.
const server = http.createServer((req, res) => {
  const host = req.headers.host;
  const page = Number(new URL(req.url, `http://${host}`).searchParams.get('page') || 1);
  const endless = host.startsWith('localhost');
  const next = endless || page < 2 ? `http://${host}/wp-json/tribe/events/v1/events?page=${page + 1}` : undefined;
  const ev = (n, cat) => ({ title: `Show ${page}-${n}`, start_date: '2026-10-10 20:00:00', categories: [{ name: cat }] });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ events: [ev(1, 'Music'), ev(2, 'Trivia')], next_rest_url: next }));
});
const port = await new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
after(() => server.close());

test('The Events Calendar: follows next pages and filters by category', async () => {
  const feed = { id: 't', url: `http://127.0.0.1:${port}/`, categories: ['music'] };
  const events = await fetchTribeEvents(feed, { today: '2026-10-03' });
  assert.deepEqual(events.map((e) => e.title), ['Show 1-1', 'Show 2-1']);
  assert.equal(events.truncated, undefined);
});

test('The Events Calendar: a calendar longer than the page cap is flagged as partial', async () => {
  const events = await fetchTribeEvents({ id: 't', url: `http://localhost:${port}/` }, { today: '2026-10-03' });
  assert.equal(events.length, 16); // 8 pages × 2
  assert.equal(events.truncated, true);
});
