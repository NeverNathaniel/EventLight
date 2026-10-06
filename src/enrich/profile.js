// Artist profiles for the artist sheet: a photo and a short bio, where they're
// from and since when, links (Apple Music, Spotify, Bandcamp, their website),
// similar artists, and top songs with 30-second previews you can play in the
// app. Looked up the first time someone opens an artist, from free, keyless
// sources, and cached in artist_profiles:
//
//   MusicBrainz   type, hometown, year formed, links — including their Apple
//                 Music id, which picks the right artist when names collide
//   Wikipedia     a one-paragraph bio and a photo, through the Wikidata link,
//                 or by name for acts MusicBrainz doesn't link (comedians)
//   Apple         their Apple Music page and top songs with previews (the
//                 iTunes Search API; previews are Apple's own 30-second clips)
//   ListenBrainz  similar artists, when we don't have their list already
//
// The week's headliners are also looked up in the background after each
// refresh (src/enrich/prefetch.js). Every call goes through the shared rate
// limits in src/enrich/limits.js, where a sheet someone is waiting on goes
// first.
import axios from 'axios';
import { USER_AGENT, sleep } from '../config.js';
import { artistKey } from '../lineup.js';
import { safeHttpUrl } from '../adapters/util.js';
import { lookupArtist } from './musicbrainz.js';
import { similarArtists } from './listenbrainz.js';
import { mbTurn, wikiTurn, itunesTurn, foreground, promote } from './limits.js';
import { getArtist, getArtistProfile, saveArtistProfile, getSimilarFor } from '../db/artists.js';
import { describesPerformer } from '../feel.js';

const MB_URL = 'https://musicbrainz.org/ws/2/artist';
const ITUNES_URL = 'https://itunes.apple.com';
const WIKI_SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const MAX_SONGS = 5;
const MAX_SIMILAR = 8;

// "https://music.apple.com/us/artist/pup/722031743", "…/artist/id722031743".
const APPLE_ARTIST_RE = /(?:music|itunes)\.apple\.com\/(?:[a-z]{2}\/)?artist\/(?:[^/?#]+\/)?(?:id)?(\d+)/i;

// ── Parsers (pure) ──────────────────────────────────────────────────────────

// A MusicBrainz artist (with url-rels) → the facts and links we show.
export function parseMusicBrainz(a) {
  if (!a || !a.id) return null;
  const rels = (a.relations || []).filter((r) => r.url?.resource);
  const link = (test) => safeHttpUrl(rels.find(test)?.url.resource) || null;
  const byType = (type) => link((r) => r.type === type);
  const byHost = (re) => link((r) => re.test(r.url.resource));

  const apple = rels.map((r) => r.url.resource.match(APPLE_ARTIST_RE)).find(Boolean);
  const wikidata = rels.find((r) => r.type === 'wikidata')?.url.resource.match(/Q\d+/);
  const wikipedia = rels.find((r) => r.type === 'wikipedia' && /\/\/en\.wikipedia\.org\/wiki\//.test(r.url.resource));

  // "Toronto, Canada" when the band started in a city of a wider area.
  const begin = a['begin-area']?.name || null;
  const area = a.area?.name || null;
  const from = begin && area && begin !== area ? `${begin}, ${area}` : begin || area;
  const life = a['life-span'] || {};

  return {
    mbid: a.id,
    name: a.name,
    type: a.type || null,
    from,
    since: life.begin ? String(life.begin).slice(0, 4) : null,
    until: life.ended ? (life.end ? String(life.end).slice(0, 4) : 'ended') : null,
    description: a.disambiguation || null,
    appleId: apple ? apple[1] : null,
    wikidataId: wikidata ? wikidata[0] : null,
    wikipediaTitle: wikipedia ? decodeURIComponent(wikipedia.url.resource.split('/wiki/')[1]).replace(/_/g, ' ') : null,
    links: {
      website: byType('official homepage'),
      bandcamp: byType('bandcamp'),
      spotify: byHost(/^https:\/\/open\.spotify\.com\/artist\//),
      youtube: byType('youtube'),
    },
  };
}

// A Wikipedia page summary → bio and photo. Disambiguation pages don't count.
export function parseWikiSummary(d) {
  if (!d || d.type !== 'standard' || !d.extract) return null;
  return {
    bio: d.extract,
    description: d.description || null,
    image: safeHttpUrl(d.thumbnail?.source) || null,
    url: safeHttpUrl(d.content_urls?.desktop?.page) || null,
  };
}

// Apple's artist for this name: the id MusicBrainz links to when there is
// one, else the first result whose name matches exactly (Apple ranks the
// better-known artist first when names collide).
export function pickAppleArtist(name, results, appleId = null) {
  const artists = (results || []).filter((r) => r.wrapperType === 'artist' && r.artistId);
  if (appleId) {
    const hit = artists.find((r) => String(r.artistId) === String(appleId));
    if (hit) return hit;
  }
  const key = artistKey(name);
  return artists.find((r) => artistKey(r.artistName) === key) || null;
}

const cleanAppleUrl = (url) => (safeHttpUrl(url) || '').replace(/[?&]uo=\d+$/, '') || null;

// Song search results → this artist's top songs, most popular first, one per
// title, each with a preview to play.
export function topSongs(results, artistId, limit = MAX_SONGS) {
  const seen = new Set();
  const out = [];
  for (const r of results || []) {
    if (r.wrapperType !== 'track' || r.kind !== 'song' || String(r.artistId) !== String(artistId)) continue;
    const preview = safeHttpUrl(r.previewUrl);
    const key = artistKey(r.trackName);
    if (!preview || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: r.trackName,
      album: r.collectionName || null,
      year: r.releaseDate ? String(r.releaseDate).slice(0, 4) : null,
      preview,
      url: cleanAppleUrl(r.trackViewUrl),
      artwork: safeHttpUrl(String(r.artworkUrl100 || '').replace('100x100bb', '300x300bb')) || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Fetchers (network) ──────────────────────────────────────────────────────
// GET JSON, after waiting for the service's turn (limits.js). A missing page
// (404) is no data, not a failure. A hiccup (a timeout, a 5xx, or rate
// limiting — Wikimedia sends 429s in bursts) gets one quick retry; anything
// still missing is re-checked within the hour (see the "partial" status
// below), so nobody waits long on the sheet. In the background a 429 isn't
// retried: the prefetch's circuit breaker backs off for the whole run instead.
async function getJSON(url, params, { turn, job } = {}, attempt = 0) {
  if (turn) await turn(job);
  try {
    const res = await axios.get(url, {
      params,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeout: 10000,
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return null;
    if (attempt >= 1 || (status && status < 500 && status !== 429)) throw err;
    if (status === 429 && job?.background) throw err;
    const asked = Number(err.response?.headers?.['retry-after']) * 1000;
    await sleep(Math.min(2000, asked || 1000));
    return getJSON(url, params, { turn, job }, attempt + 1);
  }
}

// Every fetcher takes the lookup's `job` ({ background, hint }) last: the
// turns read job.background to know whether to hold back for the sheet.
const via = (turn, job) => ({ turn, job });

async function fetchMusicBrainz(name, mbid, job = {}) {
  let id = mbid;
  if (!id) {
    await mbTurn(job);
    const found = await lookupArtist(name);
    if (!found) return null;
    id = found.mbid;
  }
  return parseMusicBrainz(
    await getJSON(`${MB_URL}/${encodeURIComponent(id)}`, { inc: 'url-rels', fmt: 'json' }, via(mbTurn, job))
  );
}

// Wikipedia by name, for a comedian MusicBrainz doesn't know or doesn't
// link: "Name", then "Name (comedian)". Only a standard article whose short
// description reads like a comedian's counts — the same guard the row's
// descriptor uses (src/feel.js), so the sheet and the row agree — so
// "Hannibal Buress" gets "American stand-up comedian", and a namesake (a
// singer-songwriter, a comic book artist, a film producer, a footballer) is
// passed over for "Name (comedian)". Bands aren't looked up this way: a band
// MusicBrainz doesn't know is usually a local act, and a Wikipedia page under
// its name is more likely another band's. `summary` fetches one page's
// summary.
export async function wikipediaByName(name, hint, summary) {
  const base = String(name || '').trim();
  if (!base || hint !== 'comedy') return null;
  for (const title of [base, `${base} (comedian)`]) {
    const page = parseWikiSummary(await summary(title));
    if (page && describesPerformer(page.description, 'comedy')) return page;
  }
  return null;
}

// Whether fetchWikipedia would ask Wikimedia anything for this act: with a
// page or Wikidata id MusicBrainz links, or by name for a comedian. The
// prefetch's breaker reads it too, so pausing Wikipedia doesn't mark a
// profile that never needed it as failing it.
export function wikipediaWouldAsk(mb, name, hint) {
  return Boolean(mb?.wikipediaTitle || mb?.wikidataId || (hint === 'comedy' && String(mb?.name || name || '').trim()));
}

async function fetchWikipedia(mb, name, job = {}) {
  if (!wikipediaWouldAsk(mb, name, job.hint)) return null;
  const summary = (title) =>
    getJSON(`${WIKI_SUMMARY_URL}/${encodeURIComponent(title.replace(/ /g, '_'))}`, null, via(wikiTurn, job));
  let title = mb?.wikipediaTitle;
  if (!title && mb?.wikidataId) {
    const d = await getJSON('https://www.wikidata.org/w/api.php', {
      action: 'wbgetentities', ids: mb.wikidataId, props: 'sitelinks', sitefilter: 'enwiki', format: 'json',
    }, via(wikiTurn, job));
    title = d?.entities?.[mb.wikidataId]?.sitelinks?.enwiki?.title;
    // Linked, but with no English article: a page found by name would be
    // about somebody else.
    if (!title) return null;
  }
  if (title) return parseWikiSummary(await summary(title));
  return wikipediaByName(mb?.name || name, job.hint, summary);
}

// The Apple artist MusicBrainz links to, looked up by id.
async function appleById(name, appleId, itunes) {
  const linked = pickAppleArtist(name, (await getJSON(`${ITUNES_URL}/lookup`, { id: appleId, country: 'US' }, itunes))?.results, appleId);
  return linked && String(linked.artistId) === String(appleId) ? linked : null;
}

async function fetchApple(name, appleId, job = {}) {
  const itunes = via(itunesTurn, job);
  const found = await getJSON(`${ITUNES_URL}/search`, { term: name, entity: 'musicArtist', limit: 10, country: 'US' }, itunes);
  let artist = pickAppleArtist(name, found?.results, appleId);
  // "mb": the artist MusicBrainz links to, so surely them. "name": the first
  // exact name match, which can be a namesake — rows only play its songs
  // when the name is distinctive enough (src/feel.js). "conflict": a name
  // match MusicBrainz's link says is someone else, kept for the sheet but
  // never played or trusted on a row.
  let match = 'name';
  if (appleId && String(artist?.artistId) === String(appleId)) match = 'mb';
  else if (appleId) {
    // The search left the linked artist out (it only ranks the top ten), so
    // ask for them by id rather than settle for a same-name stranger.
    const linked = await appleById(name, appleId, itunes);
    if (linked) [artist, match] = [linked, 'mb'];
    else if (artist) match = 'conflict';
  }
  if (!artist) return null;
  // The song search ranks by popularity; looking up by artist id doesn't, so
  // it's only a fallback for artists the search barely knows.
  const search = await getJSON(`${ITUNES_URL}/search`, {
    term: artist.artistName, entity: 'song', attribute: 'artistTerm', limit: 50, country: 'US',
  }, itunes);
  let songs = topSongs(search?.results, artist.artistId);
  if (songs.length < 3) {
    const more = await getJSON(`${ITUNES_URL}/lookup`, { id: artist.artistId, entity: 'song', limit: 25, country: 'US' }, itunes);
    songs = topSongs([...(search?.results || []), ...(more?.results || [])], artist.artistId);
  }
  return { url: cleanAppleUrl(artist.artistLinkUrl), genre: artist.primaryGenreName || null, match, songs };
}

async function fetchSimilar(key, mbid) {
  const known = getSimilarFor(key, MAX_SIMILAR);
  if (known.length) return known.map((r) => r.name);
  if (!mbid) return [];
  return (await similarArtists(mbid)).slice(0, MAX_SIMILAR).map((r) => r.name);
}

export const SOURCES = { musicbrainz: fetchMusicBrainz, wikipedia: fetchWikipedia, apple: fetchApple, similar: fetchSimilar };

// ── Assembly + cache ────────────────────────────────────────────────────────
async function buildProfile(name, key, sources, job) {
  const failed = [];
  let mb = null;
  try {
    mb = await sources.musicbrainz(name, getArtist(key)?.mbid || null, job);
  } catch {
    failed.push('MusicBrainz');
  }
  // Wikipedia is asked even when MusicBrainz found nothing: comedians are
  // mostly found there by name.
  const [wiki, apple, similar] = await Promise.allSettled([
    sources.wikipedia(mb, name, job),
    sources.apple(mb?.name || name, mb?.appleId || null, job),
    sources.similar(key, mb?.mbid || null, job),
  ]);
  if (wiki.status === 'rejected') failed.push('Wikipedia');
  if (apple.status === 'rejected') failed.push('Apple Music');
  const w = wiki.value || null;
  const a = apple.value || null;
  // Album art stands in for a photo, but not a namesake's: when MusicBrainz
  // links a different Apple artist ('conflict'), it's likely someone else's.
  const artwork = a?.match === 'conflict' ? null : a?.songs?.[0]?.artwork;

  const data = {
    name: mb?.name || name,
    type: mb?.type || null,
    from: mb?.from || null,
    since: mb?.since || null,
    until: mb?.until || null,
    description: w?.description || mb?.description || null,
    bio: w?.bio || null,
    image: w?.image || artwork || null,
    wikipedia_url: w?.url || null,
    apple: a,
    links: mb?.links || {},
    similar: similar.value || [],
    failed,
  };
  // "partial": found, but a source failed, so it's re-checked within the hour.
  const found = Boolean(mb || w || a);
  const status = found ? (failed.length ? 'partial' : 'found') : failed.length ? 'error' : 'not_found';
  // A re-check that fails, wholly or in part, never wipes what we had: gaps
  // are filled from the previous profile.
  const previous = getArtistProfile(key);
  if (previous && (previous.status === 'found' || previous.status === 'partial') && status !== 'found') {
    const { key: _k, status: _s, fresh: _f, fetched_at: _t, ...kept } = previous;
    const merged = { ...kept };
    for (const [field, value] of Object.entries(data)) {
      const empty = value == null || (Array.isArray(value) && !value.length);
      if (!empty) merged[field] = value;
    }
    saveArtistProfile(key, name, 'partial', merged);
  } else {
    saveArtistProfile(key, name, status, data);
  }
  return getArtistProfile(key);
}

// Lookups in progress: key → { job, promise }.
const inflight = new Map();

// The profile for an artist: from the cache while it's fresh, else looked up
// (once, however many requests ask at the same moment).
//   hint        'comedy' when the name comes from a comedy show, so a comedian
//               MusicBrainz doesn't know is looked for as "Name (comedian)"
//   background  true for the prefetch: it holds back while anyone is waiting
//               on a sheet. Everything else (the sheet's route) is foreground.
export async function artistProfile(name, { sources = SOURCES, force = false, hint = null, background = false } = {}) {
  const key = artistKey(name);
  if (!key) return null;
  const cached = getArtistProfile(key);
  if (cached?.fresh && !force) return cached;
  const running = inflight.get(key);
  if (running) {
    // Someone opened the artist the prefetch is fetching right now: that
    // lookup stops holding back, since someone is waiting on it.
    if (!background && running.job.background) {
      return foreground(() => {
        promote(running.job);
        return running.promise;
      });
    }
    return running.promise;
  }
  const job = { background: Boolean(background), hint: hint || null };
  const build = () => buildProfile(String(name).trim(), key, sources, job);
  const promise = (job.background ? build() : foreground(build)).finally(() => inflight.delete(key));
  inflight.set(key, { job, promise });
  return promise;
}
