// Movies tab: cinema listings grouped for browsing, with the kids /
// vapid-action filter applied (filtered films are returned separately, each
// with its reason, so the UI can show them on request).
import express from 'express';
import { getMovies, setMovieHidden } from '../db/movies.js';
import { groupMovies } from '../cinema/group.js';
import { THEATERS } from '../cinema/index.js';

const router = express.Router();

router.get('/views/movies', (req, res) => {
  res.json({
    theaters: THEATERS.map(({ id, name, url, city }) => ({ id, name, url, city })),
    ...groupMovies(getMovies()),
  });
});

router.post('/movies/:id/hidden', (req, res) => {
  const movie = setMovieHidden(parseInt(req.params.id, 10), req.body?.value !== false);
  if (!movie) return res.status(404).json({ error: 'not found' });
  res.json({ movie });
});

export default router;
