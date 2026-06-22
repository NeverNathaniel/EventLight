// Manual refresh endpoints — run all adapters, or a single one, on demand.
import express from 'express';
import { triggerRefresh, triggerAdapter, getSchedulerState } from '../scheduler/cron.js';

const router = express.Router();

// Kick a full refresh. Returns immediately if one is already running.
router.post('/refresh', async (req, res) => {
  const result = await triggerRefresh();
  res.json(result);
});

// Refresh a single adapter (e.g. re-run one scraper after fixing selectors).
router.post('/refresh/:adapter', async (req, res) => {
  const result = await triggerAdapter(req.params.adapter);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

router.get('/refresh/state', (req, res) => {
  res.json(getSchedulerState());
});

export default router;
