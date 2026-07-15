// Tests for JSON-LD event extraction (the discovery module's core parser).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchJsonLdEvents } from '../src/discovery.js';

// Venues commonly nest events in arbitrary properties of a Place node rather
// than top-level or @graph — this fixture mirrors that (Place.Events[...]).
const nested = {
  '@context': 'https://schema.org',
  '@type': 'Place',
  name: 'Fixture Comedy Club',
  Events: [
    {
      '@type': 'Event',
      name: 'Headliner Night',
      startDate: '2026-08-01T20:00:00-07:00',
      location: { '@type': 'Place', name: 'Fixture Comedy Club', address: { addressLocality: 'Tacoma' } },
      offers: { price: '25', url: 'https://tix.example/1' },
    },
    { '@type': 'ComedyEvent', name: 'Open Mic', startDate: '2026-08-03T19:30:00-07:00' },
  ],
};

const graph = {
  '@context': 'https://schema.org',
  '@graph': [{ '@type': 'MusicEvent', name: 'Graph Band', startDate: '2026-08-05' }],
};

const server = http.createServer((req, res) => {
  const doc = req.url === '/graph' ? graph : nested;
  res.setHeader('Content-Type', 'text/html');
  res.end(`<html><head><script type="application/ld+json">${JSON.stringify(doc)}</script></head><body></body></html>`);
});
const port = await new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
after(() => server.close());

test('finds Event nodes nested in arbitrary properties (Place.Events)', async () => {
  const events = await fetchJsonLdEvents(`http://127.0.0.1:${port}/nested`);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, 'Headliner Night');
  assert.equal(events[0].date, '2026-08-01');
  assert.equal(events[0].time, '20:00');
  assert.equal(events[0].venue, 'Fixture Comedy Club');
  assert.equal(events[0].city, 'Tacoma');
  assert.equal(events[0].ticket_url, 'https://tix.example/1');
  assert.equal(events[0].price_range, '$25');
  assert.equal(events[1].category, 'comedy');
});

test('still finds events under @graph', async () => {
  const events = await fetchJsonLdEvents(`http://127.0.0.1:${port}/graph`);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Graph Band');
  assert.equal(events[0].date, '2026-08-05');
});
