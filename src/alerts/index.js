// Alerts: a push when a favorite or starred artist has a new show, and a
// weekly digest of Top Picks. Sent through ntfy (see ntfy.js).
//
// New-show alerts run after every refresh. Each show alerts once — keyed by
// date + headliner, so a show two sources list, or one refreshed every six
// hours, is still one alert. The first check after you set a topic sends a
// single "alerts are on" message listing what's already on the calendar
// instead of a burst of alerts for shows you can already see.
import db from '../db/index.js';
import { getSetting, setSetting, queryEvents } from '../db/queries.js';
import { scoreEvents, hasArtistMatch } from '../scoring/engine.js';
import { topPicks, onePerShow } from '../picks.js';
import { todayISO, addDays } from '../dates.js';
import { PUBLIC_URL, DIGEST_CRON } from '../config.js';
import { parseTopic, sendNtfy } from './ntfy.js';

const MAX_SINGLE = 5; // more new shows than this in one refresh → one combined message
const MAX_LINES = 12;
const DIGEST_DAYS = 14;
const DIGEST_PICKS = 6;

// ── Settings ────────────────────────────────────────────────────────────
export function getAlertSettings() {
  return {
    topic: getSetting('alerts_topic', '') || '',
    artists: getSetting('alerts_artists', '1') === '1',
    digest: getSetting('alerts_digest', '1') === '1',
  };
}

export function digestScheduleLabel(cron = DIGEST_CRON) {
  return cron === '0 9 * * 1' ? 'Mondays at 9 AM' : `cron "${cron}"`;
}

// Returns an error string, or null once saved. A new topic, or turning
// new-show alerts back on, starts over with an "alerts are on" message.
export function saveAlertSettings({ topic, artists, digest } = {}) {
  const before = getAlertSettings();
  if (topic !== undefined) {
    const t = String(topic).trim();
    if (t && !parseTopic(t)) return 'Topic can use letters, numbers, - and _ (up to 64), or be a full ntfy topic URL';
    setSetting('alerts_topic', t);
  }
  if (artists !== undefined) setSetting('alerts_artists', artists ? '1' : '0');
  if (digest !== undefined) setSetting('alerts_digest', digest ? '1' : '0');
  const after = getAlertSettings();
  if (after.topic !== before.topic || (after.artists && !before.artists)) setSetting('alerts_baseline', '');
  return null;
}

// ── Formatting ──────────────────────────────────────────────────────────
function clock(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
}

export function formatDay(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

const headliner = (e) => (e._lineup && e._lineup[0]) || e.title;
const place = (e) => (e.city && !e.venue.includes(e.city) ? `${e.venue}, ${e.city}` : e.venue);
const artistReason = (e) => (e._reasons.find((r) => r.kind === 'favorite' || r.kind === 'learned') || {}).text || '';
const line = (e) => `• ${formatDay(e.date)} · ${headliner(e)} @ ${e.venue}`;

function lines(events) {
  const out = events.slice(0, MAX_LINES).map(line);
  if (events.length > MAX_LINES) out.push(`…and ${events.length - MAX_LINES} more`);
  return out.join('\n');
}

export function showMessage(e) {
  const when = e.time ? `${formatDay(e.date)}, ${clock(e.time)}` : formatDay(e.date);
  return {
    title: `New show: ${headliner(e)}`,
    message: `${when} · ${place(e)}\n${artistReason(e)}`,
    click: e.ticket_url || PUBLIC_URL || undefined,
    tags: ['musical_note'],
    priority: 4,
  };
}

export function combinedMessage(events) {
  return {
    title: `${events.length} new shows by your artists`,
    message: lines(events),
    click: PUBLIC_URL || undefined,
    tags: ['musical_note'],
    priority: 4,
  };
}

export function welcomeMessage(events, { digest } = {}) {
  const parts = ["You'll get a push here when a favorite or starred artist has a new show in the area."];
  if (digest) parts.push(`Top Picks arrive weekly (${digestScheduleLabel()}).`);
  parts.push(events.length ? `Already on the calendar:\n${lines(events)}` : 'Nothing by your artists on the calendar yet.');
  return { title: 'EventLight alerts are on', message: parts.join('\n\n'), click: PUBLIC_URL || undefined, tags: ['bell'] };
}

// The short "why" for a digest line: ♥ for your artists, ≈ the favorite a
// show sounds like, otherwise its best genre matches; ⌂ when close to home.
function digestWhy(e) {
  const r = e._reasons || [];
  let why = '';
  if (r.some((x) => x.kind === 'favorite' || x.kind === 'learned')) why = '♥';
  else {
    const sim = r.find((x) => x.kind === 'similar');
    const seed = sim && (sim.text.match(/\(≈ ([^)]+)\)$/) || sim.text.match(/sounds like (.+)$/));
    if (seed) why = `≈ ${seed[1]}`;
    else why = (r.find((x) => x.kind === 'genre') || {}).text || '';
  }
  return r.some((x) => x.kind === 'nearby') ? `${why} ⌂`.trim() : why;
}

export function digestMessage(events) {
  return {
    title: 'Top picks for the next two weeks',
    message: events.map((e) => `${line(e)}${digestWhy(e) ? ` — ${digestWhy(e)}` : ''}`).join('\n'),
    click: PUBLIC_URL || undefined,
    tags: ['calendar'],
  };
}

// ── Checks ──────────────────────────────────────────────────────────────
// Upcoming shows (next year) by your favorite or starred artists, one per
// show, minus shows you've already starred.
function artistShows(today) {
  const scored = scoreEvents(queryEvents({ dateFrom: today, dateTo: addDays(today, 365) }, { sort: 'date' }));
  return onePerShow(scored.filter((e) => hasArtistMatch(e) && !e.interested)).map((e) => ({
    key: `${e.date}|${e.headliner_key || e.dedupe_key}`,
    event: e,
  }));
}

const recordStmt = () => db.prepare('INSERT OR IGNORE INTO alerts_sent (key) VALUES (?)');

export async function checkArtistAlerts({ send = sendNtfy, today = todayISO() } = {}) {
  const settings = getAlertSettings();
  const target = parseTopic(settings.topic);
  if (!target || !settings.artists) return { sent: 0, skipped: 'off' };

  // Past shows can't alert again; keep the table small.
  db.prepare('DELETE FROM alerts_sent WHERE key < ?').run(today);
  const shows = artistShows(today);
  const record = recordStmt();

  if (getSetting('alerts_baseline') !== settings.topic) {
    await send(target, welcomeMessage(shows.map((s) => s.event), settings));
    db.transaction(() => shows.forEach((s) => record.run(s.key)))();
    setSetting('alerts_baseline', settings.topic);
    return { sent: 1, welcome: true, shows: shows.length };
  }

  const known = new Set(db.prepare('SELECT key FROM alerts_sent').all().map((r) => r.key));
  const fresh = shows.filter((s) => !known.has(s.key));
  if (!fresh.length) return { sent: 0 };
  if (fresh.length > MAX_SINGLE) {
    await send(target, combinedMessage(fresh.map((s) => s.event)));
    db.transaction(() => fresh.forEach((s) => record.run(s.key)))();
    return { sent: 1, shows: fresh.length };
  }
  // Record each as it goes out, so a failure part-way resends only the rest.
  for (const s of fresh) {
    await send(target, showMessage(s.event));
    record.run(s.key);
  }
  return { sent: fresh.length, shows: fresh.length };
}

export async function sendDigest({ send = sendNtfy, today = todayISO(), force = false } = {}) {
  const settings = getAlertSettings();
  const target = parseTopic(settings.topic);
  if (!target || (!settings.digest && !force)) return { sent: 0, skipped: 'off' };
  const until = addDays(today, DIGEST_DAYS);
  const { artists, events } = topPicks({ today, days: DIGEST_DAYS, limit: DIGEST_PICKS });
  const picks = [...artists.filter((e) => e.date <= until), ...events]
    .filter((e) => !e.interested)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!picks.length) return { sent: 0, skipped: 'nothing to pick' };
  await send(target, digestMessage(picks));
  return { sent: 1, shows: picks.length };
}

export async function sendTest({ send = sendNtfy } = {}) {
  const target = parseTopic(getAlertSettings().topic);
  if (!target) throw new Error('Set a topic first');
  await send(target, {
    title: 'EventLight test',
    message: 'Alerts reach this device.',
    click: PUBLIC_URL || undefined,
    tags: ['white_check_mark'],
  });
  return { sent: 1 };
}

// After a refresh: never let an alert problem fail the refresh itself.
export async function runAlerts() {
  try {
    const r = await checkArtistAlerts();
    if (r.sent) console.log(`[alerts] sent ${r.sent} message(s) about ${r.shows} show(s)`);
    return r;
  } catch (err) {
    console.error('[alerts] could not send:', err.message);
    return { sent: 0, error: err.message };
  }
}
