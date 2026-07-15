// Applies schema.sql idempotently and seeds sensible defaults.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './index.js';
import { applyTasteProfile } from './applyTasteProfile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  seedDefaults();
  // One-off Spotify taste import (idempotent; no-op once applied).
  applyTasteProfile();
  return db;
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
      ['comedy', 3],
      ['punk', 3],
      ['electronic', 3],
      ['hip hop', 3],
      ['folk', 3],
    ];
    const tx = db.transaction((rows) => rows.forEach((r) => insert.run(...r)));
    tx(seed);
  }
}

// Allow `node src/db/migrate.js` to initialise the database directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
  console.log('Database migrated at', db.name);
}
