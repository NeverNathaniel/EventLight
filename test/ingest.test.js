// Tests for the ingest pipeline: lineup storage and pruning of listings a
// complete source no longer shows. Runs against a throwaway in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.EVENTLIGHT_DB = ':memory:';
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
