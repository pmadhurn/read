import { api } from '../api.js';
import { h, dateStr, compact } from '../ui.js';

export async function render(root) {
  const { badges } = await api('/badges');
  const earned = badges.filter((b) => b.earned_at).length;
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Badges'), h('span', { class: 'chip' }, `${earned} of ${badges.length} earned`)),
    h('div', { class: 'badges' }, badges.map((b) => h('div', { class: `card badge-card ${b.earned_at ? '' : 'locked'}` },
      h('div', { class: 'ico', 'aria-hidden': 'true' }, b.icon), h('b', null, b.name), h('span', { class: 'muted small' }, b.description),
      b.earned_at ? h('span', { class: 'pill good' }, `Earned ${dateStr(b.earned_at)}`)
        : [h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': Math.round(b.progress * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${b.name} progress` }, h('i', { style: { width: `${b.progress * 100}%` } })),
          h('span', { class: 'muted small' }, `${compact(b.value)} / ${compact(b.threshold)}`)]))));
}
