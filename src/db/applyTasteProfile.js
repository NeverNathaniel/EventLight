// One-off taste-profile import (derived from Spotify; see taste-profile.json).
// Applied idempotently on startup: genres become Layer-1 manual weights,
// favorite artists become Layer-2 behavioral signals (repeated by weight).
// Guarded by the 'taste_profile_applied' setting and keyed to generated_at, so
// it runs once — bump generated_at in the JSON to re-import.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';
import { setManualGenre, recordSignals, getSetting, setSetting } from './queries.js';

const TASTE_PATH = path.join(ROOT_DIR, 'taste-profile.json');
const FLAG = 'taste_profile_applied';

export function readTasteProfile() {
  try {
    return JSON.parse(fs.readFileSync(TASTE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function applyTasteProfile() {
  const profile = readTasteProfile();
  if (!profile) return { applied: false, reason: 'no taste-profile.json' };

  const stamp = profile.generated_at || 'v1';
  if (getSetting(FLAG) === stamp) {
    return { applied: false, reason: 'already applied', stamp };
  }

  // Layer 1 — manual genre weights.
  for (const g of profile.genres || []) {
    if (g.genre) setManualGenre(g.genre, g.weight ?? 3);
  }

  // Layer 2 — favorite-artist signals, recorded `weight` times so heavier
  // artists carry a stronger behavioral boost.
  const tags = [];
  for (const a of profile.artists || []) {
    const n = Math.max(1, parseInt(a.weight, 10) || 1);
    for (let i = 0; i < n; i += 1) tags.push(a.name);
  }
  if (tags.length) recordSignals(tags);

  setSetting(FLAG, stamp);
  return {
    applied: true,
    stamp,
    genres: (profile.genres || []).length,
    artists: (profile.artists || []).length,
  };
}
