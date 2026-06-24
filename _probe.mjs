import { discoverSource } from './src/discovery.js';
const venues = [
  ['Showbox', 'https://www.showboxpresents.com/'],
  ['Paramount Theatre', 'https://www.stgpresents.org/paramount'],
  ['Moore Theatre', 'https://www.stgpresents.org/moore'],
  ['Tacoma Dome', 'https://www.tacomadome.org/'],
  ['Tacoma Comedy Club', 'https://tacomacomedyclub.com/'],
  ['The Crocodile', 'https://www.thecrocodile.com/'],
  ['Neumos', 'https://www.neumos.com/'],
  ['Chop Suey', 'https://www.chopsuey.com/'],
];
const results = await Promise.allSettled(venues.map(([n,u]) => discoverSource(u)));
results.forEach((r,i) => {
  const [name] = venues[i];
  if (r.status === 'rejected') { console.log(`${name.padEnd(20)} ERROR ${r.reason?.message||r.reason}`); return; }
  const v = r.value;
  if (v.error) { console.log(`${name.padEnd(20)} fetch-failed: ${v.error}`); return; }
  const rec = v.recommended;
  let detail = '';
  if (rec.method === 'rss') detail = `${rec.config.url} (${rec.sampleCount} items)`;
  else if (rec.method === 'ical') detail = `${rec.config.url} (${rec.sampleCount} events)`;
  else if (rec.method === 'jsonld') detail = `${rec.sampleCount} events embedded`;
  else detail = 'scrape fallback';
  console.log(`${name.padEnd(20)} -> ${rec.method.toUpperCase().padEnd(7)} ${detail}` + (v.providers.length?`  [providers: ${v.providers.join(', ')}]`:''));
});
