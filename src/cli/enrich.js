// One-shot artist enrichment: `npm run enrich [-- --max 1000]`.
// The scheduled refresh spends ENRICH_MAX_LOOKUPS calls per run; use this to
// fill the cache in one go after a first install or a big batch of new shows.
import { migrate } from '../db/migrate.js';
import { enrichArtists } from '../enrich/index.js';
import { logRun } from '../db/queries.js';

async function main() {
  migrate();
  const i = process.argv.indexOf('--max');
  const maxLookups = i > -1 ? parseInt(process.argv[i + 1], 10) || 1000 : 1000;
  console.log(`Enriching artists (up to ${maxLookups} lookups, ~1/sec)…`);
  const r = await enrichArtists({ maxLookups });
  logRun({
    source: 'enrich',
    source_name: 'artist-enrichment',
    status: r.status,
    events_found: r.lookups || 0,
    events_added: r.found || 0,
    error_msg: r.error_msg,
  });
  console.log(r);
  process.exit(0);
}

main().catch((err) => {
  console.error('Enrichment failed:', err);
  process.exit(1);
});
