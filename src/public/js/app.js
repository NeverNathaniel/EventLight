// EventLight dashboard — Week, Explore and Saved, plus the detail sheet that
// slides up over them (a show, a film, a night, an artist, a venue).
// A plain ES module with no build step: views render fetched JSON into HTML
// strings, and one delegated click handler drives every button.

const PICK = 8; // a top pick's minimum score (PICK_MIN in src/week.js)
const GOOD = 3; // shows below this are dimmed in lists (GOOD_MIN in src/week.js)

const view = document.getElementById('view');
const sheetEl = document.getElementById('sheet');
const sheetBody = document.getElementById('sheet-body');
const sheetActs = document.getElementById('sheet-acts');
const backdrop = document.getElementById('backdrop');

const state = {
  route: 'week',
  today: localISO(new Date()),
  brief: null,
  morePicks: false,
  saved: null,
  curated: null,
  facets: { cities: [] },
  movies: null,
  showLeftOut: false,
  explore: {
    q: '', type: 'all', city: 'all', sort: 'date', mode: 'list',
    page: 1, pages: 1, total: 0, events: [], loading: false,
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
const dow = (iso) => toDate(iso).toLocaleDateString('en-US', { weekday: 'short' });
const dayNum = (iso) => toDate(iso).getDate();
const monthDay = (iso) => toDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const shortDate = (iso) => toDate(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

// "Tonight", "Tomorrow", a weekday within the week, else "Sat, Oct 10".
function dayName(iso) {
  const today = state.today;
  if (iso === today) return 'Tonight';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  if (iso > today && iso <= addDays(today, 6)) return toDate(iso).toLocaleDateString('en-US', { weekday: 'long' });
  return shortDate(iso);
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
function lineupOf(e) {
  if (Array.isArray(e._lineup)) return e._lineup;
  try {
    const list = JSON.parse(e.lineup || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
// The act to lead with: the headliner when the title was parsed into a bill
// ("Tractor Presents: Bob Sumner w/ …" → "Bob Sumner"), else the title.
const headline = (e) => (kindOf(e) === 'film' ? e.title : lineupOf(e)[0] || e.title);
function runtime(min) {
  return min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '';
}
function subline(e) {
  if (kindOf(e) === 'film') return [e.year, e.rating, runtime(e.runtime)].filter(Boolean).join(' · ');
  const rest = lineupOf(e).slice(1);
  if (!rest.length) return '';
  return `with ${rest.slice(0, 2).join(' & ')}${rest.length > 2 ? ` +${rest.length - 2} more` : ''}`;
}

const GLYPH = { favorite: '♥', learned: '★', similar: '≈', film: '◆', genre: '♪', 'learned-tags': '↺', nearby: '⌂', penalty: '↓' };
const WHY_ORDER = ['favorite', 'learned', 'similar', 'film', 'genre', 'learned-tags', 'nearby'];
// The one reason worth showing in a list: a favorite beats a sound-alike
// beats a genre match beats "close to home".
function whyLine(e) {
  const reasons = e._reasons || [];
  for (const kind of WHY_ORDER) {
    const r = reasons.find((x) => x.kind === kind);
    if (r) return `${GLYPH[kind]} ${r.text}`;
  }
  return '';
}

function register(e) {
  if (kindOf(e) === 'film') {
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
function pills(e) {
  const kind = kindOf(e);
  const plan = e.going ? '<span class="pill going">Going</span>' : e.interested ? '<span class="pill maybe">Maybe</span>' : '';
  const label = kind === 'film' ? 'Film' : kind === 'comedy' ? 'Comedy' : '';
  return plan + (label ? `<span class="pill kind">${label}</span>` : '');
}

// One line in a list: time, act, where, and optionally why it's there.
function row(e, { why = false, day = false, reason = '' } = {}) {
  register(e);
  const film = kindOf(e) === 'film';
  const time = fmtTime(e.time);
  const when = day ? `${monthDay(e.date)}<br>${time || dow(e.date)}` : time || '—';
  const where = film && e.times?.length > 1
    ? `${e.venue} · ${e.times.map(fmtTime).join(', ')}`
    : [e.venue, e.city].filter(Boolean).join(' · ');
  const w = why ? whyLine(e) : '';
  const score = e._score ?? 0;
  return `<button class="row ${!film && score < GOOD ? 'dim' : ''}" data-open="${film ? 'film' : 'event'}" data-key="${esc(e.id)}">
    <span class="r-time">${when}</span>
    <span class="r-body">
      <span class="r-title">${!film && score >= PICK ? '<span class="r-star">★</span> ' : ''}${esc(headline(e))}</span>
      <span class="r-meta">${esc(where)}${e.price_range ? ` · ${esc(e.price_range)}` : ''}</span>
      ${w ? `<span class="r-why">${esc(w)}</span>` : ''}
      ${reason ? `<span class="r-reason">“${esc(reason)}”</span>` : ''}
    </span>
    <span class="r-pills">${pills(e)}</span>
  </button>`;
}

// A top pick or a Going show, as a ticket with a date stub.
function ticket(e) {
  register(e);
  const going = Boolean(e.going);
  const sub = subline(e);
  const why = whyLine(e);
  const time = fmtTime(e.time);
  return `<article class="tk ${going ? 'is-going' : ''}">
    <div class="tk-stub" aria-hidden="true">
      <span class="tk-dow">${dow(e.date)}</span><span class="tk-num">${dayNum(e.date)}</span>
      <span class="tk-time">${time || '—'}</span><span class="tk-serial">No. ${String(e.id).padStart(4, '0')}</span>
    </div>
    <button class="tk-main" data-open="event" data-key="${e.id}">
      <span class="tk-when">${esc(dayName(e.date))}${time ? ` · ${time}` : ''}</span>
      <span class="tk-title">${esc(headline(e))}</span>
      ${sub ? `<span class="tk-sub">${esc(sub)}</span>` : ''}
      <span class="tk-where">${esc([e.venue, e.city].filter(Boolean).join(' · '))}</span>
      ${why ? `<span class="tk-why">${esc(why)}</span>` : ''}
    </button>
    <div class="tk-acts">${planButtons(e)}<span class="tk-price">${esc(e.price_range || '')}</span></div>
    ${going ? '<span class="tk-stamp" aria-hidden="true">Admit two</span>' : ''}
  </article>`;
}

function furtherCard(e) {
  register(e);
  return `<button class="fc" data-open="event" data-key="${e.id}">
    <span class="fc-date">${esc(shortDate(e.date))}</span>
    <span class="fc-name">${esc(headline(e))}</span>
    <span class="fc-ven">${esc([e.venue, e.city].filter(Boolean).join(' · '))}</span>
  </button>`;
}

// ── Week ────────────────────────────────────────────────────────────────────
function renderWeek() {
  const b = state.brief;
  if (!b) return '<p class="loading">Loading your week…</p>';
  const strip = b.days
    .map((d) => {
      const today = d.date === b.today;
      return `<button class="sd ${today ? 'today' : ''}" data-open="day" data-key="${d.date}"
          aria-label="${esc(dayName(d.date))}, ${d.total} on${d.hasPick ? ', with a top pick' : ''}">
        <span class="sd-w">${today ? 'Today' : dow(d.date)}</span><span class="sd-n">${dayNum(d.date)}</span>
        <span class="sd-c">${d.total}</span>${d.hasPick ? '<span class="lit"></span>' : ''}</button>`;
    })
    .join('');
  const picks = b.picks.length
    ? `<div class="tickets">${(state.morePicks ? b.picks : b.picks.slice(0, 3)).map(ticket).join('')}</div>
       ${b.picks.length > 3 ? `<button class="more" data-act="morepicks">${state.morePicks ? 'Show fewer' : `${b.picks.length - 3} more top picks`}</button>` : ''}`
    : '<p class="note">No top picks this week. Add favorite artists and genres in <a href="/settings.html">Settings</a>, or mark shows Maybe so EventLight learns what you like.</p>';
  const days = b.days
    .map((d) => `<section>
      <button class="dh ${d.date === b.today ? 'today' : ''}" data-open="day" data-key="${d.date}">
        <span class="dl">${esc(dayName(d.date))}</span><span class="dd">${esc(shortDate(d.date))}</span><span class="dc">${d.total} on ›</span>
      </button>
      ${d.best.length ? d.best.map((e) => row(e)).join('') : `<p class="quiet">${d.total ? 'Quiet night. Nothing that clears your bar.' : 'Nothing listed yet.'}</p>`}
      ${d.more > 0 ? `<button class="more" data-open="day" data-key="${d.date}">+${d.more} more</button>` : ''}
    </section>`)
    .join('');
  const further = b.further.length
    ? `<h2 class="h">Further out</h2><div class="further">${b.further.map(furtherCard).join('')}</div>`
    : '';
  // One column on phones; on a wide screen, picks and further out sit beside the days.
  return `<h1 class="title">This week</h1>
    <div class="range">${esc(shortDate(b.from))} – ${esc(shortDate(b.to))}</div>
    <div class="strip">${strip}</div>
    <div class="week">
      <section class="w-picks"><h2 class="h">Top picks</h2>${picks}</section>
      <section class="w-days"><h2 class="h">Day by day</h2>${days}</section>
      ${further ? `<section class="w-further">${further}</section>` : ''}
    </div>`;
}

// ── Explore ─────────────────────────────────────────────────────────────────
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
        <div class="controls">${chip('all', 'Everything')}${chip('music', 'Music')}${chip('comedy', 'Comedy')}${chip('film', 'Film')}</div>
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

function renderResults() {
  const x = state.explore;
  if (x.type === 'film') return renderFilms();
  if (x.mode === 'calendar') return renderCalendar();
  if (x.loading && !x.events.length) return '<p class="loading">Loading…</p>';
  if (!x.events.length) {
    return '<div class="empty"><strong>Nothing matches</strong>Try another search or city. <button class="linkbtn" data-act="x-clear">Clear filters</button></div>';
  }
  const count = `<div class="count">${x.total} upcoming ${x.total === 1 ? 'show' : 'shows'}</div>`;
  let body;
  if (x.sort === 'relevance') {
    body = x.events.map((e) => row(e, { why: true, day: true })).join('');
  } else {
    const byDate = new Map();
    for (const e of x.events) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }
    body = [...byDate]
      .map(([date, evs]) => `<div class="sh"><span class="dl">${esc(dayName(date))}</span><span class="dd">${esc(shortDate(date))}</span>
        <button class="dc linkbtn" data-open="day" data-key="${date}">Whole night ›</button></div>
        ${evs.map((e) => row(e, { why: true })).join('')}`)
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
    _reasons: special ? [{ kind: 'film', text: m.showtimes.length === 1 ? 'One night only' : 'Special screening' }] : [],
  };
}

function renderFilms() {
  const m = state.movies;
  if (!m) return '<p class="loading">Loading…</p>';
  const section = (label, list, special) =>
    list.length ? `<h2 class="h">${label}</h2>${list.map((f) => row(movieEntry(f, special), { day: true, why: true })).join('')}` : '';
  const out = section('Special screenings', m.special, true) + section('Now playing', m.nowPlaying, false) + section('Coming soon', m.comingSoon, false);
  // Kids' films and vapid action films are filtered out; each says why, and
  // films you hid can come back.
  const left = [...m.filtered, ...m.hidden];
  const leftOut = left.length
    ? `<button class="more" data-act="x-leftout">${state.showLeftOut ? 'Hide what’s left out' : `Show what’s left out (${left.length})`}</button>
       ${state.showLeftOut ? left.map((f) => `<div class="row dim">
          <span class="r-time">${esc(monthDay(localISO(new Date(f.showtimes[0]))))}</span>
          <span class="r-body"><span class="r-title">${esc(f.title)}</span><span class="r-meta">${esc(f.hidden ? 'Hidden by you' : f._filter?.reason || 'Filtered')}</span></span>
          <span class="r-pills">${f.hidden ? `<button class="pb" data-act="unhide-film" data-id="${f.id}">Show again</button>` : ''}</span>
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
    cells += `<button class="cc ${date === state.today ? 'today' : ''}" data-open="day" data-key="${date}" ${past || !n ? 'disabled' : ''}
      aria-label="${esc(shortDate(date))}, ${n} on">${d}${n ? `<span class="n">${n}</span>` : ''}</button>`;
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
    ? `<div class="tickets">${s.going.map(ticket).join('')}</div>`
    : '<p class="note">Nothing yet. Mark a show Going and it lands here, stamped.</p>';
  const maybe = s.maybe.length
    ? s.maybe.map((e) => row(e, { why: true, day: true })).join('')
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
  const lineup = d.lineup.length
    ? `<div class="s-h">Lineup</div><div class="acts">${d.lineup.map((a, i) => {
        const note = a.favorite ? '♥ Favorite' : a.starred ? '★ Starred before' : a.similar ? `≈ ${a.similar.seed}` : a.tags.slice(0, 2).join(', ');
        return `<button class="actchip" data-open="artist" data-key="${enc(a.name)}">
          <span><span class="role">${i === 0 ? 'Headliner' : 'Support'}${note ? ` · ${esc(note)}` : ''}</span>${esc(a.name)}</span><span class="chev">›</span></button>`;
      }).join('')}</div>`
    : '';
  return {
    body: `<p class="s-eye">${esc(dayName(e.date))} · ${esc(shortDate(e.date))}${e.time ? ` · ${fmtTime(e.time)}` : ''}</p>
      <div class="s-title">${esc(headline(e))}</div>
      ${headline(e) !== e.title ? `<p class="s-sub">${esc(e.title)}</p>` : ''}
      <p class="s-sub"><button class="s-link" data-open="venue" data-key="${enc(e.venue)}">${esc(e.venue)}</button>${e.city ? ` · ${esc(e.city)}` : ''}</p>
      ${factsGrid([['Doors', fmtTime(e.doors_time) || '—'], ['Show', fmtTime(e.time) || 'TBA'], ['Price', e.price_range || '—'], ['From home', fromHome]])}
      <div class="s-h">Why it’s here</div>
      ${reasons.length
        ? `<ul class="reasons">${reasons.map((r) => `<li><span class="g">${GLYPH[r.kind] || '·'}</span>${esc(r.text)}</li>`).join('')}</ul>`
        : `<p class="s-sub">${matched.length ? 'Matches genres you like.' : 'Nothing on this bill matches your favorites or genres yet.'}</p>`}
      ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag ${isHit(t) ? 'hit' : ''}">${esc(t)}</span>`).join('')}</div>` : ''}
      ${lineup}
      <div class="s-h">Same night</div>
      ${d.sameNight.length ? d.sameNight.map((x) => row(x, { why: true })).join('') : '<p class="s-sub">Nothing else listed.</p>'}
      <button class="more" data-open="day" data-key="${e.date}">See the whole night ›</button>`,
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
  const reason = (f._reasons || [])[0];
  return {
    body: `<p class="s-eye">Film${f.times ? ` · ${esc(dayName(f.date))} · ${esc(shortDate(f.date))}` : ''}</p>
      <div class="s-title">${esc(f.title)}</div>
      <p class="s-sub">${esc([f.year, f.rating, runtime(f.runtime), f.genre].filter(Boolean).join(' · '))}</p>
      <p class="s-sub">${esc([f.venue, f.city].filter(Boolean).join(' · '))}</p>
      ${isHttp(f.poster_url) ? `<img class="poster" src="${esc(f.poster_url)}" alt="" loading="lazy" />` : ''}
      ${reason ? `<p class="s-text">${GLYPH.film} ${esc(reason.text)}</p>` : ''}
      ${f.director || f.starring ? `<p class="s-text">${esc([f.director ? `Directed by ${f.director}` : '', f.starring ? `With ${f.starring}` : ''].filter(Boolean).join('. '))}</p>` : ''}
      ${f.synopsis ? `<p class="s-text">${esc(f.synopsis)}</p>` : ''}
      ${scores.length ? `<div class="tags">${scores.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}
      <div class="s-h">Showtimes</div>${times}`,
    acts: `<button class="pb" data-act="hide-film" data-id="${f.movie_id}">Hide film</button>
      ${isHttp(f.trailer_url) ? `<a class="pb" href="${esc(f.trailer_url)}" target="_blank" rel="noopener">Trailer</a>` : ''}
      ${isHttp(f.ticket_url) ? `<a class="tix" href="${esc(f.ticket_url)}" target="_blank" rel="noopener">Tickets →</a>` : ''}`,
  };
}

function sheetDay(d) {
  const counts = [`${d.shows.length} ${d.shows.length === 1 ? 'show' : 'shows'}`, d.films.length ? `${d.films.length} ${d.films.length === 1 ? 'film' : 'films'}` : '']
    .filter(Boolean)
    .join(' · ');
  return {
    body: `<p class="s-eye">${esc(shortDate(d.date))}</p>
      <div class="s-title">${esc(dayName(d.date))}</div>
      <p class="s-sub">${counts}. Best first.</p>
      ${d.shows.length ? `<div class="s-h">Shows</div>${d.shows.map((e) => row(e, { why: true })).join('')}` : ''}
      ${d.films.length ? `<div class="s-h">At the movies</div>${d.films.map((f) => row(f, { why: true })).join('')}` : ''}
      ${!d.shows.length && !d.films.length ? '<p class="s-sub">Nothing listed for this night.</p>' : ''}`,
    acts: '',
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
  const genres = [...new Set([...(a.tags || []), ...(p?.apple?.genre ? [p.apple.genre.toLowerCase()] : [])])];
  const songs = p?.apple?.songs || [];
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
    acts: `${isHttp(p?.apple?.url) ? `<a class="tix apple" href="${esc(p.apple.url)}" target="_blank" rel="noopener">Apple Music ↗</a>` : ''}
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
    const profile = await api(`/api/artist/profile?name=${encodeURIComponent(top.key)}`);
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
      ${v.upcoming.length ? v.upcoming.map((e) => row(e, { day: true, why: true })).join('') : '<p class="s-sub">Nothing listed in the next two months.</p>'}`,
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
  day: { url: (k) => `/api/views/day?date=${encodeURIComponent(k)}`, render: sheetDay },
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
// One player for the whole app: tapping a song plays its preview, tapping it
// again pauses, and closing or leaving the sheet stops it.
const player = new Audio();
player.preload = 'none';
function syncPlayer() {
  const current = player.src && !player.paused && !player.error ? player.src : null;
  sheetBody.querySelectorAll('.song').forEach((el) => {
    const on = current && decodeURIComponent(el.dataset.key) === current;
    el.classList.toggle('playing', Boolean(on));
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (!on) el.style.setProperty('--p', '0');
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
  const el = [...sheetBody.querySelectorAll('.song.playing')][0];
  if (el && player.duration) el.style.setProperty('--p', String(player.currentTime / player.duration));
});

function openSheet(type, key) {
  if (!sheet.stack.length) sheet.opener = document.activeElement;
  stopPreview();
  const top = sheet.stack[sheet.stack.length - 1];
  if (top && top.type === type && top.key === key) return;
  sheet.stack.push({ type, key, data: null });
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

async function changePlan(id, target) {
  const copies = shown.get(id);
  const e = copies && [...copies][0];
  if (!e) return;
  const current = e.going ? 'going' : e.interested ? 'maybe' : null;
  const plan = current === target ? null : target;
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
  if (state.route === 'saved') await loadSaved();
  else render();
  if (sheet.stack.length) renderSheet();
}

async function hideEvent(id) {
  try {
    await post(`/api/events/${id}/hidden`, { value: true });
  } catch {
    toast('Couldn’t hide that. Try again.');
    return;
  }
  toast('Hidden. Settings → Clear hidden brings it back.');
  closeSheet();
  load();
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
  load();
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
  load();
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
  load();
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
function exploreParams() {
  const x = state.explore;
  const p = new URLSearchParams();
  if (x.type === 'music' || x.type === 'comedy') p.set('category', x.type);
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
  x.loading = true;
  try {
    const r = await api(`/api/events?${p}`);
    x.events = append ? x.events.concat(r.events) : r.events;
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
  if (state.route === 'explore' && box) box.innerHTML = renderResults();
}

// ── Routing ─────────────────────────────────────────────────────────────────
const ROUTES = ['week', 'explore', 'saved'];

function render() {
  const r = state.route;
  view.innerHTML = r === 'week' ? renderWeek() : r === 'explore' ? renderExplore() : renderSaved();
}

async function loadSaved() {
  const [saved, curated] = await Promise.all([api('/api/views/saved'), api('/api/views/curated').catch(() => null)]);
  state.saved = saved;
  state.curated = curated;
  if (state.route === 'saved') render();
}

async function load() {
  const r = state.route;
  try {
    if (r === 'week') {
      const brief = await api('/api/views/brief');
      state.brief = brief;
      state.today = brief.today;
    } else if (r === 'explore') {
      if (!state.facets.cities.length) state.facets = await api('/api/filters').catch(() => state.facets);
      state.explore.page = 1;
      await loadExploreResults();
    } else if (r === 'saved') {
      await loadSaved();
      return;
    }
  } catch {
    view.innerHTML = '<div class="empty"><strong>Can’t reach EventLight</strong>Check that the server is running, then reload.</div>';
    return;
  }
  if (state.route === r) render();
}

function route() {
  const r = location.hash.replace('#', '');
  state.route = ROUTES.includes(r) ? r : 'week';
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === state.route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  closeSheet();
  render();
  load();
  window.scrollTo(0, 0);
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
  const btn = ev.target.closest('button');
  if (!btn || btn.disabled) return;
  const { plan, id, open, key, act } = btn.dataset;
  if (plan) {
    changePlan(Number(id), plan);
    return;
  }
  if (open) {
    const k = open === 'artist' || open === 'venue' ? decodeURIComponent(key) : key;
    openSheet(open, k);
    return;
  }
  const x = state.explore;
  if (act?.startsWith('x-')) flushSearch();
  switch (act) {
    case 'close': closeSheet(); break;
    case 'back': stopPreview(); sheet.stack.pop(); renderSheet(); break;
    case 'play': playPreview(decodeURIComponent(key)); break;
    case 'morepicks': state.morePicks = !state.morePicks; render(); break;
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
  if (ev.key === 'Escape' && sheet.stack.length) closeSheet();
});

window.addEventListener('hashchange', route);
route();
loadStatus();
setInterval(loadStatus, 60000);
