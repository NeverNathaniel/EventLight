# EventLight

A self-hosted dashboard for live **music** and **comedy** across **Seattle, Tacoma, and the South Sound**. EventLight pulls events from APIs, RSS/iCal feeds, and headless web scrapers on a schedule, merges them into one deduplicated list, scores them against your taste, and presents everything in a dark "venue marquee" dashboard.

- **Tonight / This Week / Top Picks / Curated / This Month / Movies / Browse All** views
- **Movies** — what's playing at The Grand Cinema (Tacoma), with kids' movies and vapid action movies filtered out
- **Preference engine** — favorite artists, "sounds like your favorites" discovery, genre weights, and learning from what you star — every pick says *why* it ranks
- **Artist enrichment** — pulls the bands out of every listing title and looks up their genres (MusicBrainz) and sound-alikes (ListenBrainz) — free, keyless, cached
- **Add a venue by URL** — paste a website and EventLight auto-detects a VenuePilot widget, RSS feed, iCal feed, or embedded event data before falling back to scraping
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
| `TICKETMASTER_API_KEY` | [Ticketmaster Discovery API](https://developer.ticketmaster.com/) consumer key — free, no business needed ([how to get one](#getting-a-ticketmaster-key)) |
| `BANDSINTOWN_APP_ID` | [Bandsintown](https://artists.bandsintown.com/support/api-installation) app ID — optional; Bandsintown issues these on request and refuses made-up IDs |
| `EVENTBRITE_API_KEY` | [Eventbrite](https://www.eventbrite.com/platform/api) private OAuth token |
| `HEADLESS` | `true` (default) or `false` to watch the scraper browser while debugging |
| `CHROMIUM_PATH` | Optional path to a system Chromium/Chrome binary, for hosts where the Playwright browser download isn't available (ARM boards, NAS boxes) |
| `SCRAPER_CONCURRENCY` | How many scrapers run at once (default `3`, max `8`) — each scraper is a different site, so this stays polite per-domain |
| `REQUEST_DELAY_MS` | Polite delay between outbound requests within an adapter (default `350`) |
| `REFRESH_CRON` | Cron expression for scheduled ingestion (default `0 */6 * * *` — every 6 hours) |
| `REFRESH_ON_START` | `true` to run a full ingestion when the server boots |
| `ENRICH_ARTISTS` | `true` (default) to look up artist genres and similar artists after each refresh; `false` to skip |
| `ENRICH_MAX_LOOKUPS` | API calls the enrichment step may spend per refresh (default `150`, ~1/sec) — results are cached, so later refreshes only look up new artists |

> API keys are **never** hardcoded — they're read from `.env` exclusively. The Settings page reports only whether each key is configured, never its value.

### Getting a Ticketmaster key

The Discovery API key is free and open to individuals — you don't need a business. Only Ticketmaster's Partner/Commerce APIs (selling tickets) require approval.

1. Register at [developer-account.ticketmaster.com/user/register](https://developer-account.ticketmaster.com/user/register). The form asks for a **Company Name** and **Company Site URL**: your own name and any site you have (a GitHub profile works) are fine.
2. Confirm the email, log in, and open **My Apps**. A default app is created for you.
3. Copy its **Consumer Key** — that's the API key. (Ignore the Consumer Secret; the Discovery API doesn't use it.)
4. Paste it into **Settings → API Keys → Ticketmaster**, or set `TICKETMASTER_API_KEY` in `.env`.

The free tier allows 5,000 calls a day at 5 per second; a full refresh uses about twenty. One key covers every venue that sells through Ticketmaster within 30 miles of Seattle and Tacoma (the Tacoma Dome, Climate Pledge Arena, the Paramount, Moore and Neptune, and many more).

---

## Data sources

Each source is an adapter in `src/adapters/`. The scheduler runs them all every 6 hours, merging results into one `events` table and **deduplicating by title + date + venue**.

| Type | Sources |
| --- | --- |
| **APIs** | Ticketmaster (latlong + 30mi radius, Music & Comedy, the next 6 months, parking/VIP add-ons filtered out), Eventbrite (Seattle/Tacoma), Bandsintown (resolves your favorite artists and artists you've marked _Interested_) |
| **Feeds** | Configured in `feeds.json` — Tacoma Comedy Club and Emerald City Comedy Club (JSON-LD); Conor Byrne Pub, Jazzbones, Real Art Tacoma and Tracyton Movie House (VenuePilot); The Valley (Squarespace). Add new ones with **Add a Venue by URL** |
| **Scrapers** | Configured in `scrapers.json` — Tractor Tavern, Skylark, McMenamins Elks Temple (Tacoma), Showbox (every AEG Seattle room, paged through "Load More"), Neumos (paged), The Crocodile, Clock-Out Lounge, Airport Tavern, and Cryptatropa (Olympia) seeded with selectors verified against the live sites (2026-10). Several more ship **disabled** with notes: venues better served by the Ticketmaster API, JS-rendered sites whose selectors need in-browser tuning first, and dead/expired domains |
| **Manual** | The **＋ Add** button in the UI |

> **Few Seattle/Tacoma venues publish a classic RSS or iCal feed** — the big rooms sell through Ticketmaster or AXS, and small ones run their calendars on Squarespace, WordPress or a ticketing widget. Get the big rooms from the **Ticketmaster API** (one key covers every venue that sells through it), and the small ones from the structured feeds those platforms expose (VenuePilot, Squarespace, WordPress's Events Calendar) or a **scraper**. **Add a Venue by URL** detects whichever method a given site supports.

### Add a venue by URL (auto-discovery)

The fastest way to add a venue: **Settings → Add a Venue by URL**, paste the website, and hit **Discover**. EventLight probes the page in order and recommends the cleanest method:

1. **Ticketing and CMS feeds** — a VenuePilot widget, a WordPress site running The Events Calendar (its JSON API), or a Squarespace events page (its `?format=json` view). These carry real start times and full calendars, so they win when present
2. **RSS / Atom feed** — `<link rel="alternate">` autodiscovery tags, then common feed paths
3. **iCal feed** — `.ics` / `webcal:` links
4. **JSON-LD** — `schema.org/Event` structured data embedded in the page (parsed directly, no scraping)
5. **Scrape** — fallback only; adds a scraper template with guessed selectors to tune

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

- `type` is `rss`, `ical`, `jsonld` (for venue pages with embedded `schema.org/Event` data — set `url` to the page itself), `venuepilot` (for venues using the VenuePilot ticketing widget — add `"accountId"`, found in the page's `venuepilotSettings` script; **Add a Venue by URL** fills it in for you), `squarespace` (set `url` to the Squarespace events page; add `"tz"` if the venue isn't in your server's time zone), or `tribe` (WordPress sites running The Events Calendar — set `url` to the site's home page; an optional `"categories"` list keeps only those event categories).
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
- Optional per-item selectors: `venue` (for listings that span several rooms), `support` (a separate "with …" line), and `time` (when the time isn't in the date element).
- `skipVenues` is an optional list of venue-name substrings to drop (e.g. out-of-town rooms on a promoter's list).
- `pagination` pages through a "Load More" listing using the site's own endpoint: `{ "url": "https://…/events_ajax/{offset}?…", "start": 20, "step": 20, "maxPages": 10, "format": "json-html" }`. Use `{offset}` (start + n·step) or `{page}` (2, 3, …); `format` is `json-html` when the endpoint returns a JSON-encoded HTML string, otherwise `html`. Pages are fetched from inside the venue's page, so the URL must be on the same site.
- A `<time datetime="…">` element is the most reliable date source — the scraper prefers a `datetime` attribute on the matched date element, then any `time[datetime]` inside the item, then the element's text.
- Dates without a year (`SAT JUL 4`) get the year inferred: this year, or next year once the date is more than ~45 days in the past. Formats like `Jul 4`, `July 4th, 2026`, `4 Jul 2026`, `7/4`, and `07/04/2026` all parse.
- To debug selectors visually, set `HEADLESS=false` in `.env` and re-run the scraper from Settings.

The scraper validates each config before spending a page load on it, blocks image/media/font downloads (faster and lighter on the venue's server), retries a failed navigation once, and caps extraction at 400 items per page so one bad selector can't flood the database. Trivia, movie, bingo, karaoke and drag nights at music venues are filed as _other_ rather than music.

After a successful scrape, or a successful iCal / JSON-LD / VenuePilot feed run (sources that list a venue's whole calendar), upcoming listings that source no longer shows — cancelled or moved — are removed, unless you starred or hid them. RSS feeds and APIs are never pruned this way, since they only return a window of results.

**Selector drift** (a site changing its markup) is the usual cause of a scraper returning zero events. EventLight logs this clearly and distinguishes the two cases — *no items matched* (fix `selectors.item`) vs. *items matched but none had a usable title + date* (fix the `name`/`date` selectors). Check the status bar at the bottom of the dashboard, or **Settings → Last Refresh by source**, and `GET /api/status/logs` for the raw log.

---

## Manual refresh

- **UI:** the **Refresh now** button on the dashboard, or **Settings → Maintenance** to run all sources or a single adapter.
- **CLI:** `npm run refresh` runs every adapter once and prints a summary, then exits.
- **Artist backfill:** `npm run enrich` (Docker: `docker compose exec eventlight npm run enrich`) spends up to 1000 lookups (`-- --max N` to change) filling the artist cache in one go — worth running once after the first refresh, since a scheduled refresh only spends `ENRICH_MAX_LOOKUPS`.

---

## Preference engine

Scores are computed at query time and used for **Top Picks** and the **relevance** sort. Each part that fires adds a reason, shown on the card — _"PUP is a favorite"_, _"Movements shares fans with Joyce Manor & Modern Baseball (≈ PUP)"_ — and highlighted genre tags.

| Signal | What it does | Points |
| --- | --- | --- |
| **Favorite artists** | A favorite on the bill (Settings → Favorite Artists, weighted 1–5). Never decays. | headlining 12–20, opening 6–10 |
| **Starred artists** | The headliner of any event you've marked _Interested_ counts like a lighter favorite. | 8 / 4 |
| **Sounds like** | A lineup act is similar to a favorite or starred artist (see below). | up to 9 (half for openers) |
| **Genre weights** | Your genre weights (1–5) vs. the event's tags — the source's own plus genres looked up for the lineup. Matching is whole-word and one-way: a `punk` weight matches `pop punk`, but `indie rock` doesn't match plain `rock`. Best match + ½·second + ¼·third, so a pile of loose tags can't beat a square fit. | up to ~8.75 |
| **Learned tags** | Genre tags from events you star, fading with an 8-week half-life. | up to 4 |
| **Penalties** | Another show by a headliner you've hidden (−6); tribute acts (−3). | |

**Lineups.** Scraped listings are just titles — _"Tractor Presents: Bob Sumner w/ Laith & The Texas Birds, Birdie Fenn Cent @ The Sunset Tavern"_ — so every event's bill is parsed out of its title (`src/lineup.js`): promoter prefixes, tour names, venue suffixes, "SOLD OUT!" and similar noise are stripped, and `w/`, `x`, `•`, `//` and friends split the acts. Sources with structured data (Ticketmaster attractions, VenuePilot, Bandsintown) supply the lineup directly.

**Artist enrichment** runs after each refresh (`src/enrich/`), within a budget of API calls (`ENRICH_MAX_LOOKUPS`), everything cached in SQLite:

1. Favorite and starred artists are looked up on [MusicBrainz](https://musicbrainz.org/), and their similar artists fetched from [ListenBrainz](https://listenbrainz.org/) (derived from real listening sessions — PUP → Jeff Rosenstock, Joyce Manor, Modern Baseball…).
2. Upcoming headliners get genre tags from MusicBrainz, then their own similar lists, then support acts get tags — soonest shows first.
3. Tags are rolled up onto each event (`events.artist_tags`).

**Sounds like** compares each artist's similar-artist list with each favorite's, by cosine similarity with inverse-document-frequency weighting. That catches direct links (an act on a favorite's list) and shared-fan links (Movements' listeners also play Joyce Manor and Modern Baseball, both close to PUP), while hub artists that sit on every list — Radiohead, The Beatles — count for little.

**Top Picks** shows the best-scoring events in the next 30 days, plus a **Your Artists** section: every show by a favorite or starred artist in the next year, since those tours announce months ahead.

**Taste-profile seeding:** if a `taste-profile.json` exists at the repo root, it's imported idempotently on startup. Its genres (derived from the owner's Spotify top artists/tracks) become genre weights, and its artists (Spotify plus the owner's own list) become favorite artists.
- **Genres** are re-applied when `generated_at` changes.
- **Artists** are re-applied when `artists_updated_at` changes. Listed artists get the file's weights; favorites added or removed in Settings are otherwise left alone.

Editing the artist list therefore never resets genre weights you've tuned in Settings. Delete the file to opt out.

---

## Movies

The **Movies** tab lists everything showing at [The Grand Cinema](https://grandcinema.com) in Tacoma over the next six weeks. It has three sections:

- **Now Playing**: current runs, leaving-soonest first.
- **Special Screenings**: one-nights, repertory, and the Tacoma Film Festival (films with three or fewer showtimes), as a day-by-day program. A regular run stays in Now Playing through its last days.
- **Coming Soon**: runs that open more than a week out.

Each film shows its poster, rating, runtime, director, cast, synopsis, showtimes by day (in your browser's timezone), the trailer, and a ticket link.

**Filtered out** (`src/cinema/filter.js`). Every decision carries a reason, and **Show filtered** at the bottom of the tab lists what was left out and why.

- **Kids' movies**:
  - rated G, if released since 1990 (*2001: A Space Odyssey* stays);
  - filed under Family/Kids by the theater;
  - tagged a children's or family film on Wikidata (unless rated R/NC-17);
  - animated and rated PG;
  - kids' programs by name, e.g. "Shorts4Shorties", "Free Family Flick", "Cereal Cinema".
- **Vapid action movies**: action, superhero or martial-arts films that aren't critically acclaimed.
  - Superhero films need Metacritic ≥ 80. *The Dark Knight* passes; most of the MCU doesn't.
  - Other franchise films need Metacritic ≥ 75 or Rotten Tomatoes ≥ 90. *Terminator 2* and *Mad Max: Fury Road* pass; *Fast X* doesn't.
  - Other action films need Metacritic ≥ 65 or Rotten Tomatoes ≥ 80.
  - An action film with no scores on record (a restoration, a new import) gets the benefit of the doubt unless it's a superhero film.

Genres, franchise and critic scores come from [Wikidata](https://www.wikidata.org/), looked up by the TMDB id the theater supplies. It's free, needs no key, and is cached for a week. The ✕ on any film hides it; hidden films are listed under **Show filtered** with a button to bring them back, and stay hidden even if the film briefly drops out of a refresh.

**How it's fetched** (`src/cinema/indy.js`). The Grand's website runs on the Indy Systems ticketing platform, whose frontend loads showtimes from a GraphQL endpoint on the theater's own domain. EventLight makes the same requests the site does: one to list the dates with showtimes, then one per date. That's a few dozen small requests per refresh. Note that the theater's `robots.txt` disallows `/graphql` for crawlers. Other Indy Systems cinemas can be added to `THEATERS` in `src/cinema/index.js`; their `site-id` / `circuit-id` are the headers their website sends.

---

## Curate with Claude Code

For when you want richer, plain-English filtering than the built-in controls — _"post-punk and indie under $25, nothing on a Monday, soonest first"_ — there's a `/curate` routine you run from [Claude Code](https://claude.com/claude-code) in this repo:

```
/curate post-punk and indie under $25, soonest first
```

What happens:

1. The command runs `npm run export-events`, dumping upcoming events to `data/events-export.json` (id, title, lineup, venue, date, genres, price, and EventLight's own preference score with its reasons).
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
  enrich/          artist genres (MusicBrainz) + similar artists (ListenBrainz)
  cinema/          movie listings (The Grand Cinema via Indy Systems), Wikidata facts, kids/action filter
  lineup.js        parse the bill (headliner, support) out of an event title
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
| `GET` | `/api/views/top-picks` | Highest-scored events, next 30 days, plus `artists`: favorite/starred artists' shows in the next year |
| `GET` | `/api/views/curated` | The `/curate` routine's ranked picks (from `data/curated.json`) |
| `GET` | `/api/views/movies` | Cinema listings: `nowPlaying`, `special`, `comingSoon`, `filtered` (with reasons), `hidden` |
| `POST` | `/api/movies/:id/hidden` | Hide (or `{ "value": false }` to unhide) a film |
| `GET` | `/api/views/month?month=YYYY-MM` | Calendar counts + events |
| `GET` | `/api/events` | Paginated, filterable, sortable list |
| `POST` | `/api/events` | Add an event manually |
| `POST` | `/api/events/:id/interested` | Toggle interested (records signals) |
| `POST` | `/api/events/:id/hidden` | Hide an event |
| `GET` | `/api/filters` | Distinct cities, sources, tags |
| `GET` | `/api/status` | Last run per source + scheduler state |
| `POST` | `/api/refresh` | Run all adapters now |
| `POST` | `/api/refresh/:adapter` | Run one adapter (`ticketmaster`, `eventbrite`, `bandsintown`, `rss`, `scraper`), the `cinema` listings, or the `enrich` step |
| `POST` | `/api/settings/artists` | Add or re-weight a favorite artist (`{ name, weight }`) |
| `DELETE` | `/api/settings/artists/:key` | Remove a favorite artist |
| `POST` | `/api/discover` | Probe a venue URL for RSS/iCal/JSON-LD, falling back to a scraper template |
| `POST` | `/api/discover/add` | Save a discovered source to `feeds.json` / `scrapers.json` |
| `GET` | `/api/export/ics` | Download interested events as `.ics` |

All filter params (`category`, `city`, `genres`, `sources`, `search`, `onlyInterested`, `showHidden`) apply to the view endpoints too.

---

## Tests

```bash
npm test
```

Runs the `node:test` suite covering date/time parsing (including year inference and the "band names with numbers" cases), URL sanitisation, scraper config validation and item mapping, lineup parsing against real venue titles, the preference engine (against an in-memory database), the enrichment and VenuePilot/Ticketmaster parsers, the movie filter and listings grouping, and the `.ics` builder.

---

## License

MIT
