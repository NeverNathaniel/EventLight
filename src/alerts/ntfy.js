// Push notifications through ntfy (https://ntfy.sh): POST a JSON message to
// the server, and every phone subscribed to the topic gets it. Free, no
// account; a self-hosted ntfy server works the same way.
import axios from 'axios';
import { NTFY_SERVER, NTFY_TOKEN, USER_AGENT } from '../config.js';

const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

// "eventlight-k3j2…" (on NTFY_SERVER) or a full topic URL on another server
// ("https://ntfy.example.com/eventlight") → { server, topic }, or null.
export function parseTopic(value, defaultServer = NTFY_SERVER) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) return TOPIC_RE.test(v) ? { server: defaultServer, topic: v } : null;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  const topic = parts.pop();
  if (!topic || !TOPIC_RE.test(topic) || u.search || u.hash) return null;
  return { server: [u.origin, ...parts].join('/'), topic };
}

// Send one notification. Throws with ntfy's own error message on failure.
export async function sendNtfy(target, { title, message, click, tags, priority }, { token = NTFY_TOKEN } = {}) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = { topic: target.topic, title, message };
  if (click) body.click = click;
  if (tags?.length) body.tags = tags;
  if (priority) body.priority = priority;
  try {
    await axios.post(`${target.server}/`, body, { headers, timeout: 15000 });
  } catch (err) {
    const why = err.response?.data?.error || err.message;
    throw new Error(`ntfy: ${why}`);
  }
}
