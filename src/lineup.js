// Lineup parsing: pull artist names out of free-text event titles.
//
// Scrapers and feeds only give us a title like
//   "Tractor Presents: Dave Hause & The Mermaid x American Steel AT The Sunset"
//   "SOLD OUT! Hiss Golden Messenger: I'm People Tour w/ Sam Amidon (NIGHT ONE)"
// and the preference engine can't match a favorite artist (or look up an
// artist's genres) until the band names are separated from the promoter,
// tour name, venue suffix and ticketing noise. This is heuristic by nature —
// it aims to get the headliner right and the support acts mostly right.

// Normalised key for comparing artist names across sources:
// "The Menzingers" = "menzingers", "alt-J" = "ALT-J", "Carín León" = "carin leon".
export function artistKey(name) {
  const raw = String(name || '');
  const key = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘`".]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the\s+/, '');
  // Names in non-Latin scripts normalise to nothing — fall back to the raw text.
  return key || raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Ticketing / status noise that is never part of a band name.
const STATUS_RE =
  /\b(?:sold[\s-]?out|low tickets|few tickets left|cancell?ed|postponed|rescheduled|new date|on sale now|just added|show added|both shows|night (?:one|two|three|\d)|early show|late show|matinee(?: show)?|all ages|(?:partially )?seated|standing room only|\d{2}\+)(?!\w)[!:]*/gi;

// Words that mark a segment as a tour name / event description rather than an
// act ("Young Regan Tour", "30th Anniversary Show", "Live at The Valley").
const SUBTITLE_RE =
  /\b(?:tour|anniversary|album|record release|ep release|single release|release (?:show|party)|show|live|night|party|celebration|edition|session|experience|evening|tribute|performs?|playing|festival|fest|world|north american|in concert|vol|part|pt|benefit|birthday|farewell|reunion|halloween|christmas|holiday|returns|starring|hosted|calling|years|20\d\d)\b/i;

// Segments that are events, not acts. Dropped from the lineup entirely.
const NON_ARTIST_RE =
  /\b(?:open mic|trivia|karaoke|bingo|brunch|movie night|screening|showcase|square dance|presents?|tickets?|benefit|fundraiser|tba|tbd|special guests?|guests|and more|dj set|donations?|doors|tour)\b|\b(?:show|bash|fest|festival)$|\$\d/i;

// Dates and times that leak into titles ("Sat July 11, 7pm", "Friday July 10th").
const DATE_TIME_RE =
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i;

// "Support" markers that introduce the rest of the bill. The special-guest
// forms come first so "Plus Special Guest:" is consumed as one marker.
const SUPPORT_MARKERS = [
  '(?:plus|and|\\+)?\\s*special\\s+guests?:?',
  'w\\/', 'w\\.\\/', 'with', 'featuring', 'feat\\.?', 'ft\\.', 'plus',
  'support(?:ing)?(?:\\s+from)?:?', 'hosted\\s+by',
];
const SUPPORT_WORDS = `(?:${SUPPORT_MARKERS.join('|')})(?!\\w)`;
const SUPPORT_SPLIT_RE = new RegExp(`\\s+${SUPPORT_WORDS}\\s*|\\s+w\\/(?=\\S)`, 'i');
const SUPPORT_SPLIT_ALL_RE = new RegExp(`(?:^|\\s+)${SUPPORT_WORDS}\\s*`, 'gi');

// Co-headliner separators: "A x B", "A + B", "A • B", "A // B", "A / B", "A | B",
// and the exclamation marks scraped titles love ("Square Dance! Band Name").
// A name ending in "!" before a separator ("TACOS! | ATUMES") is one split.
const COBILL_SPLIT_RE = /!*\s+(?:x|×|\+|•|·|\|)\s+|\s*\/\/+\s*|\s*\/\s+|\s+\/\s*|\s*;\s*|!+\s+/i;

// Dashes between segments (but not inside "alt-J" or "Sea-Tac", or between
// numbers: "9 - 5 Hyperfuck" is one band).
const DASH_SPLIT_RE = /\s*[–—]\s*|(?<!\d)\s+-\s*|\s*-\s+(?!\d)/;

// "X Presents:", "KEXP Presents!", "Tractor & Heirophant Present:" at the start.
const PRESENTS_PREFIX_RE = /^.{0,60}?\bpresents?\b\s*[:!\-–—]?\s*/i;
const EVENING_PREFIX_RE = /^(?:an?\s+)?(?:evening|night|afternoon)\s+(?:with|w\/|of)\s*/i;
// Venue suffixes the Tractor uses for off-site shows: "… AT The Sunset", "… @ Neumos".
// Only a short run of capitalised words at the very end, so a "TOUR AT THE
// VALLEY with …" title doesn't lose its whole support list.
const VENUE_SUFFIX_RE =
  /\s+(?:@|AT|at(?=\s+The\s))\s+(?:The\s+)?[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,3}\s*$/;

function stripNoise(text) {
  return String(text || '')
    .replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*/g, ' ') // (partially seated), [21+], *seated*
    .replace(STATUS_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s!:,\-–—]+|[\s!:,\-–—]+$/g, '')
    .trim();
}

// Clean a single candidate name; returns null if it isn't plausibly an act.
function cleanName(name) {
  let n = stripNoise(name)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+(?:and|&)\s+friends$/i, '')
    .replace(/\s+on tour$/i, '')
    .replace(/\s+performs?\s+.*$/i, '') // "Bit Brigade Performs “Mega Man II”"
    .replace(/\s+from\s+["“].*$/i, '') // "Creed Bratton from “The Office”"
    .replace(/\s+returns?\s+to\s+.*$/i, '')
    .replace(/\s+calling$/i, '')
    .replace(/\s+(?:\d+(?:st|nd|rd|th)\s+)?(?:anniversary|album release|record release|release show|birthday)\b.*$/i, '')
    .replace(/\s+presents?\s+.*$/i, '') // "REVEREND HORTON HEAT presents The Sub Pop Years"
    .replace(/[!?.,]+$/, '')
    .trim();
  if (!n || n.length < 2 || n.length > 60) return null;
  if (DATE_TIME_RE.test(n)) return null;
  if (n.split(/\s+/).length > 7) return null;
  if (NON_ARTIST_RE.test(n)) return null;
  if (/^(?:and|more|guests?|tba|tbd|@)$/i.test(n)) return null;
  return n;
}

// Split a segment on dashes, keeping the first part and any later parts that
// read like more acts rather than a tour name.
function splitDashes(segment) {
  const parts = segment.split(DASH_SPLIT_RE).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return parts;
  return [parts[0], ...parts.slice(1).filter((p) => !SUBTITLE_RE.test(p))];
}

// "Artist: Tour Name" keeps the artist; "Some Fest: A, B, C" keeps the lineup.
function splitColon(segment) {
  const m = segment.match(/^(.+?)\s*:\s+(.+)$/);
  if (!m) return [segment];
  const [, before, after] = m;
  const beforeIsEvent = /\b(?:fest|festival|showcase|lineup|series|night|party|celebration|tour|from \w+)\s*$/i.test(before);
  return beforeIsEvent ? [after] : [before];
}

// Support lists also split on commas and on "and" when it joins two acts
// ("Bizzy Beaver and Yelm") — but not "Brooklyn Del and the Revelators".
function splitSupport(text) {
  return text
    .split(SUPPORT_SPLIT_ALL_RE)
    .flatMap((p) => p.split(/\s*,\s*|\s+(?:and|&)\s+(?!(?:the|thee|his|her|their|friends|company|co)\b)/i))
    .flatMap((p) => p.split(COBILL_SPLIT_RE));
}

// Headline commas: "Former Jock, Mad King, Gwen" is a bill, but "The Army,
// The Navy" and "Tyler, The Creator" are single acts — only split 3+ parts.
function splitHeadCommas(segment) {
  const parts = segment.split(/\s*,\s*|\s+from\s+[a-z]+:\s+/i).filter(Boolean);
  return parts.length >= 3 ? parts : [segment];
}

// Parse a lineup (headliner first) from an event title. `artist` is an
// API-provided headliner; `support` is optional free text from a separate
// "with …" field (e.g. the Showbox's subtitle line).
export function parseLineup(title, { artist, support } = {}) {
  let text = stripNoise(title).replace(VENUE_SUFFIX_RE, '');
  text = text.replace(PRESENTS_PREFIX_RE, '');
  text = text.replace(EVENING_PREFIX_RE, '').replace(/^(?:with|w\/)\s+/i, '').trim();

  const supportMatch = text.match(SUPPORT_SPLIT_RE);
  const head = supportMatch ? text.slice(0, supportMatch.index) : text;
  const tail = supportMatch ? text.slice(supportMatch.index + supportMatch[0].length) : '';

  const headliners = splitColon(head.trim())
    .flatMap((s) => s.split(COBILL_SPLIT_RE))
    .flatMap(splitHeadCommas)
    .flatMap(splitDashes);
  // A separate support line is sometimes a tour name ("Of Earth & Wires Tour")
  // or door info ("Suggested $10 donations at the door") instead.
  const supportLine = /\b(?:tour|anniversary|album|release|donations?)\b|\$\d/i.test(support || '') ? '' : support;
  const supportText = [tail, String(supportLine || '').replace(/^\s*(?:with|w\/|feat\.?|featuring|special guests?:?)\s+/i, '')]
    .filter(Boolean)
    .join(', ');
  const supporting = splitSupport(stripNoise(supportText)).flatMap(splitDashes);

  const out = [];
  const seen = new Set();
  for (const candidate of [artist, ...headliners, ...supporting]) {
    const name = cleanName(candidate);
    if (!name) continue;
    const key = artistKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 8) break;
  }
  return out;
}

// Every key worth matching for a lineup entry: the name itself plus its parts
// when it joins two acts with "&"/"and" ("Dying Fetus & Sanguisugabogg").
export function lineupKeys(name) {
  const keys = new Set([artistKey(name)]);
  for (const part of String(name || '').split(/\s+(?:&|and)\s+/i)) {
    const k = artistKey(part);
    if (k && k.length > 2) keys.add(k);
  }
  return [...keys].filter(Boolean);
}

// Tribute / cover acts — rarely what someone tracking their own taste wants.
export function isTribute(text) {
  return /\b(?:tribute|cover band|the music of|plays the music|salute to)\b/i.test(String(text || ''));
}
