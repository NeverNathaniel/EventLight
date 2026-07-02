// Tests for scraper config validation (run before any page load is spent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScraperConfig } from '../src/adapters/scraper.js';

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
