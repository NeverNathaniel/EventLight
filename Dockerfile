# EventLight runs Playwright (Chromium) for scraping, so we build on the
# official Playwright image — Chromium and its system deps are preinstalled and
# matched to the playwright npm version pinned in package.json (1.61.0).
#
# This image ships Node 24. better-sqlite3 12.x publishes Node 24 prebuilt
# binaries, but we use a two-stage build with a compiler in the first stage as
# a safety net (so the native module builds even if a prebuilt is unavailable),
# while keeping the runtime image free of build tools.

# ── deps stage: install production dependencies ──────────────────────────────
FROM mcr.microsoft.com/playwright:v1.61.0-jammy AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

# ── runtime stage ────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.61.0-jammy
ENV NODE_ENV=production \
    HEADLESS=true \
    PORT=3000
WORKDIR /app

# Built node_modules (incl. the compiled better-sqlite3) from the deps stage.
COPY --from=deps /app/node_modules ./node_modules
# Application source.
COPY . .

# The SQLite database and runtime config live here; mounted as a volume.
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
