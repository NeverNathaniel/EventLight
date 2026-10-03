// MusicBrainz artist lookup: name → { name, mbid, tags }.
// Free and keyless, but limited to ~1 request/second per client and requires a
// descriptive User-Agent. Tags are community-voted ("post-hardcore", "emo",
// "indie rock"…), which is exactly what the genre weights match against.
import axios from 'axios';
import { USER_AGENT } from '../config.js';
import { artistKey } from '../lineup.js';

const SEARCH_URL = 'https://musicbrainz.org/ws/2/artist';

// Tags that describe where/what an artist is rather than how they sound.
const NON_GENRE_TAG_RE = new RegExp(
  [
    '^(?:seen live|band|favorites?|favourites?|awesome|(?:male|female) vocal(?:ist)?s?|vocalist|singer|composer|producer|songwriter|multiple ipi|instrumentalist|guitarist|rapper|dj|group|duo|trio|usa|us|uk|ussr|american|lgbtq?\\w*|queer|trans)$',
    '^\\d0s$',
    '^\\d{4}s?$',
    '\\b(?:american|british|english|canadian|australian|irish|scottish|welsh|swedish|norwegian|danish|finnish|german|french|dutch|belgian|italian|spanish|japanese|korean|chinese|mexican|brazilian|argentinian|new zealand|united states|england|canada|seattle|portland|washington|california|new york|chicago|los angeles|london|tacoma|olympia|texas|brooklyn|nashville|austin|philadelphia|boston|detroit|atlanta|toronto|montreal|vancouver)\\b',
  ].join('|'),
  'i'
);

// Keep the voted genre-ish tags, strongest first.
export function cleanTags(tags, name) {
  const own = artistKey(name);
  return (tags || [])
    .filter((t) => t && t.name && (t.count ?? 1) > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .map((t) => String(t.name).toLowerCase().trim())
    .filter((t) => t && t.length <= 40 && !NON_GENRE_TAG_RE.test(t) && artistKey(t) !== own)
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, 8);
}

function tagVotes(c) {
  return (c.tags || []).reduce((n, t) => n + Math.max(0, t.count ?? 0), 0);
}

// Pick the search result that is really this artist: the normalised name (or
// an alias) must match exactly. Several same-named artists ("Movements" exists
// in the US, Sweden and Germany) are disambiguated by tag votes — a decent
// proxy for "the one that tours".
export function pickArtist(name, candidates) {
  const key = artistKey(name);
  const exact = (candidates || []).filter((c) => {
    if (artistKey(c.name) === key) return true;
    return (c.aliases || []).some((a) => artistKey(a.name) === key);
  });
  if (!exact.length) return null;
  exact.sort((a, b) => tagVotes(b) - tagVotes(a) || (b.score ?? 0) - (a.score ?? 0));
  const best = exact[0];
  return { name: best.name, mbid: best.id, tags: cleanTags(best.tags, best.name) };
}

// Look an artist up by name. Returns { name, mbid, tags } or null if MusicBrainz
// has no artist by that exact name. Network/HTTP errors throw.
export async function lookupArtist(name) {
  const phrase = String(name).replace(/[\\"]/g, '\\$&');
  const res = await axios.get(SEARCH_URL, {
    params: { query: `artist:"${phrase}" OR alias:"${phrase}"`, fmt: 'json', limit: 8 },
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    timeout: 15000,
  });
  return pickArtist(name, res.data?.artists || []);
}
