// EventLight settings page — Alpine component.
function settings() {
  return {
    data: {
      apiKeys: { ticketmaster: false, bandsintown: false },
      headless: true, cron: '', genres: [], artists: [], enrichment: null, preferences: [], tasteProfile: null, feeds: [], scrapers: [],
      home: { city: '', boost: 0, levels: [], cities: [] },
      alerts: { topic: '', artists: true, digest: true, subscribeUrl: null, schedule: '' },
    },
    status: { sources: [] },
    keys: { ticketmaster: '', bandsintown: '' },
    newGenre: '',
    newArtist: '',
    newFeed: { name: '', url: '', type: 'rss', venue: '', city: '', category: 'music' },
    newScraper: { name: '', url: '', city: '', item: '', name_sel: '', date_sel: '', link_sel: '' },
    adapters: ['ticketmaster', 'bandsintown', 'rss', 'scraper', 'cinema', 'enrich'],
    discover: { url: '', busy: false, result: null, error: null, adding: false },
    busy: false,
    toast: '',

    async init() {
      await this.reload();
      await this.loadStatus();
    },

    // ── Add a venue by URL (auto-discovery) ──────────────────────────────────
    async runDiscover() {
      const url = this.discover.url.trim();
      if (!url) { this.flash('Paste a venue URL first.'); return; }
      this.discover.busy = true;
      this.discover.result = null;
      this.discover.error = null;
      try {
        const r = await postJSON('/api/discover', { url });
        if (r.error) this.discover.error = r.error;
        else this.discover.result = r;
      } catch {
        this.discover.error = 'Discovery failed — check the URL and try again.';
      } finally {
        this.discover.busy = false;
      }
    },
    async addDiscovered() {
      const rec = this.discover.result?.recommended;
      if (!rec) return;
      this.discover.adding = true;
      try {
        const r = await postJSON('/api/discover/add', { target: rec.target, config: rec.config });
        if (r.error) { this.flash(r.error); return; }
        this.flash(`Added ${rec.config.name} as ${this.methodLabel(rec.method)}.`);
        this.discover.result = null;
        this.discover.url = '';
        await this.reload(); // refresh feed/scraper lists below
      } finally {
        this.discover.adding = false;
      }
    },
    methodLabel(m) {
      return { venuepilot: 'VenuePilot feed', tribe: 'WordPress events feed', squarespace: 'Squarespace events feed', rss: 'RSS feed', ical: 'iCal feed', jsonld: 'Structured data', scrape: 'Scraper' }[m] || m;
    },
    discoverSummary(res) {
      const rec = res.recommended;
      if (rec.method === 'scrape') return `No feed or API found — will scrape ${rec.config.url}`;
      const n = rec.sampleCount || 0;
      return `${n} event(s) found · ${rec.config.url}`;
    },
    async reload() {
      try { this.data = await getJSON('/api/settings'); } catch { this.flash('Could not load settings.'); }
    },
    async loadStatus() {
      try { this.status = await getJSON('/api/status'); } catch { /* non-fatal */ }
    },

    // ── Close to home ──────────────────────────────────────────────────────
    async saveHome(change) {
      const r = await postJSON('/api/settings/home', change);
      if (r.error || !r.home) { this.flash(r.error || 'Could not save.'); return; }
      this.data.home = { ...this.data.home, ...r.home };
      this.flash(r.home.boost ? `Shows near ${r.home.city} get +${r.home.boost}%.` : 'Close-to-home boost is off.');
    },

    // ── Alerts ─────────────────────────────────────────────────────────────
    randomTopic() {
      const bytes = crypto.getRandomValues(new Uint8Array(14));
      return 'eventlight-' + Array.from(bytes, (b) => (b % 36).toString(36)).join('');
    },
    async saveAlerts() {
      const { topic, artists, digest } = this.data.alerts;
      const r = await postJSON('/api/settings/alerts', { topic, artists, digest });
      if (r.alerts) this.data.alerts = r.alerts;
      if (r.error) { this.flash(r.error); return; }
      if (!r.alerts) { this.flash('Could not save.'); return; }
      this.flash(r.sent?.welcome ? 'Saved — a confirmation is on its way to your phone.' : 'Alerts saved.');
    },
    async alertAction(url, ok) {
      const r = await postJSON(url, {});
      if (r.error) { this.flash(r.error); return; }
      this.flash(r.skipped === 'nothing to pick' ? 'Nothing to send — no picks in the next two weeks.' : ok);
    },

    // ── API keys ───────────────────────────────────────────────────────────
    async saveKeys() {
      const payload = {};
      for (const k of ['ticketmaster', 'bandsintown']) {
        if (this.keys[k].trim()) payload[k] = this.keys[k].trim();
      }
      if (!Object.keys(payload).length) { this.flash('Enter at least one key.'); return; }
      await postJSON('/api/settings/keys', payload);
      this.keys = { ticketmaster: '', bandsintown: '' };
      await this.reload();
      this.flash('API keys saved.');
    },

    // ── favorite artists ─────────────────────────────────────────────────────
    async setArtistWeight(a, weight) {
      await postJSON('/api/settings/artists', { name: a.name, weight });
      await this.reload();
    },
    async addArtist() {
      const name = this.newArtist.trim();
      if (!name) return;
      await postJSON('/api/settings/artists', { name, weight: 4 });
      this.newArtist = '';
      await this.reload();
      this.flash(`${name} added — similar artists are looked up on the next refresh.`);
    },
    async delArtist(key) {
      await fetch(`/api/settings/artists/${encodeURIComponent(key)}`, { method: 'DELETE' });
      await this.reload();
    },

    // ── genres ─────────────────────────────────────────────────────────────
    async setWeight(genre, weight) {
      await postJSON('/api/settings/genres', { genre, weight });
      await this.reload();
    },
    async addGenre() {
      const genre = this.newGenre.trim();
      if (!genre) return;
      await postJSON('/api/settings/genres', { genre, weight: 3 });
      this.newGenre = '';
      await this.reload();
      this.flash('Genre added.');
    },
    async delGenre(genre) {
      await fetch(`/api/settings/genres/${encodeURIComponent(genre)}`, { method: 'DELETE' });
      await this.reload();
    },
    sortedPrefs() {
      return [...this.data.preferences].sort((a, b) => b.signal_count - a.signal_count);
    },

    // ── feeds ──────────────────────────────────────────────────────────────
    async toggleFeed(f) {
      await putJSON(`/api/settings/feeds/${f.id}`, { enabled: f.enabled === false });
      await this.reload();
    },
    async delFeed(id) {
      await fetch(`/api/settings/feeds/${id}`, { method: 'DELETE' });
      await this.reload();
    },
    async addFeed() {
      if (!this.newFeed.name || !this.newFeed.url) { this.flash('Feed needs a name and URL.'); return; }
      const res = await postJSON('/api/settings/feeds', this.newFeed);
      if (res.error) { this.flash(res.error); return; }
      this.newFeed = { name: '', url: '', type: 'rss', venue: '', city: '', category: 'music' };
      await this.reload();
      this.flash('Feed added.');
    },

    // ── scrapers ───────────────────────────────────────────────────────────
    async toggleScraper(s) {
      await putJSON(`/api/settings/scrapers/${s.id}`, { enabled: s.enabled === false });
      await this.reload();
    },
    async delScraper(id) {
      await fetch(`/api/settings/scrapers/${id}`, { method: 'DELETE' });
      await this.reload();
    },
    async addScraper() {
      const n = this.newScraper;
      if (!n.name || !n.url || !n.item) { this.flash('Scraper needs a name, URL and item selector.'); return; }
      const payload = {
        name: n.name, url: n.url, city: n.city, category: 'music',
        waitFor: n.item,
        selectors: {
          item: n.item, name: n.name_sel || 'h2, h3', date: n.date_sel || 'time, .date',
          ticketLink: n.link_sel || "a[href*='ticket'], a", image: 'img', price: '.price',
        },
      };
      const res = await postJSON('/api/settings/scrapers', payload);
      if (res.error) { this.flash(res.error); return; }
      this.newScraper = { name: '', url: '', city: '', item: '', name_sel: '', date_sel: '', link_sel: '' };
      await this.reload();
      this.flash('Scraper added.');
    },

    // ── maintenance ──────────────────────────────────────────────────────────
    async refreshAll() {
      this.busy = true;
      this.flash('Running all sources… this can take a minute.');
      try {
        await fetch('/api/refresh', { method: 'POST' });
        await this.loadStatus();
        this.flash('Refresh complete.');
      } finally { this.busy = false; }
    },
    async runAdapter(id) {
      this.busy = true;
      this.flash(`Running ${id}…`);
      try {
        await fetch(`/api/refresh/${id}`, { method: 'POST' });
        await this.loadStatus();
        this.flash(`${id} finished.`);
      } finally { this.busy = false; }
    },
    async clearHidden() {
      const { cleared } = await postJSON('/api/settings/clear-hidden', {});
      this.flash(`${cleared} event(s) un-hidden.`);
    },

    // ── helpers ──────────────────────────────────────────────────────────────
    lastRun(sourceName) {
      const s = this.status.sources.find((x) => x.source_name === sourceName);
      if (!s) return 'not run yet';
      return `last run ${relTime(s.run_at)} · ${s.status}` + (s.error_msg ? ` · ${s.error_msg}` : '');
    },
    relTime,
    flash(msg) {
      this.toast = msg;
      clearTimeout(this._t);
      this._t = setTimeout(() => (this.toast = ''), 3200);
    },
  };
}

// ── shared helpers (mirror app.js) ─────────────────────────────────────────
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}
async function putJSON(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
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
