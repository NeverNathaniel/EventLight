// EventLight dashboard — Alpine component.
// Card markup lives in card() and is rendered via x-html; interactions use
// event delegation (onCardClick) so a single click handler drives every card.

function dashboard() {
  return {
    view: 'tonight',
    loading: true,
    refreshing: false,
    openMenu: null,
    showAdd: false,
    toast: '',
    todayStr: localISO(new Date()),

    filters: {
      category: 'all',
      city: 'all',
      genres: [],
      sources: [],
      search: '',
      sort: 'date',
      onlyInterested: false,
      showHidden: false,
    },

    facets: { cities: [], sources: [], tags: [] },
    status: { sources: [], scheduler: { running: false }, lastRunAt: null, totalEvents: 0 },

    tonight: { date: localISO(new Date()), events: [] },
    week: { days: [] },
    top: { events: [] },
    month: { month: localISO(new Date()).slice(0, 7), counts: {}, events: [], cells: [], selectedDay: null },
    browse: { events: [], total: 0, page: 1, pages: 1, pageSize: 50 },

    form: blankForm(),

    // ── lifecycle ──────────────────────────────────────────────────────────
    async init() {
      this.restore();
      await this.loadFacets();
      await this.loadStatus();
      await this.load();
      this.loading = false;
      // Keep the status bar fresh.
      setInterval(() => this.loadStatus(), 30000);
    },

    restore() {
      try {
        const f = JSON.parse(localStorage.getItem('eventlight.filters') || 'null');
        if (f) this.filters = { ...this.filters, ...f };
        const v = localStorage.getItem('eventlight.view');
        if (v) this.view = v;
      } catch { /* ignore corrupt storage */ }
    },
    persist() {
      localStorage.setItem('eventlight.filters', JSON.stringify(this.filters));
      localStorage.setItem('eventlight.view', this.view);
    },

    // ── navigation / filtering ───────────────────────────────────────────────
    setView(v) {
      this.view = v;
      this.persist();
      this.load();
    },
    setFilter(key, value) {
      this.filters[key] = value;
      this.apply();
    },
    toggleMenu(name) {
      this.openMenu = this.openMenu === name ? null : name;
    },
    apply() {
      this.persist();
      this.browse.page = 1;
      this.load();
    },
    setPage(p) {
      if (p < 1 || p > this.browse.pages) return;
      this.browse.page = p;
      this.load();
    },

    buildParams() {
      const f = this.filters;
      const p = new URLSearchParams();
      if (f.category !== 'all') p.set('category', f.category);
      if (f.city !== 'all') p.set('city', f.city);
      if (f.genres.length) p.set('genres', f.genres.join(','));
      if (f.sources.length) p.set('sources', f.sources.join(','));
      if (f.search) p.set('search', f.search);
      if (f.onlyInterested) p.set('onlyInterested', 'true');
      if (f.showHidden) p.set('showHidden', 'true');
      return p;
    },

    // ── data loading ──────────────────────────────────────────────────────────
    async load() {
      const p = this.buildParams();
      try {
        if (this.view === 'tonight') {
          this.tonight = await getJSON(`/api/views/tonight?${p}`);
        } else if (this.view === 'week') {
          this.week = await getJSON(`/api/views/week?${p}`);
        } else if (this.view === 'top') {
          this.top = await getJSON(`/api/views/top-picks?${p}`);
        } else if (this.view === 'month') {
          const data = await getJSON(`/api/views/month?month=${this.month.month}&${p}`);
          this.month.counts = data.counts;
          this.month.events = data.events;
          this.buildCalendar();
        } else if (this.view === 'browse') {
          p.set('sort', this.filters.sort);
          p.set('page', this.browse.page);
          p.set('pageSize', this.browse.pageSize);
          this.browse = { ...this.browse, ...(await getJSON(`/api/events?${p}`)) };
        }
      } catch (err) {
        this.flash('Could not load events — is the server running?');
        console.error(err);
      }
    },

    async loadFacets() {
      try { this.facets = await getJSON('/api/filters'); } catch { /* non-fatal */ }
    },
    async loadStatus() {
      try { this.status = await getJSON('/api/status'); } catch { /* non-fatal */ }
    },

    // ── refresh ───────────────────────────────────────────────────────────────
    async refreshAll() {
      if (this.refreshing) return;
      this.refreshing = true;
      this.flash('Pulling fresh listings… this can take a minute.');
      try {
        await fetch('/api/refresh', { method: 'POST' });
        await this.loadFacets();
        await this.loadStatus();
        await this.load();
        this.flash('Listings updated.');
      } catch {
        this.flash('Refresh failed — check the server logs.');
      } finally {
        this.refreshing = false;
      }
    },

    // ── card actions (event delegation) ─────────────────────────────────────
    onCardClick(e) {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const host = btn.closest('[data-id]');
      if (!host) return;
      const id = parseInt(host.dataset.id, 10);
      if (btn.dataset.action === 'interested') this.toggleInterested(id);
      else if (btn.dataset.action === 'hide') this.toggleHide(id);
    },

    // The same event id can appear in several view pools as separate object
    // instances (each view is fetched independently), so return every copy.
    findAll(id) {
      const pools = [
        this.tonight.events,
        this.top.events,
        this.browse.events,
        this.month.events,
        ...this.week.days.map((d) => d.events),
      ];
      return pools.flatMap((pool) => pool.filter((x) => x.id === id));
    },

    async toggleInterested(id) {
      const matches = this.findAll(id);
      if (!matches.length) return;
      const value = !matches[0].interested;
      // Optimistic: flip every copy so whichever view is on screen re-renders.
      matches.forEach((ev) => (ev.interested = value ? 1 : 0));
      try {
        await fetch(`/api/events/${id}/interested`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
      } catch {
        matches.forEach((ev) => (ev.interested = value ? 0 : 1)); // revert
        this.flash('Could not save — try again.');
      }
    },

    async toggleHide(id) {
      try {
        await fetch(`/api/events/${id}/hidden`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: true }),
        });
        this.flash('Hidden. Toggle "Show hidden" to bring it back.');
        await this.load();
      } catch {
        this.flash('Could not hide — try again.');
      }
    },

    // ── manual entry ──────────────────────────────────────────────────────────
    openAdd() {
      this.form = blankForm();
      this.showAdd = true;
    },
    async submitManual() {
      if (!this.form.title || !this.form.venue || !this.form.date) {
        this.flash('Title, venue and date are required.');
        return;
      }
      try {
        await fetch('/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.form),
        });
        this.showAdd = false;
        this.flash('Event added.');
        await this.loadFacets();
        await this.load();
      } catch {
        this.flash('Could not add the event.');
      }
    },

    // ── month / calendar ───────────────────────────────────────────────────────
    shiftMonth(delta) {
      const [y, m] = this.month.month.split('-').map(Number);
      const d = new Date(y, m - 1 + delta, 1);
      this.month.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      this.month.selectedDay = null;
      this.load();
    },
    buildCalendar() {
      const [y, m] = this.month.month.split('-').map(Number);
      const first = new Date(y, m - 1, 1);
      const lead = (first.getDay() + 6) % 7; // Monday-start offset
      const daysInMonth = new Date(y, m, 0).getDate();
      const cells = [];
      for (let i = 0; i < lead; i += 1) cells.push({ date: null });
      for (let d = 1; d <= daysInMonth; d += 1) {
        const date = `${this.month.month}-${String(d).padStart(2, '0')}`;
        cells.push({ date, day: d, count: this.month.counts[date] || 0 });
      }
      this.month.cells = cells;
      // Default selection: today if visible, else first day with events.
      if (!this.month.selectedDay) {
        const today = cells.find((c) => c.date === this.todayStr && c.count > 0);
        const firstWith = cells.find((c) => c.count > 0);
        this.month.selectedDay = (today || firstWith || {}).date || null;
      }
    },
    selectDay(date) {
      if (!date) return;
      this.month.selectedDay = date;
    },
    dayEvents() {
      return this.month.events.filter((e) => e.date === this.month.selectedDay);
    },
    monthTitle() {
      const [y, m] = this.month.month.split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    },

    // ── week helpers ───────────────────────────────────────────────────────────
    weekHasEvents() {
      return this.week.days.some((d) => d.events.length);
    },

    // ── status bar ─────────────────────────────────────────────────────────────
    statusDotClass() {
      if (this.refreshing || this.status.scheduler?.running) return 'running';
      if (this.status.sources?.some((s) => s.status === 'error')) return 'error';
      if (this.status.sources?.length) return 'ok';
      return '';
    },
    statusSummary() {
      if (this.refreshing || this.status.scheduler?.running) return 'Refreshing';
      if (!this.status.lastRunAt) return 'Never refreshed';
      return `${this.status.totalEvents} events · ${relTime(this.status.lastRunAt)}`;
    },
    srcTitle(s) {
      const when = relTime(s.run_at);
      const base = `${s.source_name}: ${s.status} · ${when} · +${s.events_added} added`;
      return s.error_msg ? `${base}\n${s.error_msg}` : base;
    },

    // ── hero date formatting ─────────────────────────────────────────────────
    heroDow(dateStr) {
      if (!dateStr) return '';
      return new Date(`${dateStr}T00:00:00`)
        .toLocaleDateString('en-US', { weekday: 'short' })
        .toUpperCase();
    },
    heroMd(dateStr) {
      if (!dateStr) return '';
      return new Date(`${dateStr}T00:00:00`)
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        .toUpperCase();
    },

    // ── card renderer ──────────────────────────────────────────────────────────
    card(ev, showScore = false) {
      const time = fmtTime(ev.time);
      const date = this.heroMd(ev.date);
      const interested = ev.interested ? 1 : 0;
      const tags = String(ev.genre_tags || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 4);
      const scoreTag =
        showScore && ev._score > 0
          ? `<span class="tag score">★ ${ev._score.toFixed(1)}</span>`
          : '';
      const tagsHtml = tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
      const price = ev.price_range ? `<span class="price">${esc(ev.price_range)}</span>` : '';
      const ticket = ev.ticket_url
        ? `<a class="ticket-btn" href="${esc(ev.ticket_url)}" target="_blank" rel="noopener">Tickets →</a>`
        : '';
      return `
        <article class="card ${interested ? 'is-interested' : ''}" data-id="${ev.id}">
          <div class="card-time">
            <span class="t">${time || '—'}</span>
            <span class="d">${date}</span>
          </div>
          <div class="card-body">
            <div class="card-top">
              <h3 class="card-title">${esc(ev.title)}</h3>
              <div class="card-actions">
                <button class="act star ${interested ? 'on' : ''}" data-action="interested"
                        title="${interested ? 'Remove from interested' : 'Mark interested'}">${interested ? '★' : '☆'}</button>
                <button class="act hide" data-action="hide" title="Hide event">✕</button>
              </div>
            </div>
            <div class="card-meta">${esc(ev.venue || '')}${ev.city ? `<span class="city">${esc(ev.city)}</span>` : ''}</div>
            <div class="tags">${scoreTag}${tagsHtml}</div>
            <div class="card-foot">${price}${ticket}</div>
          </div>
        </article>`;
    },

    // ── toast ──────────────────────────────────────────────────────────────────
    flash(msg) {
      this.toast = msg;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => (this.toast = ''), 3200);
    },
  };
}

// ── module-level helpers ───────────────────────────────────────────────────
function blankForm() {
  return {
    title: '', artist: '', venue: '', city: '', category: 'music',
    date: '', time: '', tags: '', url: '', price_range: '',
  };
}

function localISO(d) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function fmtTime(t) {
  if (!t || !/^\d{2}:\d{2}/.test(t)) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

function relTime(iso) {
  if (!iso) return 'never';
  const then = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
  const diff = Date.now() - then;
  if (Number.isNaN(diff)) return iso;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
