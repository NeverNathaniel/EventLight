// Read/write helpers for feeds.json and scrapers.json so the Settings UI can
// manage sources without touching code.
import fs from 'node:fs';
import { FEEDS_PATH, SCRAPERS_PATH } from './config.js';

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function readFeeds() {
  const data = readJson(FEEDS_PATH, { feeds: [] });
  return Array.isArray(data.feeds) ? data.feeds : [];
}

export function writeFeeds(feeds) {
  writeJson(FEEDS_PATH, { feeds });
}

export function readScrapers() {
  const data = readJson(SCRAPERS_PATH, { scrapers: [] });
  return Array.isArray(data.scrapers) ? data.scrapers : [];
}

export function writeScrapers(scrapers) {
  writeJson(SCRAPERS_PATH, { scrapers });
}
