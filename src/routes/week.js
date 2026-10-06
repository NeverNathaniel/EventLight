// The Week screen, the day page, the detail sheet, Saved, and a calendar
// feed of the shows you're going to.
import express from 'express';
import { queryEvents } from '../db/queries.js';
import { buildIcs } from '../ics.js';
import { todayISO, addDays } from '../dates.js';
import { weekBrief, dayPage, eventDetails, artistView, venueView, savedLists, profileView } from '../week.js';
import { artistProfile } from '../enrich/profile.js';

const router = express.Router();

router.get('/views/brief', (req, res) => {
  res.json(weekBrief());
});

// Nothing is listed further ahead than a year; a day page past this is a
// typo or a stale link.
const DAY_MAX_AHEAD = 400;

// The asked date if it's a real calendar day from today to DAY_MAX_AHEAD
// days out, else today. The round trip catches dates that only look right:
// "2026-11-31" would roll over to December 1st, and "2026-12-32" doesn't
// parse at all.
function dayFor(asked, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asked || '')) return today;
  let real;
  try {
    real = addDays(asked, 0) === asked;
  } catch {
    real = false;
  }
  if (!real || asked < today || asked > addDays(today, DAY_MAX_AHEAD)) return today;
  return asked;
}

// A day's page. A missing, malformed, impossible, past or far-off date gets
// today's page (the client then shows today's address).
router.get('/views/day', (req, res) => {
  const today = todayISO();
  res.json(dayPage(dayFor(String(req.query.date || ''), today), { today }));
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
// `hint=comedy` lets a comedian MusicBrainz doesn't know be found on Wikipedia.
router.get('/artist/profile', async (req, res, next) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const hint = req.query.hint === 'comedy' ? 'comedy' : undefined;
  try {
    res.json(profileView(await artistProfile(name, { hint })));
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
