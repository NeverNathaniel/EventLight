# EventLight runs Playwright (Chromium) for scraping, so we build on the
# official Playwright image — Chromium and all its system deps are preinstalled
# and matched to the playwright npm version pinned in package.json (1.61.0).
FROM mcr.microsoft.com/playwright:v1.61.0-jammy

ENV NODE_ENV=production \
    HEADLESS=true \
    PORT=3000

WORKDIR /app

# Install dependencies first for better layer caching.
# better-sqlite3 ships prebuilt binaries, so no compile step is needed.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the application source.
COPY . .

# The SQLite database and runtime config live here; mounted as a volume.
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
