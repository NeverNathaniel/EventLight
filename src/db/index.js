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

export default db;
