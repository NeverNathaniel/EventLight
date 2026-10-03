// Tests for one-off data migrations. Runs against a throwaway in-memory database.
import './helpers/memory-db.js'; // must stay the first import
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');

const comedy = () => db.prepare("SELECT weight FROM manual_genres WHERE genre = 'comedy'").get()?.weight;

test('new installs seed comedy at 1', () => {
  migrate();
  assert.equal(comedy(), 1);
});

test('an install still at the old seeded comedy 3 drops to 1, once; your own weight stays', () => {
  db.exec("UPDATE manual_genres SET weight = 3 WHERE genre = 'comedy'; DELETE FROM settings WHERE key = 'comedy_seed_lowered';");
  migrate();
  assert.equal(comedy(), 1);
  // Set back to 3 afterwards (by you, in Settings): left alone from now on.
  db.exec("UPDATE manual_genres SET weight = 3 WHERE genre = 'comedy'");
  migrate();
  assert.equal(comedy(), 3);
  // A weight you'd tuned before the change is never touched.
  db.exec("UPDATE manual_genres SET weight = 4 WHERE genre = 'comedy'; DELETE FROM settings WHERE key = 'comedy_seed_lowered';");
  migrate();
  assert.equal(comedy(), 4);
});
