// Shared helpers for adapters: category classification and date/time parsing.

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

// Normalise any date-ish input to an ISO date string (YYYY-MM-DD), or null.
export function toISODate(input) {
  if (!input) return null;
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return input.toISOString().slice(0, 10);
  }
  const str = String(input).trim();

  // Already ISO-ish.
  const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];

  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

// Extract a 24h HH:MM time from a date object or a string like "8:00 PM".
export function toTime(input) {
  if (!input) return null;
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return input.toISOString().slice(11, 16);
  }
  const str = String(input);

  // ISO datetime with explicit time.
  const isoTime = str.match(/T(\d{2}):(\d{2})/);
  if (isoTime) return `${isoTime[1]}:${isoTime[2]}`;

  // "8:00 PM" / "8 PM"
  const ampm = str.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (/p/i.test(ampm[3])) h += 12;
    const m = ampm[2] || '00';
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  return null;
}

// Trim and collapse whitespace from scraped text.
export function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// Resolve a possibly-relative URL against a base.
export function absoluteUrl(href, base) {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}
