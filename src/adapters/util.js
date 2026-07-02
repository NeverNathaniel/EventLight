// Shared helpers for adapters: category classification, date/time parsing,
// and URL sanitisation.
//
// Date parsing is the heart of scraping correctness. Venue calendars usually
// print dates without a year ("SAT JUL 4"), and JavaScript's native
// `new Date("July 4")` silently resolves that to the year 2001 — so parsing is
// done with explicit patterns and the year is inferred for upcoming listings.

const COMEDY_HINTS = [
  'comedy', 'comedian', 'stand-up', 'standup', 'stand up', 'improv', 'open mic comedy',
];
const MUSIC_HINTS = [
  'music', 'concert', 'band', 'live music', 'dj', 'tour', 'acoustic', 'rock', 'jazz',
  'hip hop', 'rap', 'punk', 'metal', 'folk', 'electronic', 'indie', 'orchestra', 'symphony',
];

// Best-effort category from arbitrary text (title, classification, etc.).
export function classify(text, fallback = 'other') {
  const t = String(text || '').toLowerCase();
  if (COMEDY_HINTS.some((h) => t.includes(h))) return 'comedy';
  if (MUSIC_HINTS.some((h) => t.includes(h))) return 'music';
  return fallback;
}

// ── Date parsing ─────────────────────────────────────────────────────────

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|' +
  'aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

// "July 4", "Jul 4th, 2026" — the (?!\d) guard stops "Jul 2026" from being
// read as day 20.
const MONTH_FIRST_RE = new RegExp(
  `(?:^|[^a-z])(${MONTH_RE})\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`,
  'i'
);
// "4 July", "04 Jul 2026" (RFC 2822 pubDates land here).
const DAY_FIRST_RE = new RegExp(
  `(?:^|[^\\d])(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?(?:,?\\s+(\\d{4}))?`,
  'i'
);

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Format using local components — never toISOString(), which shifts the day
// across the UTC boundary for evening events / non-UTC hosts.
function fromLocalDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Validate that y-m-d is a real calendar date (rejects 2026-99-99, Feb 30).
function ymdOrNull(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// Guard against garbage years from loose text ("Blink 182" → year 182,
// "The 1975" → 1975). Listings are near-term: accept last year → +2 years.
function plausibleYear(y, now) {
  const cur = now.getFullYear();
  return y >= cur - 1 && y <= cur + 2;
}

// A month/day with no year: listings are upcoming, so pick this year unless
// the date already passed by more than ~45 days — then it's next year's.
function inferYear(m, d, now) {
  const y = now.getFullYear();
  const candidate = new Date(y, m - 1, d);
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 45);
  return candidate < cutoff ? y + 1 : y;
}

// Normalise any date-ish input to an ISO date string (YYYY-MM-DD), or null.
// `now` is injectable for tests and year inference.
export function toISODate(input, now = new Date()) {
  if (!input) return null;
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return fromLocalDate(input);
  }
  const str = String(input).trim();

  // Already ISO-ish (2026-07-04, possibly inside a datetime string).
  const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return ymdOrNull(parseInt(iso[1], 10), parseInt(iso[2], 10), parseInt(iso[3], 10));
  }

  // Numeric M/D or M/D/YY(YY). Slash-only when the year is missing, so time
  // ranges like "6-8" aren't read as June 8.
  const numeric = str.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?:[/-](\d{2,4}))?(?!\d)/);
  if (numeric) {
    const m = parseInt(numeric[1], 10);
    const d = parseInt(numeric[2], 10);
    let y = numeric[3] ? parseInt(numeric[3], 10) : null;
    if (y != null && y < 100) y += 2000;
    if (y == null) y = inferYear(m, d, now);
    if (!plausibleYear(y, now)) return null;
    return ymdOrNull(y, m, d);
  }

  // Month-name formats, with or without a year.
  const named = str.match(MONTH_FIRST_RE) || str.match(DAY_FIRST_RE);
  if (named) {
    const monthFirst = /[a-z]/i.test(named[1]);
    const m = MONTHS[(monthFirst ? named[1] : named[2]).slice(0, 3).toLowerCase()];
    const d = parseInt(monthFirst ? named[2] : named[1], 10);
    const y = named[3] ? parseInt(named[3], 10) : inferYear(m, d, now);
    if (!plausibleYear(y, now)) return null;
    return ymdOrNull(y, m, d);
  }

  // Last-resort native parse, accepted only when the result lands in the
  // plausible-year window (kills "Blink 182" → 0182, "1975" → 1975).
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime()) && plausibleYear(parsed.getFullYear(), now)) {
    return fromLocalDate(parsed);
  }
  return null;
}

// Extract a 24h HH:MM time from a date object or a string like "8:00 PM".
export function toTime(input) {
  if (!input) return null;
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    // Local wall-clock time — toISOString() would report UTC.
    return `${pad2(input.getHours())}:${pad2(input.getMinutes())}`;
  }
  const str = String(input);

  // ISO datetime with explicit time.
  const isoTime = str.match(/T(\d{2}):(\d{2})/);
  if (isoTime) return `${isoTime[1]}:${isoTime[2]}`;

  // "8:00 PM" / "8 PM" / "8p.m." — \b guards keep "10 amp" from matching.
  const ampm = str.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (/p/i.test(ampm[3])) h += 12;
    const m = ampm[2] || '00';
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  // Bare 24h time, e.g. "19:30".
  const h24 = str.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (h24) return `${pad2(parseInt(h24[1], 10))}:${h24[2]}`;
  return null;
}

// Trim and collapse whitespace from scraped text.
export function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// Resolve a possibly-relative URL against a base. Only http(s) results are
// returned — scraped pages can carry javascript:/data: links that must never
// reach the UI as hrefs.
export function absoluteUrl(href, base) {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// Absolute http(s) URLs only (relative inputs are rejected). Used at the DB
// boundary as the last line of defence for ticket/image URLs.
export function safeHttpUrl(href) {
  return absoluteUrl(href, undefined);
}
