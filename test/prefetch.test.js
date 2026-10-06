// Tests for the background artist-profile prefetch and the shared rate
// limits it runs under: who gets looked up first, the per-run budget and
// deadline, the circuit breakers, and the iTunes token bucket. Sources are
// stubbed and the limits run on a fake clock, so nothing touches the network
// or waits on real time. Runs against a throwaway in-memory database.
import './helpers/memory-db.js'; // must stay the first import
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { upsertEvent, setManualGenre } = await import('../src/db/queries.js');
const { saveArtist, saveArtistProfile } = await import('../src/db/artists.js');
const { prefetchProfiles, prefetchQueue, prefetchState } = await import('../src/enrich/prefetch.js');
const limits = await import('../src/enrich/limits.js');

migrate();
db.exec('DELETE FROM manual_genres; DELETE FROM favorite_artists; DELETE FROM preferences;');
setManualGenre('punk', 5);

// Saturday 5 January 2030.
const TODAY = '2030-01-05';
const NOW = new Date(2030, 0, 5, 8, 0).getTime();
const day = (n) => {
  const d = new Date(2030, 0, 5 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function add(name, n, fields = {}) {
  upsertEvent({
    source: 'scrape',
    source_name: 'test',
    title: name,
    lineup: [name],
    venue: 'Test Hall',
    city: 'Seattle',
    category: 'music',
    time: '20:00',
    date: day(n),
    ...fields,
  });
}

add('Static Saints', 0); // no tags, but MusicBrainz knows them → tier 2
add('Glass Harbor', 3, { genre_tags: 'punk' }); // tier 1
add('The Low Tides', 1, { genre_tags: 'punk' }); // tier 1, sooner
add('Hannibal Buress', 10, { category: 'comedy' }); // tier 1, comedy hint
add('Nate Jackson', 20, { category: 'comedy' }); // comedy too far out
add('Nobody Knows Us', 2); // no tags, unknown: not worth a lookup
add('Punk Rock Karaoke', 1, { genre_tags: 'punk', lineup: ['Punk Rock Karaoke'] }); // a regular night
add('Far Punks', 12, { genre_tags: 'punk' }); // tier 3
for (const n of [0, 7, 14]) add('Cumbia Night', n, { genre_tags: 'punk' }); // a weekly night
add('Way Out', 40, { genre_tags: 'punk' }); // past the 30-day window
add('Hidden Punks', 2, { genre_tags: 'punk' });
db.prepare("UPDATE events SET hidden = 1 WHERE title = 'Hidden Punks'").run();
saveArtist({ key: 'static saints', name: 'Static Saints', mbid: 'x', tags: [], status: 'found' });

const ORDER = ['The Low Tides', 'Glass Harbor', 'Hannibal Buress', 'Static Saints', 'Far Punks'];

// Stub sources that record each call (and the lookup's job) and can fail on cue.
function stubSources({ appleFails = () => null, wikiFails = () => null, onLookup = () => {} } = {}) {
  const calls = { musicbrainz: [], wikipedia: [], apple: [] };
  const fail = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
  return {
    calls,
    sources: {
      musicbrainz: async (name, mbid, job) => {
        calls.musicbrainz.push({ name, job: { ...job } });
        onLookup(name);
        return null;
      },
      wikipedia: async (mb, name) => {
        calls.wikipedia.push(name);
        const status = wikiFails(name);
        if (status) throw fail(status);
        return { bio: `${name} are a band.`, description: 'American punk band', image: null, url: null };
      },
      apple: async (name) => {
        calls.apple.push(name);
        const status = appleFails(name);
        if (status) throw fail(status);
        return { url: null, genre: 'Punk', match: 'name', songs: [] };
      },
      similar: async () => [],
    },
  };
}

beforeEach(() => {
  db.exec("DELETE FROM artist_profiles; DELETE FROM scrape_log WHERE source_name = 'profiles';");
});

test('the queue: good matches this week and comedians first, then known acts, then further out, soonest first', () => {
  const { queue, skipped } = prefetchQueue({ today: TODAY, now: NOW });
  assert.deepEqual(queue.map((c) => c.name), ORDER);
  assert.deepEqual(queue.map((c) => c.tier), [1, 1, 1, 2, 3]);
  assert.equal(queue.find((c) => c.name === 'Hannibal Buress').hint, 'comedy');
  assert.equal(queue.find((c) => c.name === 'Glass Harbor').hint, null);
  assert.equal(skipped, 0);
});

test('a few nights in a row is a run, not a regular: a comedy weekend and a band\'s stand are looked up', () => {
  // Thursday to Saturday at the comedy club, two shows on the Saturday; a
  // punk band Wednesday to Friday. Both have three dates in the window, as
  // the weekly Cumbia Night does, but only Cumbia Night is a regular.
  const runs = [
    ['Sam Jay', 5, { category: 'comedy', venue: 'Tacoma Comedy Club' }],
    ['Sam Jay', 6, { category: 'comedy', venue: 'Tacoma Comedy Club' }],
    ['Sam Jay - Early Show', 7, { category: 'comedy', venue: 'Tacoma Comedy Club', lineup: ['Sam Jay'], time: '19:00' }],
    ['Sam Jay - Late Show', 7, { category: 'comedy', venue: 'Tacoma Comedy Club', lineup: ['Sam Jay'], time: '21:30' }],
    ['Glass Pylons', 4, { genre_tags: 'punk' }],
    ['Glass Pylons', 5, { genre_tags: 'punk' }],
    ['Glass Pylons', 6, { genre_tags: 'punk' }],
  ];
  for (const [name, n, fields] of runs) add(name, n, fields);
  try {
    const { queue, skipped } = prefetchQueue({ today: TODAY, now: NOW });
    const names = queue.map((c) => c.name);
    assert.ok(names.includes('Sam Jay'), 'the comedy weekend gets a descriptor before anyone opens it');
    assert.equal(queue.find((c) => c.name === 'Sam Jay').hint, 'comedy');
    assert.equal(queue.find((c) => c.name === 'Sam Jay').date, day(5), 'looked up for its first night');
    assert.ok(names.includes('Glass Pylons'), "a band's three-night stand is looked up");
    assert.ok(!names.includes('Cumbia Night'), 'the weekly night is still left alone');
    assert.equal(skipped, 0);
  } finally {
    db.prepare("DELETE FROM events WHERE title LIKE 'Sam Jay%' OR title = 'Glass Pylons'").run();
  }
});

test('profiles we have are skipped: found this month, missed this week, failed in the last 6 hours', () => {
  saveArtistProfile('low tides', 'The Low Tides', 'found', {});
  saveArtistProfile('glass harbor', 'Glass Harbor', 'not_found', {});
  saveArtistProfile('hannibal buress', 'Hannibal Buress', 'partial', {});
  saveArtistProfile('static saints', 'Static Saints', 'partial', {});
  db.prepare("UPDATE artist_profiles SET fetched_at = datetime('now', '-7 hours') WHERE artist_key = 'static saints'").run();
  saveArtistProfile('far punks', 'Far Punks', 'not_found', {});
  db.prepare("UPDATE artist_profiles SET fetched_at = datetime('now', '-8 days') WHERE artist_key = 'far punks'").run();

  const { queue, skipped } = prefetchQueue({ today: TODAY, now: NOW });
  assert.deepEqual(queue.map((c) => c.name), ['Static Saints', 'Far Punks']);
  assert.equal(skipped, 3);
});

test('a run looks profiles up in queue order, in the background, and logs one row', async () => {
  const { sources, calls } = stubSources();
  const r = await prefetchProfiles({ today: TODAY, now: () => NOW, sources });
  assert.deepEqual(calls.musicbrainz.map((c) => c.name), ORDER);
  assert.ok(calls.musicbrainz.every((c) => c.job.background === true), 'prefetch lookups yield to the sheet');
  assert.deepEqual(
    calls.musicbrainz.map((c) => c.job.hint),
    [null, null, 'comedy', null, null]
  );
  assert.deepEqual(r, { fetched: 5, found: 5, partial: 0, skipped: 0, left: 0, stoppedBy: 'done', errors: 0, wikipediaPaused: false });
  const log = db.prepare("SELECT * FROM scrape_log WHERE source_name = 'profiles'").all();
  assert.equal(log.length, 1);
  assert.equal(log[0].source, 'enrich');
  assert.equal(log[0].status, 'ok');
  assert.equal(log[0].events_found, 5);
  assert.equal(log[0].error_msg, null);
  assert.equal(prefetchState().running, false);

  const again = await prefetchProfiles({ today: TODAY, now: () => NOW, sources });
  assert.equal(again.fetched, 0, 'the next run finds everything cached');
  assert.equal(again.skipped, 5);
});

test('a run stops at its budget', async () => {
  const { sources, calls } = stubSources();
  const r = await prefetchProfiles({ max: 2, today: TODAY, now: () => NOW, sources });
  assert.equal(r.fetched, 2);
  assert.equal(r.stoppedBy, 'max');
  assert.equal(r.left, 3);
  assert.deepEqual(calls.musicbrainz.map((c) => c.name), ORDER.slice(0, 2));
  assert.match(db.prepare("SELECT error_msg FROM scrape_log WHERE source_name = 'profiles'").get().error_msg, /3 left/);
});

test('a run stops at its deadline', async () => {
  let t = NOW;
  // Each lookup takes four minutes on the fake clock.
  const { sources } = stubSources({ onLookup: () => { t += 4 * 60000; } });
  const r = await prefetchProfiles({ deadlineMs: 10 * 60000, today: TODAY, now: () => t, sources });
  assert.equal(r.fetched, 3);
  assert.equal(r.stoppedBy, 'deadline');
  assert.equal(r.left, 2);
});

test("the first iTunes 429 stops the run, and that artist's profile is saved as partial", async () => {
  const { sources, calls } = stubSources({ appleFails: (name) => (name === 'Glass Harbor' ? 429 : null) });
  const r = await prefetchProfiles({ today: TODAY, now: () => NOW, sources });
  assert.equal(r.stoppedBy, 'itunes');
  assert.equal(r.fetched, 2);
  assert.equal(r.left, 3);
  assert.deepEqual(calls.apple, ['The Low Tides', 'Glass Harbor'], 'no more Apple calls after the 429');
  const row = db.prepare("SELECT status FROM artist_profiles WHERE artist_key = 'glass harbor'").get();
  assert.equal(row.status, 'partial');
  assert.match(db.prepare("SELECT error_msg FROM scrape_log WHERE source_name = 'profiles'").get().error_msg, /Apple Music/);
});

test('an iTunes 403 trips the same breaker', async () => {
  const { sources } = stubSources({ appleFails: () => 403 });
  const r = await prefetchProfiles({ today: TODAY, now: () => NOW, sources });
  assert.equal(r.stoppedBy, 'itunes');
  assert.equal(r.fetched, 1);
});

test("Apple backing us off is a pause, not a broken source: the run is logged 'ok', with the note kept", async () => {
  // The first act is one nobody knows, so its lookup saves nothing but the
  // error, and the run stops there.
  const { sources } = stubSources({ appleFails: () => 429 });
  const r = await prefetchProfiles({
    today: TODAY, now: () => NOW, sources: { ...sources, wikipedia: async () => null },
  });
  assert.equal(r.stoppedBy, 'itunes');
  assert.deepEqual([r.fetched, r.found, r.partial, r.errors], [1, 0, 0, 1]);
  const log = db.prepare("SELECT status, error_msg FROM scrape_log WHERE source_name = 'profiles'").get();
  assert.equal(log.status, 'ok', "the header's 'needs a look' count stays clear");
  assert.match(log.error_msg, /Apple Music is rate limiting; 4 left for the next refresh; 1 lookup error/);
});

test("a run whose every lookup fails is still logged as an error", async () => {
  const { sources } = stubSources({ appleFails: () => 500 });
  const r = await prefetchProfiles({
    today: TODAY, now: () => NOW, sources: { ...sources, wikipedia: async () => null },
  });
  assert.equal(r.stoppedBy, 'done');
  assert.equal(r.errors, 5);
  assert.equal(db.prepare("SELECT status FROM scrape_log WHERE source_name = 'profiles'").get().status, 'error');
});

test('two Wikimedia 429s in a row and Wikipedia is skipped for the rest of the run', async () => {
  const { sources, calls } = stubSources({ wikiFails: (name) => (name === 'Hannibal Buress' ? null : 429) });
  // The Low Tides 429, Glass Harbor 429: paused before Hannibal Buress.
  const r = await prefetchProfiles({ today: TODAY, now: () => NOW, sources });
  assert.equal(r.fetched, 5);
  assert.equal(r.wikipediaPaused, true);
  assert.deepEqual(calls.wikipedia, ['The Low Tides', 'Glass Harbor']);
  // The two that hit the 429s, and the comedian, who is looked for on
  // Wikipedia by name, are saved as partial so a later run fills Wikipedia
  // in. Static Saints and Far Punks would never have asked Wikipedia (no
  // MusicBrainz link, no comedy hint), so the pause costs them nothing.
  const status = (key) => db.prepare('SELECT status FROM artist_profiles WHERE artist_key = ?').get(key).status;
  assert.deepEqual(['low tides', 'glass harbor', 'hannibal buress'].map(status), ['partial', 'partial', 'partial']);
  assert.deepEqual(['static saints', 'far punks'].map(status), ['found', 'found']);
  assert.equal(r.partial, 3);
  assert.equal(r.stoppedBy, 'done');
});

test("once Wikipedia is paused, a profile that wouldn't have asked it isn't marked as failing it", async () => {
  // MusicBrainz knows every act; only The Low Tides and Glass Harbor link a
  // Wikipedia page. The stub asks the network the way fetchWikipedia does:
  // with a linked page or Wikidata id, or by name for a comedian.
  const asked = [];
  const sources = {
    musicbrainz: async (name) => ({
      name, type: 'Group', from: 'Seattle', appleId: null, links: {},
      wikidataId: name === 'The Low Tides' || name === 'Glass Harbor' ? `Q${name.length}` : null,
    }),
    wikipedia: async (mb, name, job) => {
      if (!mb?.wikipediaTitle && !mb?.wikidataId && job?.hint !== 'comedy') return null;
      asked.push(name);
      throw Object.assign(new Error('HTTP 429'), { response: { status: 429 } });
    },
    apple: async () => ({ url: null, genre: 'Punk', match: 'name', songs: [] }),
    similar: async () => [],
  };
  const r = await prefetchProfiles({ today: TODAY, now: () => NOW, sources });
  assert.equal(r.wikipediaPaused, true);
  assert.deepEqual(asked, ['The Low Tides', 'Glass Harbor']);
  const row = (key) => db.prepare('SELECT status, data FROM artist_profiles WHERE artist_key = ?').get(key);
  assert.equal(row('hannibal buress').status, 'partial', 'the comedian would have asked, so it is retried');
  for (const key of ['static saints', 'far punks']) {
    assert.equal(row(key).status, 'found', `${key} is settled for 30 days, not re-fetched in 6 hours`);
    assert.deepEqual(JSON.parse(row(key).data).failed, []);
  }
  assert.equal(r.found, 2);
  assert.equal(r.partial, 3);
});

test('a 429 followed by a success does not trip the Wikipedia breaker', async () => {
  const { sources, calls } = stubSources({ wikiFails: (name) => (name === 'The Low Tides' || name === 'Hannibal Buress' ? 429 : null) });
  const r = await prefetchProfiles({ today: TODAY, now: () => NOW, sources });
  assert.equal(r.wikipediaPaused, false);
  assert.equal(calls.wikipedia.length, 5);
});

test('runs never overlap', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { sources } = stubSources();
  const slow = { ...sources, musicbrainz: async (...args) => { await gate; return sources.musicbrainz(...args); } };
  const first = prefetchProfiles({ today: TODAY, now: () => NOW, sources: slow });
  assert.equal(prefetchState().running, true);
  const second = await prefetchProfiles({ today: TODAY, now: () => NOW, sources });
  assert.equal(second.stoppedBy, 'running');
  assert.equal(second.fetched, 0);
  release();
  assert.equal((await first).fetched, 5);
});

// ── The shared limits ───────────────────────────────────────────────────────

// A clock that only moves when someone sleeps: a sleep ends `ms` after it
// started, so callers sleeping side by side don't add up.
function fakeClock() {
  const clock = { t: 0, slept: [] };
  const sleep = async (ms) => {
    const until = clock.t + ms;
    clock.slept.push(ms);
    await null;
    clock.t = Math.max(clock.t, until);
  };
  limits.setClock({ now: () => clock.t, sleep });
  limits.resetLimits();
  return clock;
}

test('iTunes: 18 calls go straight through, the 19th waits until the first is a minute old', async () => {
  const clock = fakeClock();
  try {
    for (let i = 0; i < 18; i += 1) await limits.itunesTurn();
    assert.deepEqual(clock.slept, []);
    await limits.itunesTurn();
    assert.deepEqual(clock.slept, [60000]);
    assert.equal(limits.itunesTokens(), 17, 'the first 18 have left the window; the 19th is in it');
    clock.t += 60000;
    assert.equal(limits.itunesTokens(), 18, 'a quiet minute frees every call, no more');
  } finally {
    limits.setClock();
  }
});

test('iTunes: the background leaves the last four calls of the minute for the sheet', async () => {
  const clock = fakeClock();
  try {
    for (let i = 0; i < 14; i += 1) await limits.itunesTurn({ background: true });
    assert.deepEqual(clock.slept, [], '14 without waiting');
    for (let i = 0; i < 4; i += 1) await limits.itunesTurn();
    assert.deepEqual(clock.slept, [], "a sheet's four calls still go straight away");
    await limits.itunesTurn({ background: true });
    assert.deepEqual(clock.slept, [60000], 'the background waits until only 13 are in the last minute');
  } finally {
    limits.setClock();
  }
});

// The most calls any 60 s window holds.
const busiestMinute = (stamps) => Math.max(...stamps.map((s) => stamps.filter((x) => x >= s && x < s + 60000).length));

test('iTunes: never more than 18 calls in any minute, the first minute of a run included', async () => {
  const clock = fakeClock();
  try {
    const stamps = [];
    const call = async (opts) => {
      await limits.itunesTurn(opts);
      stamps.push(clock.t);
      clock.t += 300; // each request takes a moment
    };
    // A prefetch's pace: two MusicBrainz turns, then two or three iTunes
    // calls a profile; and now and then someone opens an artist sheet.
    const job = { background: true };
    for (let p = 0; p < 40; p += 1) {
      await limits.mbTurn(job);
      clock.t += 300;
      await limits.mbTurn(job);
      clock.t += 300;
      for (let k = 0; k < 2 + (p % 2); k += 1) await call(job);
      if (p % 6 === 1) for (let k = 0; k < 4; k += 1) await call();
    }
    assert.ok(stamps.length > 100);
    assert.ok(stamps.filter((s) => s < stamps[0] + 60000).length <= 18, 'the first minute keeps to 18');
    assert.ok(busiestMinute(stamps) <= 18, `busiest minute: ${busiestMinute(stamps)} calls`);
  } finally {
    limits.setClock();
  }
});

test('background callers hold back while a sheet is loading', async () => {
  fakeClock();
  try {
    let release;
    const sheet = limits.foreground(() => new Promise((resolve) => { release = resolve; }));
    const order = [];
    const bg = Promise.all([
      limits.itunesTurn({ background: true }).then(() => order.push('itunes')),
      limits.mbTurn({ background: true }).then(() => order.push('mb')),
      limits.wikiTurn({ background: true }).then(() => order.push('wiki')),
    ]);
    await limits.itunesTurn();
    order.push('sheet');
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.deepEqual(order, ['sheet'], 'nothing in the background moved while the sheet was loading');
    release();
    await sheet;
    await bg;
    assert.deepEqual(order.slice(0, 1), ['sheet']);
    assert.equal(order.length, 4);
    assert.equal(limits.foregroundBusy(), false);
  } finally {
    limits.setClock();
  }
});

test('MusicBrainz turns are 1.1 s apart, however many callers share them', async () => {
  const clock = fakeClock();
  try {
    await Promise.all([limits.mbTurn(), limits.mbTurn({ background: true }), limits.mbTurn()]);
    // Three callers at once: the first goes now, the others 1.1 s and 2.2 s on.
    assert.deepEqual(clock.slept, [1100, 2200]);
  } finally {
    limits.setClock();
  }
});
