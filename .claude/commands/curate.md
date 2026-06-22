---
description: Filter and rank EventLight's upcoming events by natural-language criteria, then publish to the dashboard's Curated tab.
argument-hint: [what you're in the mood for, e.g. "post-punk and indie under $25, soonest first"]
allowed-tools: Bash(node:*), Bash(npm run export-events), Read, Write
---

You are curating live-event listings for the owner of this EventLight instance.

## Their request
$ARGUMENTS

(If the request above is empty, default to: "the strongest overall picks for the next two weeks.")

## Do this

1. Refresh the export so you're working from current data:
   `node src/cli/export-events.js`
2. Read `data/events-export.json`. Each event has: `id, title, artist, venue, city, date, time, category, genre_tags, price_range, ticket_url, interested, score`. The `score` field is EventLight's own preference score (higher = closer to the owner's stated tastes).
3. Select the events that genuinely match the request, and **rank them best-first** using your judgment. Weigh, in roughly this order: how well the act/genre/vibe fits the request; the owner's `score` and `interested` flag; price and date constraints they mentioned; and variety (don't return five near-identical shows if better spread exists). Be willing to return a short, high-quality list rather than padding it.
4. Write `data/curated.json` with exactly this shape:
   ```json
   {
     "criteria": "<echo the request you interpreted, in plain words>",
     "generated_at": "<current ISO timestamp>",
     "events": [
       { "id": 12, "reason": "<one short sentence on why this made the cut>" }
     ]
   }
   ```
   Order the `events` array from best to worst. Keep each `reason` to one sentence. Only include `id`s that exist in the export.
5. Print a brief summary: how many events matched, the top 3–5 with their reasons, and remind the owner to open the **Curated** tab (or refresh it) to see the result.

Keep it fast and practical — this is a personal tool, not a report.
