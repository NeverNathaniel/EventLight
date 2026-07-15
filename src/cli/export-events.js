// Export upcoming events to data/events-export.json for the /curate routine.
// Run directly (`npm run export-events`) or let the /curate Claude Code command
// invoke it. Claude reads the JSON, ranks by your criteria, and writes
// data/curated.json, which the dashboard's "Curated" tab then displays.
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from '../db/migrate.js';
import { queryEvents } from '../db/queries.js';
import { scoreEvents } from '../scoring/engine.js';
import { DATA_DIR } from '../config.js';

function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function main() {
  migrate();
  const rows = scoreEvents(
    queryEvents({ dateFrom: todayISO(), showHidden: false }, { sort: 'date' })
  );

  // A compact shape that's easy for the curation step to reason over.
  const events = rows.map((e) => ({
    id: e.id,
    title: e.title,
    artist: e.artist,
    venue: e.venue,
    city: e.city,
    date: e.date,
    time: e.time,
    category: e.category,
    genre_tags: e.genre_tags,
    price_range: e.price_range,
    ticket_url: e.ticket_url,
    interested: e.interested,
    score: Number(e._score?.toFixed?.(2) ?? 0),
  }));

  const out = { generated_at: new Date().toISOString(), count: events.length, events };
  const file = path.join(DATA_DIR, 'events-export.json');
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Exported ${events.length} upcoming event(s) to ${file}`);
}

main();
