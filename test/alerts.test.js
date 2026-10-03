// Tests for alerts: new-show pushes for your artists, the weekly digest and
// the ntfy request itself. Nothing is sent to ntfy.sh — a fake sender records
// messages, and a local server stands in for ntfy. In-memory database.
import './helpers/memory-db.js'; // must stay the first import
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { migrate } = await import('../src/db/migrate.js');
const { default: db } = await import('../src/db/index.js');
const { upsertEvent, setInterested } = await import('../src/db/queries.js');
const { setFavoriteArtist } = await import('../src/db/artists.js');
const { parseTopic, sendNtfy } = await import('../src/alerts/ntfy.js');
const { saveAlertSettings, checkArtistAlerts, sendDigest, formatDay } = await import('../src/alerts/index.js');

migrate();
db.exec('DELETE FROM favorite_artists; DELETE FROM manual_genres; DELETE FROM events;');
setFavoriteArtist('Lord Huron', 5);
setFavoriteArtist('Waxahatchee', 5);

const TODAY = '2099-03-01';
let n = 0;
const show = (title, date, extra = {}) =>
  upsertEvent({ source: 'scrape', source_name: `venue${(n += 1)}`, title, venue: 'Paramount Theatre', city: 'Seattle', date, category: 'music', ...extra });
const outbox = [];
const send = async (target, msg) => outbox.push({ target, ...msg });
const check = () => checkArtistAlerts({ send, today: TODAY });

test('parseTopic: a bare topic, a topic URL on another server, and junk', () => {
  assert.deepEqual(parseTopic('eventlight-abc123', 'https://ntfy.sh'), { server: 'https://ntfy.sh', topic: 'eventlight-abc123' });
  assert.deepEqual(parseTopic('https://push.example.com/ntfy/my_topic'), { server: 'https://push.example.com/ntfy', topic: 'my_topic' });
  assert.equal(parseTopic(''), null);
  assert.equal(parseTopic('has spaces'), null);
  assert.equal(parseTopic('https://ntfy.sh/'), null);
  assert.equal(parseTopic('javascript:alert(1)'), null);
});

test('no topic, no alerts', async () => {
  show('Lord Huron', '2099-04-10');
  assert.deepEqual(await check(), { sent: 0, skipped: 'off' });
  assert.equal(outbox.length, 0);
});

test('the first check sends one "alerts are on" message listing what is already on the calendar', async () => {
  assert.equal(saveAlertSettings({ topic: 'eventlight-test' }), null);
  const r = await check();
  assert.equal(r.welcome, true);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].title, 'EventLight alerts are on');
  assert.match(outbox[0].message, /Already on the calendar:\n• Fri, Apr 10 · Lord Huron @ Paramount Theatre/);
  assert.deepEqual(outbox[0].target, { server: 'https://ntfy.sh', topic: 'eventlight-test' });
  // Nothing new since: nothing sent.
  assert.deepEqual(await check(), { sent: 0 });
  assert.equal(outbox.length, 1);
});

test('a new show by a favorite alerts once, even when a second source lists it', async () => {
  outbox.length = 0;
  show('Waxahatchee w/ MJ Lenderman', '2099-05-02', { time: '20:00', ticket_url: 'https://tix.example/wax' });
  await check();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].title, 'New show: Waxahatchee');
  assert.equal(outbox[0].message, 'Sat, May 2, 8 PM · Paramount Theatre, Seattle\nWaxahatchee is a favorite');
  assert.equal(outbox[0].click, 'https://tix.example/wax');
  // Ticketmaster lists the same show later under another title: no second alert.
  upsertEvent({ source: 'api', source_name: 'ticketmaster', title: 'Waxahatchee - Tigers Blood Tour', venue: 'Paramount', city: 'Seattle', date: '2099-05-02', lineup: ['Waxahatchee'] });
  await check();
  assert.equal(outbox.length, 1);
});

test('shows you starred and acts that only contain a favorite\'s name don\'t alert', async () => {
  outbox.length = 0;
  show('Lord Huron', '2099-06-01');
  setInterested(db.prepare("SELECT id FROM events WHERE date = '2099-06-01'").get().id, true);
  show('Lord Huronettes', '2099-06-02');
  await check();
  assert.equal(outbox.length, 0);
});

test('many new shows at once arrive as one message', async () => {
  outbox.length = 0;
  for (let d = 10; d < 17; d += 1) show('Lord Huron', `2099-07-${d}`);
  const r = await check();
  assert.deepEqual(r, { sent: 1, shows: 7 });
  assert.equal(outbox[0].title, '7 new shows by your artists');
  assert.equal(outbox[0].message.split('\n').length, 7);
});

test('a send that fails part-way resends only what did not go out', async () => {
  outbox.length = 0;
  show('Waxahatchee', '2099-08-01');
  show('Waxahatchee', '2099-08-02');
  let calls = 0;
  const flaky = async (target, msg) => {
    calls += 1;
    if (calls === 2) throw new Error('ntfy: down');
    outbox.push(msg);
  };
  await assert.rejects(checkArtistAlerts({ send: flaky, today: TODAY }), /down/);
  assert.equal(outbox.length, 1);
  await check();
  assert.equal(outbox.length, 2);
  assert.notEqual(outbox[0].message, outbox[1].message);
});

test('a new topic starts over with an "alerts are on" message', async () => {
  outbox.length = 0;
  saveAlertSettings({ topic: 'eventlight-other' });
  await check();
  assert.equal(outbox[0].title, 'EventLight alerts are on');
  assert.equal(saveAlertSettings({ topic: 'bad topic!' }) !== null, true);
});

test('the digest lists the next two weeks in date order with a short why', async () => {
  outbox.length = 0;
  db.exec("INSERT INTO manual_genres (genre, weight) VALUES ('punk', 4)");
  show('Some Punk Band', '2099-03-09', { genre_tags: ['punk'] });
  show('Far Away Punk Band', '2099-04-30', { genre_tags: ['punk'] });
  await sendDigest({ send, today: TODAY });
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].title, 'Top picks for the next two weeks');
  assert.equal(outbox[0].message, `• ${formatDay('2099-03-09')} · Some Punk Band @ Paramount Theatre — punk`);
  saveAlertSettings({ digest: false });
  assert.deepEqual(await sendDigest({ send, today: TODAY }), { sent: 0, skipped: 'off' });
  assert.equal((await sendDigest({ send, today: TODAY, force: true })).sent, 1);
});

test('sendNtfy posts JSON to the server root with the topic and an optional token', async () => {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.statusCode = got.length === 1 ? 200 : 429;
      res.end(got.length === 1 ? '{}' : JSON.stringify({ error: 'limit reached' }));
    });
  });
  const port = await new Promise((r) => server.listen(0, () => r(server.address().port)));
  after(() => server.close());
  const target = parseTopic(`http://127.0.0.1:${port}/eventlight-x`);
  await sendNtfy(target, { title: 'T', message: 'M', click: 'https://x.example', tags: ['bell'], priority: 4 }, { token: 'tk_1' });
  assert.deepEqual(got[0], {
    url: '/',
    auth: 'Bearer tk_1',
    body: { topic: 'eventlight-x', title: 'T', message: 'M', click: 'https://x.example', tags: ['bell'], priority: 4 },
  });
  await assert.rejects(sendNtfy(target, { title: 'T', message: 'M' }, { token: '' }), /ntfy: limit reached/);
  assert.equal(got[1].auth, undefined);
});
