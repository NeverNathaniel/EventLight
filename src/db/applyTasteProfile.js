// Taste-profile import (see taste-profile.json). Applied idempotently on
// startup: genres become genre weights and artists become favorite artists
// (which never decay, unlike behavioral signals). Each half has its own
// version stamp, so editing the artist list doesn't reset genre weights
// you've tuned in Settings:
//   generated_at        → re-applies the genre weights when changed
//   artists_updated_at  → re-applies the artist list when changed (falls back
//                         to generated_at)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';
import db from './index.js';
import { setManualGenre, getSetting, setSetting } from './queries.js';
import { setFavoriteArtist } from './artists.js';

const TASTE_PATH = path.join(ROOT_DIR, 'taste-profile.json');
const FLAG = 'taste_profile_applied';
const FAVORITES_FLAG = 'taste_profile_favorites';

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
  const artistsStamp = profile.artists_updated_at || stamp;
  // Favorites have their own flag so installs that imported the profile
  // before favorite artists existed still pick them up once.
  const favoritesApplied = getSetting(FAVORITES_FLAG) === artistsStamp;
  if (getSetting(FLAG) === stamp && favoritesApplied) {
    return { applied: false, reason: 'already applied', stamp };
  }

  // Layer 1 — manual genre weights.
  if (getSetting(FLAG) !== stamp) {
    for (const g of profile.genres || []) {
      if (g.genre) setManualGenre(g.genre, g.weight ?? 3);
    }
    setSetting(FLAG, stamp);
  }

  // Favorite artists. Earlier versions stored these as decaying behavioral
  // signals (which faded to almost nothing within a few months) — clear those.
  if (!favoritesApplied) {
    const clearSignal = db.prepare('DELETE FROM preferences WHERE tag = ?');
    for (const a of profile.artists || []) {
      if (!a.name) continue;
      setFavoriteArtist(a.name, a.weight ?? 3, a.source || profile.source || 'profile');
      clearSignal.run(String(a.name).trim().toLowerCase());
    }
    setSetting(FAVORITES_FLAG, artistsStamp);
  }

  return {
    applied: true,
    stamp,
    genres: (profile.genres || []).length,
    artists: (profile.artists || []).length,
  };
}
