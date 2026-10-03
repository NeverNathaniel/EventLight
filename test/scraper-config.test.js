// Tests for scraper config validation (run before any page load is spent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScraperConfig, mapScrapedItem } from '../src/adapters/scraper.js';

const valid = {
  url: 'https://venue.example/calendar',
  selectors: { item: '.event', name: 'h3', date: 'time' },
};

test('accepts a complete config', () => {
  assert.equal(validateScraperConfig(valid), null);
});

test('rejects a missing or invalid url', () => {
  assert.match(validateScraperConfig({ ...valid, url: '' }), /No url/);
  assert.match(validateScraperConfig({ ...valid, url: 'not a url' }), /Invalid url/);
  assert.match(validateScraperConfig({ ...valid, url: 'file:///etc/passwd' }), /scheme/);
});

test('rejects missing selectors.item (the Settings UI default)', () => {
  assert.match(validateScraperConfig({ ...valid, selectors: undefined }), /selectors\.item/);
  assert.match(
    validateScraperConfig({ ...valid, selectors: { item: '', name: '', date: '' } }),
    /selectors\.item/
  );
});

test('validates pagination: placeholder required, same site only', () => {
  const paged = (pagination) => ({ ...valid, pagination });
  assert.equal(
    validateScraperConfig(paged({ url: 'https://venue.example/events/ajax/{offset}', start: 20, step: 20 })),
    null
  );
  assert.match(validateScraperConfig(paged({ url: 'https://venue.example/events/ajax' })), /placeholder/);
  assert.match(validateScraperConfig(paged({ url: 'https://evil.example/{page}' })), /same site/);
});

test('mapScrapedItem: per-item venue, support line, separate time', () => {
  const cfg = { id: 'showbox', url: 'https://www.showboxpresents.com/events', venue: 'The Showbox', city: 'Seattle', category: 'music', skipVenues: ['Numerica'] };
  const item = {
    name: ' Failure ',
    date: 'Sat, Oct 3, 2026',
    time: 'Show 8:30 PM',
    venue: '@ Showbox SoDo',
    support: 'with quannnic',
    link: 'https://www.axs.com/events/1',
    image: '',
    price: '',
  };
  const ev = mapScrapedItem(item, cfg);
  assert.equal(ev.title, 'Failure');
  assert.equal(ev.date, '2026-10-03');
  assert.equal(ev.time, '20:30');
  assert.equal(ev.venue, 'Showbox SoDo');
  assert.equal(ev.support, 'with quannnic');
  // Rooms outside the area are skipped; items without a venue use the config's.
  assert.equal(mapScrapedItem({ ...item, venue: '@ Numerica Veterans Arena' }, cfg), null);
  assert.equal(mapScrapedItem({ ...item, venue: '' }, cfg).venue, 'The Showbox');
});
