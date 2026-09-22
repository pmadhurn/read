// Home: today's ring, streaks, 30-day calendar, continue reading, family activity (GM-5, LB-4, GM-14).
import { api } from '../api.js';
import { h, cover, avatar, ago, num, duration, mount } from '../ui.js';
import { state, refreshMe } from '../app.js';

export function ring(fraction, big, small) {
  const r = 64, c = 2 * Math.PI * r;
  return h('div', { class: 'ring', role: 'img', 'aria-label': `Daily goal ${Math.round(fraction * 100)} percent complete` },
    h('svg', { viewBox: '0 0 148 148', width: 148, height: 148 },
      h('circle', { cx: 74, cy: 74, r, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': 12 }),
      h('circle', { cx: 74, cy: 74, r, fill: 'none', stroke: fraction >= 1 ? 'var(--good)' : 'var(--primary)', 'stroke-width': 12,
        'stroke-linecap': 'round', 'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - Math.min(1, fraction)) })),
    h('div', { class: 'center' }, h('div', { class: 'big' }, big), h('div', { class: 'muted small' }, small)));
}

export function feedText(item) {
  const d = item.data;
  switch (item.kind) {
    case 'finished': return ['finished ', h('i', null, d.title)];
    case 'started': return ['started ', h('i', null, d.title)];
    case 'streak': return [`hit a ${d.days}-day streak 🔥`];
    case 'badge': return [`earned ${d.icon} ${d.badge}`];
    case 'level': return [`reached level ${d.level}`];
    case 'trophy': return [`won the ${d.trophy} trophy ${{ gold: '🥇', silver: '🥈', bronze: '🥉' }[d.trophy]}`];
    default: return [item.kind];
  }
}

export function feedList(items) {
  if (!items.length) return h('p', { class: 'muted' }, 'Nothing yet. Start reading and it shows up here.');
  return h('ul', { class: 'feed' }, items.map((i) => h('li', null, avatar(i),
    h('div', null, h('b', null, i.name), ' ', feedText(i), h('time', { datetime: i.at }, ago(i.at))))));
}

export function calendar(me) {
  const byDay = new Map(me.calendar.map((d) => [d.day, d]));
  const cells = [];
  const end = new Date(me.date + 'T00:00:00');
  for (let i = 29; i >= 0; i--) {
    const d = new Date(end); d.setDate(end.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const rec = byDay.get(iso);
    const cls = rec?.met ? 'met' : rec?.freeze ? 'freeze' : '';
    const label = `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}: ${rec?.met ? 'goal met' : rec?.freeze ? 'streak freeze used' : 'goal not met'}`;
    cells.push(h('i', { class: `${cls} ${i === 0 ? 'today' : ''}`, title: label, 'aria-label': label, role: 'img' }, rec?.freeze && !rec.met ? '🧊' : d.getDate()));
  }
  return h('div', { class: 'cal' }, cells);
}

export async function render(root) {
  const [me, lib, feed] = await Promise.all([refreshMe(), api('/books'), api('/feed')]);
  const t = me.today;
  const left = t.type === 'words' ? `${num(Math.max(0, t.target - t.done))} words to go` : `${Math.max(0, Math.ceil(t.target - t.done))} min to go`;
  const reading = lib.books.filter((b) => b.my_status === 'reading' && b.status === 'ready')
    .sort((a, b) => (b.read_at || '').localeCompare(a.read_at || ''));

  mount(root, 
    h('div', { class: 'page-head' }, h('h1', null, `Hello, ${me.name}`),
      h('a', { class: 'btn primary', href: reading[0] ? `#/read/${reading[0].id}` : '#/library' }, reading[0] ? '▶ Continue reading' : 'Pick a book')),
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'card' }, h('h2', null, 'Today'),
        h('div', { class: 'ring-wrap' },
          ring(t.fraction, t.met ? '✓' : `${Math.round(t.fraction * 100)}%`, t.type === 'words' ? `${num(t.done)} / ${num(t.target)} words` : `${Math.floor(t.done)} / ${t.target} min`),
          h('div', { class: 'grid cols-2 grow', style: { 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' } },
            h('div', { class: 'stat' }, h('b', { style: { color: 'var(--flame)' } }, `🔥 ${me.current_streak}`), h('span', null, 'Current streak')),
            h('div', { class: 'stat' }, h('b', null, me.best_streak), h('span', null, 'Best streak')),
            h('div', { class: 'stat' }, h('b', { style: { color: 'var(--ice)' } }, `🧊 ${me.freezes}`), h('span', null, 'Freezes held (max 2)')),
            h('div', { class: 'stat' }, h('b', null, num(t.words)), h('span', null, `Words today · ${duration(t.seconds)}`)))),
        h('p', { class: 'muted small', style: { 'margin-top': '12px' } }, t.met ? 'Goal met. The streak is safe for today.' : `${left}. Days end at midnight IST.`)),
      h('section', { class: 'card' },
        h('div', { class: 'row', style: { 'justify-content': 'space-between', 'margin-bottom': '12px' } }, h('h2', null, `Level ${me.level}`), h('span', { class: 'pill' }, `${me.tier} league`)),
        h('div', { class: 'bar good', role: 'progressbar', 'aria-valuenow': Math.round(me.level_progress * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Progress to next level' },
          h('i', { style: { width: `${me.level_progress * 100}%` } })),
        h('p', { class: 'muted small', style: { margin: '8px 0 16px' } }, `${num(me.xp)} XP · ${num(me.level_next - me.xp)} XP to level ${me.level + 1}`),
        h('h3', null, 'Last 30 days'), calendar(me))),
    h('section', { class: 'stack', style: { 'margin-top': '24px' } }, h('h2', null, 'Continue reading'),
      reading.length ? h('div', { class: 'hscroll' }, reading.map((b) => h('a', { class: 'card continue', href: `#/read/${b.id}` }, cover(b),
        h('div', { class: 'grow stack', style: { gap: '6px' } }, h('b', { class: 't' }, b.title), h('span', { class: 'muted small' }, b.author),
          h('div', { class: 'bar good' }, h('i', { style: { width: `${b.fraction * 100}%` } })), h('span', { class: 'small muted' }, `${Math.round(b.fraction * 100)}% done`)))))
        : h('p', { class: 'muted' }, 'No books in progress. ', h('a', { href: '#/library' }, 'Open the library'), ' to start one.')),
    h('section', { class: 'card', style: { 'margin-top': '24px' } }, h('h2', null, 'Family activity'), feedList(feed.items.slice(0, 12))));
}
