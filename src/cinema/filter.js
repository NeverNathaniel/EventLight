// Which films to leave out of the Movies tab: kids' movies and vapid action
// movies. Every decision carries a reason, and filtered films stay one click
// away in the UI, so a wrong call is visible rather than silent.
//
// Kids' movie — any of:
//   - rated G, if released since 1990 (older G films include 2001: A Space
//     Odyssey; since then G has meant children's films)
//   - the theater files it under Family / Kids / Children
//   - Wikidata calls it a children's or family film (unless it's rated R/NC-17)
//   - animated and rated PG (animated PG-13/R films stay)
//   - a kids' program by name ("Shorts4Shorties", "Free Family Flick", "Cereal Cinema"…)
//
// Vapid action movie — an action / superhero / martial-arts film that isn't
// critically acclaimed:
//   - superhero films need Metacritic ≥ 80 (The Dark Knight passes; most of
//     the MCU doesn't)
//   - other franchise films need Metacritic ≥ 75 or RT ≥ 90 (Terminator 2,
//     Mad Max: Fury Road pass; Fast X doesn't)
//   - other action films need Metacritic ≥ 65 or RT ≥ 80
// With no scores on record (restorations, new imports) only superhero films
// are filtered.

// Program names, not words that merely appear in film titles: "The Kid",
// "Children of Men" and "The Children's Hour" must not match.
const KIDS_PROGRAM_RE =
  /\b(?:shorts\s*4\s*shorties|kids['’]?\s+(?:film|movie|matinee|series|club|day|fest(?:ival)?|shorts|camp)|children['’]s\s+(?:film|program|series|matinee)|family\s+(?:flick|film|matinee|day|series|fun)|cereal\s+cinema|toddlers?|storytime|sensory[\s-]friendly)\b/i;
const KIDS_GENRE_RE = /^(?:family|kids|children(?:['’]s)?)$/i;
const KIDS_WIKIDATA_RE = /^(?:children['’]s\b.*\bfilm|family film)$/i;
const ACTION_RE = /\b(?:action|superhero|martial arts|disaster|kaiju)\b/i;
const SUPERHERO_RE = /\bsuperhero\b/i;

export const ACCLAIM = {
  superheroMetacritic: 80,
  superheroRottenTomatoes: 95, // only used when there's no Metacritic score
  franchiseMetacritic: 75,
  franchiseRottenTomatoes: 90,
  metacritic: 65,
  rottenTomatoes: 80,
};
const MODERN_G_YEAR = 1990;

function list(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function scoreText(m) {
  const parts = [];
  if (m.mc_score != null) parts.push(`Metacritic ${m.mc_score}`);
  if (m.rt_score != null) parts.push(`RT ${m.rt_score}%`);
  return parts.join(', ');
}

// Returns { hidden, kind: 'kids' | 'action' | null, reason }.
export function classifyMovie(m) {
  const rating = String(m.rating || '').toUpperCase().trim();
  const genre = String(m.genre || '');
  const wd = list(m.wd_genres);
  const adultRated = rating === 'R' || rating === 'NC-17';

  // ── Kids ──────────────────────────────────────────────────────────────
  const kids = (reason) => ({ hidden: true, kind: 'kids', reason });
  const year = parseInt(String(m.release_date || '').slice(0, 4), 10);
  if (rating === 'G' && !(year < MODERN_G_YEAR)) return kids('Rated G');
  if (KIDS_GENRE_RE.test(genre.trim())) return kids(`Family film (${genre})`);
  if (!adultRated) {
    if (KIDS_PROGRAM_RE.test(m.title || '')) return kids("Kids' program");
    const tag = wd.find((g) => KIDS_WIKIDATA_RE.test(g));
    if (tag) return kids(`Wikidata: ${tag}`);
  }
  if (/animation|animated/i.test(`${genre} ${wd.join(' ')}`) && rating === 'PG') {
    return kids('Animated, rated PG');
  }

  // ── Vapid action ─────────────────────────────────────────────────────
  const actionTags = [genre, ...wd].filter((g) => ACTION_RE.test(g));
  if (actionTags.length) {
    const superhero = actionTags.some((g) => SUPERHERO_RE.test(g));
    const franchise = Boolean(m.wd_series);
    const mc = m.mc_score;
    const rt = m.rt_score;
    const atLeast = (score, bar) => score != null && score >= bar;
    const acclaimed = superhero
      ? mc != null ? mc >= ACCLAIM.superheroMetacritic : atLeast(rt, ACCLAIM.superheroRottenTomatoes)
      : franchise
        ? atLeast(mc, ACCLAIM.franchiseMetacritic) || atLeast(rt, ACCLAIM.franchiseRottenTomatoes)
        : atLeast(mc, ACCLAIM.metacritic) || atLeast(rt, ACCLAIM.rottenTomatoes);
    const unscored = mc == null && rt == null;
    if (!acclaimed && (superhero || !unscored)) {
      const what = superhero ? 'Superhero movie' : franchise ? `Franchise action (${m.wd_series})` : 'Action movie';
      const scores = scoreText(m);
      return { hidden: true, kind: 'action', reason: scores ? `${what} · ${scores}` : what };
    }
  }

  return { hidden: false, kind: null, reason: null };
}
