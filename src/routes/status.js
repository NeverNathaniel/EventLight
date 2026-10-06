// /api/status — last run info per source (for the UI status bar) plus scheduler state.
import express from 'express';
import { getStatus, getRecentLogs, countEvents } from '../db/queries.js';
import { getSchedulerState } from '../scheduler/cron.js';
import { prefetchState } from '../enrich/prefetch.js';

const router = express.Router();

router.get('/status', (req, res) => {
  const sources = getStatus();
  res.json({
    scheduler: getSchedulerState(),
    totalEvents: countEvents({ showHidden: true }),
    sources,
    // When the listings were last refreshed. The background artist lookups
    // run on for a few minutes after a refresh and don't count.
    lastRunAt: sources
      .filter((s) => s.source_name !== 'profiles')
      .reduce((latest, s) => (s.run_at > (latest || '') ? s.run_at : latest), null),
    profiles: prefetchState(),
  });
});

// Recent ingestion log lines (for debugging selector drift, API errors, etc.).
router.get('/status/logs', (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
  res.json({ logs: getRecentLogs(limit) });
});

export default router;
