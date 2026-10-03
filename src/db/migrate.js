// Applies schema.sql idempotently and seeds sensible defaults.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './index.js';
import { applyTasteProfile } from './applyTasteProfile.js';
import { parseLineup } from '../lineup.js';
import { headlinerKey, getSetting, setSetting } from './queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  backfillLineups();
  backfillHeadlinerKeys();
  seedDefaults();
  lowerSeededComedy();
  // One-off Spotify taste import (idempotent; no-op once applied).
  applyTasteProfile();
  return db;
}

// Events stored before lineup parsing existed get one parsed from their title.
function backfillLineups() {
  const rows = db.prepare("SELECT id, title, artist FROM events WHERE lineup = '[]'").all();
  if (!rows.length) return;
  const update = db.prepare('UPDATE events SET lineup = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      const lineup = parseLineup(r.title, { artist: r.artist });
      if (lineup.length) update.run(JSON.stringify(lineup), r.id);
    }
  })();
}

// Events stored before cross-source matching existed get their headliner key.
function backfillHeadlinerKeys() {
  const rows = db.prepare("SELECT id, lineup FROM events WHERE headliner_key IS NULL AND lineup != '[]'").all();
  if (!rows.length) return;
  const update = db.prepare('UPDATE events SET headliner_key = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      let lineup = [];
      try { lineup = JSON.parse(r.lineup); } catch { /* leave it unmatched */ }
      const key = Array.isArray(lineup) ? headlinerKey(lineup) : null;
      if (key) update.run(key, r.id);
    }
  })();
}

// Seed a starter set of manual genres (weight 3) the first time only, so the
// preference engine has something to work with out of the box.
function seedDefaults() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM manual_genres').get().n;
  if (count === 0) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO manual_genres (genre, weight) VALUES (?, ?)'
    );
    const seed = [
      ['indie rock', 3],
      ['rock', 3],
      ['jazz', 3],
      ['comedy', 1],
      ['punk', 3],
      ['electronic', 3],
      ['hip hop', 3],
      ['folk', 3],
    ];
    const tx = db.transaction((rows) => rows.forEach((r) => insert.run(...r)));
    tx(seed);
  }
}

// Comedy was seeded at 3, which filled Top Picks with comedy-club nights once
// Ticketmaster was on. Installs still at that seeded 3 drop to 1 (comedy
// still scores, below any music you'd like); a weight you set yourself is
// left alone. Runs once.
function lowerSeededComedy() {
  if (getSetting('comedy_seed_lowered')) return;
  db.prepare("UPDATE manual_genres SET weight = 1 WHERE genre = 'comedy' AND weight = 3").run();
  setSetting('comedy_seed_lowered', '1');
}

// Allow `node src/db/migrate.js` to initialise the database directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
  console.log('Database migrated at', db.name);
}
