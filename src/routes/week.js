// The Week screen, the detail sheet behind it, Saved, and a calendar feed of
// the shows you're going to.
import express from 'express';
import { queryEvents } from '../db/queries.js';
import { buildIcs } from '../ics.js';
import { todayISO, addDays } from '../dates.js';
import { weekBrief, dayView, eventDetails, artistView, venueView, savedLists, profileView } from '../week.js';
import { artistProfile } from '../enrich/profile.js';

const router = express.Router();

router.get('/views/brief', (req, res) => {
  res.json(weekBrief());
});

router.get('/views/day', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayISO();
  res.json(dayView(date));
});

router.get('/views/saved', (req, res) => {
  res.json(savedLists());
});

router.get('/events/:id/details', (req, res) => {
  const details = eventDetails(parseInt(req.params.id, 10));
  if (!details) return res.status(404).json({ error: 'not found' });
  res.json(details);
});

router.get('/artist', (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.json(artistView(name));
});

// Looks the artist up (MusicBrainz, Wikipedia, Apple Music) if their cached
// profile is missing or stale. Takes a second or two the first time.
router.get('/artist/profile', async (req, res, next) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    res.json(profileView(await artistProfile(name)));
  } catch (err) {
    next(err);
  }
});

router.get('/venue', (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.json(venueView(name));
});

// Subscribe to this URL in a calendar app to see your Going shows there.
// Shows from the last month stay on it so a show doesn't vanish the day after.
router.get('/calendar/going.ics', (req, res) => {
  const events = queryEvents({ dateFrom: addDays(todayISO(), -30), onlyInterested: true, showHidden: true }, { sort: 'date' })
    .filter((e) => e.going);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.send(buildIcs(events, 'EventLight — Going'));
});

export default router;
