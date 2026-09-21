import { api, session, setProfile, flushBeats } from './api.js';
import { h, clear, avatar, modal, chime, toast } from './ui.js';

export const state = { me: null, admin: false };
const root = document.getElementById('app');
let cleanup = null;

const routes = {
  '': () => import('./views/home.js'),
  library: () => import('./views/library.js'),
  book: () => import('./views/book.js'),
  upload: () => import('./views/upload.js'),
  read: () => import('./views/reader.js'),
  ranks: () => import('./views/social.js'),
  stats: () => import('./views/stats.js'),
  compare: () => import('./views/stats.js'),
  review: () => import('./views/review.js'),
  badges: () => import('./views/badges.js'),
  settings: () => import('./views/settings.js'),
  admin: () => import('./views/admin.js'),
  profiles: () => import('./views/profiles.js'),
};
const NAV = [['', '🏠', 'Home'], ['library', '📚', 'Library'], ['ranks', '🏆', 'Ranks'], ['stats', '📈', 'Stats'], ['settings', '⚙️', 'Settings']];

export const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

export function applyTheme(settings = state.me?.settings) {
  let theme = settings?.theme || 'dark';
  if (theme === 'system') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').content = bg;
  document.documentElement.style.setProperty('--accent-profile', state.me?.color || '');
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme());

export async function refreshMe() {
  state.me = await api('/me');
  applyTheme();
  paintChips();
  return state.me;
}

export function setMe(me) { state.me = me; paintChips(); }

function paintChips() {
  const el = document.getElementById('chips');
  if (!el || !state.me) return;
  clear(el).append(
    h('span', { class: 'chip flame', title: `${state.me.current_streak}-day streak` }, '🔥 ', state.me.current_streak),
    h('span', { class: 'chip', title: `${state.me.xp} XP` }, `Lv ${state.me.level}`));
}

function shell(active) {
  const link = ([path, ico, label], withIcon) => h('a', { href: `#/${path}`, 'aria-current': path === active ? 'page' : null },
    withIcon ? h('span', { class: 'ico', 'aria-hidden': 'true' }, ico) : null, label);
  const view = h('main', { id: 'view', tabindex: '-1' });
  clear(root).append(
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'Read, home' }, 'r', h('span', null, 'e'), 'ad'),
      h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map((n) => link(n, false))),
      h('span', { class: 'spacer' }),
      h('span', { id: 'chips', class: 'row nowrap' }),
      // Always visible, on every page (AC-7).
      h('button', { class: 'who', onClick: () => go('#/profiles'), 'aria-label': `Switch profile. Current: ${state.me.name}` },
        avatar(state.me), h('span', { class: 'label' }, 'Switch'))),
    view,
    h('nav', { class: 'tabbar', 'aria-label': 'Main' }, NAV.map((n) => link(n, true))));
  paintChips();
  return view;
}

async function render() {
  if (cleanup) { try { cleanup(); } catch { /* view already gone */ } cleanup = null; }
  const [name = '', ...params] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  const query = new URLSearchParams(location.hash.split('?')[1] || '');

  if (!session.profileId || name === 'profiles') {
    const mod = await routes.profiles();
    cleanup = await mod.render(clear(root), { params, query });
    return;
  }
  if (!state.me) {
    try { await refreshMe(); } catch (e) {
      if (e.status === 404) { setProfile(null); return render(); }   // profile was deleted
      if (!e.offline) throw e;
      clear(root).append(h('p', { class: 'boot' }, 'You are offline. Open the app once while online first.'));
      return;
    }
  }
  const load = routes[name] || routes[''];
  const mod = await load();
  const fullscreen = name === 'read';
  const target = fullscreen ? clear(root) : shell(['book', 'upload'].includes(name) ? 'library'
    : ['compare', 'review', 'badges'].includes(name) ? 'stats' : name === 'admin' ? 'settings' : name);
  cleanup = await mod.render(target, { params, query, name });
  if (!fullscreen) window.scrollTo(0, 0);
}

// ---- celebrations (GM-10, GM-17): one pop-up per event, in order.
export async function celebrate(events) {
  const sound = state.me?.settings?.sound;
  for (const e of events || []) {
    const spec = {
      goal_met: ['🎯', 'Daily goal met!', `Streak: ${e.streak} day${e.streak === 1 ? '' : 's'}`, 'goal'],
      level_up: ['⭐', `Level ${e.level}!`, 'Keep reading to climb higher.', 'level'],
      badge: [e.icon, e.name, e.description, 'badge'],
      book_done: ['🎉', 'Book finished!', e.title, 'level'],
      freeze_earned: ['🧊', 'Streak freeze earned', `You hold ${e.freezes}. One is used automatically if you miss a day.`, 'badge'],
    }[e.type];
    if (!spec) continue;
    if (sound) chime(spec[3]);
    await modal((close) => [
      h('div', { class: 'ico', 'aria-hidden': 'true' }, spec[0]), h('h2', null, spec[1]), h('p', { class: 'muted' }, spec[2]),
      h('button', { class: 'btn primary', autofocus: true, onClick: () => close() }, 'Nice'),
    ], { className: 'celebrate' });
  }
}

export async function ensureAdmin() {
  if (state.admin) return true;
  const access = await api('/access');
  if (access.admin) { state.admin = true; return true; }
  const pin = await (await import('./ui.js')).promptBox('Admin PIN', { label: 'PIN', type: 'password', ok: 'Unlock', hint: 'Needed once per browser session for admin actions.' });
  if (!pin) return false;
  try { await api('/access/admin', { method: 'POST', body: { pin } }); state.admin = true; toast('Admin unlocked'); return true; }
  catch { return false; }
}

window.addEventListener('hashchange', render);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
flushBeats();
render().catch((e) => { console.error(e); clear(root).append(h('p', { class: 'boot' }, 'Something went wrong. Reload the page.')); });
