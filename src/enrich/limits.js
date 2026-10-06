// Shared rate limits for the free services artist lookups lean on. Three
// callers use them: the artist sheet (someone is waiting), enrichment after
// a refresh, and the background profile prefetch (src/enrich/prefetch.js).
// Sharing one limiter per service means they can't race each other past a
// service's limit, however many run at once.
//
//   MusicBrainz  about one request a second
//   iTunes       about 20 a minute before Apple starts answering 403; we
//                keep to 18 in any 60 s, and the background leaves the
//                last 4 of those for the sheet
//   Wikimedia    no hard limit, but bursts get 429s
//
// The sheet comes first: while a foreground lookup is in flight, background
// callers hold back before taking a turn.
import { sleep as realSleep } from '../config.js';

const MB_GAP_MS = 1100;
const WIKI_GAP_MS = 250;
export const ITUNES_PER_MIN = 18;
const ITUNES_WINDOW_MS = 60000;
// The background only takes an iTunes call while at least this many of the
// minute's are left, so an artist sheet opened mid-prefetch (three or four
// calls) never waits.
const ITUNES_RESERVE = 4;

// Tests swap in a fake clock so nothing waits on real time.
const clock = { now: () => Date.now(), sleep: realSleep };
export function setClock({ now, sleep } = {}) {
  clock.now = now || (() => Date.now());
  clock.sleep = sleep || realSleep;
}

// ── Foreground priority ─────────────────────────────────────────────────────
let inFlight = 0;
let waiters = [];

function wake() {
  const ready = waiters;
  waiters = [];
  for (const resolve of ready) resolve();
}

// Run a lookup someone is waiting on. Background callers hold back until
// every foreground lookup has finished.
export async function foreground(fn) {
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    if (!inFlight) wake();
  }
}

// A background lookup someone is now waiting on (they opened the artist the
// prefetch was fetching): it stops holding back. `job` is the same object
// the lookup passes to the turns below, so the change reaches calls already
// waiting.
export function promote(job) {
  job.background = false;
  wake();
}

export function foregroundBusy() {
  return inFlight > 0;
}

// `opts.background` is read on every check rather than once, so a promoted
// lookup stops waiting straight away.
async function yieldToForeground(opts) {
  while (opts?.background && inFlight > 0) await new Promise((resolve) => waiters.push(resolve));
}

// ── Per-service turns ───────────────────────────────────────────────────────
// A fixed gap between requests: each caller books the next free slot, then
// waits for it.
function gapLimiter(gapMs) {
  let next = 0;
  const turn = async (opts) => {
    await yieldToForeground(opts);
    const now = clock.now();
    const wait = next - now;
    next = Math.max(now, next) + gapMs;
    if (wait > 0) await clock.sleep(wait);
  };
  turn.reset = () => {
    next = 0;
  };
  return turn;
}

export const mbTurn = gapLimiter(MB_GAP_MS);
export const wikiTurn = gapLimiter(WIKI_GAP_MS);

// iTunes keeps a log of the last minute's calls rather than a gap, so a
// sheet's three or four calls can go at once. (It was a token bucket, but a
// full bucket plus its refill let a fresh prefetch make about 32 calls in its
// first minute, well past where Apple starts saying no.) A call goes when
// fewer than 18 were made in the last 60 s — 14 for the background — so no
// 60 s window ever holds more than 18.
const itunesLog = [];

function itunesRecent(now) {
  while (itunesLog.length && now - itunesLog[0] >= ITUNES_WINDOW_MS) itunesLog.shift();
  return itunesLog.length;
}

export async function itunesTurn(opts = {}) {
  for (;;) {
    await yieldToForeground(opts);
    const now = clock.now();
    const limit = opts.background ? ITUNES_PER_MIN - ITUNES_RESERVE : ITUNES_PER_MIN;
    const recent = itunesRecent(now);
    if (recent < limit) {
      itunesLog.push(now);
      return;
    }
    // Wait until enough of the oldest calls are a minute old, then check
    // again (a sheet may have opened, or taken the slot, in the meantime).
    await clock.sleep(Math.max(1, itunesLog[recent - limit] + ITUNES_WINDOW_MS - now));
  }
}

// How many iTunes calls could go right now.
export function itunesTokens() {
  return Math.max(0, ITUNES_PER_MIN - itunesRecent(clock.now()));
}

// For tests: no recent calls, free slots, nothing in flight.
export function resetLimits() {
  mbTurn.reset();
  wikiTurn.reset();
  itunesLog.length = 0;
  inFlight = 0;
  wake();
}
