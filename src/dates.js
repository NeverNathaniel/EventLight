// Calendar dates as YYYY-MM-DD in server-local time (the server runs in the
// venues' time zone; set TZ in Docker).
export function localISO(d) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

export function todayISO() {
  return localISO(new Date());
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localISO(d);
}
