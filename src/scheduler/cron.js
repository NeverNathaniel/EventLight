// Scheduled ingestion via node-cron. Runs all adapters on REFRESH_CRON
// (default every 6 hours) and guards against overlapping runs.
import cron from 'node-cron';
import { runAll, runAdapter, getAdapterById } from '../adapters/index.js';
import { REFRESH_CRON, REFRESH_ON_START } from '../config.js';

const state = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSummary: null,
};

export function getSchedulerState() {
  return { ...state, cron: REFRESH_CRON };
}

// Run all adapters, guarding against concurrent invocations.
export async function triggerRefresh() {
  if (state.running) {
    return { skipped: true, reason: 'A refresh is already in progress.' };
  }
  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  try {
    const summary = await runAll();
    state.lastSummary = summary;
    return summary;
  } finally {
    state.lastFinishedAt = new Date().toISOString();
    state.running = false;
  }
}

// Refresh a single adapter on demand (e.g. "re-run this scraper").
export async function triggerAdapter(id) {
  const adapter = getAdapterById(id);
  if (!adapter) return { error: `Unknown adapter: ${id}` };
  if (state.running) {
    return { skipped: true, reason: 'A refresh is already in progress.' };
  }
  state.running = true;
  try {
    return { results: await runAdapter(adapter) };
  } finally {
    state.running = false;
  }
}

export function startScheduler() {
  if (!cron.validate(REFRESH_CRON)) {
    console.warn(`[scheduler] Invalid REFRESH_CRON "${REFRESH_CRON}"; scheduler disabled.`);
    return;
  }
  cron.schedule(REFRESH_CRON, () => {
    console.log('[scheduler] Triggering scheduled refresh…');
    triggerRefresh().catch((err) => console.error('[scheduler] refresh failed', err));
  });
  console.log(`[scheduler] Ingestion scheduled: "${REFRESH_CRON}"`);

  if (REFRESH_ON_START) {
    console.log('[scheduler] REFRESH_ON_START enabled — running initial ingestion…');
    triggerRefresh().catch((err) => console.error('[scheduler] initial refresh failed', err));
  }
}
