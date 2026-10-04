// Tests for artist profiles (the artist sheet): parsing MusicBrainz, Wikipedia
// and Apple responses, and how profiles are assembled and cached. The sources
// are stubbed, so nothing here touches the network. Runs against a throwaway
// in-memory database.
import './helpers/memory-db.js'; // must stay the first import
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { setFavoriteArtist, getArtistProfile } = await import('../src/db/artists.js');
const { parseMusicBrainz, parseWikiSummary, pickAppleArtist, topSongs, artistProfile } = await import(
  '../src/enrich/profile.js'
);
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
