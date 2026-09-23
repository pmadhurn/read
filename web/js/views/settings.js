// Per-profile settings, stored on the server so they follow the person to every device (section 6).
import { api } from '../api.js';
import { h, clear, segmented, toast, avatar, mount } from '../ui.js';
import { state, setMe, applyTheme, go, ensureAdmin } from '../app.js';
import { profileForm } from './profiles.js';
import { splitAtOrp } from './reader.js';
import * as offline from '../offline.js';

export const FONTS = {
  serif: { label: 'Serif (Literata)', css: 'var(--font-serif)' },
  sans: { label: 'Sans-serif (Inter)', css: 'var(--font-sans)' },
  mono: { label: 'Monospace (JetBrains Mono)', css: 'var(--font-mono)' },
  legible: { label: 'Atkinson Hyperlegible', css: 'var(--font-legible)' },
  dyslexic: { label: 'OpenDyslexic', css: 'var(--font-dyslexic)' },
};

const range = (label, s, key, min, max, step, onChange, fmt = (v) => v) => {
  const out = h('span', { class: 'muted small' }, fmt(s[key]));
  return h('label', { class: 'field' }, h('span', { class: 'row', style: { 'justify-content': 'space-between' } }, label, out),
    h('input', { type: 'range', min, max, step, value: s[key], onInput: (e) => { s[key] = Number(e.target.value); out.textContent = fmt(s[key]); onChange(); } }));
};
const toggle = (label, s, key, onChange) => h('label', { class: 'switch' }, label,
  h('input', { type: 'checkbox', checked: !!s[key], onChange: (e) => { s[key] = e.target.checked; onChange(); } }));

// Shared by the settings page and the reader's side panel; mutates `s` and calls onChange.
export function readerControls(s, onChange) {
  const presets = h('input', { type: 'text', value: (s.presets || []).join(', '), inputmode: 'numeric', onChange: (e) => {
    s.presets = e.target.value.split(/[^\d]+/).map(Number).filter((n) => n >= 100 && n <= 1000).slice(0, 5); e.target.value = s.presets.join(', '); onChange();
  } });
  return h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('span', null, 'Theme'), segmented([['dark', 'Dark'], ['light', 'Light'], ['sepia', 'Sepia'], ['system', 'Follow system']], s.theme, (v) => { s.theme = v; onChange(); }, 'Theme')),
    h('label', { class: 'field' }, h('span', null, 'Reader font'),
      h('select', { onChange: (e) => { s.font = e.target.value; onChange(); } }, Object.entries(FONTS).map(([k, f]) => h('option', { value: k, selected: s.font === k }, f.label)))),
    range('Word size', s, 'size', 24, 96, 2, onChange, (v) => `${v} px`),
    h('label', { class: 'field' }, h('span', null, 'Highlight colour'), h('input', { type: 'color', value: s.orp_color, onInput: (e) => { s.orp_color = e.target.value; onChange(); } })),
    range('Default speed', s, 'wpm', 100, 1000, 25, onChange, (v) => `${v} WPM`),
    h('label', { class: 'field' }, h('span', null, 'Speed presets'), presets),
    range('Punctuation pauses', s, 'pause_strength', 0, 2, 0.1, onChange, (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`)),
    h('div', { class: 'field' }, h('span', null, 'Words per flash'), segmented([['1', '1'], ['2', '2'], ['3', '3']], String(s.chunk), (v) => { s.chunk = Number(v); onChange(); }, 'Words per flash')),
    h('div', { class: 'field' }, h('span', null, 'Blink breaks'),
      segmented([['0', 'Off'], ['5', 'Every 5 s'], ['10', 'Every 10 s'], ['20', 'Every 20 s']], String(s.blink_break ?? 10), (v) => { s.blink_break = Number(v); onChange(); }, 'Blink breaks'),
      h('span', { class: 'muted small' }, 'A dimmed half-second beat at the next sentence end, so blinks land between sentences. Left arrow, Backspace or a tap on the left edge replays the sentence.')),
    toggle('Show the last few words below (blink safety net)', s, 'trail', onChange),
    toggle('Guide lines', s, 'guides', onChange), toggle('Show WPM while reading', s, 'show_wpm', onChange),
    toggle('Ease in after play (ramp-up)', s, 'ramp', onChange), toggle('Focus mode: hide controls while playing', s, 'focus', onChange),
    toggle('Sound effects', s, 'sound', onChange));
}

// Live preview of font, size and colours (AP-7).
function preview(s) {
  const sample = ['Reading', 'किताबें', 'धर्मक्षेत्रे', 'વાંચન', 'comprehension', 'one', 'word', 'at', 'a', 'time.'];
  const pre = h('span', { class: 'pre' }), pivot = h('span', { class: 'pivot' }), post = h('span', { class: 'post' });
  const box = h('div', { class: 'rsvp' }, h('i', { class: 'rule top' }), h('i', { class: 'rule bot' }), h('i', { class: 'guide top' }), h('i', { class: 'guide bot' }), h('div', { class: 'word' }, pre, pivot, post));
  const wrap = h('div', { class: 'preview', 'aria-hidden': 'true' }, box);
  let i = 0;
  const paint = () => {
    wrap.style.setProperty('--reader-size', `${Math.min(s.size, 64)}px`); wrap.style.setProperty('--reader-font', FONTS[s.font].css); wrap.style.setProperty('--orp', s.orp_color);
    box.classList.toggle('no-guides', !s.guides);
    const [a, p, b] = splitAtOrp(sample[i % sample.length]); pre.textContent = a; pivot.textContent = p; post.textContent = b;
  };
  const timer = setInterval(() => { i++; paint(); }, 700);
  paint();
  return { el: wrap, paint, stop: () => clearInterval(timer) };
}

const GOALS = [['minutes', 5, 'Casual', '5 min'], ['minutes', 10, 'Regular', '10 min'], ['minutes', 20, 'Serious', '20 min'], ['minutes', 30, 'Intense', '30 min']];

async function reminders(box) {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;
  if (!supported) { box.append(h('p', { class: 'muted small' }, 'This browser does not support notifications. On iPhone, add the app to the Home Screen first.')); return; }
  const reg = await navigator.serviceWorker.ready;
  const paint = async () => {
    const sub = await reg.pushManager.getSubscription();
    clear(box).append(h('label', { class: 'switch' }, h('span', null, 'Evening reminder', h('div', { class: 'muted small' }, 'A notification around 8 pm IST, only if today’s goal is still open.')),
      h('input', { type: 'checkbox', checked: !!sub, onChange: async (e) => {
        try {
          if (e.target.checked) {
            if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this site.');
            const { key } = await api('/push/key');
            const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
            const created = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
            await api('/push/subscribe', { method: 'POST', body: { subscription: created.toJSON() } }); toast('Reminders on for this device');
          } else if (sub) { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); toast('Reminders off'); }
        } catch (err) { toast(err.message, 'bad'); }
        paint();
      } })));
  };
  paint();
}

export async function render(root) {
  const me = state.me, s = { ...me.settings };
  const pv = preview(s);
  let timer = null;
  const changed = () => { pv.paint(); applyTheme(s); clearTimeout(timer); timer = setTimeout(async () => setMe(await api('/me', { method: 'PATCH', body: { settings: s } })), 500); };
  const patch = async (body, msg) => { setMe(await api('/me', { method: 'PATCH', body })); applyTheme(); if (msg) toast(msg); };

  const isCustom = !(me.goal_type === 'minutes' && [5, 10, 20, 30].includes(me.goal_value));
  const customInput = h('input', { type: 'number', min: 100, max: 100000, step: 100, value: me.goal_type === 'words' ? me.goal_value : 2000, 'aria-label': 'Custom goal in words' });
  const goalBox = h('div', { class: 'stack' });
  const paintGoals = () => clear(goalBox).append(
    h('div', { class: 'grid cols-4' }, GOALS.map(([type, value, name, text]) => h('button', { class: 'btn', style: { 'flex-direction': 'column', gap: '0' },
      'aria-pressed': String(state.me.goal_type === type && state.me.goal_value === value), onClick: async () => { await patch({ goal_type: type, goal_value: value }, 'Goal saved'); paintGoals(); } }, h('b', null, name), h('span', { class: 'muted small' }, `${text} a day`)))),
    h('div', { class: 'field' }, h('span', null, 'Or a custom word count per day'),
      h('div', { class: 'row nowrap' }, customInput,
        h('button', { class: 'btn', style: { flex: 'none' }, 'aria-pressed': String(state.me.goal_type === 'words'), onClick: async () => { await patch({ goal_type: 'words', goal_value: Number(customInput.value) }, 'Goal saved'); paintGoals(); } }, 'Use words'))));
  paintGoals(); void isCustom;

  const ua = navigator.userAgent, ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installBox = h('div', { class: 'stack', style: { gap: '8px' } }, h('h2', { style: { 'margin-top': '8px' } }, 'On this device'),
    offline.isInstalled() ? h('p', { class: 'muted small' }, 'Installed as an app on this device.')
      : offline.installPrompt ? h('div', null, h('button', { class: 'btn', onClick: async () => { offline.installPrompt.prompt(); const r = await offline.installPrompt.userChoice; if (r.outcome === 'accepted') toast('Installed'); } }, '📲 Install as an app'))
        : h('p', { class: 'muted small' }, ios ? 'To install: tap Share in Safari, then “Add to Home Screen”.' : 'To install: open the browser menu and choose “Install app” or “Add to Home screen”.'),
    h('p', { class: 'muted small' }, `Books you open are kept for offline reading; press “Keep offline” on a book to save all of it. ${offline.keptIds().length} book${offline.keptIds().length === 1 ? '' : 's'} saved on this device. Reading offline still counts: it syncs when you are back online.`));
  const pushBox = h('div');
  reminders(pushBox);

  mount(root, h('div', { class: 'page-head' }, h('h1', null, 'Settings')),
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'card stack' }, h('h2', null, 'Profile'),
        h('div', { class: 'row' }, avatar(me, 'md'), h('b', { class: 'grow' }, me.name),
          h('button', { class: 'btn', onClick: async () => { const r = await profileForm({ title: 'Edit profile', initial: me, submitLabel: 'Save', onSubmit: (body) => api('/me', { method: 'PATCH', body }) }); if (r) { setMe(r); go('#/settings'); } } }, 'Edit')),
        h('label', { class: 'switch' }, h('span', null, 'Hide me from the leaderboard', h('div', { class: 'muted small' }, 'Also hides you from leagues and the activity feed. Your own streaks, XP and badges keep working.')),
          h('input', { type: 'checkbox', checked: me.hidden, onChange: (e) => patch({ hidden: e.target.checked }, e.target.checked ? 'You are hidden' : 'You are visible') })),
        h('h2', { style: { 'margin-top': '8px' } }, 'Daily goal'), goalBox, pushBox, installBox,
        h('div', { class: 'row', style: { 'margin-top': '8px' } }, h('a', { class: 'btn', href: '#/badges' }, '🏅 Badges'), h('button', { class: 'btn', onClick: async () => { if (await ensureAdmin()) go('#/admin'); } }, '🔐 Admin'))),
      h('section', { class: 'card stack' }, h('h2', null, 'Reader'), pv.el, readerControls(s, changed))));
  return () => { pv.stop(); clearTimeout(timer); };
}
