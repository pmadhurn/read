// "Who's reading?" (AC-5, AC-6, AC-7)
import { api, setProfile } from '../api.js';
import { h, clear, avatar, modal, toast } from '../ui.js';
import { state, go, applyTheme } from '../app.js';

const EMOJI = ['📖', '🦊', '🐼', '🦉', '🐯', '🐸', '🦋', '🐢', '🦄', '🐙', '🌻', '🌙', '⭐', '🔥', '🍉', '🥭', '⚽', '🎸', '🚀', '🎨', '🧠', '👑', '🪁', '🏏'];
const COLORS = ['#4f7cff', '#22aa66', '#e0563b', '#c9459b', '#8a5cf6', '#d99a1c', '#1aa6b7', '#7a8699', '#d6336c', '#5c940d'];

export function profileForm({ title, initial = {}, submitLabel, onSubmit }) {
  return modal((close) => {
    let chosenAvatar = initial.avatar || EMOJI[Math.floor(Math.random() * EMOJI.length)];
    let color = initial.color || COLORS[Math.floor(Math.random() * COLORS.length)];
    const name = h('input', { type: 'text', maxlength: 30, required: true, value: initial.name || '', autofocus: true, autocomplete: 'off' });
    const custom = h('input', { type: 'text', maxlength: 8, placeholder: 'or type any emoji', 'aria-label': 'Custom emoji avatar', onInput: () => { if (custom.value.trim()) { chosenAvatar = custom.value.trim(); paint(); } } });
    const emojiGrid = h('div', { class: 'emoji-grid', role: 'group', 'aria-label': 'Avatar' });
    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Colour' });
    const previewBox = h('div', { class: 'row', style: { 'justify-content': 'center' } });
    const paint = () => {
      clear(previewBox).append(avatar({ avatar: chosenAvatar, color }, 'lg'));
      [...emojiGrid.children].forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === chosenAvatar)));
      [...swatches.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === color)));
    };
    EMOJI.forEach((e) => emojiGrid.append(h('button', { type: 'button', 'aria-label': `Avatar ${e}`, onClick: () => { chosenAvatar = e; custom.value = ''; paint(); } }, e)));
    COLORS.forEach((c) => swatches.append(h('button', { type: 'button', 'data-c': c, style: { '--c': c }, 'aria-label': `Colour ${c}`, onClick: () => { color = c; paint(); } })));
    paint();
    return h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      try { close(await onSubmit({ name: name.value, avatar: chosenAvatar, color })); } catch { /* toast already shown */ }
    } },
      h('h2', null, title), previewBox,
      h('label', { class: 'field' }, h('span', null, 'Name'), name),
      h('div', { class: 'field' }, h('span', null, 'Avatar'), emojiGrid, custom),
      h('div', { class: 'field' }, h('span', null, 'Colour'), swatches),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, submitLabel)));
  });
}

export async function render(root) {
  const data = await api('/profiles');
  const choose = (p) => { setProfile(p.id); state.me = null; go('#/'); };
  const grid = h('div', { class: 'picker-grid' });
  for (const p of data.profiles) {
    grid.append(h('button', { class: 'picker-card', onClick: () => choose(p), 'aria-label': `${p.name}, ${p.current_streak}-day streak, level ${p.level}` },
      avatar(p, 'lg'), h('span', { class: 'name' }, p.name),
      h('span', { class: 'chip flame' }, '🔥 ', p.current_streak)));
  }
  if (data.profiles.length < data.max) {
    grid.append(h('button', { class: 'picker-card', onClick: async () => {
      const created = await profileForm({ title: 'New profile', submitLabel: 'Create', onSubmit: (body) => api('/profiles', { method: 'POST', body }) });
      if (created) { toast(`Welcome, ${created.name}`); choose(created); }
    } }, h('span', { class: 'avatar lg', style: { '--c': 'var(--border)' }, 'aria-hidden': 'true' }, '＋'), h('span', { class: 'name' }, 'Add profile'),
      h('span', { class: 'muted small' }, `${data.profiles.length} of ${data.max}`)));
  }
  applyTheme(state.me?.settings || { theme: 'dark' });
  root.append(h('main', { class: 'picker', id: 'view' },
    h('h1', null, 'Who’s reading?'), grid,
    h('p', null, h('button', { class: 'btn ghost sm', onClick: async () => { await api('/access/logout', { method: 'POST' }); location.reload(); } }, 'Forget this device'))));
}
