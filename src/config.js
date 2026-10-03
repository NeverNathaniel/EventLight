// Central configuration: loads environment, resolves paths, and exposes constants.
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root is one level above /src.
export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
// EVENTLIGHT_DB lets tests use a throwaway database (e.g. ":memory:").
export const DB_PATH = process.env.EVENTLIGHT_DB || path.join(DATA_DIR, 'events.db');
export const PUBLIC_DIR = path.join(__dirname, 'public');
export const FEEDS_PATH = path.join(ROOT_DIR, 'feeds.json');
export const SCRAPERS_PATH = path.join(ROOT_DIR, 'scrapers.json');
export const ENV_PATH = path.join(ROOT_DIR, '.env');

export const PORT = parseInt(process.env.PORT || '3000', 10);

// Cron schedule for the recurring ingestion run. Default: every 6 hours.
export const REFRESH_CRON = process.env.REFRESH_CRON || '0 */6 * * *';
export const REFRESH_ON_START =
  String(process.env.REFRESH_ON_START || 'false').toLowerCase() === 'true';

// Playwright runs headless unless explicitly disabled for debugging.
export const HEADLESS =
  String(process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';

// Optional path to a system Chromium/Chrome binary. Useful when the Playwright
// browser download isn't available (ARM boards, NAS boxes, containers).
export const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '';

// Geographic search anchors used by the Ticketmaster / Eventbrite adapters.
export const LOCATIONS = [
  { name: 'Seattle', city: 'Seattle', stateCode: 'WA', latlong: '47.6062,-122.3321' },
  { name: 'Tacoma', city: 'Tacoma', stateCode: 'WA', latlong: '47.2529,-122.4443' },
];

export const SEARCH_RADIUS_MILES = 30;

// "Close to home": shows you'd like anyway rank higher the nearer they are to
// your home city. These are defaults — Settings → Close to Home overrides them.
export const HOME_CITY = process.env.HOME_CITY ?? 'Tacoma';
export const HOME_BOOST = Math.max(0, Math.min(100, parseInt(process.env.HOME_BOOST ?? '50', 10) || 0));

// Polite delay (ms) applied between outbound requests within an adapter to
// respect rate limits.
export const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || '350', 10);

// How many scrapers run at once. Each scraper targets a different site, so a
// small pool speeds up the run without hitting any one domain harder.
export const SCRAPER_CONCURRENCY = Math.max(
  1,
  Math.min(8, parseInt(process.env.SCRAPER_CONCURRENCY || '3', 10) || 3)
);

// Artist enrichment (MusicBrainz genre tags + ListenBrainz similar artists).
// Both services are free and keyless; lookups are cached in SQLite and
// rate-limited, so each refresh only spends a bounded budget on new artists.
export const ENRICH_ARTISTS =
  String(process.env.ENRICH_ARTISTS ?? 'true').toLowerCase() !== 'false';
export const ENRICH_MAX_LOOKUPS = Math.max(
  0,
  parseInt(process.env.ENRICH_MAX_LOOKUPS || '150', 10) || 0
);
// MusicBrainz asks every client to identify itself with a contact URL.
export const USER_AGENT = 'EventLight/1.0 (+https://github.com/NeverNathaniel/EventLight)';

// API keys are read lazily so the Settings page can update .env at runtime.
export function getApiKeys() {
  return {
    ticketmaster: process.env.TICKETMASTER_API_KEY || '',
    bandsintown: process.env.BANDSINTOWN_APP_ID || '',
    eventbrite: process.env.EVENTBRITE_API_KEY || '',
  };
}

// Small promise-based sleep used for inter-request delays.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
