// Film facts from Wikidata, looked up by TMDB id (which the theater supplies):
// genres ("children's film", "superhero film"…), the franchise/series a film
// belongs to, and Rotten Tomatoes / Metacritic scores. Free and keyless;
// one SPARQL query covers a whole batch of films.
import axios from 'axios';
import { USER_AGENT } from '../config.js';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const ROTTEN_TOMATOES = 'Q105584';
const METACRITIC = 'Q150248';

function sparql(tmdbIds) {
  const values = tmdbIds.map((id) => `"${String(id).replace(/[^0-9]/g, '')}"`).join(' ');
  return `SELECT ?tmdb
    (GROUP_CONCAT(DISTINCT ?genreLabel; separator="|") AS ?genres)
    (GROUP_CONCAT(DISTINCT ?seriesLabel; separator="|") AS ?series)
    (GROUP_CONCAT(DISTINCT ?rt; separator="|") AS ?rts)
    (GROUP_CONCAT(DISTINCT ?mc; separator="|") AS ?mcs)
  WHERE {
    VALUES ?tmdb { ${values} }
    ?film wdt:P4947 ?tmdb .
    OPTIONAL { ?film wdt:P136 ?genre . ?genre rdfs:label ?genreLabel . FILTER(LANG(?genreLabel) = "en") }
    OPTIONAL { ?film wdt:P179 ?s . ?s rdfs:label ?seriesLabel . FILTER(LANG(?seriesLabel) = "en") }
    OPTIONAL { ?film p:P444 ?r1 . ?r1 ps:P444 ?rt ; pq:P447 wd:${ROTTEN_TOMATOES} . }
    OPTIONAL { ?film p:P444 ?r2 . ?r2 ps:P444 ?mc ; pq:P447 wd:${METACRITIC} . }
  } GROUP BY ?tmdb`;
}

// "94%" → 94; "85/100" → 85; averages like "5.7/10" are ignored. When
// Wikidata holds several snapshots of a score, the highest is used.
export function parseScore(list, kind) {
  const values = String(list || '')
    .split('|')
    .map((v) => {
      const m = kind === 'rt' ? v.match(/^(\d{1,3})\s*%$/) : v.match(/^(\d{1,3})\s*\/\s*100$/);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter((n) => n != null && n <= 100);
  return values.length ? Math.max(...values) : null;
}

export function parseBindings(bindings) {
  const out = new Map();
  for (const b of bindings || []) {
    const tmdb = b.tmdb?.value;
    if (!tmdb) continue;
    out.set(tmdb, {
      genres: (b.genres?.value || '').split('|').map((g) => g.trim()).filter(Boolean),
      series: (b.series?.value || '').split('|').filter(Boolean)[0] || null,
      rt: parseScore(b.rts?.value, 'rt'),
      mc: parseScore(b.mcs?.value, 'mc'),
    });
  }
  return out;
}

// Map tmdbId → facts. Films Wikidata doesn't know are simply absent.
export async function lookupFilms(tmdbIds) {
  const ids = [...new Set(tmdbIds.filter(Boolean).map(String))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const res = await axios.post(ENDPOINT, new URLSearchParams({ query: sparql(ids.slice(i, i + 50)) }), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' },
      timeout: 30000,
    });
    for (const [k, v] of parseBindings(res.data?.results?.bindings)) out.set(k, v);
  }
  return out;
}
