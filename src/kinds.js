// What a listing is: a kind for every show (Music, Stand-up, Drag, Trivia…),
// a few flags worth seeing in a list (Sold out, Free…), and the key that ties
// a recurring night's dates together.
//
// Sources only tell us music | comedy | other, and "other" covers everything
// from Hamlet to karaoke, so the finer kinds are read from the title and the
// source's own tags. Rules run in order and the first match wins. Band names
// are the hazard ("Bingo Players", "Film School", "Pearl Jam"), so:
//   - when the headliner is an artist MusicBrainz knows, their name is taken
//     out of the title before the rules run, and a known act is Music;
//   - "jam" only counts with a qualifier ("jazz jam", "jam session");
//   - every rule matches whole words.
import { artistKey, isTribute } from './lineup.js';

// family: how the day page groups a kind (see groupOf).
export const KINDS = {
  music: { label: 'Music', family: 'music' },
  classical: { label: 'Classical', family: 'music' },
  festival: { label: 'Festival', family: 'music' },
  tribute: { label: 'Tribute', family: 'music' },
  comedy: { label: 'Stand-up', family: 'comedy' },
  improv: { label: 'Improv', family: 'comedy' },
  podcast: { label: 'Podcast', family: 'comedy' },
  film: { label: 'Film', family: 'film' },
  screening: { label: 'Screening', family: 'film' },
  theater: { label: 'Theater', family: 'stage' },
  drag: { label: 'Drag', family: 'stage' },
  cabaret: { label: 'Cabaret', family: 'stage' },
  talk: { label: 'Talk', family: 'stage' },
  'open-mic': { label: 'Open mic', family: 'night' },
  jam: { label: 'Jam', family: 'night' },
  dj: { label: 'DJ night', family: 'night' },
  karaoke: { label: 'Karaoke', family: 'night' },
  trivia: { label: 'Trivia', family: 'night' },
  bingo: { label: 'Bingo', family: 'night' },
  dance: { label: 'Dance', family: 'night' },
  market: { label: 'Market', family: 'other' },
  class: { label: 'Class', family: 'other' },
  event: { label: 'Event', family: 'other' },
};

// Title rules, in order. Drag comes before bingo and trivia ("Drag Bingo" is
// a drag show), and screenings before talks ("Movie Night + Q&A").
const TITLE_RULES = [
  ['drag', /\bdrag (?:shows?|brunch|bingo|queens?|kings?|race|night|revue|ball|extravaganza)\b|\bdrag (?:&|and) /i],
  ['cabaret', /burles\w*|\bcabaret\b|\bvariety show\b|\bvaudeville\b|\bcircus\b|\bsideshow\b/i],
  ['karaoke', /karaoke|queeraoke/i],
  ['trivia', /\btrivia\b|\bpub quiz\b|\bquiz night\b/i],
  ['bingo', /\bbingo\b/i],
  ['open-mic', /\bopen[\s-]?mic\b|\bopen stage\b|\bsongwriter (?:night|round)\b/i],
  ['jam', /\b(?:jazz|blues|bluegrass|old[\s-]?time|irish|celtic|funk|soul|session|open|community|folk) jam\b|\bjam (?:session|night)\b/i],
  ['dj', /\bdj (?:night|set)\b|\bdjs\b|\bdance (?:party|night)\b|\bsilent disco\b|\b(?:emo|goth|darkwave|disco|80s|90s|2000s|y2k|sad girl|britpop) (?:night|dance|party)\b/i],
  ['dance', /\bsquare danc\w*|\bcontra danc\w*|\bswing danc\w*|\bsalsa\b|\bbachata\b|\bline danc\w*|\btwo[\s-]step\b|\btango\b|\bballroom\b/i],
  ['screening', /\b(?:movie night|film night|screening|double feature|cinema club|film (?:fest|festival|series))\b|\bmovie\b/i],
];
const COMEDY_RULES = [
  ['improv', /\bimprov\w*|\bsketch\b/i],
  ['podcast', /\b(?:live )?podcast\b|\blive taping\b/i],
];
const LATE_RULES = [
  ['podcast', /\b(?:live )?podcast\b|\blive taping\b/i],
  ['talk', /\blecture\b|\bauthor (?:talk|reading|event)\b|\bbook (?:launch|reading|talk|signing)\b|\bstorytell\w*|\bstory slam\b|\bhistory pub\b|\btrue crime\b|\bin conversation\b|\bpoetry\b|\bspoken word\b|\bpanel\b/i],
  ['market', /\bmarket\b|\bflea\b|\bcraft (?:fair|fest)\b|\bmakers\b|\bbazaar\b|\bbrewfest\b|\bbeer fest\w*|\bwine walk\b/i],
  ['class', /\bworkshop\b|\bclass\b|\blessons?\b|\byoga\b|\bpaint night\b/i],
];
const THEATER_TAGS = new Set(['theatre', 'theater', 'musical', 'musicals', 'ballet', 'play', 'plays', 'opera house', 'dance theatre']);
const CLASSICAL_TAGS = new Set(['classical', 'symphony', 'opera', 'chamber music', 'orchestra']);
const COMEDY_WORDS_RE = /\bcomedy\b|\bcomedian|\bstand[\s-]?up\b|\bcomics?\b/i;

function sourceTags(e) {
  return String(e.genre_tags || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function lineupOf(e) {
  if (Array.isArray(e._lineup)) return e._lineup;
  try {
    const list = JSON.parse(e.lineup || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// The title with the headliner's name taken out, so a known band's name can't
// trip a rule. Matched on normalised words, so "The Jam" and "the jam" agree.
function titleWithout(title, name) {
  const t = ` ${artistKey(title)} `;
  const n = artistKey(name);
  return n ? t.replace(` ${n} `, ' ').trim() : t.trim();
}

const make = (key, extra = {}) => ({ key, ...KINDS[key], ...extra });

// The kind of a listing: { key, label, family } (plus domain: 'comedy' for a
// comedy open mic). `headlinerFound` is true when MusicBrainz knows the act
// at the top of the bill.
export function kindOf(e, { headlinerFound = false } = {}) {
  if (e.kind === 'film') return make('film');
  const lineup = lineupOf(e);
  const title = headlinerFound && lineup[0] ? titleWithout(e.title, lineup[0]) : String(e.title || '');
  const category = e.category || 'other';
  const comedyDomain = category === 'comedy' || COMEDY_WORDS_RE.test(e.title || '');

  for (const [key, re] of TITLE_RULES) {
    if (!re.test(title)) continue;
    if (key === 'open-mic' && comedyDomain) return make(key, { domain: 'comedy' });
    return make(key);
  }
  // Every act "DJ …" and none of them known is a DJ night; DJ Shadow stays Music.
  if (!headlinerFound && lineup.length && lineup.every((n) => /^dj\s/i.test(n))) return make('dj');
  if (category === 'comedy') {
    for (const [key, re] of COMEDY_RULES) if (re.test(title)) return make(key);
    return make('comedy');
  }
  for (const [key, re] of LATE_RULES) if (re.test(title)) return make(key);
  const tags = sourceTags(e);
  if (tags.some((t) => THEATER_TAGS.has(t))) return make('theater');
  if (tags.some((t) => CLASSICAL_TAGS.has(t))) return make('classical');
  if (/\bfest(?:ival)?\b/i.test(e.title || '') && lineup.length >= 4) return make('festival');
  if (isTribute(e.title)) return make('tribute');
  if (category === 'music' || headlinerFound) return make('music');
  return make('event');
}

// Which group a listing sits in on the day page: music, comedy, film or
// around (everything else). Explore's filters use the source category the
// same way, so a show is in the same place on both.
export function groupOf(e, kind = kindOf(e)) {
  if (kind.family === 'film') return 'film';
  if (kind.family === 'music') return 'music';
  if (kind.family === 'comedy') return 'comedy';
  if (kind.family === 'night' && (e.category === 'music' || e.category === 'comedy')) return e.category;
  return 'around';
}

// Kinds whose title names the night better than the parsed lineup does:
// "Author Talk: Jess Walter", "Open Mic Monday", "Hamlet". A drag or cabaret
// show with a named performer leads with the performer.
export function usesTitle(kind, lineup = []) {
  if (kind.family === 'stage') return !((kind.key === 'drag' || kind.key === 'cabaret') && lineup.length);
  return kind.family === 'night' || kind.family === 'other';
}

const STATUS_PREFIX_RE = /^\s*(?:sold[\s-]?out|cancell?ed|postponed|rescheduled|just added|new date|on sale now)\s*[!:.\-–—|]*\s*/i;
// The title as a headline: ticketing noise ("SOLD OUT!") belongs in a flag.
export function cleanTitle(title) {
  let t = String(title || '');
  for (let i = 0; i < 3 && STATUS_PREFIX_RE.test(t); i += 1) t = t.replace(STATUS_PREFIX_RE, '');
  return t.trim() || String(title || '');
}

// ── Flags ───────────────────────────────────────────────────────────────────
// At most one is shown on a row, so they're listed in priority order. Films
// get One night only / Last chance / Opens from the film scoring instead.
export const FLAG_ORDER = ['cancelled', 'sold-out', 'one-night', 'last-chance', 'opens', 'low-tix', 'release', 'free'];

export function flagsOf(e) {
  const title = String(e.title || '');
  const price = String(e.price_range || '');
  const flags = [];
  const cancelled = title.match(/\b(cancell?ed|postponed)\b/i);
  if (cancelled) flags.push({ key: 'cancelled', label: /^post/i.test(cancelled[1]) ? 'Postponed' : 'Cancelled' });
  if (/\bsold[\s-]?out\b/i.test(title) || /\bsold[\s-]?out\b/i.test(price)) flags.push({ key: 'sold-out', label: 'Sold out' });
  if (/\blow tickets\b|\bfew tickets left\b|\balmost sold out\b/i.test(title)) flags.push({ key: 'low-tix', label: 'Few left' });
  if (/\b(?:album|record|ep|single) release\b/i.test(title)) flags.push({ key: 'release', label: 'Release show' });
  // "Free Throw" is a band, so a bare "free" in a title doesn't count.
  if (/^\s*free\b|\bno cover\b|^\s*\$0(?:\.00)?\s*$/i.test(price) || /\bfree (?:show|admission|entry|event|concert)\b|\(free\)|\bno cover\b/i.test(title)) {
    flags.push({ key: 'free', label: 'Free' });
  }
  return flags;
}

export function sortFlags(flags) {
  return [...flags].sort((a, b) => FLAG_ORDER.indexOf(a.key) - FLAG_ORDER.indexOf(b.key));
}

// ── Series (recurring nights) ───────────────────────────────────────────────
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_RE = new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b|\\b\\d{1,2}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?\\b`, 'gi');
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi;
const WEEKDAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?s?';
const EDGE_WEEKDAY_RE = new RegExp(`^(?:(?:every|each)\\s+)?${WEEKDAY}\\b\\s*|\\s*\\b${WEEKDAY}$`, 'g');
const NOISE_RE = /\b(?:sold out|cancell?ed|postponed|rescheduled|just added|new date|on sale now|early show|late show|matinee|all ages|21|18)\b/g;

// A title with the parts that change from week to week taken out:
// "Trivia Night #12 – Thursday, Oct 9" and "Trivia Night #13 – Thursday,
// Oct 16" both become "trivia night".
export function titleStem(title) {
  let t = String(title || '')
    .replace(/#\s*\d+/g, ' ')
    .replace(/\bvol(?:ume)?\.?\s*\d+/gi, ' ')
    .replace(/\b(?:part|pt|episode|ep|week|night|round|no)\.?\s*\d+\b/gi, ' ')
    .replace(DATE_RE, ' ')
    .replace(TIME_RE, ' ')
    .replace(/^.*?\bpresents?\b:?/i, ' ');
  t = artistKey(t).replace(NOISE_RE, ' ');
  t = t.replace(/\b\d+(?:st|nd|rd|th)?\b/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i += 1) t = t.replace(EDGE_WEEKDAY_RE, '').trim();
  return t;
}

// The same night at the same venue, whatever its date.
export function seriesKey(e) {
  return `${artistKey(e.venue)}|${titleStem(e.title)}`;
}
