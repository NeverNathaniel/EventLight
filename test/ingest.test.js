// Tests for the ingest pipeline: lineup storage and pruning of listings a
// complete source no longer shows. Runs against a throwaway in-memory database.
import './helpers/memory-db.js'; // must stay the first import
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { setInterested } = await import('../src/db/queries.js');
const { runAdapter } = await import('../src/adapters/index.js');

migrate();

const show = (title, date = '2099-05-01') => ({
  source: 'scrape',
  source_name: 'venue',
  title,
  venue: 'Venue',
  date,
  category: 'music',
});
const fakeAdapter = (events, extra = {}) => ({
  meta: { id: 'fake', source: 'scrape', label: 'Fake' },
  run: async () => ({
    runs: [{ source: 'scrape', source_name: 'venue', status: 'ok', events, ...extra }],
  }),
});
const titles = () => db.prepare("SELECT title FROM events WHERE source_name = 'venue' ORDER BY title").all().map((r) => r.title);
const wait = () => new Promise((r) => setTimeout(r, 1100)); // updated_at has 1-second resolution

test('lineup is parsed and stored on ingest', async () => {
  await runAdapter(fakeAdapter([show('Tractor Presents: Olive Klug w/ Frail Talk')]));
  const row = db.prepare("SELECT artist, lineup FROM events WHERE title LIKE '%Olive Klug%'").get();
  assert.deepEqual(JSON.parse(row.lineup), ['Olive Klug', 'Frail Talk']);
  assert.equal(row.artist, 'Olive Klug');
});

test('a complete source prunes upcoming shows it no longer lists, keeping starred ones', async () => {
  db.exec("DELETE FROM events WHERE source_name = 'venue'");
  const listing = ['A', 'B', 'C', 'D', 'E', 'F'].map((t) => show(t));
  await runAdapter(fakeAdapter(listing, { complete: true }));
  setInterested(db.prepare("SELECT id FROM events WHERE title = 'F'").get().id, true);
  await wait();

  // E is cancelled; F is gone from the listing too but you starred it.
  const [summary] = await runAdapter(fakeAdapter(listing.slice(0, 4).concat(show('G')), { complete: true }));
  assert.equal(summary.pruned, 1);
  assert.deepEqual(titles(), ['A', 'B', 'C', 'D', 'F', 'G']);
});

test('sources without the complete flag (RSS, APIs) never prune', async () => {
  await wait();
  await runAdapter(fakeAdapter(['A', 'B', 'C', 'D', 'H'].map((t) => show(t))));
  assert.ok(titles().includes('G'));
});

test('a near-empty run is treated as breakage, not cancellations', async () => {
  await wait();
  const [summary] = await runAdapter(fakeAdapter([show('A')], { complete: true }));
  assert.equal(summary.pruned, 0);
  assert.ok(titles().includes('B'));
});

test('a run that would prune most of a source is treated as breakage', async () => {
  db.exec("DELETE FROM events WHERE source_name = 'venue'");
  const listing = 'ABCDEFGHIJ'.split('').map((t) => show(t));
  await runAdapter(fakeAdapter(listing, { complete: true }));
  await wait();
  // Only half the calendar came back (say, page 2 of the listing failed).
  const [summary] = await runAdapter(fakeAdapter(listing.slice(0, 5), { complete: true }));
  assert.equal(summary.pruned, 0);
  assert.equal(titles().length, 10);
});

test("today's shows are never pruned (venues drop them the day of)", async () => {
  db.exec("DELETE FROM events WHERE source_name = 'venue'");
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const listing = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((t) => show(t)).concat(show('Tonight', today));
  await runAdapter(fakeAdapter(listing, { complete: true }));
  await wait();
  await runAdapter(fakeAdapter(listing.slice(0, 7), { complete: true }));
  assert.ok(titles().includes('Tonight'));
});

test('a feed and a scraper sharing an id never prune each other', async () => {
  db.exec("DELETE FROM events WHERE source_name = 'venue'");
  const asFeed = (events) => ({
    meta: { id: 'feed', source: 'rss', label: 'Feed' },
    run: async () => ({ runs: [{ source: 'rss', source_name: 'venue', status: 'ok', events, complete: true }] }),
  });
  await runAdapter(asFeed(['Feed Show'].map((t) => ({ ...show(t), source: 'rss' }))));
  await wait();
  await runAdapter(fakeAdapter('ABCDEF'.split('').map((t) => show(t)), { complete: true }));
  assert.ok(titles().includes('Feed Show'));
});

test('a show listed by a venue and by Ticketmaster is listed once', async () => {
  const { upsertEvent, queryEvents, countEvents } = await import('../src/db/queries.js');
  const day = '2099-07-04';
  const base = { date: day, category: 'music', city: 'Seattle' };
  upsertEvent({ ...base, source: 'scrape', source_name: 'tractor', title: 'Tractor Presents: Dave Hause w/ American Steel', venue: 'The Tractor Tavern' });
  upsertEvent({ ...base, source: 'api', source_name: 'ticketmaster', title: 'Dave Hause (21+)', venue: 'Tractor', lineup: ['Dave Hause', 'American Steel'] });
  // Same source twice is two shows (matinee + evening).
  upsertEvent({ ...base, source: 'api', source_name: 'ticketmaster', title: 'Choir - Matinee', venue: 'Hall', lineup: ['Choir'], time: '14:00' });
  upsertEvent({ ...base, source: 'api', source_name: 'ticketmaster', title: 'Choir - Evening', venue: 'Hall', lineup: ['Choir'], time: '19:30' });
  // No parsed act: two venues' open mics are not one show.
  upsertEvent({ ...base, source: 'scrape', source_name: 'a', title: 'Open Mic', venue: 'Bar A' });
  upsertEvent({ ...base, source: 'rss', source_name: 'b', title: 'Open Mic', venue: 'Bar B' });
  // Same act, same night, other city: not the same show.
  upsertEvent({ ...base, source: 'rss', source_name: 'c', title: 'Dave Hause', venue: 'Elsewhere', city: 'Spokane' });

  const listed = () => queryEvents({ dateFrom: day, dateTo: day }).map((e) => `${e.source_name}: ${e.title}`).sort();
  assert.deepEqual(listed(), [
    'a: Open Mic',
    'b: Open Mic',
    'c: Dave Hause',
    'ticketmaster: Choir - Evening',
    'ticketmaster: Choir - Matinee',
    'tractor: Tractor Presents: Dave Hause w/ American Steel',
  ]);
  assert.equal(countEvents({ dateFrom: day, dateTo: day }), 6);
  assert.equal(countEvents({ dateFrom: day, dateTo: day, showDuplicates: true }), 7);
  // Filtering by source still shows that source's copy.
  assert.ok(queryEvents({ dateFrom: day, dateTo: day, sources: ['ticketmaster'] }).some((e) => e.title === 'Dave Hause (21+)'));
  // The copy you starred wins.
  const tmCopy = db.prepare("SELECT id FROM events WHERE title = 'Dave Hause (21+)'").get();
  setInterested(tmCopy.id, true);
  assert.ok(listed().includes('ticketmaster: Dave Hause (21+)'));
  assert.ok(!listed().some((t) => t.startsWith('tractor:')));
});
