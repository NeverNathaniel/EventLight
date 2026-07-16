# EventLight

A self-hosted dashboard for live **music** and **comedy** across **Seattle, Tacoma, and the South Sound**. EventLight pulls events from APIs, RSS/iCal feeds, and headless web scrapers on a schedule, merges them into one deduplicated list, scores them against your taste, and presents everything in a dark "venue marquee" dashboard.

- **Tonight / This Week / Top Picks / Curated / This Month / Browse All** views
- **Preference engine** — manual genre weights + behavioral learning from what you mark _Interested_
- **Add a venue by URL** — paste a website and EventLight auto-detects an RSS feed, iCal feed, or embedded event data before falling back to scraping
- **Curate with Claude Code** — a `/curate` routine filters and ranks your events by plain-English criteria and publishes them to the dashboard
- **Modular ingestion** — one adapter per source; failures are isolated and logged
- **Local-first** — Node + Express + SQLite, no external database, no build step
- **Runs in Docker** — one `docker compose up` with persistent volumes ([see below](#run-with-docker-linux))

---

## Prerequisites

Two ways to run it — pick one:

- **Docker** (recommended for servers/NAS/LXC): Docker Engine with the Compose plugin. See [Run with Docker (Linux)](#run-with-docker-linux).
- **Bare metal**: **Node.js ≥ 20** (developed on Node 22) plus a one-time **Playwright Chromium** install for scraping:

  ```bash
  npx playwright install chromium
  ```

API keys are optional but recommended (see below). Without keys, the API adapters are skipped and the app runs on feeds + scrapers only.

---

## Install & run (bare metal)

```bash
npm install
npx playwright install chromium      # one time, for the scraper
cp .env.example .env                 # then add your API keys
npm start
```

Open **http://localhost:3000**.

The SQLite database is created automatically at `data/events.db` on first boot. To initialise it explicitly without starting the server: `npm run init-db`.

---

## Run with Docker (Linux)

The image is built on the official **Playwright** base image, so Chromium and every system library it needs are already inside — no `playwright install` step, no browser dependencies on the host. This is the easiest way to run EventLight on a home server, NAS, or Proxmox LXC.

### 1. Install Docker

On a fresh Debian/Ubuntu host ([full instructions for other distros](https://docs.docker.com/engine/install/)):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then log out and back in
```

Verify with `docker compose version` — Compose v2 (the `docker compose` plugin, not the old `docker-compose` binary) is required.

### 2. Start the stack

```bash
git clone https://github.com/NeverNathaniel/EventLight.git
cd EventLight
cp .env.example .env             # REQUIRED before the first run — see note below
docker compose up --build -d
```

Open **http://\<host\>:3000**.

> **Why `cp .env.example .env` is required first:** Compose bind-mounts `./.env` into the container so API keys saved in the Settings UI persist on the host. If the file doesn't exist, Docker creates a *directory* named `.env` in its place and the container fails to start. Create the file first (empty is fine).

### What the stack gives you

| Piece | Purpose |
| --- | --- |
| `./data/` volume | The SQLite database — survives rebuilds and image upgrades |
| `./feeds.json`, `./scrapers.json` bind mounts | Source config — edits made in the Settings UI persist on the host |
| `./.env` bind mount | API keys — editable in the Settings UI or by hand |
| `shm_size: 1gb` | Chromium crashes with Docker's default 64 MB `/dev/shm`, especially inside an LXC |
| `init: true` | Reaps zombie Chromium processes left behind by the scraper |
| Healthcheck | `docker ps` shows `healthy` once the API responds |
| `restart: unless-stopped` | Comes back up after reboots and crashes |

### Configuration

- **Port** — set `PORT=8080` in `.env` to publish on a different host port (the app always listens on 3000 inside the container).
- **Timezone** — set `TZ=America/Los_Angeles` (the default) in `.env`. This matters: the *Tonight* and *This Week* views compute "today" in the container's timezone, so a wrong `TZ` shifts every view by a day around midnight.
- All other variables from the [Configure `.env`](#configure-env) table apply as-is.

### Day-2 operations

```bash
npm run docker:logs                              # tail logs (or: docker compose logs -f)
docker compose exec eventlight npm run refresh   # one-shot ingestion from the CLI
docker compose down                              # stop
git pull && docker compose up --build -d         # upgrade to a new version
```

**Backup:** everything that matters is on the host — copy `data/events.db` (stop the container first, or use `docker compose exec eventlight node -e "require('better-sqlite3')('data/events.db').backup('data/backup.db')"` for a live-safe snapshot), plus `feeds.json`, `scrapers.json`, and `.env`.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| Container exits immediately, logs mention `.env` | `.env` was auto-created as a directory — `docker compose down`, `rmdir .env`, `cp .env.example .env`, `docker compose up -d` |
| Scrapers crash on heavy pages / "Target crashed" | Increase `shm_size` in `docker-compose.yml` (already 1 GB by default) |
| *Tonight* shows the wrong day's events | Set `TZ` in `.env` to your zone and restart |
| Port already in use | Change `PORT` in `.env` and `docker compose up -d` again |
| `docker ps` shows `unhealthy` | `docker compose logs` — the API isn't responding on 3000 inside the container |

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
| `CHROMIUM_PATH` | Optional path to a system Chromium/Chrome binary, for hosts where the Playwright browser download isn't available (ARM boards, NAS boxes) |
| `SCRAPER_CONCURRENCY` | How many scrapers run at once (default `3`, max `8`) — each scraper is a different site, so this stays polite per-domain |
| `REQUEST_DELAY_MS` | Polite delay between outbound requests within an adapter (default `350`) |
| `REFRESH_CRON` | Cron expression for scheduled ingestion (default `0 */6 * * *` — every 6 hours) |
| `REFRESH_ON_START` | `true` to run a full ingestion when the server boots |

> API keys are **never** hardcoded — they're read from `.env` exclusively. The Settings page reports only whether each key is configured, never its value.

---

## Data sources

Each source is an adapter in `src/adapters/`. The scheduler runs them all every 6 hours, merging results into one `events` table and **deduplicating by title + date + venue**.

| Type | Sources |
| --- | --- |
| **APIs** | Ticketmaster (latlong + 30mi radius, Music & Comedy), Eventbrite (Seattle/Tacoma), Bandsintown (resolves artists you've marked _Interested_) |
| **RSS / iCal / JSON-LD** | Configured in `feeds.json` — Tacoma Comedy Club and Emerald City Comedy Club seeded (JSON-LD); most other venues don't publish feeds, so add new ones with **Add a Venue by URL** |
| **Scrapers** | Configured in `scrapers.json` — Tractor Tavern, Skylark, The Valley, Showbox, Neumos, The Crocodile, Jazzbones, Clock-Out Lounge, Airport Tavern, and Cryptatropa (Olympia) seeded with selectors verified against the live sites (2026-07). Several more ship **disabled** with notes: venues better served by the Ticketmaster API, JS-rendered sites whose selectors need in-browser tuning first, and dead/expired domains |
| **Manual** | The **＋ Add** button in the UI |

> **Most Seattle/Tacoma venues don't publish feeds** — they run on JS-rendered ticketing platforms (AXS, Ticketmaster, TicketWeb). So `feeds.json` ships empty. Get coverage from the **Ticketmaster API** (one key covers every venue that sells through it) and from **scrapers** for the rest. Use **Add a Venue by URL** to let EventLight detect whichever method a given site supports.

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
- A `<time datetime="…">` element is the most reliable date source — the scraper prefers a `datetime` attribute on the matched date element, then any `time[datetime]` inside the item, then the element's text.
- Dates without a year (`SAT JUL 4`) get the year inferred: this year, or next year once the date is more than ~45 days in the past. Formats like `Jul 4`, `July 4th, 2026`, `4 Jul 2026`, `7/4`, and `07/04/2026` all parse.
- To debug selectors visually, set `HEADLESS=false` in `.env` and re-run the scraper from Settings.

The scraper validates each config before spending a page load on it, blocks image/media/font downloads (faster and lighter on the venue's server), retries a failed navigation once, and caps extraction at 250 items per page so one bad selector can't flood the database.

**Selector drift** (a site changing its markup) is the usual cause of a scraper returning zero events. EventLight logs this clearly and distinguishes the two cases — *no items matched* (fix `selectors.item`) vs. *items matched but none had a usable title + date* (fix the `name`/`date` selectors). Check the status bar at the bottom of the dashboard, or **Settings → Last Refresh by source**, and `GET /api/status/logs` for the raw log.

---

## Manual refresh

- **UI:** the **Refresh now** button on the dashboard, or **Settings → Maintenance** to run all sources or a single adapter.
- **CLI:** `npm run refresh` runs every adapter once and prints a summary, then exits.

---

## Preference engine

Scores are computed at query time and used for **Top Picks** and the **relevance** sort.

1. **Manual weights (Layer 1)** — in Settings, weight your genres 1–5. An event's base score is the sum of the weights of the genres it matches.
2. **Behavioral learning (Layer 2)** — when you mark an event _Interested_, its genre tags and artist become signals. Matching events get a boost equal to the summed signal counts, **decayed** by the number of weeks since each signal was last seen (divisor floored at 1).

**Taste-profile seeding:** if a `taste-profile.json` exists at the repo root (this one was derived from the owner's Spotify top artists/tracks), it's imported idempotently on startup — its genres become Layer-1 weights and its artists become Layer-2 signals. Guarded by the `taste_profile_applied` setting; bump `generated_at` in the JSON to re-import, or delete the file to opt out.

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
taste-profile.json one-off Spotify-derived preference seed (optional)
Dockerfile         Playwright-based image (Chromium included)
docker-compose.yml one-command stack with persistent volumes
.env.example       configuration template
data/events.db     SQLite database (created at runtime, gitignored)
```

---

## API reference (local)

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/views/tonight` | Today's events |
| `GET` | `/api/views/week` | This week, grouped by day |
| `GET` | `/api/views/top-picks` | Highest-scored events, next 30 days |
| `GET` | `/api/views/curated` | The `/curate` routine's ranked picks (from `data/curated.json`) |
| `GET` | `/api/views/month?month=YYYY-MM` | Calendar counts + events |
| `GET` | `/api/events` | Paginated, filterable, sortable list |
| `POST` | `/api/events` | Add an event manually |
| `POST` | `/api/events/:id/interested` | Toggle interested (records signals) |
| `POST` | `/api/events/:id/hidden` | Hide an event |
| `GET` | `/api/filters` | Distinct cities, sources, tags |
| `GET` | `/api/status` | Last run per source + scheduler state |
| `POST` | `/api/refresh` | Run all adapters now |
| `POST` | `/api/refresh/:adapter` | Run one adapter (`ticketmaster`, `eventbrite`, `bandsintown`, `rss`, `scraper`) |
| `POST` | `/api/discover` | Probe a venue URL for RSS/iCal/JSON-LD, falling back to a scraper template |
| `POST` | `/api/discover/add` | Save a discovered source to `feeds.json` / `scrapers.json` |
| `GET` | `/api/export/ics` | Download interested events as `.ics` |

All filter params (`category`, `city`, `genres`, `sources`, `search`, `onlyInterested`, `showHidden`) apply to the view endpoints too.

---

## Tests

```bash
npm test
```

Runs the `node:test` suite covering date/time parsing (including year inference and the "band names with numbers" cases), URL sanitisation, scraper config validation, and the `.ics` builder.

---

## License

MIT
