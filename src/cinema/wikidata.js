// Film facts from Wikidata, looked up by TMDB id (which the theater supplies):
// genres ("children's film", "superhero film"…), the franchise/series a film
// belongs to, Rotten Tomatoes / Metacritic scores, and the crew (directors,
// writers, composers, cinematographers) your film taste is matched against.
// Free and keyless; two SPARQL queries cover a whole batch of films.
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

// The crew, one row per (film, role, person). Roles are a UNION-like VALUES
// list rather than OPTIONAL joins, so a film's rows don't multiply.
export const CREW_ROLES = { P57: 'director', P58: 'writer', P86: 'composer', P344: 'cinematographer' };
function crewSparql(tmdbIds) {
  const values = tmdbIds.map((id) => `"${String(id).replace(/[^0-9]/g, '')}"`).join(' ');
  const roles = Object.entries(CREW_ROLES).map(([p, role]) => `(wdt:${p} "${role}")`).join(' ');
  return `SELECT ?tmdb ?role ?name WHERE {
    VALUES ?tmdb { ${values} }
    VALUES (?prop ?role) { ${roles} }
    ?film wdt:P4947 ?tmdb ; ?prop ?person .
    ?person rdfs:label ?name . FILTER(LANG(?name) = "en")
  }`;
}

// Map tmdbId → { director: [], writer: [], composer: [], cinematographer: [] }.
export function parseCrew(bindings) {
  const out = new Map();
  for (const b of bindings || []) {
    const tmdb = b.tmdb?.value;
    const role = b.role?.value;
    const name = b.name?.value?.trim();
    if (!tmdb || !Object.values(CREW_ROLES).includes(role) || !name) continue;
    if (!out.has(tmdb)) out.set(tmdb, {});
    const crew = out.get(tmdb);
    crew[role] = [...new Set([...(crew[role] || []), name])];
  }
  return out;
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

async function query(text) {
  const res = await axios.post(ENDPOINT, new URLSearchParams({ query: text }), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' },
    timeout: 30000,
  });
  return res.data?.results?.bindings;
}

// Map tmdbId → facts (with `crew`). Films Wikidata doesn't know are simply
// absent. The crew is best-effort: if its query fails, `crew` is null (and
// asked again on the next refresh) rather than costing the filters their facts.
export async function lookupFilms(tmdbIds) {
  const ids = [...new Set(tmdbIds.filter(Boolean).map(String))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const facts = parseBindings(await query(sparql(batch)));
    let crew = null;
    try {
      crew = parseCrew(await query(crewSparql(batch)));
    } catch (err) {
      console.warn('[cinema] Wikidata crew lookup failed:', err.message);
    }
    for (const [k, v] of facts) out.set(k, { ...v, crew: crew ? crew.get(k) || {} : null });
  }
  return out;
}
