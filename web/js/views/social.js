// Leaderboard, weekly league, trophies and the family feed (GM-11..14).
import { api } from '../api.js';
import { h, clear, avatar, num, segmented, dateStr, mount } from '../ui.js';
import { state } from '../app.js';
import { feedList } from './home.js';

const MEDAL = { gold: '🥇', silver: '🥈', bronze: '🥉' };

function rows(list, showTier) {
  if (!list.length) return h('p', { class: 'muted' }, 'Nobody is on the board yet.');
  return h('ol', { style: { 'list-style': 'none', margin: 0, padding: 0 } }, list.map((r, i) => h('li', { class: `rank ${r.id === state.me.id ? 'me' : ''}` },
    h('span', { class: 'pos' }, r.xp > 0 && i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1), avatar(r, 'md'),
    h('div', { class: 'grow' }, h('a', { href: `#/stats/${r.id}`, style: { color: 'inherit', 'font-weight': 600, 'text-decoration': 'none' } }, r.name),
      h('div', { class: 'muted small' }, showTier ? `${r.tier} league` : `Level ${r.level} · 🔥 ${r.streak}`)),
    h('span', { class: 'xp' }, `${num(r.xp)} XP`))));
}

export async function render(root) {
  const [league, feed] = await Promise.all([api('/league'), api('/feed')]);
  const board = h('div');
  const load = async (period) => { const data = await api(`/leaderboard?period=${period}`); clear(board).append(rows(data.rows, false)); };
  const ends = new Date(league.ends_at), hoursLeft = Math.max(0, (ends - Date.now()) / 3600e3);
  const left = hoursLeft > 48 ? `${Math.ceil(hoursLeft / 24)} days left` : `${Math.ceil(hoursLeft)} hours left`;
  const weeks = new Map();
  league.history.forEach((x) => { if (!weeks.has(x.week_start)) weeks.set(x.week_start, []); weeks.get(x.week_start).push(x); });

  mount(root, h('div', { class: 'page-head' }, h('h1', null, 'Ranks')),
    state.me.hidden ? h('div', { class: 'notice', style: { 'margin-bottom': '16px' } }, 'You are hidden from these boards. Change it in Settings.') : null,
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'card' }, h('div', { class: 'row', style: { 'justify-content': 'space-between', 'margin-bottom': '12px' } }, h('h2', null, 'Family leaderboard'),
        segmented([['week', 'This week'], ['month', 'This month'], ['all', 'All time']], 'week', load, 'Period')), board),
      h('section', { class: 'card' }, h('div', { class: 'row', style: { 'justify-content': 'space-between', 'margin-bottom': '4px' } }, h('h2', null, 'Weekly league'), h('span', { class: 'pill' }, left)),
        h('p', { class: 'muted small', style: { 'margin-bottom': '8px' } }, `Resets Monday 00:00 IST. Top 3 win trophies and move up a tier (${league.tiers.join(' → ')}); the bottom of the table moves down.`),
        rows(league.rows, true)),
      h('section', { class: 'card' }, h('h2', null, 'Trophy cabinet'),
        weeks.size ? [...weeks].map(([week, winners]) => h('div', { class: 'row', style: { padding: '8px 0', 'border-bottom': '1px solid var(--border)' } },
          h('span', { class: 'muted small', style: { width: '96px' } }, `Week of ${dateStr(week, { day: 'numeric', month: 'short' })}`),
          winners.map((w) => h('span', { class: 'chip' }, `${MEDAL[w.trophy]} ${w.name} · ${num(w.xp)}`))))
          : h('p', { class: 'muted' }, 'The first trophies are handed out when this week ends.')),
      h('section', { class: 'card' }, h('h2', null, 'Activity'), feedList(feed.items))));
  load('week');
}
