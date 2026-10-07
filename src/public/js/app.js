// EventLight dashboard — Week, a page for each day, Explore and Saved, plus
// the detail sheet that slides up over them (a show, a film, an artist, a
// venue). A plain ES module with no build step: views render fetched JSON
// into HTML strings, and one delegated click handler drives every button.
//
// The server dresses every listing (src/annotate.js): what it is (_kind,
// _flags, _regular), how it reads in a list (_headline, _feel — genres,
// sounds-like, a song to preview) and how it ranks (_pick, _role).

const PICK = 8; // a top pick's minimum (PICK_MIN in src/week.js)
const GOOD = 3; // listings below this are dimmed (GOOD_MIN in src/week.js)

const view = document.getElementById('view');
const sheetEl = document.getElementById('sheet');
const sheetBody = document.getElementById('sheet-body');
const sheetActs = document.getElementById('sheet-acts');
const backdrop = document.getElementById('backdrop');

const state = {
  route: 'week',
  hash: '',
  today: localISO(new Date()),
  brief: null,
  morePicks: false,
  day: null,
  dayData: null,
  dayTarget: null, // a section to scroll to once the day page draws ('g-film')
  open: new Set(), // day-page folds the person opened (groups, regulars, started)
  scroll: {},
  saved: null,
  curated: null,
  facets: { cities: [] },
  movies: null,
  showLeftOut: false,
  explore: {
    q: '', type: 'all', city: 'all', sort: 'date', mode: 'list',
    page: 1, pages: 1, total: 0, events: [], films: {}, filmsTo: null, loading: false,
    month: localISO(new Date()).slice(0, 7), counts: {},
  },
};

// Every copy of an event currently on screen, so Going / Maybe can update
// them all; films are kept by id for their sheet.
const shown = new Map();
const films = new Map();
const sheet = { stack: [], opener: null };

// ── Helpers ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const enc = (s) => esc(encodeURIComponent(s));
// http(s) only — never render a scraped javascript:/data: URL as an href.
const isHttp = (u) => /^https?:\/\//i.test(u || '');

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

function localISO(d) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}
function toDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(iso, n) {
  const d = toDate(iso);
  d.setDate(d.getDate() + n);
  return localISO(d);
}
// A real calendar date: "2026-11-31" doesn't survive the round trip.
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && localISO(toDate(s)) === s;
const dow = (iso) => toDate(iso).toLocaleDateString('en-US', { weekday: 'short' });
const weekday = (iso) => toDate(iso).toLocaleDateString('en-US', { weekday: 'long' });
const dayNum = (iso) => toDate(iso).getDate();
const monthDay = (iso) => toDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const shortDate = (iso) => toDate(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

// "Tonight", "Tomorrow", a weekday within the week, else "Sat, Oct 10".
function dayName(iso) {
  const today = state.today;
  if (iso === today) return 'Tonight';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  if (iso > today && iso <= addDays(today, 6)) return weekday(iso);
  return shortDate(iso);
}
// "tonight", "for tomorrow", "for Friday", "for Sat, Nov 14".
function forDay(iso) {
  const name = dayName(iso);
  return name === 'Tonight' ? 'tonight' : `for ${name === 'Tomorrow' ? 'tomorrow' : name}`;
}

// "20:00" → "8:00p".
function fmtTime(t) {
  if (!t || !/^\d{2}:\d{2}/.test(t)) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${h >= 12 ? 'p' : 'a'}`;
}
function clock(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relTime(iso) {
  if (!iso) return 'never';
  const then = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (Number.isNaN(mins)) return iso;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

const kindOf = (e) => e.kind || e.category;
const isFilm = (e) => kindOf(e) === 'film';
function lineupOf(e) {
  if (Array.isArray(e._lineup)) return e._lineup;
  try {
    const list = JSON.parse(e.lineup || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
// The name to lead with: the server's headline (the act, or the title for a
// trivia night or a play), else the headliner when the title was parsed.
const headline = (e) => e._headline || (isFilm(e) ? e.title : lineupOf(e)[0] || e.title);
function runtime(min) {
  return min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '';
}

// What it is, as a tag: Music, Stand-up, Film, Drag, Trivia… The server's
// kind when there is one, else the source category.
const FALLBACK_KIND = {
  film: { label: 'Film', family: 'film' },
  comedy: { label: 'Stand-up', family: 'comedy' },
  music: { label: 'Music', family: 'music' },
};
const kindInfo = (e) => e._kind || FALLBACK_KIND[kindOf(e)] || { label: 'Event', family: 'other' };
function kindTag(e, { plain = false } = {}) {
  const k = kindInfo(e);
  if (plain) return `<span class="tk-kind">${esc(k.label)}</span>`;
  // A comedy open mic wears comedy's colors; dashed like any regular.
  return `<span class="kind k-${esc(k.domain || k.family)}${e._regular ? ' reg' : ''}">${esc(k.label)}</span>`;
}

// A film's one line: "Drama · 1984 · 2h 25m · MC 88".
function filmLine(f) {
  const crit = f.mc_score != null ? `MC ${f.mc_score}` : f.rt_score != null ? `RT ${f.rt_score}%` : '';
  return [f.genre, f.year, runtime(f.runtime), crit].filter(Boolean).join(' · ');
}

const tagList = (tags) => (tags || []).map((t) => `<span class="${t.hit ? 'hit' : ''}">${esc(t.tag)}</span>`).join(' · ');
const LINK_GLYPH = { curated: '✎', favorite: '♥', learned: '★', similar: '≈' };

// The "what is it" line: genres (yours highlighted), a descriptor for an act
// we know little about, a comedian's run, a film's genre and reviews, a
// regular night's cadence.
function feelLine(e) {
  const f = e._feel || {};
  if (isFilm(e)) return esc(f.line || filmLine(e));
  const k = kindInfo(e);
  const tags = tagList(f.tags);
  const run = e._run?.text || '';
  if (k.family === 'comedy') {
    const n = lineupOf(e).length;
    const what = f.descriptor
      || (k.key === 'improv' ? 'improv' : k.key === 'podcast' ? 'live podcast' : n >= 4 ? `showcase · ${n} comics` : 'stand-up');
    return esc([what, run].filter(Boolean).join(' · '));
  }
  if (k.family === 'music') {
    let out = tags;
    if (out && f.descriptor && (f.tags || []).length < 2) out = `${esc(f.descriptor)} · ${out}`;
    if (!out) out = f.habit ? `<i>${esc(f.habit)}</i>` : esc(f.descriptor || f.bill || '');
    return [esc(e._regular?.cadence || ''), esc(f.program || ''), out, esc(run)].filter(Boolean).join(' · ');
  }
  return [esc(e._regular?.cadence || run), esc(f.program || ''), tags].filter(Boolean).join(' · ');
}

// The "is it for us" line: a favorite on the bill, who they sound like, who
// they're for, or who else is playing.
function linkLine(e) {
  const l = e._feel?.link;
  if (!l && isFilm(e)) {
    const flag = (e._flags || [])[0]?.label || (e.special ? 'Special screening' : '');
    return esc([flag, e.director ? `dir. ${e.director}` : ''].filter(Boolean).join(' · '));
  }
  if (!l) return '';
  const g = LINK_GLYPH[l.kind];
  // A film's flag comes first: "One night only · ♥ One of your favorites".
  const pre = l.pre ? `${esc(l.pre)} · ` : '';
  return `${pre}${g ? `<span class="g" aria-hidden="true">${g}</span> ` : ''}${esc(l.text)}`;
}

// "For fans of A, B & C", when the link line went to something else.
function fansLine(e, limit = 3) {
  const f = e._feel;
  if (!f?.fans?.length || f.link?.kind === 'fans') return '';
  const names = f.fans.slice(0, limit).map((a) => `${a.favorite ? '♥ ' : ''}${a.name}`);
  return `For fans of ${esc(names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names[0])}`;
}

function planText(e) {
  if (e.going) return '<b class="plan">✓ Going</b>';
  if (e.interested) return '<b class="plan">✓ Maybe</b>';
  return '';
}

function metaLine(e) {
  if (isFilm(e)) {
    const times = (e.times || []).map(fmtTime).join(', ');
    return esc([e.venue, times].filter(Boolean).join(' · '));
  }
  const times = e._times?.length > 1 ? e._times.map(fmtTime).join(' & ') : '';
  // "Free" in the price already says it.
  const flag = (e._flags || []).find((f) => !(f.key === 'free' && /free/i.test(e.price_range || '')));
  // Your plan leads, so on a narrow phone it's the venue that gets cut short.
  return [
    planText(e),
    flag ? `<b class="flag">${esc(flag.label)}</b>` : '',
    esc([e.venue, e.city, times, e.price_range].filter(Boolean).join(' · ')),
  ].filter(Boolean).join(' · ');
}

// A song to preview: a round play button (rows) or "▶ Listen" (tickets).
function previewButton(e, { label = false } = {}) {
  const p = e._feel?.preview;
  if (!p || !isHttp(p.url)) return '';
  const name = `Play a preview: ${p.title} by ${p.artist}`;
  return label
    ? `<button class="pb listen" data-act="play" data-key="${enc(p.url)}" aria-label="${esc(name)}" aria-pressed="false"><span class="pl-off">▶ Listen</span><span class="pl-on">❚❚ Pause</span></button>`
    : `<button class="pv" data-act="play" data-key="${enc(p.url)}" aria-label="${esc(name)}" aria-pressed="false"><span class="play" aria-hidden="true"></span></button>`;
}

function register(e) {
  if (isFilm(e)) {
    films.set(e.id, e);
    return;
  }
  if (!shown.has(e.id)) shown.set(e.id, new Set());
  shown.get(e.id).add(e);
}

// ── Pieces ──────────────────────────────────────────────────────────────────
function planButtons(e) {
  const going = Boolean(e.going);
  const maybe = !going && Boolean(e.interested);
  return (
    `<button class="pb ${going ? 'on-going' : ''}" data-plan="going" data-id="${e.id}" aria-pressed="${going}">${going ? '✓ Going' : 'Going'}</button>` +
    `<button class="pb ${maybe ? 'on-maybe' : ''}" data-plan="maybe" data-id="${e.id}" aria-pressed="${maybe}">${maybe ? '✓ Maybe' : 'Maybe'}</button>`
  );
}

// One listing in a list. The whole row opens it; a play button beside it
// previews the headliner's best-known song.
//   time + kind │ title
//               │ what it is (genres, a descriptor, a film's reviews)
//               │ is it for us (a favorite, sounds like, for fans of)
//               │ where · price · flag · your plan
function row(e, { day = false, reason = '' } = {}) {
  register(e);
  const film = isFilm(e);
  const time = fmtTime(e.time);
  const when = day ? `<span class="r-date">${esc(monthDay(e.date))}</span>${time || esc(dow(e.date))}` : time || '—';
  const pick = e._pick ?? e._score ?? 0;
  const feel = feelLine(e);
  const link = reason ? `<span class="g" aria-hidden="true">✎</span> “${esc(reason)}”` : linkLine(e);
  const fans = fansLine(e);
  const pv = previewButton(e);
  return `<article class="row ${!film && pick < GOOD ? 'dim' : ''} ${pv ? 'has-pv' : ''}">
    <div class="r-stub"><span class="r-time">${when}</span>${kindTag(e)}</div>
    <div class="r-body">
      <button class="r-main" data-open="${film ? 'film' : 'event'}" data-key="${esc(e.id)}"><span class="r-title">${!film && pick >= PICK ? '<span class="r-star" aria-label="Top pick">★</span> ' : ''}${esc(headline(e))}</span></button>
      ${feel ? `<span class="r-feel">${feel}</span>` : ''}
      ${link ? `<span class="r-link">${link}</span>` : ''}
      ${fans ? `<span class="r-fans">${fans}</span>` : ''}
      <span class="r-meta">${metaLine(e)}</span>
    </div>
    ${pv}
  </article>`;
}

// A top pick or a Going show, as a ticket with a date stub.
function ticket(e, { role = '' } = {}) {
  register(e);
  const film = isFilm(e);
  const going = Boolean(e.going);
  const time = fmtTime(e.time);
  const f = e._feel || {};
  const when = role ? `${role}${time ? ` · ${time}` : ''}` : `${dayName(e.date)}${time ? ` · ${time}` : ''}`;
  const tags = tagList(f.tags);
  const lines = film
    ? [
      `<span class="tk-tags">${esc(f.line || filmLine(e))}</span>`,
      f.synopsis || e.synopsis ? `<span class="tk-sub tk-syn">${esc(f.synopsis || e.synopsis)}</span>` : '',
    ]
    : [
      f.program ? `<span class="tk-sub">${esc(f.program)}</span>` : '',
      f.descriptor ? `<span class="tk-sub">${esc(f.descriptor)}</span>` : '',
      tags ? `<span class="tk-tags">${tags}</span>` : f.habit ? `<span class="tk-tags"><i>${esc(f.habit)}</i></span>` : '',
    ];
  const link = linkLine(e);
  const fans = fansLine(e);
  const times = e._times?.length > 1 ? ` · ${e._times.map(fmtTime).join(' & ')}` : '';
  return `<article class="tk ${going ? 'is-going' : ''}">
    <div class="tk-stub" aria-hidden="true">
      <span class="tk-dow">${dow(e.date)}</span><span class="tk-num">${dayNum(e.date)}</span>
      <span class="tk-time">${time || '—'}</span>${kindTag(e, { plain: true })}
    </div>
    <button class="tk-main" data-open="${film ? 'film' : 'event'}" data-key="${esc(e.id)}">
      <span class="sr-only">${esc(kindInfo(e).label)}, ${esc(shortDate(e.date))}. </span>
      <span class="tk-when">${esc(when)}</span>
      <span class="tk-title">${esc(headline(e))}</span>
      ${lines.join('')}
      ${link ? `<span class="tk-why">${link}</span>` : ''}
      ${fans ? `<span class="tk-fans">${fans}</span>` : ''}
      <span class="tk-where">${esc([e.venue, e.city].filter(Boolean).join(' · ') + times)}</span>
    </button>
    <div class="tk-acts">${previewButton(e, { label: true })}${film ? '' : planButtons(e)}<span class="tk-price">${esc(film ? (e.times || []).map(fmtTime).join(', ') : e.price_range || '')}</span></div>
    ${going ? '<span class="tk-stamp" aria-hidden="true">Admit two</span>' : ''}
  </article>`;
}

function furtherCard(e) {
  register(e);
  const tags = (e._feel?.tags || []).map((t) => t.tag).join(' · ');
  return `<button class="fc" data-open="event" data-key="${e.id}">
    <span class="fc-date">${esc(kindInfo(e).label)} · ${esc(shortDate(e.date))}</span>
    <span class="fc-name">${esc(headline(e))}</span>
    ${tags ? `<span class="fc-tags">${esc(tags)}</span>` : ''}
    ${e._feel?.link ? `<span class="fc-why">${linkLine(e)}</span>` : ''}
    <span class="fc-ven">${esc([e.venue, e.city].filter(Boolean).join(' · '))}</span>
  </button>`;
}

// "◆ At the movies: Paris, Texas (one night) · Anora (MC 91) +2 ›" — a day's
// films in one line, opening the day page.
function filmsLink(date, count, top) {
  if (!count) return '';
  const names = top.map((f) => `${f.title}${f.note ? ` (${f.note})` : ''}`);
  const rest = count - top.length;
  const text = names.length ? `${names.join(' · ')}${rest > 0 ? ` +${rest}` : ''}` : `${count} ${count === 1 ? 'film' : 'films'}`;
  return `<a class="filmline" href="#day/${date}"><span class="g" aria-hidden="true">◆</span> <span class="fl-k">At the movies:</span> ${esc(text)} <span aria-hidden="true">›</span></a>`;
}

// The seven-day strip. On the Week it opens a day; on a day page it moves to
// another day without stacking up history (see goDay).
function strip(days, { current = null, today }) {
  return `<div class="strip">${days.map((d) => {
    const isToday = d.date === today;
    const on = d.date === current;
    const label = `${esc(dayName(d.date))}, ${d.total} on${d.hasPick ? ', with a top pick' : ''}`;
    const inner = `<span class="sd-w">${isToday ? 'Today' : dow(d.date)}</span><span class="sd-n">${dayNum(d.date)}</span>
      <span class="sd-c">${d.total}</span>${d.hasPick ? '<span class="lit"></span>' : ''}`;
    return current
      ? `<button class="sd ${on ? 'on' : ''} ${isToday ? 'today' : ''}" data-day="${d.date}" aria-label="${label}" ${on ? 'aria-current="date"' : ''}>${inner}</button>`
      : `<a class="sd ${isToday ? 'today on' : ''}" href="#day/${d.date}" aria-label="${label}">${inner}</a>`;
  }).join('')}</div>`;
}

// ── Week ────────────────────────────────────────────────────────────────────
function renderWeek() {
  const b = state.brief;
  if (!b) return '<p class="loading">Loading your week…</p>';
  const picks = b.picks.length
    ? `<div class="tickets">${(state.morePicks ? b.picks : b.picks.slice(0, 3)).map((e) => ticket(e)).join('')}</div>
       ${b.picks.length > 3 ? `<button class="more" data-act="morepicks">${state.morePicks ? 'Show fewer' : `${b.picks.length - 3} more top picks`}</button>` : ''}`
    : '<p class="note">No top picks this week. Add favorite artists and genres in <a href="/settings.html">Settings</a>, or mark shows Maybe so EventLight learns what you like.</p>';
  const days = b.days
    .map((d) => {
      const more = d.more - (d.films?.top?.length || 0);
      const quiet = !d.total
        ? 'Nothing listed yet.'
        : { regulars: 'Just the regulars.', started: 'Tonight’s best has already started.' }[d.picksLabel] || 'Quiet night. Nothing close to your taste.';
      return `<section>
      <a class="dh ${d.date === b.today ? 'today' : ''}" href="#day/${d.date}" title="${esc(d.dek || '')}">
        <span class="dl">${esc(dayName(d.date))}</span><span class="dd">${esc(shortDate(d.date))}</span><span class="dc">${d.total} on ›</span>
      </a>
      ${d.picks.length ? d.picks.map((e) => row(e)).join('') : `<p class="quiet">${quiet}</p>`}
      ${filmsLink(d.date, d.films?.count || 0, d.films?.top || [])}
      ${more > 0 ? `<a class="more" href="#day/${d.date}">+${more} more${d.regulars ? ` · ${d.regulars} weekly` : ''} ›</a>` : ''}
    </section>`;
    })
    .join('');
  const further = b.further.length
    ? `<h2 class="h">Further out</h2><div class="further">${b.further.map(furtherCard).join('')}</div>`
    : '';
  const note = [b.note?.text, b.curated?.criteria ? `Curated for “${b.curated.criteria}”` : ''].filter(Boolean);
  // One column on phones; on a wide screen, picks and further out sit beside the days.
  return `<h1 class="title">This week</h1>
    <div class="range">${esc(shortDate(b.from))} – ${esc(shortDate(b.to))}</div>
    ${note.length ? `<p class="wnote">${note.map(esc).join(' · ')}</p>` : ''}
    ${strip(b.days, { today: b.today })}
    <div class="week">
      <section class="w-picks"><h2 class="h">Top picks</h2>${picks}</section>
      <section class="w-days"><h2 class="h">Day by day</h2>${days}</section>
      ${further ? `<section class="w-further">${further}</section>` : ''}
    </div>`;
}

// ── A day ───────────────────────────────────────────────────────────────────
function countsLine(c) {
  return [
    [c.music, 'music'], [c.comedy, 'comedy'], [c.film, c.film === 1 ? 'film' : 'films'],
    [c.around, 'around town'], [c.regulars, 'weekly'],
  ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(' · ');
}

function fold(key, open, title, body) {
  return `<section class="fold ${open ? 'open' : ''}">
    <button class="fold-h" data-act="fold" data-key="${key}" aria-expanded="${open}">${title}<span class="chev" aria-hidden="true">${open ? '−' : '›'}</span></button>
    ${open ? `<div class="fold-b">${body}</div>` : ''}
  </section>`;
}

// One line for a weekly night: "7:00p  TRIVIA  Trivia Night · Airport Tavern · Every Thu".
function regularLine(e) {
  register(e);
  return `<button class="rl" data-open="event" data-key="${e.id}">
    <span class="r-time">${fmtTime(e.time) || '—'}</span>${kindTag(e)}
    <span class="rl-t">${esc(headline(e))}</span><span class="rl-m">${esc([e.venue, e._regular?.cadence].filter(Boolean).join(' · '))}</span>
  </button>`;
}

function renderDay() {
  const d = state.dayData;
  if (!d || d.date !== state.day) return '<p class="loading">Loading…</p>';
  const back = `<button class="backlink" data-act="day-back">‹ ${dayOrigin() === 'explore' ? 'Explore' : 'Week'}</button>`;
  const name = dayName(d.date);
  const pickHead = d.picks.length
    ? `Top picks ${forDay(d.date)}`
    : { regulars: 'Just the regulars', started: 'Already under way' }[d.picksLabel] || 'Nothing stands out';
  const pickNote = d.picks.length
    ? ''
    : d.counts.total
      ? `<p class="note">${{
        regulars: 'Only the weekly nights are on. They’re below.',
        started: 'Tonight’s best began over an hour ago. It’s under Already started, below.',
      }[d.picksLabel] || 'Nothing close to your taste. Everything on is below, best first.'}</p>`
      : `<p class="note">Nothing listed for ${esc(name === 'Tonight' ? 'tonight' : name)} yet. Venues usually post a few weeks out.</p>`;
  const picks = d.picks.length
    ? `<div class="tickets">${d.picks.map((e) => ticket(e, { role: e._role?.label || '' })).join('')}</div>`
    : '';
  const plans = d.plans.length ? `<section class="d-plans"><h2 class="h">Your other plans</h2>${d.plans.map((e) => row(e)).join('')}</section>` : '';
  const group = (g) => {
    const open = state.open.has(`g-${g.key}`);
    const ids = new Set(g.showIds);
    const list = open ? g.items : g.items.filter((e) => ids.has(e.id));
    const more = g.total - list.length;
    return `<section class="grp grp-${g.key}" id="g-${g.key}"><h2 class="h">${esc(g.label)} · ${g.total}</h2>
      ${list.map((e) => row(e)).join('')}
      ${more > 0 ? `<button class="loadmore" data-act="fold" data-key="g-${g.key}">+${more} more ${esc(g.label.toLowerCase())}</button>` : ''}
      ${open && g.total > g.showIds.length ? `<button class="more" data-act="fold" data-key="g-${g.key}">Show fewer</button>` : ''}
    </section>`;
  };
  const left = d.groups.filter((g) => g.key === 'film').map(group).join('');
  const right = d.groups.filter((g) => g.key !== 'film').map(group).join('');
  const regKinds = [...new Set(d.regulars.map((e) => kindInfo(e).label.toLowerCase()))].join(', ');
  // On a regulars-only day the fold starts open; tapping it still closes it.
  const regularsFirst = !d.picks.length && d.picksLabel === 'regulars';
  const regulars = d.regulars.length
    ? fold('regulars', regularsFirst !== state.open.has('regulars'),
      `<span>Every week · ${d.regulars.length}</span><span class="fold-k">${esc(regKinds)}</span>`,
      d.regulars.map(regularLine).join(''))
    : '';
  const started = d.started.length
    ? fold('started', state.open.has('started'), `<span>Already started · ${d.started.length}</span>`, d.started.map((e) => row(e)).join(''))
    : '';
  const nav = (dir, n) => {
    if (!n) return '<span></span>';
    const label = `${dir < 0 ? '‹ ' : ''}${esc(n.date === state.today ? 'Today' : weekday(n.date))}${dir > 0 ? ' ›' : ''}`;
    return `<button class="dnav ${dir > 0 ? 'next' : 'prev'}" data-day="${n.date}">
      <span class="dn-d">${label}</span><span class="dn-p">${n.picks ? `${n.picks} ${n.picks === 1 ? 'pick' : 'picks'}` : esc(shortDate(n.date))}</span></button>`;
  };
  return `<div class="dayp">
    <header class="d-head">
      ${back}
      <p class="d-eye">${esc(shortDate(d.date))}</p>
      <h1 class="title" tabindex="-1" id="day-title">${esc(name)}</h1>
      ${d.dek && d.counts.total ? `<p class="dek">${esc(d.dek)}</p>` : ''}
      ${d.counts.total ? `<p class="range">${esc(countsLine(d.counts))}</p>` : ''}
      ${strip(d.strip, { current: d.date, today: d.today })}
    </header>
    <div class="d-left">
      <section class="d-picks">${d.counts.total ? `<h2 class="h">${esc(pickHead)}</h2>` : ''}${picks}${pickNote}</section>
      ${plans}
      ${left}
    </div>
    <div class="d-right">${right}${regulars}${started}</div>
    <nav class="d-foot" aria-label="Other days">${nav(-1, d.prev)}${nav(1, d.next)}</nav>
  </div>`;
}

// ── Explore ─────────────────────────────────────────────────────────────────
const EXPLORE_TYPES = [['all', 'Everything'], ['music', 'Music'], ['comedy', 'Comedy'], ['film', 'Film'], ['other', 'Around town']];

function renderExplore() {
  const x = state.explore;
  const chip = (key, label) => `<button class="chip" data-act="x-type" data-key="${key}" aria-pressed="${x.type === key}">${label}</button>`;
  const seg = (act, key, label, on) => `<button data-act="${act}" data-key="${key}" aria-pressed="${on}">${label}</button>`;
  const cities = state.facets.cities.map((c) => `<option value="${esc(c)}" ${x.city === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const filmMode = x.type === 'film';
  // Filters above the results on phones; a sidebar that stays put on a wide screen.
  return `<h1 class="title">Explore</h1>
    <div class="explore">
      <div class="x-side">
        <input class="search" id="x-search" type="search" placeholder="Search shows, artists, venues" aria-label="Search" value="${esc(x.q)}" ${filmMode ? 'hidden' : ''} />
        <div class="controls">${EXPLORE_TYPES.map(([k, l]) => chip(k, l)).join('')}</div>
        ${filmMode ? '' : `<div class="controls">
          <select class="select" id="x-city" aria-label="City"><option value="all">Anywhere</option>${cities}</select>
          <div class="seg" role="group" aria-label="View">${seg('x-mode', 'list', 'List', x.mode === 'list')}${seg('x-mode', 'calendar', 'Calendar', x.mode === 'calendar')}</div>
        </div>`}
        ${filmMode || x.mode !== 'list' ? '' : `<div class="controls"><div class="seg" role="group" aria-label="Sort">${seg('x-sort', 'date', 'By date', x.sort === 'date')}${seg('x-sort', 'relevance', 'Best match', x.sort === 'relevance')}</div></div>`}
      </div>
      <div class="x-main">
        <div id="x-results">${renderResults()}</div>
        <p class="note">Missing a show? <button class="linkbtn" data-open="add" data-key="new">Add it yourself</button>.</p>
      </div>
    </div>`;
}

// Films on a date in Explore's list: one-off screenings and films worth
// planning around get their own rows; the rest fold into one line.
function exploreFilms(date) {
  const list = state.explore.films[date] || [];
  // Films you searched for are all listed.
  const rows = state.explore.q ? list : list.filter((f) => f.special || f._film?.eligible);
  const rest = list.filter((f) => !rows.includes(f));
  return { rows, line: filmsLink(date, rest.length, []) };
}

function renderResults() {
  const x = state.explore;
  if (x.type === 'film') return renderFilms();
  if (x.mode === 'calendar') return renderCalendar();
  if (x.loading && !x.events.length) return '<p class="loading">Loading…</p>';
  const filmDates = Object.keys(x.films || {});
  if (!x.events.length && !filmDates.length) {
    return '<div class="empty"><strong>Nothing matches</strong>Try another search or city. <button class="linkbtn" data-act="x-clear">Clear filters</button></div>';
  }
  const films = x.q ? Object.values(x.films || {}).flat().length : 0;
  const count = `<div class="count">${x.total} upcoming ${x.total === 1 ? 'show' : 'shows'}${films ? ` · ${films} ${films === 1 ? 'film showing' : 'film showings'}` : ''}</div>`;
  let body;
  if (x.sort === 'relevance') {
    body = x.events.map((e) => row(e, { day: true })).join('');
  } else {
    const byDate = new Map();
    for (const e of x.events) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }
    // A date with films and no shows still gets its header.
    for (const date of filmDates) if (!byDate.has(date)) byDate.set(date, []);
    body = [...byDate.keys()].sort()
      .map((date) => {
        const { rows, line } = exploreFilms(date);
        const items = [...byDate.get(date), ...rows].sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
        return `<div class="sh"><span class="dl">${esc(dayName(date))}</span><span class="dd">${esc(shortDate(date))}</span>
        <a class="dc" href="#day/${date}">Whole day ›</a></div>
        ${items.map((e) => row(e)).join('')}${line}`;
      })
      .join('');
  }
  const more = x.page < x.pages ? `<button class="loadmore" data-act="x-more">${x.loading ? 'Loading…' : 'Show more'}</button>` : '';
  return count + body + more;
}

// A cinema listing as a film entry, for the Film list and its sheet.
function movieEntry(m, special) {
  const first = new Date(m.showtimes[0]);
  return {
    id: `movie-${m.id}`, kind: 'film', movie_id: m.id, title: m.title, date: localISO(first), time: clock(first),
    showtimes: m.showtimes, venue: m.theater, city: m.city, ticket_url: m.url, special,
    rating: m.rating, runtime: m.runtime, director: m.director, starring: m.starring, year: m.year,
    genre: m.genre, synopsis: m.synopsis, poster_url: m.poster_url, trailer_url: m.trailer_url, mc_score: m.mc_score, rt_score: m.rt_score,
    crew: m.crew,
    // The server scores each film as of its next showing (flags, the feel
    // line, reasons); an older server's listing falls back to the basics.
    _kind: m._kind, _feel: m._feel, _film: m._film, _pick: m._pick,
    _flags: m._flags || (special && m.showtimes.length === 1 ? [{ key: 'one-night', label: 'One night only' }] : []),
    _reasons: m._reasons || (special ? [{ kind: 'film', text: m.showtimes.length === 1 ? 'One night only' : 'Special screening' }] : []),
  };
}

function renderFilms() {
  const m = state.movies;
  if (!m) return '<p class="loading">Loading…</p>';
  const section = (label, list, special) =>
    list.length ? `<h2 class="h">${label}</h2>${list.map((f) => row(movieEntry(f, special), { day: true })).join('')}` : '';
  const out = section('Special screenings', m.special, true) + section('Now playing', m.nowPlaying, false) + section('Coming soon', m.comingSoon, false);
  // Kids' films and vapid action films are filtered out; each says why, and
  // films you hid can come back.
  const left = [...m.filtered, ...m.hidden];
  const leftOut = left.length
    ? `<button class="more" data-act="x-leftout">${state.showLeftOut ? 'Hide what’s left out' : `Show what’s left out (${left.length})`}</button>
       ${state.showLeftOut ? left.map((f) => `<div class="row lo dim">
          <div class="r-stub"><span class="r-time">${esc(monthDay(localISO(new Date(f.showtimes[0]))))}</span></div>
          <div class="r-body"><span class="r-title">${esc(f.title)}</span><span class="r-meta">${esc(f.hidden ? 'Hidden by you' : f._filter?.reason || 'Filtered')}</span></div>
          ${f.hidden ? `<button class="pb" data-act="unhide-film" data-id="${f.id}">Show again</button>` : ''}
        </div>`).join('') : ''}`
    : '';
  return (out || '<div class="empty"><strong>No films listed</strong>The cinema listings arrive on the next refresh.</div>') + leftOut;
}

function renderCalendar() {
  const x = state.explore;
  const [y, m] = x.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // Monday first
  const days = new Date(y, m, 0).getDate();
  const heads = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cdw">${d}</div>`).join('');
  let cells = '<div class="cc blank"></div>'.repeat(lead);
  for (let d = 1; d <= days; d += 1) {
    const date = `${x.month}-${String(d).padStart(2, '0')}`;
    const n = x.counts[date] || 0;
    const past = date < state.today;
    const label = `${esc(shortDate(date))}, ${n} on`;
    const inner = `${d}${n ? `<span class="n">${n}</span>` : ''}`;
    cells += past || !n
      ? `<span class="cc off ${date === state.today ? 'today' : ''}" aria-label="${label}">${inner}</span>`
      : `<a class="cc ${date === state.today ? 'today' : ''}" href="#day/${date}" aria-label="${label}">${inner}</a>`;
  }
  const title = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return `<div class="cal-head"><button data-act="x-month" data-key="-1" aria-label="Previous month">‹</button>
      <div class="cal-title">${esc(title)}</div><button data-act="x-month" data-key="1" aria-label="Next month">›</button></div>
    <div class="cal">${heads}${cells}</div>`;
}

// ── Saved ───────────────────────────────────────────────────────────────────
function renderSaved() {
  const s = state.saved;
  if (!s) return '<p class="loading">Loading…</p>';
  const feed = `${location.origin}/api/calendar/going.ics`;
  const going = s.going.length
    ? `<div class="tickets">${s.going.map((e) => ticket(e)).join('')}</div>`
    : '<p class="note">Nothing yet. Mark a show Going and it lands here, stamped.</p>';
  const maybe = s.maybe.length
    ? s.maybe.map((e) => row(e, { day: true })).join('')
    : '<p class="note">Shows you mark Maybe collect here while you decide.</p>';
  const c = state.curated;
  const curated = c && c.events.length
    ? `<h2 class="h">Curated</h2>
       ${c.criteria ? `<p class="criteria">“${esc(c.criteria)}”${c.generated_at ? ` · ${esc(relTime(c.generated_at))}` : ''}</p>` : ''}
       ${c.events.map((e) => row(e, { day: true, reason: e._reason })).join('')}`
    : '';
  return `<h1 class="title">Saved</h1>
    <div class="saved">
      <section>
        <h2 class="h">Going</h2>${going}
        <div class="box">
          <p>Put Going shows on your phone’s calendar: subscribe to this link in your calendar app. It works wherever your phone can reach EventLight.</p>
          <div class="copyrow"><input id="feed-url" readonly value="${esc(feed)}" aria-label="Calendar link" /><button class="pb" data-act="copy-feed">Copy</button></div>
        </div>
      </section>
      <section><h2 class="h">Maybe</h2>${maybe}${curated}</section>
    </div>`;
}

// ── Detail sheet ────────────────────────────────────────────────────────────
function factsGrid(list) {
  return `<div class="facts">${list.map(([k, v]) => `<div class="fact"><span class="fk">${k}</span><span class="fv">${esc(v)}</span></div>`).join('')}</div>`;
}

const GLYPH = { favorite: '♥', learned: '★', similar: '≈', film: '◆', genre: '♪', 'learned-tags': '↺', nearby: '⌂', penalty: '↓' };

function sheetEvent(d) {
  const e = d.event;
  register(e);
  const fromHome = d.home.nearby
    ? d.home.miles ? `${d.home.miles} mi · close to home` : 'Close to home'
    : d.home.miles ? `${d.home.miles} mi` : e.city || '—';
  const reasons = (e._reasons || []).filter((r) => r.kind !== 'genre');
  const matched = (e._matched || []).map((g) => g.toLowerCase());
  const tags = (e._tags || []).slice(0, 8);
  const isHit = (t) => matched.some((g) => ` ${t.replace(/-/g, ' ')} `.includes(` ${g.replace(/-/g, ' ')} `));
  const comedy = kindInfo(e).family === 'comedy';
  const lineup = d.lineup.length
    ? `<div class="s-h">Lineup</div><div class="acts">${d.lineup.map((a, i) => {
        const note = a.favorite ? '♥ Favorite' : a.starred ? '★ Starred before' : a.similar ? `≈ ${a.similar.seed}` : '';
        const what = [a.descriptor, (a.tags || []).slice(0, 3).join(' · ')].filter(Boolean).join(' · ');
        const fans = a.fans?.length ? `For fans of ${a.fans.map((f) => `${f.favorite ? '♥ ' : ''}${f.name}`).join(', ')}` : '';
        const pv = a.preview && isHttp(a.preview.url)
          ? `<button class="pv" data-act="play" data-key="${enc(a.preview.url)}" aria-label="${esc(`Play a preview: ${a.preview.title} by ${a.preview.artist}`)}" aria-pressed="false"><span class="play" aria-hidden="true"></span></button>`
          : '';
        return `<div class="actrow ${pv ? 'has-pv' : ''}"><button class="actchip" data-open="artist" data-key="${enc(a.name)}" ${comedy ? 'data-hint="comedy"' : ''}>
          <span><span class="role">${i === 0 ? 'Headliner' : 'Support'}${note ? ` · ${esc(note)}` : ''}</span>${esc(a.name)}
          ${what ? `<span class="a-what">${esc(what)}</span>` : ''}${fans ? `<span class="a-fans">${esc(fans)}</span>` : ''}</span><span class="chev">›</span></button>${pv}</div>`;
      }).join('')}</div>`
    : '';
  const flags = [...(e._flags || []).map((f) => f.label), e._regular?.cadence, e._run?.text].filter(Boolean);
  return {
    body: `<p class="s-eye">${esc(kindInfo(e).label)} · ${esc(dayName(e.date))} · ${esc(shortDate(e.date))}${e.time ? ` · ${fmtTime(e.time)}` : ''}</p>
      <div class="s-title">${esc(headline(e))}</div>
      ${headline(e) !== e.title ? `<p class="s-sub">${esc(e.title)}</p>` : ''}
      <p class="s-sub"><button class="s-link" data-open="venue" data-key="${enc(e.venue)}">${esc(e.venue)}</button>${e.city ? ` · ${esc(e.city)}` : ''}</p>
      ${flags.length ? `<p class="s-flags">${flags.map(esc).join(' · ')}</p>` : ''}
      ${factsGrid([['Doors', fmtTime(e.doors_time) || '—'], ['Show', e._times?.length > 1 ? e._times.map(fmtTime).join(' & ') : fmtTime(e.time) || 'TBA'], ['Price', e.price_range || '—'], ['From home', fromHome]])}
      ${e._curated ? `<p class="connect">✎ ${esc(e._curated)}</p>` : ''}
      <div class="s-h">Why it’s here</div>
      ${reasons.length
        ? `<ul class="reasons">${reasons.map((r) => `<li><span class="g">${GLYPH[r.kind] || '·'}</span>${esc(r.text)}</li>`).join('')}</ul>`
        : `<p class="s-sub">${matched.length ? 'Matches genres you like.' : 'Nothing on this bill matches your favorites or genres yet.'}</p>`}
      ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag ${isHit(t) ? 'hit' : ''}">${esc(t)}</span>`).join('')}</div>` : ''}
      ${lineup}
      <div class="s-h">Same night</div>
      ${d.sameNight.length ? d.sameNight.map((x) => row(x)).join('') : '<p class="s-sub">Nothing else listed.</p>'}
      <a class="more" href="#day/${e.date}">See the whole day ›</a>`,
    acts: `${planButtons(e)}<button class="pb" data-act="hide" data-id="${e.id}">Hide</button>
      ${isHttp(e.ticket_url) ? `<a class="tix" href="${esc(e.ticket_url)}" target="_blank" rel="noopener">Tickets →</a>` : ''}`,
  };
}

function sheetFilm(f) {
  let times = '';
  if (f.times) {
    times = `<div class="tags">${f.times.map((t) => `<span class="tag">${fmtTime(t)}</span>`).join('')}</div>`;
  } else if (f.showtimes) {
    const byDay = new Map();
    for (const iso of f.showtimes) {
      const d = new Date(iso);
      const key = localISO(d);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(fmtTime(clock(d)));
    }
    times = [...byDay].slice(0, 6).map(([date, list]) => `<p class="s-text"><strong>${esc(dayName(date))}</strong> · ${esc(list.join(', '))}</p>`).join('');
  }
  const scores = [f.mc_score != null ? `Metacritic ${f.mc_score}` : '', f.rt_score != null ? `Rotten Tomatoes ${f.rt_score}%` : ''].filter(Boolean);
  // Why it's here: your taste first (♥ a favorite, ≈ who and what it's
  // like), then the occasion (◆ One night only, Last chance…).
  const reasons = (f._reasons || []).filter((r) => !/^(Metacritic|Rotten)/.test(r.text));
  // The crew Wikidata knows beyond the director: writer, score, camera.
  const crew = f.crew || {};
  const others = (role) => (crew[role] || []).filter((n) => !String(f.director || '').includes(n));
  const crewText = [['Written by', others('writer')], ['Score by', crew.composer || []], ['Shot by', crew.cinematographer || []]]
    .filter(([, names]) => names.length)
    .map(([label, names]) => `${label} ${names.slice(0, 2).join(' & ')}`)
    .join('. ');
  return {
    body: `<p class="s-eye">Film${f.times ? ` · ${esc(dayName(f.date))} · ${esc(shortDate(f.date))}` : ''}</p>
      <div class="s-title">${esc(f.title)}</div>
      <p class="s-sub">${esc([f.year, f.rating, runtime(f.runtime), f.genre].filter(Boolean).join(' · '))}</p>
      <p class="s-sub">${esc([f.venue, f.city].filter(Boolean).join(' · '))}</p>
      ${isHttp(f.poster_url) ? `<img class="poster" src="${esc(f.poster_url)}" alt="" loading="lazy" />` : ''}
      ${reasons.length ? `<ul class="reasons">${reasons.map((r) => `<li><span class="g">${GLYPH[r.kind] || '·'}</span>${esc(r.text)}</li>`).join('')}</ul>` : ''}
      ${f.director || f.starring ? `<p class="s-text">${esc([f.director ? `Directed by ${f.director}` : '', f.starring ? `With ${f.starring}` : ''].filter(Boolean).join('. '))}</p>` : ''}
      ${crewText ? `<p class="s-text">${esc(crewText)}</p>` : ''}
      ${f.synopsis ? `<p class="s-text">${esc(f.synopsis)}</p>` : ''}
      ${scores.length ? `<div class="tags">${scores.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}
      <div class="s-h">Showtimes</div>${times}`,
    acts: `<button class="pb" data-act="hide-film" data-id="${f.movie_id}">Hide film</button>
      ${isHttp(f.trailer_url) ? `<a class="pb" href="${esc(f.trailer_url)}" target="_blank" rel="noopener">Trailer</a>` : ''}
      ${isHttp(f.ticket_url) ? `<a class="tix" href="${esc(f.ticket_url)}" target="_blank" rel="noopener">Tickets →</a>` : ''}`,
  };
}

// The artist sheet. What EventLight already knows (how they connect to your
// taste, their upcoming dates) shows at once; the profile — photo, bio,
// hometown, links, top songs to preview — fills in when it arrives.
function sheetArtist(a) {
  const p = a.profile;
  const loading = Boolean(a.profileLoading || (!p && !a.profileTried));
  const rel = a.favorite
    ? '♥ One of your favorite artists'
    : a.starred
      ? '★ You starred one of their shows'
      : a.similar
        ? a.similar.via?.length
          ? `≈ Shares fans with ${a.similar.via.join(' & ')} (≈ ${a.similar.seed})`
          : `≈ Sounds like ${a.similar.seed}`
        : 'No link to your favorites yet. Mark one of their shows Maybe and EventLight learns from it.';
  // "Since" is when a band formed; for a solo artist MusicBrainz gives a birth year instead.
  const facts = p
    ? [p.type === 'Person' ? 'Solo artist' : p.type, p.from, p.since && p.type !== 'Person' ? `Since ${p.since}` : '', p.until ? `Until ${p.until}` : '']
        .filter(Boolean).join(' · ')
    : '';
  // An Apple match MusicBrainz disagrees with may be another act of the same
  // name: its songs, genre and link aren't offered as theirs.
  const apple = p?.apple && p.apple.match !== 'conflict' ? p.apple : null;
  const genres = [...new Set([...(a.tags || []), ...(apple?.genre ? [apple.genre.toLowerCase()] : [])])];
  const songs = apple?.songs || [];
  const links = [
    ['Spotify', p?.links?.spotify], ['Bandcamp', p?.links?.bandcamp], ['Website', p?.links?.website], ['YouTube', p?.links?.youtube],
  ].filter(([, url]) => isHttp(url));
  const similar = p?.similar || [];
  const photo = isHttp(p?.image) ? `<img class="a-photo" src="${esc(p.image)}" alt="" />` : '';
  const listen = songs.length
    ? `<div class="songs">${songs.map((s) => `<button class="song" data-act="play" data-key="${enc(s.preview)}" aria-label="Play a preview of ${esc(s.title)}">
          <span class="play" aria-hidden="true"></span>
          ${isHttp(s.artwork) ? `<img src="${esc(s.artwork)}" alt="" loading="lazy" />` : '<span class="noart"></span>'}
          <span class="sb"><span class="st">${esc(s.title)}</span><span class="sm">${esc([s.album, s.year].filter(Boolean).join(' · '))}</span></span>
        </button>`).join('')}</div>
       <p class="src-note">30-second previews from Apple Music. Open Apple Music for the full songs.</p>`
    : loading
      ? '<p class="s-sub">Finding their songs…</p>'
      : '<p class="s-sub">No songs found on Apple Music.</p>';
  const sources = [p?.bio ? 'Wikipedia' : '', p?.from || p?.type ? 'MusicBrainz' : '', songs.length ? 'Apple Music' : ''].filter(Boolean);
  return {
    body: `<p class="s-eye">Artist</p>
      <div class="a-head ${photo ? '' : 'no-photo'}">${photo}
        <div>
          <div class="s-title">${esc(p?.name || a.name)}</div>
          ${facts ? `<p class="a-facts">${esc(facts)}</p>` : ''}
          ${p?.description ? `<p class="s-sub">${esc(p.description)}</p>` : ''}
        </div>
      </div>
      <p class="connect">${esc(rel)}</p>
      <div class="s-h">Listen</div>${listen}
      ${p?.bio ? `<div class="s-h">About</div><p class="s-text">${esc(p.bio)}</p>
        ${isHttp(p.wikipedia_url) ? `<a class="more" href="${esc(p.wikipedia_url)}" target="_blank" rel="noopener">More on Wikipedia ↗</a>` : ''}` : ''}
      ${genres.length ? `<div class="s-h">Genres</div><div class="tags">${genres.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      ${links.length ? `<div class="s-h">Links</div><div class="links">${links.map(([label, url]) => `<a class="lk" href="${esc(url)}" target="_blank" rel="noopener">${label} ↗</a>`).join('')}</div>` : ''}
      ${similar.length ? `<div class="s-h">Similar artists</div><div class="links">${similar.map((s) => `<button class="lk" data-open="artist" data-key="${enc(s.name)}">${s.favorite ? '♥ ' : ''}${esc(s.name)}</button>`).join('')}</div>` : ''}
      <div class="s-h">Coming up</div>
      ${a.upcoming.length ? a.upcoming.map((e) => row(e, { day: true })).join('') : '<p class="s-sub">No dates in the next year.</p>'}
      ${loading && p == null ? '' : sources.length ? `<p class="src-note">From ${sources.join(', ')}.</p>` : ''}`,
    acts: `${isHttp(apple?.url) ? `<a class="tix apple" href="${esc(apple.url)}" target="_blank" rel="noopener">Apple Music ↗</a>` : ''}
      ${a.favorite
        ? '<button class="pb on-maybe" disabled>♥ Favorite</button>'
        : `<button class="pb" data-act="favorite" data-key="${enc(a.name)}">♥ Add to favorites</button>`}`,
  };
}

// Look the artist's profile up when it's missing or stale, then redraw the
// sheet if it's still the one on screen.
async function loadArtistProfile(top) {
  const a = top.data;
  if (a.profile?.fresh || a.profileLoading || a.profileTried) return;
  a.profileLoading = true;
  try {
    const hint = top.hint ? `&hint=${encodeURIComponent(top.hint)}` : '';
    const profile = await api(`/api/artist/profile?name=${encodeURIComponent(top.key)}${hint}`);
    if (profile) a.profile = profile;
  } catch {
    /* the sheet keeps what it has */
  }
  a.profileLoading = false;
  a.profileTried = true;
  if (sheet.stack[sheet.stack.length - 1] === top) renderSheet();
}

function sheetVenue(v) {
  const where = [v.city, v.home.nearby ? 'close to home' : v.home.miles ? `${v.home.miles} mi from home` : ''].filter(Boolean).join(' · ');
  return {
    body: `<p class="s-eye">Venue</p>
      <div class="s-title">${esc(v.name)}</div>
      ${where ? `<p class="s-sub">${esc(where)}</p>` : ''}
      <div class="s-h">Next shows here</div>
      ${v.upcoming.length ? v.upcoming.map((e) => row(e, { day: true })).join('') : '<p class="s-sub">Nothing listed in the next two months.</p>'}`,
    acts: '',
  };
}

function sheetAdd() {
  const field = (id, label, attrs = '', full = false) =>
    `<label class="${full ? 'full' : ''}">${label}<input id="${id}" ${attrs} /></label>`;
  return {
    body: `<p class="s-eye">Explore</p><div class="s-title">Add a show</div>
      <p class="s-sub">For a show none of the sources list. It shows up everywhere once saved.</p>
      <form class="form" id="add-form">
        ${field('f-title', 'Title *', 'required placeholder="e.g. The Murder City Devils"', true)}
        ${field('f-venue', 'Venue *', 'required placeholder="e.g. Neumos"')}
        ${field('f-city', 'City', 'placeholder="Tacoma"')}
        ${field('f-date', 'Date *', 'type="date" required')}
        ${field('f-time', 'Time', 'type="time"')}
        <label>Type<select id="f-category"><option value="music">Music</option><option value="comedy">Comedy</option><option value="other">Other</option></select></label>
        ${field('f-price', 'Price', 'placeholder="$15–20"')}
        ${field('f-url', 'Ticket link', 'type="url" placeholder="https://…"', true)}
      </form>`,
    acts: '<button class="pb on-going" data-act="add-submit">Add show</button><button class="pb" data-act="close">Cancel</button>',
  };
}

const SHEETS = {
  event: { url: (k) => `/api/events/${encodeURIComponent(k)}/details`, render: sheetEvent },
  artist: { url: (k) => `/api/artist?name=${encodeURIComponent(k)}`, render: sheetArtist, after: loadArtistProfile },
  venue: { url: (k) => `/api/venue?name=${encodeURIComponent(k)}`, render: sheetVenue },
  film: { local: (k) => films.get(k), render: sheetFilm },
  add: { local: () => ({}), render: sheetAdd },
};

async function renderSheet() {
  const top = sheet.stack[sheet.stack.length - 1];
  if (!top) {
    sheetEl.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('locked');
    sheet.opener?.focus?.({ preventScroll: true });
    return;
  }
  const wasHidden = sheetEl.hidden;
  sheetEl.hidden = false;
  backdrop.hidden = false;
  document.body.classList.add('locked');
  sheetEl.querySelector('[data-act="back"]').classList.toggle('invisible', sheet.stack.length < 2);
  if (wasHidden) sheetEl.querySelector('.close').focus({ preventScroll: true });
  const kind = SHEETS[top.type];
  if (!top.data) {
    if (kind.local) {
      top.data = kind.local(top.key);
    } else {
      sheetBody.innerHTML = '<p class="loading">Loading…</p>';
      sheetActs.hidden = true;
      try {
        top.data = await api(kind.url(top.key));
      } catch {
        if (sheet.stack[sheet.stack.length - 1] === top) {
          sheetBody.innerHTML = '<p class="loading">Couldn’t load this. Check that EventLight is running, then try again.</p>';
        }
        return;
      }
      if (sheet.stack[sheet.stack.length - 1] !== top) return;
    }
  }
  if (!top.data) {
    sheetBody.innerHTML = '<p class="loading">This listing is gone. It may have been removed on the last refresh.</p>';
    sheetActs.hidden = true;
    return;
  }
  const { body, acts } = kind.render(top.data);
  sheetBody.innerHTML = body;
  sheetActs.innerHTML = acts;
  sheetActs.hidden = !acts.trim();
  syncPlayer();
  kind.after?.(top);
}

// A photo or cover that fails to load (a moved file, no network) is dropped
// rather than shown as a broken image.
document.addEventListener('error', (ev) => {
  const img = ev.target;
  if (img.tagName !== 'IMG') return;
  if (img.classList.contains('a-photo')) {
    img.closest('.a-head')?.classList.add('no-photo');
    img.remove();
  } else {
    img.replaceWith(Object.assign(document.createElement('span'), { className: 'noart' }));
  }
}, true);

// ── Song previews ───────────────────────────────────────────────────────────
// One player for the whole app: tapping a song (in a list, on a ticket, in
// the artist sheet) plays its preview, tapping it again pauses, and leaving
// the screen or the sheet stops it.
const player = new Audio();
player.preload = 'none';
// The element that shows a preview's progress: the song, row or ticket around the button.
const progressHost = (el) => el.closest('.song, .row, .tk, .actrow') || el;
function syncPlayer() {
  const current = player.src && !player.paused && !player.error ? player.src : null;
  document.querySelectorAll('[data-act="play"]').forEach((el) => {
    const on = Boolean(current) && decodeURIComponent(el.dataset.key) === current;
    el.classList.toggle('playing', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    const host = progressHost(el);
    host.classList.toggle('playing', on);
    if (!on) host.style.setProperty('--p', '0');
  });
}
function playPreview(url) {
  if (player.src === url && !player.paused) {
    player.pause();
  } else {
    if (player.src !== url) player.src = url;
    player.play().catch(() => toast('Couldn’t play that preview.'));
  }
}
function stopPreview() {
  if (!player.paused) player.pause();
}
for (const type of ['play', 'pause', 'ended']) player.addEventListener(type, syncPlayer);
player.addEventListener('error', () => {
  toast('This browser can’t play the preview. Open it in Apple Music instead.');
  syncPlayer();
});
player.addEventListener('timeupdate', () => {
  if (!player.duration) return;
  document.querySelectorAll('[data-act="play"].playing').forEach((el) => {
    progressHost(el).style.setProperty('--p', String(player.currentTime / player.duration));
  });
});

function openSheet(type, key, extra = {}) {
  if (!sheet.stack.length) sheet.opener = document.activeElement;
  stopPreview();
  const top = sheet.stack[sheet.stack.length - 1];
  if (top && top.type === type && top.key === key) return;
  sheet.stack.push({ type, key, data: null, ...extra });
  renderSheet().then(() => { sheetBody.scrollTop = 0; });
}

function closeSheet() {
  stopPreview();
  sheet.stack = [];
  renderSheet();
}

// ── Actions ─────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// Going / Maybe toggles. What's on screen decides: tapping a pressed button
// clears the plan, so a plan changed on the other phone can't be re-set by
// a stale copy here.
async function changePlan(id, target, pressed) {
  const copies = shown.get(id);
  if (!copies) return;
  const plan = pressed ? null : target;
  try {
    await post(`/api/events/${id}/plan`, { plan });
  } catch {
    toast('Couldn’t save that. Try again.');
    return;
  }
  for (const copy of copies) {
    copy.going = plan === 'going' ? 1 : 0;
    copy.interested = plan ? 1 : 0;
  }
  toast(plan === 'going' ? 'You’re going. It’s in Saved.' : plan === 'maybe' ? 'Saved as Maybe.' : 'Removed from your plans.');
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
  if (sheet.stack.length) await renderSheet();
  refocus(`[data-plan="${target}"][data-id="${id}"]`);
  // Plans change the picks (a Going show leads its day), so the Week, a day
  // and Saved fetch their data again, keeping their place. Explore's order
  // doesn't depend on plans, and refetching would drop the pages you loaded.
  if (state.route !== 'explore') load({ quiet: true });
}

// A selector for the focused control on the page, so a quiet redraw can put
// focus back on its new copy.
function focusSelector() {
  const el = document.activeElement;
  if (!el || !view.contains(el)) return null;
  const d = el.dataset;
  const q = (v) => CSS.escape(v || '');
  if (d.plan) return `[data-plan="${q(d.plan)}"][data-id="${q(d.id)}"]`;
  if (d.open) return `[data-open="${q(d.open)}"][data-key="${q(d.key)}"]`;
  if (d.act) return `[data-act="${q(d.act)}"]${d.key ? `[data-key="${q(d.key)}"]` : ''}`;
  if (d.day) return `[data-day="${q(d.day)}"]`;
  return null;
}

// Put focus back on a control after a redraw replaced it (the sheet's copy
// first, when the sheet is open).
function refocus(selector) {
  const el = (sheet.stack.length && sheetEl.querySelector(selector)) || view.querySelector(selector);
  el?.focus({ preventScroll: true });
}

async function hideEvent(id) {
  try {
    await post(`/api/events/${id}/hidden`, { value: true });
  } catch {
    toast('Couldn’t hide that. Try again.');
    return;
  }
  toast('Hidden. Settings → Clear hidden brings it back.');
  // Explore is redrawn from memory when you go back to it.
  state.explore.events = state.explore.events.filter((e) => e.id !== id);
  closeSheet();
  load({ quiet: true });
}

async function hideFilm(movieId, value = true) {
  try {
    await post(`/api/movies/${movieId}/hidden`, { value });
  } catch {
    toast('Couldn’t save that. Try again.');
    return;
  }
  toast(value ? 'Film hidden. Explore → Film → Show what’s left out brings it back.' : 'Film is back in the listings.');
  closeSheet();
  state.movies = null;
  load({ quiet: true });
}

async function addFavorite(name) {
  try {
    await post('/api/settings/artists', { name, weight: 4 });
  } catch {
    toast('Couldn’t add that. Try again.');
    return;
  }
  toast(`${name} is now a favorite. Similar artists are looked up on the next refresh.`);
  const top = sheet.stack[sheet.stack.length - 1];
  if (top?.type === 'artist') top.data = { ...top.data, favorite: true };
  renderSheet();
  load({ quiet: true });
}

async function submitAdd() {
  const val = (id) => document.getElementById(id)?.value.trim() || '';
  const body = {
    title: val('f-title'), venue: val('f-venue'), city: val('f-city'), date: val('f-date'), time: val('f-time'),
    category: val('f-category') || 'music', price_range: val('f-price'), url: val('f-url'),
  };
  if (!body.title || !body.venue || !body.date) {
    toast('Title, venue and date are required.');
    return;
  }
  try {
    await post('/api/events', body);
  } catch {
    toast('Couldn’t add the show. Try again.');
    return;
  }
  toast('Show added.');
  closeSheet();
  load({ quiet: true });
}

async function copyFeed() {
  const input = document.getElementById('feed-url');
  try {
    await navigator.clipboard.writeText(input.value);
    toast('Link copied. Add it in your calendar app as a subscription.');
  } catch {
    input.select();
    toast('Select the link and copy it.');
  }
}

// ── Explore loading ─────────────────────────────────────────────────────────
// Explore's chips group listings the way the day page does (a talk at a
// music venue is under Around town on both).
const EXPLORE_GROUP = { music: 'music', comedy: 'comedy', other: 'around' };

function exploreParams() {
  const x = state.explore;
  const p = new URLSearchParams();
  if (EXPLORE_GROUP[x.type]) p.set('group', EXPLORE_GROUP[x.type]);
  if (x.city !== 'all') p.set('city', x.city);
  if (x.q) p.set('search', x.q);
  return p;
}

async function loadExploreResults({ append = false } = {}) {
  const x = state.explore;
  if (x.type === 'film') {
    if (!state.movies) state.movies = await api('/api/views/movies');
    return;
  }
  if (x.mode === 'calendar') {
    const p = exploreParams();
    p.set('month', x.month);
    x.counts = (await api(`/api/views/month?${p}`)).counts;
    return;
  }
  const p = exploreParams();
  p.set('dateFrom', state.today);
  p.set('sort', x.sort);
  p.set('page', String(x.page));
  p.set('pageSize', '60');
  // Films come along with "Everything" by date, a page's worth of days at a
  // time — and with a search, the films that match it.
  const withFilms = x.type === 'all' && x.sort === 'date';
  if (withFilms) {
    p.set('withFilms', '1');
    if (append && x.filmsTo) p.set('filmsFrom', addDays(x.filmsTo, 1));
  }
  x.loading = true;
  try {
    const r = await api(`/api/events?${p}`);
    x.events = append ? x.events.concat(r.events) : r.events;
    x.films = withFilms ? { ...(append ? x.films : {}), ...(r.films || {}) } : {};
    x.filmsTo = withFilms ? r.filmsTo || x.filmsTo : null;
    x.total = r.total;
    x.pages = r.pages;
  } finally {
    x.loading = false;
  }
}

async function refreshResults({ append = false } = {}) {
  if (!append) state.explore.page = 1;
  try {
    await loadExploreResults({ append });
  } catch {
    toast('Couldn’t load shows. Is EventLight running?');
  }
  const box = document.getElementById('x-results');
  if (state.route === 'explore' && box) {
    box.innerHTML = renderResults();
    syncPlayer();
  }
}

// ── Routing ─────────────────────────────────────────────────────────────────
// #week, #explore, #saved, and #day/YYYY-MM-DD (also #day/today, #day/tomorrow).
const ROUTES = ['week', 'explore', 'saved'];

function render() {
  const r = state.route;
  view.innerHTML = r === 'week' ? renderWeek() : r === 'explore' ? renderExplore() : r === 'day' ? renderDay() : renderSaved();
  syncPlayer();
}

async function loadSaved() {
  const [saved, curated] = await Promise.all([api('/api/views/saved'), api('/api/views/curated').catch(() => null)]);
  state.saved = saved;
  state.curated = curated;
}

// Fetch a day's page. False when you've moved to another day meanwhile, so
// a slow answer never replaces the day on screen.
async function loadDay() {
  const date = state.day;
  const d = await api(`/api/views/day?date=${encodeURIComponent(date)}`);
  if (state.route !== 'day' || state.day !== date) return false;
  state.today = d.today;
  // A past day shows today's page, under today's address.
  if (d.date !== date) {
    state.day = d.date;
    state.hash = `#day/${d.date}`;
    history.replaceState(history.state, '', state.hash);
  }
  state.dayData = d;
  return true;
}

// Fetch the current screen's data and draw it. `quiet` keeps what's on
// screen, and the scroll position, until the new data arrives.
async function load({ quiet = false } = {}) {
  const r = state.route;
  const hash = state.hash;
  try {
    if (r === 'week') {
      const brief = await api('/api/views/brief');
      state.brief = brief;
      state.today = brief.today;
    } else if (r === 'day') {
      if (!(await loadDay())) return;
    } else if (r === 'explore') {
      if (!state.facets.cities.length) state.facets = await api('/api/filters').catch(() => state.facets);
      state.explore.page = 1;
      await loadExploreResults();
    } else if (r === 'saved') {
      await loadSaved();
    }
  } catch {
    if (!quiet) view.innerHTML = '<div class="empty"><strong>Can’t reach EventLight</strong>Check that the server is running, then reload.</div>';
    return;
  }
  if (state.route !== r || (r !== 'day' && state.hash !== hash)) return;
  const y = window.scrollY;
  const keep = quiet ? focusSelector() : null;
  render();
  if (quiet) {
    window.scrollTo(0, y);
    if (keep) view.querySelector(keep)?.focus({ preventScroll: true });
  } else if (r === 'day') {
    document.getElementById('day-title')?.focus({ preventScroll: true });
    // "At the movies: …" lands on the films, not the top of the page.
    if (state.dayTarget) document.getElementById(state.dayTarget)?.scrollIntoView();
    state.dayTarget = null;
  }
}

// Where a day page's "‹ Week" / "‹ Explore" goes: kept on the day's own
// history entry when the Week or Explore opened it, so Back and Forward
// can't leave it pointing somewhere else.
const dayOrigin = () => history.state?.from || null;
let openedFrom = null; // set by a tap on a day link inside the app

// Move to another day from a day page. It replaces the address rather than
// adding to history (keeping where the day was opened from), so Back still
// returns to where you came from.
function goDay(date) {
  if (!isISODate(date)) return;
  history.replaceState(history.state, '', `#day/${date}`);
  route();
}

function route() {
  const prev = state.hash;
  if (prev && state.route !== 'day') state.scroll[prev] = window.scrollY;
  const raw = location.hash.replace('#', '');
  const m = /^day\/(\d{4}-\d{2}-\d{2}|today|tomorrow)$/.exec(raw);
  stopPreview();
  closeSheet();
  if (m) {
    const date = m[1] === 'today' ? state.today : m[1] === 'tomorrow' ? addDays(state.today, 1) : m[1];
    // "today", "tomorrow" and dates that don't exist get a real address.
    if (m[1] !== date || !isISODate(date)) {
      location.replace(`#day/${isISODate(date) ? date : state.today}`);
      return;
    }
    if (openedFrom) history.replaceState({ from: openedFrom }, '');
    openedFrom = null;
    if (state.day !== date) state.open = new Set();
    state.route = 'day';
    state.day = date;
    state.hash = `#day/${date}`;
  } else {
    state.route = ROUTES.includes(raw) ? raw : 'week';
    state.hash = `#${state.route}`;
  }
  const nav = state.route === 'day' ? 'week' : state.route;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  // Coming back to the Week or Explore: draw what we had, where we were,
  // then refresh the Week quietly.
  const y = state.scroll[state.hash];
  const have = (state.route === 'week' && state.brief) || (state.route === 'explore' && state.explore.events.length);
  if (have && y != null) {
    render();
    window.scrollTo(0, y);
    if (state.route === 'week') load({ quiet: true });
    return;
  }
  render();
  window.scrollTo(0, 0);
  load();
}

async function loadStatus() {
  try {
    const s = await api('/api/status');
    const failing = (s.sources || []).filter((x) => x.status === 'error').length;
    const el = document.getElementById('updated');
    el.innerHTML = s.scheduler?.running
      ? 'Refreshing…'
      : `Updated ${esc(relTime(s.lastRunAt))}${failing ? ` · <span class="warn">${failing} ${failing === 1 ? 'source needs' : 'sources need'} a look</span>` : ''}`;
    el.title = 'Sources and refresh are in Settings';
  } catch {
    /* the status line is optional */
  }
}

// ── Events ──────────────────────────────────────────────────────────────────
document.addEventListener('click', (ev) => {
  if (ev.target === backdrop) {
    closeSheet();
    return;
  }
  // A link to a day page: remember where it was opened from (for "‹ Week"),
  // and which section a films line points at. A link to the day you're on
  // (the sheet's "See the whole day") just closes the sheet.
  const dayLink = ev.target.closest('a[href^="#day/"]');
  if (dayLink) {
    if (dayLink.getAttribute('href') === location.hash) {
      ev.preventDefault();
      closeSheet();
      return;
    }
    openedFrom = ['week', 'explore'].includes(state.route) ? state.route : null;
    if (dayLink.classList.contains('filmline')) state.dayTarget = 'g-film';
    return;
  }
  const btn = ev.target.closest('button');
  if (!btn || btn.disabled) return;
  const { plan, id, open, key, act, day, hint } = btn.dataset;
  if (plan) {
    changePlan(Number(id), plan, btn.getAttribute('aria-pressed') === 'true');
    return;
  }
  if (day) {
    goDay(day);
    return;
  }
  if (open) {
    const k = open === 'artist' || open === 'venue' ? decodeURIComponent(key) : key;
    openSheet(open, k, hint ? { hint } : {});
    return;
  }
  const x = state.explore;
  if (act?.startsWith('x-')) flushSearch();
  switch (act) {
    case 'close': closeSheet(); break;
    case 'back': stopPreview(); sheet.stack.pop(); renderSheet(); break;
    case 'play': playPreview(decodeURIComponent(key)); break;
    case 'morepicks': state.morePicks = !state.morePicks; render(); break;
    case 'day-back':
      if (dayOrigin()) history.back();
      else location.hash = '#week';
      break;
    case 'fold': {
      if (state.open.has(key)) state.open.delete(key);
      else state.open.add(key);
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      refocus(`[data-act="fold"][data-key="${key}"]`);
      break;
    }
    case 'hide': hideEvent(Number(id)); break;
    case 'hide-film': hideFilm(Number(id)); break;
    case 'unhide-film': hideFilm(Number(id), false); break;
    case 'x-leftout': state.showLeftOut = !state.showLeftOut; refreshResults(); break;
    case 'favorite': addFavorite(decodeURIComponent(key)); break;
    case 'add-submit': submitAdd(); break;
    case 'copy-feed': copyFeed(); break;
    case 'x-type': x.type = key; render(); refreshResults(); break;
    case 'x-mode': x.mode = key; render(); refreshResults(); break;
    case 'x-sort': x.sort = key; render(); refreshResults(); break;
    case 'x-more': x.page += 1; refreshResults({ append: true }); break;
    case 'x-clear':
      Object.assign(x, { q: '', type: 'all', city: 'all' });
      render();
      refreshResults();
      break;
    case 'x-month': {
      const [y, m] = x.month.split('-').map(Number);
      x.month = localISO(new Date(y, m - 1 + Number(key), 1)).slice(0, 7);
      refreshResults();
      break;
    }
    default: break;
  }
});

// Search waits for a pause in typing; a filter tapped mid-word applies the
// search first, so the text in the box and the results never disagree.
let searchTimer = null;
function flushSearch() {
  const input = document.getElementById('x-search');
  if (!searchTimer || !input) return;
  clearTimeout(searchTimer);
  searchTimer = null;
  state.explore.q = input.value.trim();
}
document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'x-search') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    state.explore.q = ev.target.value.trim();
    refreshResults();
  }, 300);
});
document.addEventListener('change', (ev) => {
  if (ev.target.id !== 'x-city') return;
  state.explore.city = ev.target.value;
  refreshResults();
});
document.addEventListener('submit', (ev) => {
  if (ev.target.id === 'add-form') {
    ev.preventDefault();
    submitAdd();
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && sheet.stack.length) {
    closeSheet();
    return;
  }
  // ← / → step through days on a day page (not while typing or in the sheet).
  if (state.route !== 'day' || sheet.stack.length || ev.altKey || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
  if (ev.target.closest?.('input, select, textarea')) return;
  // Only from the day on screen, so a quick second press can't skip a day.
  const d = state.dayData;
  if (!d || d.date !== state.day) return;
  if (ev.key === 'ArrowLeft' && d.prev) goDay(d.prev.date);
  if (ev.key === 'ArrowRight' && d.next) goDay(d.next.date);
});

window.addEventListener('hashchange', route);
route();
loadStatus();
setInterval(loadStatus, 60000);
