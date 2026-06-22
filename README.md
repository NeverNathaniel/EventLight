# EventLight

A self-hosted dashboard for live **music** and **comedy** across **Seattle, Tacoma, and the South Sound**. EventLight pulls events from APIs, RSS/iCal feeds, and headless web scrapers on a schedule, merges them into one deduplicated list, scores them against your taste, and presents everything in a dark "venue marquee" dashboard.

- **Tonight / This Week / Top Picks / Curated / This Month / Browse All** views
- **Add a venue by URL** — paste a website and EventLight auto-detects an RSS feed, iCal feed, or embedded event data before falling back to scraping
- **Preference engine** — manual genre weights + behavioral learning from what you mark _Interested_
- **Curate with Claude Code** — a `/curate` routine filters and ranks your events by plain-English criteria and publishes them to the dashboard
- **Modular ingestion** — one adapter per source; failures are isolated and logged
- **Local-first** — Node + Express + SQLite, no external database, no build step
- **Runs in Docker** — one `docker compose up` with persistent volumes

---

## Prerequisites

- **Node.js ≥ 18** (developed on Node 22)
- A one-time **Playwright Chromium** install for scraping:

  ```bash
  npx playwright install chromium
  ```

- API keys are optional but recommended (see below). Without keys, the API adapters are skipped and the app runs on feeds + scrapers only.

---

## Install & run

```bash
npm install
npx playwright install chromium      # one time, for the scraper
cp .env.example .env                 # then add your API keys
npm start
```

Open **http://localhost:3000**.

The SQLite database is created automatically at `data/events.db` on first boot. To initialise it explicitly without starting the server: `npm run init-db`.

---

## Run with Docker

The image is built on the official Playwright base, so Chromium and all its system dependencies are included — no separate `playwright install` step.

```bash
cp .env.example .env          # required first — add your API keys
docker compose up --build -d  # build + start in the background
# open http://localhost:3000
```

- `cp .env.example .env` **before** the first run — Compose reads `.env` for config and bind-mounts it for runtime edits.
- Persistent volumes keep your data across rebuilds: `./data` (the SQLite DB), plus `./feeds.json`, `./scrapers.json`, and `./.env` so changes made in the Settings UI survive.
- Change the published port with `PORT=8080` in `.env` (the app always listens on `3000` inside the container).
- Convenience scripts: `npm run docker:up`, `npm run docker:down`, `npm run docker:logs`.

---

## Configure `.env`

Copy `.env.example` to `.env` and fill in what you have. You can also paste keys into the **Settings** page in the UI — they're written back to `.env`.

| Variable | Purpose |
| --- | --- |
| `PORT` | Server port (default `3000`) |
| `TICKETMASTER_API_KEY` | [Ticketmaster Discovery API](https://developer.ticketmaster.com/) consumer key |
| `BANDSINTOWN_APP_ID` | [Bandsintown](https://artists.bandsintown.com/support/api-installation) app ID |
| `EVENTBRITE_API_KEY` | [Eventbrite](https://www.eventbrite.com/platform/api) private OAuth token |
| `HEADLESS` | `true` (default) or `false` to watch the scraper browser while debugging |
| `REFRESH_CRON` | Cron expression for scheduled ingestion (default `0 */6 * * *` — every 6 hours) |
| `REFRESH_ON_START` | `true` to run a full ingestion when the server boots |

> API keys are **never** hardcoded — they're read from `.env` exclusively. The Settings page reports only whether each key is configured, never its value.

---

## Data sources

Each source is an adapter in `src/adapters/`. The scheduler runs them all every 6 hours, merging results into one `events` table and **deduplicating by title + date + venue**.

| Type | Sources |
| --- | --- |
| **APIs** | Ticketmaster (latlong + 30mi radius, Music & Comedy), Eventbrite (Seattle/Tacoma), Bandsintown (resolves artists you've marked _Interested_) |
| **RSS / iCal / JSON-LD** | Configured in `feeds.json` — Showbox, Paramount, Moore, Tacoma Dome, Tacoma Comedy Club, The Crocodile, Neumos, Chop Suey (seeded) |
| **Scrapers** | Configured in `scrapers.json` — Tractor Tavern, Skylark Cafe, New Frontier Lounge, Full Tilt (Georgetown), Jazzbones, Louie G's, The Valley (seeded) |
| **Manual** | The **＋ Add** button in the UI |

### Add a venue by URL (auto-discovery)

The fastest way to add a venue: **Settings → Add a Venue by URL**, paste the website, and hit **Discover**. EventLight probes the page in order and recommends the cleanest method:

1. **RSS / Atom feed** — `<link rel="alternate">` autodiscovery tags, then common feed paths
2. **iCal feed** — `.ics` / `webcal:` links
3. **JSON-LD** — `schema.org/Event` structured data embedded in the page (parsed directly, no scraping)
4. **Scrape** — fallback only; adds a scraper template with guessed selectors to tune

It also flags third-party providers it spots (Eventbrite, Bandsintown, Songkick, Ticketmaster, DICE, …) so you know to set the matching API key. Click **Add** and the source is written to `feeds.json` or `scrapers.json`. (Available programmatically via `POST /api/discover`.)

### Add a new RSS / iCal / JSON-LD feed

Either use **Settings → RSS / iCal Feeds → Add feed** in the UI, or edit `feeds.json` directly:

```json
{
  "id": "barboza",
  "name": "Barboza",
  "url": "https://www.thebarboza.com/events/feed/",
  "type": "rss",
  "city": "Seattle",
  "venue": "Barboza",
  "category": "music",
  "enabled": true
}
```

- `type` is `rss`, `ical`, or `jsonld` (for venue pages with embedded `schema.org/Event` data — set `url` to the page itself).
- Set `enabled` to `false` to skip it on refresh.
- No restart needed for UI edits; a hand-edited file is picked up on the next refresh.

> The seeded feed URLs are best-effort guesses. If one 404s it will be logged as an error in the status bar — verify the real feed URL, or move that venue to `scrapers.json`.

### Add a new scraper

Use **Settings → Web Scrapers → Add scraper**, or edit `scrapers.json`:

```json
{
  "id": "barboza",
  "name": "Barboza",
  "url": "https://www.thebarboza.com/calendar",
  "city": "Seattle",
  "venue": "Barboza",
  "category": "music",
  "enabled": true,
  "waitFor": ".event",
  "selectors": {
    "item": ".event",
    "name": ".event-title, h3",
    "date": "time, .event-date",
    "ticketLink": "a[href*='ticket'], a",
    "image": "img",
    "price": ".price"
  }
}
```

- `selectors.item` is the repeating element for each event; the other selectors are queried **within** each item (comma-separated fallback lists are allowed).
- `waitFor` is an optional selector to wait for on JS-rendered pages.
- A `<time datetime="…">` element is the most reliable date source.
- To debug selectors visually, set `HEADLESS=false` in `.env` and re-run the scraper from Settings.

**Selector drift** (a site changing its markup) is the usual cause of a scraper returning zero events. EventLight logs this clearly — check the status bar at the bottom of the dashboard, or **Settings → Last Refresh by source**, and `GET /api/status/logs` for the raw log.

---

## Manual refresh

- **UI:** the **Refresh now** button on the dashboard, or **Settings → Maintenance** to run all sources or a single adapter.
- **CLI:** `npm run refresh` runs every adapter once and prints a summary, then exits.

---

## Preference engine

Scores are computed at query time and used for **Top Picks** and the **relevance** sort.

1. **Manual weights (Layer 1)** — in Settings, weight your genres 1–5. An event's base score is the sum of the weights of the genres it matches.
2. **Behavioral learning (Layer 2)** — when you mark an event _Interested_, its genre tags and artist become signals. Matching events get a boost equal to the summed signal counts, **decayed** by the number of weeks since each signal was last seen (divisor floored at 1).

---

## Curate with Claude Code

For when you want richer, plain-English filtering than the built-in controls — _"post-punk and indie under $25, nothing on a Monday, soonest first"_ — there's a `/curate` routine you run from [Claude Code](https://claude.com/claude-code) in this repo:

```
/curate post-punk and indie under $25, soonest first
```

What happens:

1. The command runs `npm run export-events`, dumping upcoming events to `data/events-export.json` (id, title, venue, date, genres, price, and EventLight's own preference score).
2. Claude reads that file, selects and **ranks** the events that match your request, and writes `data/curated.json` — each pick with a one-line reason.
3. Open the **Curated** tab in the dashboard (or refresh it) to see the ranked picks with Claude's reasoning. Interested/Hide work there like any other view.

It's intentionally simple — a single-user, private-repo workflow. The routine lives in `.claude/commands/curate.md`; edit it to change how curation reasons. You can also run the export manually with `npm run export-events` and consume the JSON however you like.

---

## Project structure

```
src/
  adapters/        one file per source + the runAll() orchestrator
  db/              SQLite setup, schema, migrations, query helpers
  routes/          Express handlers (events, settings, refresh, status, discover)
  scheduler/       node-cron job + manual triggers
  scoring/         preference engine
  cli/             refresh + export-events commands
  discovery.js     paste-a-URL source auto-discovery (RSS/iCal/JSON-LD/scrape)
  public/          frontend (HTML, CSS, vanilla JS + Alpine.js, vendored)
.claude/
  commands/        /curate Claude Code routine
feeds.json         RSS/iCal/JSON-LD feed config (editable in UI)
scrapers.json      scraper config (editable in UI)
Dockerfile         Playwright-based image
docker-compose.yml one-command stack with persistent volumes
.env.example       configuration template
data/events.db     SQLite database (created at runtime, gitignored)
```

```
src/
  adapters/      one file per source + the runAll() orchestrator
  db/            SQLite setup, schema, migrations, query helpers
  routes/        Express route handlers (events, settings, refresh, status)
  scheduler/     node-cron job + manual triggers
  scoring/       preference engine
  cli/           one-shot refresh command
  public/        frontend (HTML, CSS, vanilla JS + Alpine.js, vendored)
feeds.json       RSS/iCal feed config (editable in UI)
scrapers.json    scraper config (editable in UI)
.env.example     configuration template
data/events.db   SQLite database (created at runtime, gitignored)
```

---

## API reference (local)

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/views/tonight` | Today's events |
| `GET` | `/api/views/week` | This week, grouped by day |
| `GET` | `/api/views/top-picks` | Highest-scored events, next 30 days |
| `GET` | `/api/views/curated` | Picks produced by the `/curate` routine |
| `GET` | `/api/views/month?month=YYYY-MM` | Calendar counts + events |
| `GET` | `/api/events` | Paginated, filterable, sortable list |
| `POST` | `/api/events` | Add an event manually |
| `POST` | `/api/events/:id/interested` | Toggle interested (records signals) |
| `POST` | `/api/events/:id/hidden` | Hide an event |
| `GET` | `/api/filters` | Distinct cities, sources, tags |
| `GET` | `/api/status` | Last run per source + scheduler state |
| `POST` | `/api/refresh` | Run all adapters now |
| `POST` | `/api/refresh/:adapter` | Run one adapter (`ticketmaster`, `eventbrite`, `bandsintown`, `rss`, `scraper`) |
| `POST` | `/api/discover` | Probe a venue URL for RSS/iCal/JSON-LD/scrape |
| `POST` | `/api/discover/add` | Save a discovered source to `feeds.json`/`scrapers.json` |
| `GET` | `/api/export/ics` | Download interested events as `.ics` |

All filter params (`category`, `city`, `genres`, `sources`, `search`, `onlyInterested`, `showHidden`) apply to the view endpoints too.

---

## License

MIT
