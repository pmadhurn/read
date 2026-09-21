// Fetch wrapper plus the offline-safe heartbeat queue (NF-4).
import { toast } from './ui.js';

export const session = { profileId: Number(localStorage.getItem('read.profile')) || null };

export function setProfile(id) {
  session.profileId = id;
  if (id) localStorage.setItem('read.profile', String(id)); else localStorage.removeItem('read.profile');
}

export async function api(path, { method = 'GET', body, raw, quiet = false } = {}) {
  const headers = {};
  if (session.profileId) headers['X-Profile-Id'] = String(session.profileId);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), credentials: 'same-origin' });
  } catch {
    const err = new Error('No connection.'); err.offline = true;
    if (!quiet) toast(err.message, 'bad');
    throw err;
  }
  if (res.status === 401 && !path.startsWith('/access')) {
    // The device is no longer remembered (passcode changed): back to the gate.
    const gone = await res.clone().json().catch(() => ({}));
    if (gone.detail === 'Passcode required') { location.reload(); await new Promise(() => {}); }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || `Request failed (${res.status})`); err.status = res.status;
    if (!quiet) toast(err.message, 'bad');
    throw err;
  }
  return data;
}

// ---- reading heartbeats: written to localStorage first, sent when the network allows.
const QUEUE_KEY = 'read.beats';
const loadQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; } };
const saveQueue = (q) => localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-400)));
let flushing = false;
const listeners = new Set();
export const onBeatResult = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function queueBeat(beat) {
  const q = loadQueue(); q.push({ ...beat, profile: session.profileId }); saveQueue(q);
  return flushBeats();
}

export async function flushBeats() {
  if (flushing) return;
  flushing = true;
  try {
    for (let q = loadQueue(); q.length; q = loadQueue()) {
      const beat = q[0];
      try {
        const res = await fetch('/api/reading/beat', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Profile-Id': String(beat.profile) }, body: JSON.stringify(beat),
        });
        if (res.status === 401 || res.status >= 500) break;      // keep it for later
        const rest = loadQueue(); rest.shift(); saveQueue(rest); // sent, or rejected for good (deleted book)
        if (res.ok) { const data = await res.json(); listeners.forEach((fn) => fn(data, beat)); }
      } catch { break; }
    }
  } finally { flushing = false; }
}

// Last resort while the page is going away.
export function beaconBeat(beat) {
  const q = loadQueue(); q.push({ ...beat, profile: session.profileId }); saveQueue(q);
  flushBeats();
}
window.addEventListener('online', flushBeats);
