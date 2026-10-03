// ListenBrainz similar-artist lookup (keyless "labs" API). Similarity is
// derived from real listening sessions — for PUP it returns Jeff Rosenstock,
// Joyce Manor, Modern Baseball, Sorority Noise, The Menzingers… exactly the
// kind of bands that come through small Seattle rooms.
import axios from 'axios';
import { USER_AGENT } from '../config.js';
import { artistKey } from '../lineup.js';

const SIMILAR_URL = 'https://labs.api.listenbrainz.org/similar-artists/json';
const ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

// Keep artists at least this similar relative to the seed's closest match.
const MIN_RELATIVE_SCORE = 0.2;
const MAX_RESULTS = 80;

// Normalise a raw response into [{ key, name, score }] with score in 0..1.
// The labs endpoint has returned both a bare array and a [{ data: [...] }]
// dataset wrapper over time — accept either.
export function normalizeSimilar(body) {
  let rows = Array.isArray(body) ? body : [];
  if (rows.length && Array.isArray(rows[0]?.data)) rows = rows.flatMap((d) => d.data);
  rows = rows.filter((r) => r && r.name && Number(r.score) > 0);
  const max = Math.max(0, ...rows.map((r) => Number(r.score)));
  if (!max) return [];
  const out = [];
  const seen = new Set();
  for (const r of rows.sort((a, b) => b.score - a.score)) {
    const score = Number(r.score) / max;
    const key = artistKey(r.name);
    if (score < MIN_RELATIVE_SCORE || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name: r.name, score: Math.round(score * 1000) / 1000 });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

export async function similarArtists(mbid) {
  const res = await axios.get(SIMILAR_URL, {
    params: { artist_mbids: mbid, algorithm: ALGORITHM },
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    timeout: 30000,
  });
  return normalizeSimilar(res.data);
}
