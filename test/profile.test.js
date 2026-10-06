// Tests for artist profiles (the artist sheet): parsing MusicBrainz, Wikipedia
// and Apple responses, and how profiles are assembled and cached. The sources
// are stubbed, so nothing here touches the network. Runs against a throwaway
// in-memory database.
import './helpers/memory-db.js'; // must stay the first import
import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { setFavoriteArtist, getArtistProfile } = await import('../src/db/artists.js');
const { parseMusicBrainz, parseWikiSummary, pickAppleArtist, topSongs, artistProfile, wikipediaByName } = await import(
  '../src/enrich/profile.js'
);
const limits = await import('../src/enrich/limits.js');
const { profileView } = await import('../src/week.js');

migrate();

// Trimmed from MusicBrainz's answer for PUP (inc=url-rels).
const PUP_MB = {
  id: '3165f5e0-44ff-446a-81d7-c09ec69661ae',
  name: 'PUP',
  type: 'Group',
  disambiguation: 'Canadian punk band',
  area: { name: 'Canada' },
  'begin-area': { name: 'Toronto' },
  'life-span': { begin: '2010', ended: false },
  relations: [
    { type: 'official homepage', url: { resource: 'https://www.puptheband.com/' } },
    { type: 'bandcamp', url: { resource: 'https://puptheband.bandcamp.com/' } },
    { type: 'free streaming', url: { resource: 'https://open.spotify.com/artist/6A7uqgC2N1nUhrCLAytHxN' } },
    { type: 'free streaming', url: { resource: 'https://www.deezer.com/artist/117527' } },
    { type: 'streaming', url: { resource: 'https://music.apple.com/gb/artist/722031743' } },
    { type: 'youtube', url: { resource: 'https://www.youtube.com/channel/UCU-33byAz0Oo4RgMy-aEWQA' } },
    { type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q16967929' } },
    { type: 'blog', url: { resource: 'javascript:alert(1)' } },
  ],
};

const song = (artistId, trackName, extra = {}) => ({
  wrapperType: 'track',
  kind: 'song',
  artistId,
  trackName,
  collectionName: 'Morbid Stuff',
  releaseDate: '2019-04-05T07:00:00Z',
  previewUrl: `https://audio-ssl.itunes.apple.com/${encodeURIComponent(trackName)}.m4a`,
  trackViewUrl: 'https://music.apple.com/us/album/kids/1457237734?i=1457237746&uo=4',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg',
  ...extra,
});

test('MusicBrainz facts: hometown, year formed, Apple id, Wikidata id and links', () => {
  const mb = parseMusicBrainz(PUP_MB);
  assert.equal(mb.type, 'Group');
  assert.equal(mb.from, 'Toronto, Canada');
  assert.equal(mb.since, '2010');
  assert.equal(mb.until, null);
  assert.equal(mb.description, 'Canadian punk band');
  assert.equal(mb.appleId, '722031743');
  assert.equal(mb.wikidataId, 'Q16967929');
  assert.deepEqual(mb.links, {
    website: 'https://www.puptheband.com/',
    bandcamp: 'https://puptheband.bandcamp.com/',
    spotify: 'https://open.spotify.com/artist/6A7uqgC2N1nUhrCLAytHxN',
    youtube: 'https://www.youtube.com/channel/UCU-33byAz0Oo4RgMy-aEWQA',
  });
  assert.equal(parseMusicBrainz({ ...PUP_MB, 'begin-area': null }).from, 'Canada');
  assert.equal(parseMusicBrainz({ ...PUP_MB, 'life-span': { begin: '2005', ended: true, end: '2019' } }).until, '2019');
  assert.equal(parseMusicBrainz(null), null);
});

test('Wikipedia summaries give a bio and photo; disambiguation pages give nothing', () => {
  const wiki = parseWikiSummary({
    type: 'standard',
    extract: 'PUP is a Canadian punk rock band formed in Toronto, Ontario in 2010.',
    description: 'Canadian punk rock band',
    thumbnail: { source: 'https://upload.wikimedia.org/pup.jpg' },
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/PUP_(band)' } },
  });
  assert.equal(wiki.bio.startsWith('PUP is a Canadian punk rock band'), true);
  assert.equal(wiki.image, 'https://upload.wikimedia.org/pup.jpg');
  assert.equal(wiki.url, 'https://en.wikipedia.org/wiki/PUP_(band)');
  assert.equal(parseWikiSummary({ type: 'disambiguation', extract: 'PUP may refer to:' }), null);
});

test('Apple: the artist MusicBrainz points to wins; otherwise the first exact name match', () => {
  const results = [
    { wrapperType: 'artist', artistId: 1829599976, artistName: 'rent strike' },
    { wrapperType: 'artist', artistId: 1332002462, artistName: 'RENT STRIKE' },
    { wrapperType: 'artist', artistId: 5, artistName: 'Rent Strike Collective' },
  ];
  assert.equal(pickAppleArtist('Rent Strike', results, '1332002462').artistId, 1332002462);
  assert.equal(pickAppleArtist('Rent Strike', results).artistId, 1829599976);
  assert.equal(pickAppleArtist('Ezra Bell', results), null);
});

test('top songs: this artist only, one per title, playable, most popular first', () => {
  const songs = topSongs(
    [
      song(722031743, 'Kids'),
      song(1398609389, 'PAW Patrol Pup Pup Boogie'),
      song(722031743, 'Kids'),
      song(722031743, 'Free at Last', { previewUrl: undefined }),
      song(722031743, 'DVP'),
      { wrapperType: 'artist', artistId: 722031743, artistName: 'PUP' },
    ],
    722031743
  );
  assert.deepEqual(songs.map((s) => s.title), ['Kids', 'DVP']);
  assert.equal(songs[0].year, '2019');
  assert.equal(songs[0].url, 'https://music.apple.com/us/album/kids/1457237734?i=1457237746');
  assert.equal(songs[0].artwork, 'https://is1-ssl.mzstatic.com/image/thumb/x/300x300bb.jpg');
  const many = Array.from({ length: 9 }, (_, i) => song(1, `Song ${i}`));
  assert.equal(topSongs(many, 1).length, 5);
});

// Stub sources that count their calls.
function stubSources({ wikiFails = false } = {}) {
  const calls = { musicbrainz: 0, wikipedia: 0, apple: 0, similar: 0 };
  return {
    calls,
    sources: {
      musicbrainz: async () => { calls.musicbrainz += 1; return parseMusicBrainz(PUP_MB); },
      wikipedia: async () => {
        calls.wikipedia += 1;
        if (wikiFails) throw new Error('HTTP 429');
        return { bio: 'PUP is a Canadian punk rock band.', description: 'Canadian punk rock band', image: 'https://upload.wikimedia.org/pup.jpg', url: 'https://en.wikipedia.org/wiki/PUP_(band)' };
      },
      apple: async (name, appleId) => {
        calls.apple += 1;
        assert.equal(appleId, '722031743', 'Apple is looked up by the id MusicBrainz links to');
        return { url: 'https://music.apple.com/us/artist/pup/722031743', genre: 'Alternative', songs: topSongs([song(722031743, 'Kids')], 722031743) };
      },
      similar: async () => { calls.similar += 1; return ['Jeff Rosenstock', 'Joyce Manor']; },
    },
  };
}

test('a profile is assembled from every source, then served from the cache', async () => {
  const { sources, calls } = stubSources();
  const p = await artistProfile('PUP', { sources });
  assert.equal(p.status, 'found');
  assert.equal(p.from, 'Toronto, Canada');
  assert.equal(p.bio, 'PUP is a Canadian punk rock band.');
  assert.equal(p.image, 'https://upload.wikimedia.org/pup.jpg');
  assert.equal(p.apple.songs[0].title, 'Kids');
  assert.deepEqual(p.similar, ['Jeff Rosenstock', 'Joyce Manor']);
  assert.equal(p.fresh, true);

  await artistProfile('PUP', { sources });
  assert.equal(calls.musicbrainz, 1, 'the second open is answered from the cache');
});

test('a source that fails leaves a partial profile, re-checked within the hour, keeping what we had', async () => {
  const { sources } = stubSources({ wikiFails: true });
  const p = await artistProfile('PUP', { sources, force: true });
  assert.equal(p.status, 'partial');
  assert.equal(p.bio, 'PUP is a Canadian punk rock band.', 'the earlier bio survives a failed re-check');
  assert.equal(p.apple.url, 'https://music.apple.com/us/artist/pup/722031743');

  db.prepare("UPDATE artist_profiles SET fetched_at = datetime('now', '-2 hours') WHERE artist_key = 'pup'").run();
  assert.equal(getArtistProfile('pup').fresh, false);
});

test('with nothing cached, a failing source still shows the rest, and photos fall back to album art', async () => {
  const { sources } = stubSources({ wikiFails: true });
  const p = await artistProfile('Sorcha Richardson', { sources });
  assert.equal(p.status, 'partial');
  assert.equal(p.bio, null);
  assert.equal(p.image, 'https://is1-ssl.mzstatic.com/image/thumb/x/300x300bb.jpg');
  assert.deepEqual(p.failed, ['Wikipedia']);
});

test('the artist sheet marks your favorites among similar artists', async () => {
  setFavoriteArtist('Joyce Manor', 4);
  const view = profileView(getArtistProfile('pup'));
  assert.deepEqual(view.similar, [
    { name: 'Jeff Rosenstock', favorite: false },
    { name: 'Joyce Manor', favorite: true },
  ]);
  assert.equal(profileView(null), null);
});

// ── Wikipedia by name, Apple match, and the shared limits ───────────────────

const page = (description, extra = {}) => ({
  type: 'standard',
  extract: `Someone, ${description}.`,
  description,
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/X' } },
  ...extra,
});

test('Wikipedia by name: a performer page is taken, a namesake is turned away', async () => {
  const pages = {
    'Hannibal Buress': page('American stand-up comedian (born 1983)'),
    'Nate Jackson': page('American football player'),
    'Nate Jackson (comedian)': page('American comedian'),
    'Movements (band)': page('American post-hardcore band'),
    'Ali Siddiq': page('American actor'),
  };
  const asked = [];
  const summary = async (title) => {
    asked.push(title);
    return pages[title] || null;
  };
  assert.equal((await wikipediaByName('Hannibal Buress', 'comedy', summary)).description, 'American stand-up comedian (born 1983)');
  assert.deepEqual(asked, ['Hannibal Buress'], 'a performer page by plain name is enough');
  assert.equal((await wikipediaByName('Nate Jackson', 'comedy', summary)).description, 'American comedian');
  asked.length = 0;
  assert.equal(await wikipediaByName('Movements', null, summary), null, 'a band is never looked up by name');
  assert.deepEqual(asked, []);
  asked.length = 0;
  assert.equal(await wikipediaByName('Ali Siddiq', 'comedy', summary), null, 'an actor of the same name is not the comic');
  assert.deepEqual(asked, ['Ali Siddiq', 'Ali Siddiq (comedian)']);
});

test("Wikipedia by name: for a comedian, a singer's, comic-book artist's or producer's page is a namesake", async () => {
  const pages = {
    'Sam Smith': page('English singer-songwriter (born 1992)'),
    'Sam Smith (comedian)': page('American stand-up comedian'),
    'Dan Parent': page('American comic book artist'),
    'Joe Roth': page('American film producer'),
    'Joe Roth (comedian)': page('American comedian and podcaster'),
    'Tig Notaro': page('American comedian, writer and actress (born 1971)'),
  };
  const asked = [];
  const summary = async (title) => {
    asked.push(title);
    return pages[title] || null;
  };
  assert.equal((await wikipediaByName('Sam Smith', 'comedy', summary)).description, 'American stand-up comedian');
  assert.deepEqual(asked, ['Sam Smith', 'Sam Smith (comedian)'], 'the real "(comedian)" page is still tried');
  asked.length = 0;
  assert.equal(await wikipediaByName('Dan Parent', 'comedy', summary), null, '"comic book artist" is not a comic');
  assert.deepEqual(asked, ['Dan Parent', 'Dan Parent (comedian)']);
  assert.equal((await wikipediaByName('Joe Roth', 'comedy', summary)).description, 'American comedian and podcaster');
  // A comedian's own page, however long its description, is taken first time.
  asked.length = 0;
  assert.equal((await wikipediaByName('Tig Notaro', 'comedy', summary)).description, 'American comedian, writer and actress (born 1971)');
  assert.deepEqual(asked, ['Tig Notaro']);
});

// Every outbound request answered from a table, so the real fetchers run
// without the network. Unknown URLs are a 404.
function stubHttp(routes) {
  const asked = [];
  const original = axios.get;
  axios.get = async (url, { params = {} } = {}) => {
    asked.push(decodeURIComponent(url));
    for (const [matches, reply] of routes) {
      if (!matches(url, params)) continue;
      if (reply instanceof Error) throw reply;
      return { data: typeof reply === 'function' ? reply(url, params) : reply };
    }
    throw Object.assign(new Error('HTTP 404'), { response: { status: 404 } });
  };
  return { asked, restore: () => { axios.get = original; } };
}

// The rate limits' waits pass instantly on a fake clock.
function fakeClock() {
  let t = 0;
  const slept = [];
  limits.setClock({ now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  limits.resetLimits();
  return { slept };
}

const wikiSummary = (title) => (url) => url.endsWith(`/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
const isItunes = (entity) => (url, params) => url.startsWith('https://itunes.apple.com/search') && params.entity === entity;

test(`a comedian MusicBrainz doesn't know is found on Wikipedia as "Name (comedian)"`, async () => {
  fakeClock();
  const http = stubHttp([
    [(url) => url === 'https://musicbrainz.org/ws/2/artist', { artists: [] }],
    [wikiSummary('Nate Jackson'), page('American football player (born 1979)')],
    [wikiSummary('Nate Jackson (comedian)'), page('American stand-up comedian')],
    [isItunes('musicArtist'), { results: [{ wrapperType: 'artist', artistId: 42, artistName: 'Nate Jackson', primaryGenreName: 'Comedy' }] }],
    [isItunes('song'), { results: [song(42, 'Super Funny'), song(42, 'Pancakes'), song(42, 'Uncle Pete')] }],
  ]);
  try {
    const p = await artistProfile('Nate Jackson', { hint: 'comedy' });
    assert.equal(p.status, 'found');
    assert.equal(p.description, 'American stand-up comedian');
    assert.equal(p.bio, 'Someone, American stand-up comedian.');
    assert.equal(p.apple.genre, 'Comedy');
    assert.equal(p.apple.match, 'name', 'no MusicBrainz link, so Apple was matched by name');
    assert.ok(http.asked.some((u) => u.endsWith('Nate_Jackson_(comedian)')));
  } finally {
    http.restore();
    limits.setClock();
  }
});

test('a band MusicBrainz doesn’t know is never looked up on Wikipedia by name', async () => {
  fakeClock();
  const http = stubHttp([
    [(url) => url === 'https://musicbrainz.org/ws/2/artist', { artists: [] }],
    [wikiSummary('Lemon Twigs Junior'), page('American indie rock band')],
  ]);
  try {
    const p = await artistProfile('Lemon Twigs Junior');
    assert.equal(p.status, 'not_found');
    assert.equal(p.description, null, 'a same-named band’s page is probably somebody else');
    assert.ok(!http.asked.some((u) => u.includes('wikipedia.org')));
  } finally {
    http.restore();
    limits.setClock();
  }
});

test("Apple: the artist MusicBrainz links to is recorded as an 'mb' match, ahead of a namesake", async () => {
  const { slept } = fakeClock();
  const http = stubHttp([
    [(url) => url === 'https://musicbrainz.org/ws/2/artist', { artists: [{ id: PUP_MB.id, name: 'PUP', score: 100, tags: [] }] }],
    [(url) => url.startsWith('https://musicbrainz.org/ws/2/artist/'), PUP_MB],
    [(url) => url.startsWith('https://www.wikidata.org/'), { entities: { Q16967929: { sitelinks: { enwiki: { title: 'PUP (band)' } } } } }],
    [wikiSummary('PUP (band)'), page('Canadian punk rock band')],
    [isItunes('musicArtist'), { results: [
      { wrapperType: 'artist', artistId: 1398609389, artistName: 'PUP', primaryGenreName: "Children's Music" },
      { wrapperType: 'artist', artistId: 722031743, artistName: 'PUP', primaryGenreName: 'Alternative' },
    ] }],
    [isItunes('song'), { results: [song(722031743, 'Kids'), song(722031743, 'DVP'), song(722031743, 'Totally Fine')] }],
    [(url) => url.includes('listenbrainz'), []],
  ]);
  try {
    const p = await artistProfile('PUP', { force: true });
    assert.equal(p.apple.match, 'mb');
    assert.equal(p.apple.genre, 'Alternative');
    assert.equal(p.description, 'Canadian punk rock band', 'a linked page needs no guard');
    // Through the shared limits: the two MusicBrainz calls 1.1 s apart, the
    // two Wikimedia ones (Wikidata, then the page) 250 ms apart.
    assert.deepEqual(slept, [1100, 250]);
  } finally {
    http.restore();
    limits.setClock();
  }
});

// MusicBrainz knows "Static Saints" and links their Apple id 111.
const SAINTS_MB = {
  id: 'saints-mbid',
  name: 'Static Saints',
  type: 'Group',
  area: { name: 'Seattle' },
  'life-span': { begin: '2015' },
  relations: [{ type: 'streaming', url: { resource: 'https://music.apple.com/us/artist/static-saints/111' } }],
};
const appleArtist = (artistId, primaryGenreName) => ({
  wrapperType: 'artist', artistId, artistName: 'Static Saints', primaryGenreName,
  artistLinkUrl: `https://music.apple.com/us/artist/static-saints/${artistId}?uo=4`,
});
const isLookup = (id, entity) => (url, params) =>
  url.startsWith('https://itunes.apple.com/lookup') && String(params.id) === String(id) && params.entity === entity;

function saintsHttp({ linked }) {
  return stubHttp([
    [(url) => url === 'https://musicbrainz.org/ws/2/artist', { artists: [{ id: 'saints-mbid', name: 'Static Saints', score: 100, tags: [] }] }],
    [(url) => url.startsWith('https://musicbrainz.org/ws/2/artist/'), SAINTS_MB],
    // Apple's artist search only turns up a namesake, a Christian act.
    [isItunes('musicArtist'), { results: [appleArtist(999, 'Christian')] }],
    [isLookup(111), { results: linked ? [appleArtist(111, 'Punk')] : [] }],
    [isItunes('song'), (url, params) => ({
      results: params.term === 'Static Saints'
        ? [song(999, 'Worship Song'), song(111, 'Static'), song(111, 'Saints'), song(111, 'Feedback')]
        : [],
    })],
    [(url) => url.includes('listenbrainz'), []],
  ]);
}

test("Apple: when the search only finds a namesake, the id MusicBrainz links is looked up instead", async () => {
  fakeClock();
  const http = saintsHttp({ linked: true });
  try {
    const p = await artistProfile('Static Saints', { force: true });
    assert.equal(p.apple.url, 'https://music.apple.com/us/artist/static-saints/111');
    assert.equal(p.apple.genre, 'Punk');
    assert.equal(p.apple.match, 'mb');
    assert.deepEqual(p.apple.songs.map((x) => x.title), ['Static', 'Saints', 'Feedback']);
    assert.ok(http.asked.some((u) => u.startsWith('https://itunes.apple.com/lookup')));
  } finally {
    http.restore();
    limits.setClock();
  }
});

test("Apple: a namesake that disagrees with MusicBrainz's link, which Apple no longer knows, is a 'conflict'", async () => {
  fakeClock();
  const http = saintsHttp({ linked: false });
  try {
    const p = await artistProfile('Static Saints', { force: true });
    // Kept for the sheet, but rows won't play it or take its genre (src/feel.js).
    assert.equal(p.apple.match, 'conflict');
    assert.equal(p.apple.genre, 'Christian');
    // …and its album art isn't the band's photo.
    assert.ok(p.apple.songs[0].artwork, 'the songs have artwork to borrow');
    assert.equal(p.image, null);
  } finally {
    http.restore();
    limits.setClock();
  }
});

test('opening an artist the background prefetch is fetching joins that lookup instead of deadlocking', { timeout: 5000 }, async () => {
  limits.resetLimits();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let jobSeen = null;
  const sources = {
    musicbrainz: async (name, mbid, job) => {
      jobSeen = job;
      await gate;
      // The background holds back while a sheet is loading, so without the
      // hand-over this would wait on the very sheet that is waiting on it.
      await limits.itunesTurn(job);
      return null;
    },
    wikipedia: async () => page('American indie rock band'),
    apple: async () => null,
    similar: async () => [],
  };
  const background = artistProfile('Lemon Shark Parade', { sources, background: true });
  await Promise.resolve();
  assert.equal(jobSeen.background, true);
  const sheet = artistProfile('Lemon Shark Parade', { sources });
  assert.equal(limits.foregroundBusy(), true);
  assert.equal(jobSeen.background, false, 'the lookup is the sheet\'s now');
  release();
  const [a, b] = await Promise.all([background, sheet]);
  assert.equal(a.description, 'American indie rock band');
  assert.equal(b.status, 'found');
  assert.equal(limits.foregroundBusy(), false);
});
