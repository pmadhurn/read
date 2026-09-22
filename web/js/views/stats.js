// Reading stats for any profile (section 8), plus side-by-side compare (ST-6).
import { api } from '../api.js';
import { h, clear, avatar, num, compact, duration, dateStr, tip, mount } from '../ui.js';
import { state, go } from '../app.js';

const W = 440, H = 190, PAD = { l: 38, r: 8, t: 10, b: 24 };

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((m) => m >= v);
}

function frame(max, fmt) {
  const svg = h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (const f of [0, 0.5, 1]) {
    const y = PAD.t + (H - PAD.t - PAD.b) * (1 - f);
    svg.append(h('line', { class: 'axis', x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, 'stroke-dasharray': f ? '2 4' : null }),
      h('text', { x: PAD.l - 6, y: y + 4, 'text-anchor': 'end' }, fmt(max * f)));
  }
  return svg;
}

// One series, so one colour and no legend; the card title names it. Every mark has a hover/focus tooltip.
export function barChart(points, { label, fmt = compact, every = 5 }) {
  const max = niceMax(Math.max(...points.map((p) => p.v)));
  const svg = frame(max, fmt);
  svg.setAttribute('aria-label', label);
  const inner = W - PAD.l - PAD.r, slot = inner / points.length, bw = Math.max(2, Math.min(18, slot - 2)), base = H - PAD.b;
  points.forEach((p, i) => {
    const x = PAD.l + slot * i + (slot - bw) / 2, hgt = (H - PAD.t - PAD.b) * p.v / max;
    const hit = h('rect', { class: 'hit', x: PAD.l + slot * i, y: PAD.t, width: slot, height: base - PAD.t, tabindex: p.v ? 0 : null, 'aria-label': `${p.name}: ${fmt(p.v)}` });
    tip(hit, `${p.name}: ${p.tip ?? fmt(p.v)}`);
    const r = Math.min(4, bw / 2, hgt);
    svg.append(hit, h('path', { class: 'mark', 'pointer-events': 'none', d: hgt <= 0 ? '' : `M${x},${base} v${-(hgt - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${hgt - r} z` }));
    if (p.tick ?? i % every === 0) svg.append(h('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' }, p.short));
  });
  return svg;
}

export function lineChart(points, { label, fmt = compact }) {
  const live = points.filter((p) => p.v > 0);
  if (live.length < 2) return h('p', { class: 'muted' }, 'Not enough reading days yet to draw a trend.');
  const max = niceMax(Math.max(...live.map((p) => p.v)));
  const svg = frame(max, fmt);
  svg.setAttribute('aria-label', label);
  const X = (i) => PAD.l + (W - PAD.l - PAD.r) * (i / (points.length - 1)), Y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const coords = points.map((p, i) => [X(i), Y(p.v), p]).filter((c) => c[2].v > 0);
  svg.append(h('polyline', { class: 'line', points: coords.map((c) => `${c[0]},${c[1]}`).join(' ') }));
  coords.forEach(([x, y, p], n) => {
    const dot = h('circle', { class: 'mark', cx: x, cy: y, r: 4, stroke: 'var(--surface)', 'stroke-width': 2, tabindex: 0, 'aria-label': `${p.name}: ${fmt(p.v)}` });
    tip(dot, `${p.name}: ${fmt(p.v)} WPM`);
    svg.append(dot);
    if (n === 0 || n === coords.length - 1) svg.append(h('text', { x, y: H - 6, 'text-anchor': n ? 'end' : 'start' }, p.short));
  });
  return svg;
}

export function heatmap(days, todayIso) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const end = new Date(todayIso + 'T00:00:00'), start = new Date(end); start.setDate(end.getDate() - 364);
  const peak = Math.max(1, ...days.map((d) => d.words));
  const grid = h('div', { class: 'heat', role: 'img', 'aria-label': 'Reading days over the last year' });
  for (let i = 0; i < (start.getDay() + 6) % 7; i++) grid.append(h('i', { class: 'pad' }));
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const words = byDay.get(iso)?.words || 0;
    const cell = h('i', { 'data-l': words ? Math.min(4, 1 + Math.floor(words / peak * 3.999)) : 0 });
    tip(cell, `${dateStr(iso, { day: 'numeric', month: 'short' })}: ${words ? num(words) + ' words' : 'no reading'}`);
    grid.append(cell);
  }
  const scroller = h('div', { class: 'table-wrap' }, grid);
  requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth; });   // newest weeks first in view
  return h('div', null, scroller,
    h('div', { class: 'row small muted', style: { 'margin-top': '8px', gap: '4px' } }, 'Less', [0, 1, 2, 3, 4].map((l) => h('i', { 'data-l': l, class: 'heat-key', style: { width: '12px', height: '12px', 'border-radius': '3px', display: 'inline-block', background: `var(--heat-${l})` } })), 'More'));
}

function last30(data) {
  const byDay = new Map(data.days.map((d) => [d.day, d]));
  const out = [], end = new Date(data.today + 'T00:00:00');
  for (let i = 29; i >= 0; i--) {
    const d = new Date(end); d.setDate(end.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ iso, name: dateStr(iso, { day: 'numeric', month: 'short' }), short: String(d.getDate()), rec: byDay.get(iso) });
  }
  return out;
}

function totalsGrid(t) {
  const cell = (v, label) => h('div', { class: 'stat' }, h('b', null, v), h('span', null, label));
  return h('div', { class: 'grid cols-4' }, cell(compact(t.words), 'Words read'), cell(duration(t.seconds), 'Time read'), cell(t.books_finished, 'Books finished'),
    cell(t.avg_wpm || '–', 'Average WPM'), cell(t.top_wpm || '–', 'Top WPM, 5+ min'), cell(t.days, 'Days read'));
}

async function compare(root, a, b) {
  const [A, B, all] = await Promise.all([api(`/stats/${a}`), api(`/stats/${b}`), api('/profiles')]);
  const pick = (current, other, side) => h('select', { 'aria-label': `Profile ${side}`, onChange: (e) => go(side === 'A' ? `#/compare/${e.target.value}/${other}` : `#/compare/${other}/${e.target.value}`) },
    all.profiles.map((p) => h('option', { value: p.id, selected: p.id === current }, p.name)));
  const row = (label, f, fmt = num) => { const x = f(A), y = f(B); return h('tr', null, h('td', { class: 'num', style: { 'font-weight': x > y ? 700 : 400 } }, fmt(x)), h('th', { style: { 'text-align': 'center' } }, label), h('td', { style: { 'font-weight': y > x ? 700 : 400 } }, fmt(y))); };
  mount(root, h('div', { class: 'page-head' }, h('h1', null, 'Compare'), h('a', { class: 'btn', href: '#/stats' }, '← Stats')),
    h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', { class: 'num' }, pick(A.profile.id, B.profile.id, 'A')), h('th'), h('th', null, pick(B.profile.id, A.profile.id, 'B')))),
      h('tbody', null, row('Level', (s) => s.profile.level), row('Total XP', (s) => s.profile.xp), row('Current streak', (s) => s.profile.current_streak), row('Best streak', (s) => s.profile.best_streak),
        row('Words read', (s) => s.totals.words), row('Time read', (s) => s.totals.seconds, duration), row('Books finished', (s) => s.totals.books_finished),
        row('Average WPM', (s) => s.totals.avg_wpm), row('Top WPM (5+ min)', (s) => s.totals.top_wpm), row('Days read', (s) => s.totals.days), row('Trophies', (s) => s.trophies.length))))));
}

export async function render(root, { params, name }) {
  if (name === 'compare') return compare(root, Number(params[0]), Number(params[1]));
  const pid = Number(params[0]) || state.me.id;
  const [data, all] = await Promise.all([api(`/stats/${pid}`), api('/profiles')]);
  const p = data.profile, days = last30(data), year = Number(data.today.slice(0, 4));
  const others = all.profiles.filter((x) => x.id !== pid);

  mount(root, 
    h('div', { class: 'page-head' }, h('div', { class: 'row' }, avatar(p, 'md'), h('div', null, h('h1', null, pid === state.me.id ? 'My stats' : p.name), h('span', { class: 'muted small' }, `Level ${p.level} · ${num(p.xp)} XP · 🔥 ${p.current_streak} · ${p.tier} league`))),
      h('div', { class: 'row' },
        h('select', { 'aria-label': 'View another profile', style: { width: 'auto' }, onChange: (e) => go(`#/stats/${e.target.value}`) }, all.profiles.map((x) => h('option', { value: x.id, selected: x.id === pid }, x.name))),
        others.length ? h('a', { class: 'btn', href: `#/compare/${pid}/${pid === state.me.id ? others[0].id : state.me.id}` }, 'Compare') : null,
        h('a', { class: 'btn', href: `#/review/${pid}/${year}` }, `${year} in review`), h('a', { class: 'btn', href: '#/badges' }, 'Badges'))),
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h2', null, 'Totals'), totalsGrid(data.totals)),
      h('div', { class: 'grid cols-2' },
        h('section', { class: 'card' }, h('h2', null, 'Words per day, last 30 days'), barChart(days.map((d) => ({ name: d.name, short: d.short, v: d.rec?.words || 0, tip: `${num(d.rec?.words || 0)} words` })), { label: 'Words read per day over the last 30 days' })),
        h('section', { class: 'card' }, h('h2', null, 'Average WPM over time'), lineChart(days.map((d) => ({ name: d.name, short: d.name, v: d.rec?.wpm || 0 })), { label: 'Average words per minute per day', fmt: (v) => String(Math.round(v)) })),
        h('section', { class: 'card' }, h('h2', null, 'Reading time by hour of day'), barChart(data.hours.map((m, hr) => ({ name: `${String(hr).padStart(2, '0')}:00`, short: String(hr), v: m, tip: `${Math.round(m)} min`, tick: hr % 3 === 0 })), { label: 'Minutes read by hour of day, IST', fmt: (v) => `${Math.round(v)}m` })),
        h('section', { class: 'card' }, h('h2', null, 'Reading days, last 12 months'), heatmap(data.days, data.today))),
      h('section', { class: 'card' }, h('h2', null, 'By book'), data.books.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Book'), h('th', { class: 'num' }, 'Time'), h('th', { class: 'num' }, 'Sessions'), h('th', { class: 'num' }, 'Avg WPM'), h('th', null, 'Started'), h('th', null, 'Finished'))),
        h('tbody', null, data.books.map((b) => h('tr', null, h('td', null, b.deleted ? h('i', { class: 'muted' }, 'Deleted book') : h('a', { href: `#/book/${b.book_id}` }, b.title)),
          h('td', { class: 'num' }, duration(b.seconds)), h('td', { class: 'num' }, b.sessions), h('td', { class: 'num' }, b.avg_wpm || '–'), h('td', null, dateStr(b.first_read)), h('td', null, b.finished_at ? dateStr(b.finished_at) : '–'))))))
        : h('p', { class: 'muted' }, 'No reading sessions yet.')),
      h('section', { class: 'card' }, h('h2', null, 'Recent sessions'), data.sessions.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Book'), h('th', { class: 'num' }, 'Words'), h('th', { class: 'num' }, 'Active'), h('th', { class: 'num' }, 'WPM'))),
        h('tbody', null, data.sessions.map((s) => h('tr', null, h('td', null, new Date(s.started_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })),
          h('td', null, s.title), h('td', { class: 'num' }, num(s.words)), h('td', { class: 'num' }, duration(s.active_seconds)), h('td', { class: 'num' }, s.avg_wpm || '–'))))))
        : h('p', { class: 'muted' }, 'No sessions yet.'))));
}
