// Read/update the .env file at runtime (used by the Settings API key editor).
// Updates both the file and process.env so adapters pick up changes without a
// server restart.
import fs from 'node:fs';
import { ENV_PATH } from './config.js';

function readRaw() {
  try {
    return fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    return '';
  }
}

// Apply key→value updates, preserving existing lines/comments where possible.
export function updateEnv(updates) {
  const lines = readRaw().split('\n');
  const seen = new Set();

  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });

  // Append any keys that weren't already present.
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }

  fs.writeFileSync(ENV_PATH, out.join('\n'), 'utf8');

  // Reflect changes immediately in the running process.
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
}
