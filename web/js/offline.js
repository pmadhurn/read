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
