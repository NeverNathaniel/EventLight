// /api/status — last run info per source (for the UI status bar) plus scheduler state.
import express from 'express';
import { getStatus, getRecentLogs, countEvents } from '../db/queries.js';
import { getSchedulerState } from '../scheduler/cron.js';

const router = express.Router();

router.get('/status', (req, res) => {
  const sources = getStatus();
  res.json({
    scheduler: getSchedulerState(),
    totalEvents: countEvents({ showHidden: true }),
    sources,
    lastRunAt: sources.reduce(
      (latest, s) => (s.run_at > (latest || '') ? s.run_at : latest),
      null
    ),
  });
});

// Recent ingestion log lines (for debugging selector drift, API errors, etc.).
router.get('/status/logs', (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
  res.json({ logs: getRecentLogs(limit) });
});

export default router;
