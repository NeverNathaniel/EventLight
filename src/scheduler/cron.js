// Scheduled ingestion via node-cron. Runs all adapters on REFRESH_CRON
// (default every 6 hours) and guards against overlapping runs. Alerts for new
// shows go out after each refresh, then the coming headliners' artist
// profiles are looked up in the background; the Top Picks digest has its own
// schedule.
import cron from 'node-cron';
import { runAll, runAdapter, getAdapterById } from '../adapters/index.js';
import { REFRESH_CRON, REFRESH_ON_START, DIGEST_CRON, PROFILE_PREFETCH } from '../config.js';
import { runAlerts, sendDigest } from '../alerts/index.js';
import { prefetchProfiles } from '../enrich/prefetch.js';

const state = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSummary: null,
};

export function getSchedulerState() {
  return { ...state, cron: REFRESH_CRON };
}

// Artist profiles for the new listings take minutes (the free services are
// rate limited), so they're fetched detached from the refresh: "Refreshing…"
// and the refresh request don't wait for them, and prefetchProfiles keeps its
// own guard against overlapping runs. setImmediate lets the refresh answer
// before the prefetch's first (synchronous) scoring pass.
function startPrefetch() {
  if (!PROFILE_PREFETCH) return;
  setImmediate(() => {
    prefetchProfiles()
      .then((r) => {
        if (r.fetched) console.log(`[profiles] Looked up ${r.fetched} artist profile(s) (${r.found} found, stopped: ${r.stoppedBy})`);
      })
      .catch((err) => console.error('[profiles] background lookups failed:', err.message));
  });
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
    summary.alerts = await runAlerts();
    state.lastSummary = summary;
    return summary;
  } finally {
    state.lastFinishedAt = new Date().toISOString();
    state.running = false;
    startPrefetch();
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
  if (cron.validate(DIGEST_CRON)) {
    cron.schedule(DIGEST_CRON, () => {
      sendDigest().catch((err) => console.error('[alerts] digest failed:', err.message));
    });
  } else {
    console.warn(`[scheduler] Invalid DIGEST_CRON "${DIGEST_CRON}"; weekly digest disabled.`);
  }

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
