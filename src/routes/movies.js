// Movies tab: cinema listings grouped for browsing, with the kids /
// vapid-action filter applied (filtered films are returned separately, each
// with its reason, so the UI can show them on request). Listed films carry
// the day page's flags, feel line and _pick for their next showing, and each
// group is sorted best first (see movieGroups in week.js).
import express from 'express';
import { setMovieHidden } from '../db/movies.js';
import { THEATERS } from '../cinema/index.js';
import { movieGroups } from '../week.js';

const router = express.Router();

router.get('/views/movies', (req, res) => {
  res.json({
    theaters: THEATERS.map(({ id, name, url, city }) => ({ id, name, url, city })),
    ...movieGroups(),
  });
});

router.post('/movies/:id/hidden', (req, res) => {
  const movie = setMovieHidden(parseInt(req.params.id, 10), req.body?.value !== false);
  if (!movie) return res.status(404).json({ error: 'not found' });
  res.json({ movie });
});

export default router;
