// Tests for the .ics export builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs } from '../src/ics.js';

const base = {
  id: 1,
  title: 'Band Night',
  venue: 'The Spot',
  city: 'Seattle',
  date: '2026-07-04',
  time: '20:00',
  genre_tags: 'rock',
  ticket_url: 'https://venue.example/t/1',
};

test('timed events get a DTSTART with local time', () => {
  const ics = buildIcs([base]);
  assert.match(ics, /DTSTART:20260704T200000/);
  assert.match(ics, /SUMMARY:Band Night/);
  assert.match(ics, /LOCATION:The Spot\\, Seattle/);
});

test('date-only events become all-day', () => {
  const ics = buildIcs([{ ...base, time: null }]);
  assert.match(ics, /DTSTART;VALUE=DATE:20260704/);
});

test('special characters are escaped per RFC 5545', () => {
  const ics = buildIcs([{ ...base, title: 'Punk; Rock, Night\\Out' }]);
  assert.match(ics, /SUMMARY:Punk\\; Rock\\, Night\\\\Out/);
});

test('document structure is well-formed', () => {
  const ics = buildIcs([base]);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'));
  assert.ok(ics.endsWith('END:VCALENDAR'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.equal((ics.match(/END:VEVENT/g) || []).length, 1);
});
