// Tests for the adapter parsing helpers — the core of scraping correctness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  toISODate,
  toTime,
  clean,
  absoluteUrl,
  safeHttpUrl,
} from '../src/adapters/util.js';

// A fixed "now" makes year inference deterministic: July 2, 2026 (local).
const NOW = new Date(2026, 6, 2);

test('toISODate: ISO strings pass through', () => {
  assert.equal(toISODate('2026-07-04', NOW), '2026-07-04');
  assert.equal(toISODate('2026-07-04T19:30:00-07:00', NOW), '2026-07-04');
});

test('toISODate: invalid ISO-looking dates are rejected', () => {
  assert.equal(toISODate('2026-99-99', NOW), null);
  assert.equal(toISODate('2026-02-30', NOW), null);
});

test('toISODate: Date objects use local components, not UTC', () => {
  // 11:30 PM local — toISOString() would report the next (or previous) day
  // depending on the host timezone.
  const late = new Date(2026, 6, 4, 23, 30);
  assert.equal(toISODate(late, NOW), '2026-07-04');
});

test('toISODate: month-name dates without a year infer the upcoming year', () => {
  assert.equal(toISODate('July 4', NOW), '2026-07-04');
  assert.equal(toISODate('SAT JUL 4', NOW), '2026-07-04');
  assert.equal(toISODate('Fri, Jul 4th', NOW), '2026-07-04');
  // A month/day that already passed rolls over to next year.
  assert.equal(toISODate('Jan 15', NOW), '2027-01-15');
  // ...but a recent past date (within the grace window) stays in this year.
  assert.equal(toISODate('Jun 25', NOW), '2026-06-25');
});

test('toISODate: month-name dates with an explicit year', () => {
  assert.equal(toISODate('Jul 4, 2026', NOW), '2026-07-04');
  assert.equal(toISODate('4 July 2026', NOW), '2026-07-04');
  // RFC 2822 pubDate style (rss).
  assert.equal(toISODate('Fri, 04 Jul 2026 19:00:00 GMT', NOW), '2026-07-04');
});

test('toISODate: numeric dates', () => {
  assert.equal(toISODate('7/4/2026', NOW), '2026-07-04');
  assert.equal(toISODate('07/04/26', NOW), '2026-07-04');
  assert.equal(toISODate('7/4', NOW), '2026-07-04');
});

test('toISODate: band names with numbers do not become dates', () => {
  assert.equal(toISODate('Blink 182', NOW), null);
  assert.equal(toISODate('The 1975', NOW), null);
  assert.equal(toISODate('1975', NOW), null);
  assert.equal(toISODate('An Evening With 311', NOW), null);
});

test('toISODate: implausible years are rejected', () => {
  assert.equal(toISODate('Jul 4, 1999', NOW), null);
  assert.equal(toISODate('Jul 4, 2099', NOW), null);
});

test('toISODate: empty / junk input', () => {
  assert.equal(toISODate('', NOW), null);
  assert.equal(toISODate(null, NOW), null);
  assert.equal(toISODate('Doors at eight', NOW), null);
});

test('toTime: am/pm strings', () => {
  assert.equal(toTime('8 PM'), '20:00');
  assert.equal(toTime('8:30pm'), '20:30');
  assert.equal(toTime('Doors 7 p.m.'), '19:00');
  assert.equal(toTime('12:00 PM'), '12:00');
  assert.equal(toTime('12 AM'), '00:00');
});

test('toTime: ISO datetimes and bare 24h times', () => {
  assert.equal(toTime('2026-07-04T19:30:00'), '19:30');
  assert.equal(toTime('19:30'), '19:30');
});

test('toTime: Date objects use local wall-clock time', () => {
  assert.equal(toTime(new Date(2026, 6, 4, 20, 0)), '20:00');
});

test('toTime: does not false-match inside words or junk', () => {
  assert.equal(toTime('10 amps of fun'), null);
  assert.equal(toTime('no time here'), null);
  assert.equal(toTime(''), null);
});

test('classify: hints and fallback', () => {
  assert.equal(classify('Stand-Up Showcase'), 'comedy');
  assert.equal(classify('Jazz Night'), 'music');
  assert.equal(classify('Trivia', 'music'), 'music');
  assert.equal(classify('Trivia'), 'other');
});

test('clean: collapses whitespace', () => {
  assert.equal(clean('  The\n  Band \t Name '), 'The Band Name');
});

test('absoluteUrl: resolves relative URLs and rejects unsafe schemes', () => {
  assert.equal(
    absoluteUrl('/tickets/123', 'https://venue.example/calendar'),
    'https://venue.example/tickets/123'
  );
  assert.equal(absoluteUrl('javascript:alert(1)', 'https://venue.example'), null);
  assert.equal(absoluteUrl('data:text/html,x', 'https://venue.example'), null);
  assert.equal(absoluteUrl('', 'https://venue.example'), null);
});

test('safeHttpUrl: absolute http(s) only', () => {
  assert.equal(safeHttpUrl('https://venue.example/t/1'), 'https://venue.example/t/1');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('/relative/path'), null);
  assert.equal(safeHttpUrl(null), null);
});
