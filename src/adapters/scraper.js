// Web scraping adapter (Playwright, headless). Iterates enabled entries in
// scrapers.json. Fault-tolerant: a failed scraper logs and the run continues —
// it never throws to the caller or crashes the server.
import { chromium } from 'playwright';
import { readScrapers } from '../configFiles.js';
import { HEADLESS, REQUEST_DELAY_MS, sleep } from '../config.js';
import { classify, toISODate, toTime, clean, absoluteUrl } from './util.js';

export const meta = { id: 'scraper', source: 'scrape', label: 'Web scrapers' };

// Runs in the browser context: pull raw fields per event item using the
// configured selectors (each may be a comma-separated fallback list).
function extractInPage(selectors) {
  const items = Array.from(document.querySelectorAll(selectors.item));
  const pick = (root, sel) => (sel ? root.querySelector(sel) : null);
  return items.map((el) => {
    const nameEl = pick(el, selectors.name);
    const dateEl = pick(el, selectors.date);
    const linkEl = pick(el, selectors.ticketLink);
    const imgEl = pick(el, selectors.image);
    const priceEl = pick(el, selectors.price);
    return {
      name: nameEl?.textContent || '',
      // a <time> element's datetime attribute is the most reliable date source
      date:
        (dateEl && (dateEl.getAttribute && dateEl.getAttribute('datetime'))) ||
        (dateEl?.textContent || ''),
      link: linkEl?.getAttribute('href') || '',
      image: imgEl?.getAttribute('src') || imgEl?.getAttribute('data-src') || '',
      price: priceEl?.textContent || '',
    };
  });
}

async function runScraper(browser, cfg) {
  const source_name = cfg.id || cfg.name;
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();
  try {
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (cfg.waitFor) {
      // Wait for the JS-rendered content, but don't fail the whole scrape if the
      // condition times out — the markup may already be present.
      await page.waitForSelector(cfg.waitFor, { timeout: 12000 }).catch(() => {});
    }

    const raw = await page.evaluate(extractInPage, cfg.selectors);

    const events = raw
      .map((r) => {
        const title = clean(r.name);
        const date = toISODate(r.date);
        if (!title || !date) return null;
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
      return {
        source: 'scrape',
        source_name,
        status: 'error',
        error_msg: `No items matched selector "${cfg.selectors.item}" at ${cfg.url} (possible selector drift)`,
        events: [],
      };
    }

    return { source: 'scrape', source_name, status: 'ok', events };
  } catch (err) {
    return {
      source: 'scrape',
      source_name,
      status: 'error',
      error_msg: `${cfg.url} — ${err.message}`,
      events: [],
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function run() {
  const scrapers = readScrapers().filter((s) => s.enabled !== false);
  if (scrapers.length === 0) return { runs: [] };

  let browser;
  try {
    browser = await chromium.launch({ headless: HEADLESS });
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

  const runs = [];
  try {
    for (const cfg of scrapers) {
      runs.push(await runScraper(browser, cfg));
      await sleep(REQUEST_DELAY_MS);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { runs };
}
