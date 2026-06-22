// Adapter registry + orchestrator.
// runAll() executes every adapter, upserts (dedupes) results into SQLite, and
// logs each source's run to scrape_log. Adapter failures are isolated.
import * as ticketmaster from './ticketmaster.js';
import * as bandsintown from './bandsintown.js';
import * as eventbrite from './eventbrite.js';
import * as rss from './rss.js';
import * as scraper from './scraper.js';
import { upsertEvents, logRun } from '../db/queries.js';

export const adapters = [ticketmaster, eventbrite, bandsintown, rss, scraper];

// Normalise any adapter result into a flat array of per-source runs.
function toRuns(adapter, result) {
  if (result && Array.isArray(result.runs)) return result.runs;
  return [
    {
      source: adapter.meta.source,
      source_name: adapter.meta.id,
      status: result?.status || 'ok',
      events: result?.events || [],
      error_msg: result?.error_msg || null,
    },
  ];
}

// Ingest a single run's events and write its log row. Returns a summary.
function ingestRun(run) {
  let counts = { found: 0, added: 0, updated: 0, invalid: 0 };
  if (run.status === 'ok' && run.events.length) {
    counts = upsertEvents(run.events);
  } else {
    counts.found = run.events?.length || 0;
  }

  logRun({
    source: run.source,
    source_name: run.source_name,
    status: run.status,
    events_found: counts.found,
    events_added: counts.added,
    error_msg: run.error_msg,
  });

  return {
    source: run.source,
    source_name: run.source_name,
    status: run.status,
    found: counts.found,
    added: counts.added,
    updated: counts.updated,
    error_msg: run.error_msg || null,
  };
}

// Run a single adapter by id (used by the on-demand refresh of one source).
export async function runAdapter(adapter) {
  const summaries = [];
  try {
    const result = await adapter.run();
    for (const run of toRuns(adapter, result)) {
      summaries.push(ingestRun(run));
    }
  } catch (err) {
    // Last-resort guard: an adapter that throws still logs and continues.
    logRun({
      source: adapter.meta.source,
      source_name: adapter.meta.id,
      status: 'error',
      error_msg: err.message,
    });
    summaries.push({
      source: adapter.meta.source,
      source_name: adapter.meta.id,
      status: 'error',
      found: 0,
      added: 0,
      updated: 0,
      error_msg: err.message,
    });
  }
  return summaries;
}

// Run every adapter sequentially. Returns a flat list of run summaries.
export async function runAll() {
  const startedAt = new Date().toISOString();
  const results = [];
  for (const adapter of adapters) {
    const summaries = await runAdapter(adapter);
    results.push(...summaries);
    const label = adapter.meta.label;
    const added = summaries.reduce((n, s) => n + s.added, 0);
    const errors = summaries.filter((s) => s.status === 'error').length;
    console.log(
      `[ingest] ${label}: +${added} added` + (errors ? `, ${errors} error(s)` : '')
    );
  }
  return { startedAt, finishedAt: new Date().toISOString(), results };
}

// Look up an adapter module by its meta id.
export function getAdapterById(id) {
  return adapters.find((a) => a.meta.id === id) || null;
}
