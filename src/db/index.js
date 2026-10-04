// SQLite connection (better-sqlite3 — synchronous, fast, no callbacks).
// The schema is applied the moment the connection opens, before any module
// (e.g. queries.js) prepares a statement against these tables. ES module
// imports run before top-level code, so table creation cannot wait for an
// explicit migrate() call in server.js.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DB_PATH } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure the data directory exists before opening the file.
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables idempotently (CREATE TABLE IF NOT EXISTS) on connection open.
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// CREATE TABLE IF NOT EXISTS never alters an existing table, so columns added
// after the first release are bolted on here — also before any prepare().
for (const [table, name, def] of [
  ['events', 'lineup', "TEXT NOT NULL DEFAULT '[]'"],
  ['events', 'artist_tags', "TEXT NOT NULL DEFAULT ''"],
  ['artists', 'similar_at', 'TEXT'],
  ['movies', 'peak_showings', 'INTEGER NOT NULL DEFAULT 0'],
  ['events', 'headliner_key', 'TEXT'],
  ['events', 'going', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
// Finds the same show listed by another source (see buildWhere in queries.js).
db.exec('CREATE INDEX IF NOT EXISTS idx_events_show ON events(date, headliner_key)');

export default db;
