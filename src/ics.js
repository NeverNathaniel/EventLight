// Build an iCalendar (.ics) document from event rows.
// Timed events use floating local time; date-only events become all-day.

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtUtcStamp(d = new Date()) {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// Escape per RFC 5545 (commas, semicolons, backslashes, newlines).
function esc(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function eventToVevent(ev) {
  const dateCompact = String(ev.date).replace(/-/g, '');
  const lines = ['BEGIN:VEVENT', `UID:eventlight-${ev.id}@localhost`, `DTSTAMP:${fmtUtcStamp()}`];

  if (ev.time && /^\d{2}:\d{2}/.test(ev.time)) {
    const t = ev.time.slice(0, 5).replace(':', '');
    lines.push(`DTSTART:${dateCompact}T${t}00`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${dateCompact}`);
  }

  lines.push(`SUMMARY:${esc(ev.title)}`);
  const location = [ev.venue, ev.city].filter(Boolean).join(', ');
  if (location) lines.push(`LOCATION:${esc(location)}`);

  const descParts = [];
  if (ev.artist) descParts.push(`Artist: ${ev.artist}`);
  if (ev.genre_tags) descParts.push(`Genres: ${ev.genre_tags}`);
  if (ev.price_range) descParts.push(`Price: ${ev.price_range}`);
  if (ev.ticket_url) descParts.push(`Tickets: ${ev.ticket_url}`);
  if (descParts.length) lines.push(`DESCRIPTION:${esc(descParts.join('\n'))}`);
  if (ev.ticket_url) lines.push(`URL:${esc(ev.ticket_url)}`);

  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

export function buildIcs(events, calName = 'EventLight — Interested') {
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EventLight//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${esc(calName)}`,
  ];
  const body = events.map(eventToVevent);
  return [...header, ...body, 'END:VCALENDAR'].join('\r\n');
}
