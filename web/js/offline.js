// "Keep offline": pulls a whole book through the service worker so it stays on this device.
import { api, session } from './api.js';

const DATA = 'read-data-v1';
const key = (bookId) => `read.offline.${session.profileId}.${bookId}`;
export const isKept = (bookId) => { try { return !!localStorage.getItem(key(bookId)); } catch { return false; } };
export const keptIds = () => { try { return Object.keys(localStorage).filter((k) => k.startsWith(`read.offline.${session.profileId}.`)).map((k) => Number(k.split('.').pop())); } catch { return []; } };
export const supported = () => 'serviceWorker' in navigator && 'caches' in window;

export async function keep(bookId, onProgress = () => {}) {
  await navigator.serviceWorker.ready;
  const book = await api(`/books/${bookId}`);
  const total = book.chapters.length + 1;
  for (let i = 0; i < book.chapters.length; i++) {
    await api(`/books/${bookId}/chapters/${i}`);        // each fetch goes through the worker, which stores it
    onProgress((i + 1) / total);
  }
  if (book.has_cover) await fetch(`/api/books/${bookId}/cover?size=thumb`, { credentials: 'same-origin' }).catch(() => {});
  await api('/books');                                   // the library list, so the shelf renders offline too
  onProgress(1);
  localStorage.setItem(key(bookId), JSON.stringify({ chapters: book.chapters.length, at: Date.now() }));
  return book;
}

export async function forget(bookId) {
  localStorage.removeItem(key(bookId));
  if (!supported()) return;
  const cache = await caches.open(DATA);
  for (const req of await cache.keys()) {
    if (new URL(req.url).pathname.startsWith(`/api/books/${bookId}/`)) await cache.delete(req);
  }
}

// The browser's own install prompt (Chrome, Edge, Android); Safari has none.
export let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
export const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ---- Recovery: books this device holds in its offline cache that the server no longer has.
const DISMISSED = 'read.recover.dismissed';
const dismissed = () => { try { return JSON.parse(localStorage.getItem(DISMISSED)) || []; } catch { return []; } };
export const dismissRecovery = (ids) => localStorage.setItem(DISMISSED, JSON.stringify([...new Set([...dismissed(), ...ids])]));

export async function findRecoverable(liveIds) {
  if (!supported()) return [];
  const cache = await caches.open(DATA);
  const live = new Set(liveIds.map(Number)), skip = new Set(dismissed());
  const details = new Map(), chapters = new Map();
  for (const req of await cache.keys()) {
    const u = new URL(req.url);
    let m = u.pathname.match(/^\/api\/books\/(\d+)$/);
    if (m) { details.set(Number(m[1]), req); continue; }
    m = u.pathname.match(/^\/api\/books\/(\d+)\/chapters\/(\d+)$/);
    if (m) { const id = Number(m[1]); if (!chapters.has(id)) chapters.set(id, new Map()); chapters.get(id).set(Number(m[2]), req); }
  }
  const out = [];
  for (const [id, req] of details) {
    if (live.has(id) || skip.has(id)) continue;
    const detail = await (await cache.match(req)).json().catch(() => null);
    if (!detail || detail.status !== 'ready' || !detail.chapters?.length) continue;
    const have = chapters.get(id) || new Map();
    if (!have.size) continue;
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(`read.pos.${session.profileId}.${id}`)); } catch { /* none */ }
    out.push({ id, title: detail.title, author: detail.author, total: detail.chapters.length, have: have.size, meta: detail, reqs: have, position: pos });
  }
  return out;
}

export async function recover(item) {
  const cache = await caches.open(DATA);
  const chapters = [];
  for (const [i, c] of item.meta.chapters.entries()) {
    const req = item.reqs.get(i);
    const data = req ? await (await cache.match(req)).json().catch(() => null) : null;
    chapters.push({ title: c.title, text: data?.text || '' });
  }
  const body = { title: item.title, author: item.author, chapters, position: item.position && { chapter_ord: item.position.chapter_ord, word_index: item.position.word_index } };
  const res = await api('/books/recover', { method: 'POST', body });
  dismissRecovery([item.id]);
  for (const req of await cache.keys()) if (new URL(req.url).pathname.startsWith(`/api/books/${item.id}`)) await cache.delete(req);
  return res;
}
