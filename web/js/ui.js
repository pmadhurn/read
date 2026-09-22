// DOM helper, overlays, formatting, sounds.

export function h(tag, attrs, ...children) {
  const el = tag === 'svg' || SVG_TAGS.has(tag)
    ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, children);
  return el;
}
const SVG_TAGS = new Set(['circle', 'rect', 'path', 'line', 'text', 'g', 'polyline', 'title']);
function add(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) add(el, c);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el) => { el.replaceChildren(); return el; };
// Views hand their pieces to this so a conditional `null` never becomes the text "null".
export const mount = (root, ...children) => { add(root, children); return root; };

const nf = new Intl.NumberFormat('en-IN');
export const num = (n) => nf.format(Math.round(n || 0));
export function compact(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
export function duration(seconds) {
  seconds = Math.max(0, Math.round(seconds || 0));
  const hrs = Math.floor(seconds / 3600), min = Math.floor((seconds % 3600) / 60);
  if (hrs) return `${hrs}h ${min}m`;
  if (min) return `${min} min`;
  return `${seconds}s`;
}
export function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
export const dateStr = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Date(iso).toLocaleDateString('en-IN', opts);
export function bytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

export function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 5000 : 3000);
}

// Modal with focus trap; resolves with the value passed to close().
export function modal(build, { wide = false, className = '' } = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const close = (value) => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); previous?.focus?.(); resolve(value); };
    const box = h('div', { class: `modal ${wide ? 'wide' : ''} ${className}`, role: 'dialog', 'aria-modal': 'true' });
    const backdrop = h('div', { class: 'backdrop', onMousedown: (e) => { if (e.target === backdrop) close(undefined); } }, box);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(undefined); }
      if (e.key === 'Tab') {
        const items = [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    add(box, [build(close)]);
    document.body.append(backdrop);
    const heading = box.querySelector('h2');
    if (heading) { heading.id = 'dlg-title'; box.setAttribute('aria-labelledby', 'dlg-title'); }
    (box.querySelector('[autofocus]') || box.querySelector('input, textarea, select, button'))?.focus();
  });
}

export function confirmBox(title, text, { danger = false, ok = 'Confirm' } = {}) {
  return modal((close) => [
    h('h2', null, title), h('p', { class: 'muted' }, text),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onClick: () => close(false) }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => close(true) }, ok)),
  ]);
}

export function promptBox(title, { label = '', value = '', type = 'text', ok = 'Save', hint = '' } = {}) {
  return modal((close) => {
    const input = h('input', { type, value, autofocus: true, autocomplete: 'off', inputmode: type === 'password' ? 'numeric' : null });
    return h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); close(input.value); } },
      h('h2', null, title), hint && h('p', { class: 'muted small' }, hint),
      h('label', { class: 'field' }, h('span', null, label), input),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => close(undefined) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, ok)));
  });
}

export function avatar(p, size = '') {
  return h('span', { class: `avatar ${size}`, style: { '--c': p.color || '#4f7cff' }, 'aria-hidden': 'true' }, p.avatar || '📖');
}

export function cover(book, size = 'thumb') {
  const box = h('div', { class: 'cover', style: { '--c': hue(book.title || '') } });
  if (book.has_cover) box.append(h('img', { src: `/api/books/${book.id}/cover?size=${size}`, alt: '', loading: 'lazy', decoding: 'async' }));
  else box.append(h('div', { class: 'fallback' }, h('b', null, book.title || 'Untitled'), h('span', null, book.author || '')));
  return box;
}
function hue(text) {
  let x = 0;
  for (const ch of text) x = (x * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${x} 45% 45%)`;
}

export function segmented(options, value, onChange, label) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const paint = () => [...wrap.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(value))));
  for (const [v, text] of options) {
    wrap.append(h('button', { type: 'button', 'data-v': v, onClick: () => { value = v; paint(); onChange(v); } }, text));
  }
  paint();
  return wrap;
}

let audio;
export function chime(kind = 'goal') {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const notes = { goal: [523, 659, 784], level: [392, 523, 659, 784, 1047], badge: [659, 880] }[kind] || [660];
    notes.forEach((freq, i) => {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.type = 'triangle'; osc.frequency.value = freq;
      const t = audio.currentTime + i * 0.11;
      gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(0.16, t + 0.02); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.connect(gain).connect(audio.destination); osc.start(t); osc.stop(t + 0.4);
    });
  } catch { /* no audio available */ }
}

// Hover/focus tooltip for chart marks.
let tipEl;
export function tip(target, text) {
  const show = (e) => {
    tipEl ||= document.body.appendChild(h('div', { class: 'tip', role: 'tooltip' }));
    tipEl.textContent = text; tipEl.hidden = false;
    const r = target.getBoundingClientRect();
    tipEl.style.left = `${Math.min(window.innerWidth - 60, Math.max(60, r.left + r.width / 2))}px`;
    tipEl.style.top = `${r.top}px`;
  };
  const hide = () => { if (tipEl) tipEl.hidden = true; };
  target.addEventListener('pointerenter', show); target.addEventListener('pointerleave', hide);
  target.addEventListener('focus', show); target.addEventListener('blur', hide);
}
