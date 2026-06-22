// One-shot manual ingestion: `npm run refresh`.
// Runs every adapter once and prints a summary, then exits.
import { migrate } from '../db/migrate.js';
import { runAll } from '../adapters/index.js';

async function main() {
  migrate();
  console.log('Running all adapters…\n');
  const { results } = await runAll();

  console.log('\n── Summary ───────────────────────────────');
  for (const r of results) {
    const line = `${r.source_name.padEnd(20)} ${r.status.padEnd(8)} found=${r.found} added=${r.added} updated=${r.updated}`;
    console.log(r.error_msg ? `${line}\n   ↳ ${r.error_msg}` : line);
  }
  const totalAdded = results.reduce((n, r) => n + r.added, 0);
  console.log(`\nDone. ${totalAdded} new event(s) added.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Refresh failed:', err);
  process.exit(1);
});
