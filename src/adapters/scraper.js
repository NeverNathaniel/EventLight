// Web scraping adapter (Playwright, headless). Iterates enabled entries in
// scrapers.json. Fault-tolerant: a failed scraper logs and the run continues —
// it never throws to the caller or crashes the server.
//
// Robustness measures:
//   - configs are validated up front (a scraper saved without selectors gets a
//     clear error instead of a cryptic in-page failure)
//   - image/media/font requests are blocked (faster, lighter on the venue)
//   - navigation is retried once on transient failures
//   - extracted items are capped and sanity-filtered so one bad selector can't
//     flood the database with nav/footer junk
//   - scrapers run with small concurrency (each entry is a different site, so
//     parallelism stays polite per-domain)
import { chromium } from 'playwright';
import { readScrapers } from '../configFiles.js';
import { CHROMIUM_PATH, HEADLESS, REQUEST_DELAY_MS, SCRAPER_CONCURRENCY, sleep } from '../config.js';
import { classify, toISODate, toTime, clean, absoluteUrl } from './util.js';

export const meta = { id: 'scraper', source: 'scrape', label: 'Web scrapers' };

const NAV_TIMEOUT_MS = 30000;
const WAITFOR_TIMEOUT_MS = 12000;
const MAX_ITEMS = 250; // cap per page — a selector matching more than this is drifting
const MAX_TITLE_LEN = 300; // longer "titles" are almost always scooped-up page copy
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);

// Validate a scraper config before spending a page load on it.
// Returns an error message, or null when the config is runnable.
export function validateScraperConfig(cfg) {
  if (!cfg.url) return 'No url configured';
  try {
    const u = new URL(cfg.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return `Unsupported URL scheme "${u.protocol}" — only http(s) is scraped`;
    }
  } catch {
    return `Invalid url "${cfg.url}"`;
  }
  if (!cfg.selectors || !String(cfg.selectors.item || '').trim()) {
    return 'selectors.item is not configured — set it to the repeating per-event element';
  }
  return null;
}

// Runs in the browser context: pull raw fields per event item using the
// configured selectors (each may be a comma-separated fallback list).
function extractInPage({ selectors, maxItems }) {
  const items = Array.from(document.querySelectorAll(selectors.item)).slice(0, maxItems);
  const pick = (root, sel) => {
    if (!sel) return null;
    try {
      return root.querySelector(sel);
    } catch {
      return null; // an invalid sub-selector shouldn't kill the whole extract
    }
  };
  return items.map((el) => {
    const nameEl = pick(el, selectors.name);
    const dateEl = pick(el, selectors.date);
    const linkEl = pick(el, selectors.ticketLink);
    const imgEl = pick(el, selectors.image);
    const priceEl = pick(el, selectors.price);
    // A <time datetime="…"> is the most reliable date source: prefer it on the
    // matched date element, then anywhere within the item, then fall back to text.
    const timeAttr =
      (dateEl && dateEl.getAttribute && dateEl.getAttribute('datetime')) ||
      el.querySelector('time[datetime]')?.getAttribute('datetime') ||
      '';
    return {
      name: nameEl?.textContent || '',
      date: timeAttr || (dateEl?.textContent || ''),
      link: linkEl?.getAttribute('href') || '',
      image: imgEl?.getAttribute('src') || imgEl?.getAttribute('data-src') || '',
      price: priceEl?.textContent || '',
    };
  });
}

async function runScraper(browser, cfg) {
  const source_name = cfg.id || cfg.name;
  const fail = (error_msg) => ({ source: 'scrape', source_name, status: 'error', error_msg, events: [] });

  const configError = validateScraperConfig(cfg);
  if (configError) return fail(configError);

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();
  try {
    // Skip heavy assets — the extractor reads src attributes from the DOM, so
    // the images themselves never need to download.
    await context.route('**/*', (route) =>
      BLOCKED_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue()
    );

    // One retry absorbs transient network hiccups without hammering the site.
    let navError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        navError = null;
        break;
      } catch (err) {
        navError = err;
        if (attempt === 0) await sleep(2000);
      }
    }
    if (navError) throw navError;

    if (cfg.waitFor) {
      // Wait for the JS-rendered content, but don't fail the whole scrape if the
      // condition times out — the markup may already be present.
      await page.waitForSelector(cfg.waitFor, { timeout: WAITFOR_TIMEOUT_MS }).catch(() => {});
    }

    const raw = await page.evaluate(extractInPage, {
      selectors: cfg.selectors,
      maxItems: MAX_ITEMS,
    });

    const events = raw
      .map((r) => {
        const title = clean(r.name);
        const date = toISODate(r.date);
        if (!title || !date || title.length > MAX_TITLE_LEN) return null;
        return {
          source: 'scrape',
          source_name,
          title,
          artist: null,
          venue: cfg.venue || cfg.name,
          city: cfg.city || null,
          date,
          time: toTime(r.date),
          doors_time: null,
          category: classify(title, cfg.category || 'music'),
          genre_tags: cfg.category ? [cfg.category] : [],
          ticket_url: absoluteUrl(clean(r.link), cfg.url),
          image_url: absoluteUrl(clean(r.image), cfg.url),
          price_range: clean(r.price) || null,
        };
      })
      .filter(Boolean);

    if (raw.length === 0) {
      // Selector drift is the usual culprit — surface it clearly.
      return fail(
        `No items matched selector "${cfg.selectors.item}" at ${cfg.url} (possible selector drift)`
      );
    }
    if (events.length === 0) {
      // Items matched but nothing parsed — the drift is in the field selectors.
      return fail(
        `Matched ${raw.length} item(s) at ${cfg.url} but none had a usable title + date — check the "name" and "date" selectors`
      );
    }

    return { source: 'scrape', source_name, status: 'ok', events };
  } catch (err) {
    return fail(`${cfg.url} — ${err.message}`);
  } finally {
    await context.close().catch(() => {});
  }
}

export async function run() {
  const scrapers = readScrapers().filter((s) => s.enabled !== false);
  if (scrapers.length === 0) return { runs: [] };

  let browser;
  try {
    browser = await chromium.launch({
      headless: HEADLESS,
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    });
  } catch (err) {
    // Browser failed to launch (e.g. not installed) — report once, don't crash.
    return {
      runs: scrapers.map((s) => ({
        source: 'scrape',
        source_name: s.id || s.name,
        status: 'error',
        error_msg: `Playwright launch failed: ${err.message}. Run "npx playwright install chromium".`,
        events: [],
      })),
    };
  }

  // Worker pool: each scraper targets a different site, so a few in flight at
  // once is still polite per-domain. Each worker paces itself with the delay.
  const queue = [...scrapers];
  const runs = [];
  const worker = async () => {
    for (;;) {
      const cfg = queue.shift();
      if (!cfg) return;
      runs.push(await runScraper(browser, cfg));
      if (queue.length) await sleep(REQUEST_DELAY_MS);
    }
  };

  try {
    const workers = Math.max(1, Math.min(SCRAPER_CONCURRENCY, scrapers.length));
    await Promise.all(Array.from({ length: workers }, worker));
  } finally {
    await browser.close().catch(() => {});
  }
  return { runs };
}
