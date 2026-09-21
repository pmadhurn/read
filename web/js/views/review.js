// Year in review (ST-7).
import { api } from '../api.js';
import { h, num, duration, dateStr } from '../ui.js';
import { barChart } from './stats.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export async function render(root, { params }) {
  const [pid, year] = params.map(Number);
  const r = await api(`/stats/${pid}/year/${year}`);
  const big = (value, label) => h('div', { class: 'card review' }, h('div', { class: 'huge' }, value), h('p', { class: 'muted' }, label));
  const hour = r.favourite_hour;
  root.append(h('div', { class: 'page-head' }, h('h1', null, `${r.avatar} ${r.name}’s ${year} in review`),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: `#/review/${pid}/${year - 1}` }, `← ${year - 1}`), h('a', { class: 'btn', href: `#/stats/${pid}` }, 'Stats'))),
    r.totals.words === 0 ? h('p', { class: 'empty' }, `No reading recorded in ${year}.`) : h('div', { class: 'stack' },
      h('div', { class: 'grid cols-3' }, big(num(r.totals.words), 'words read'), big(duration(r.totals.seconds), 'spent reading'), big(r.totals.books_finished, 'books finished'),
        big(r.totals.days, 'days with reading'), big(`🔥 ${r.longest_streak}`, 'longest streak of the year'), big(num(r.xp), 'XP earned')),
      h('section', { class: 'card' }, h('h2', null, 'Words by month'), barChart(r.months.map((v, i) => ({ name: MONTHS[i], short: MONTHS[i], v, tick: true })), { label: `Words read per month in ${year}` })),
      h('div', { class: 'grid cols-2' },
        h('section', { class: 'card' }, h('h2', null, 'Highlights'), h('ul', { style: { margin: 0, 'padding-left': '20px', 'line-height': 2 } },
          r.best_day && h('li', null, `Biggest day: ${num(r.best_day.words)} words on ${dateStr(r.best_day.day, { day: 'numeric', month: 'long' })}`),
          r.totals.avg_wpm ? h('li', null, `Average speed: ${r.totals.avg_wpm} WPM`) : null, r.totals.top_wpm ? h('li', null, `Fastest sustained session: ${r.totals.top_wpm} WPM`) : null,
          hour != null && h('li', null, `Favourite reading hour: ${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`),
          h('li', null, `Daily goal met on ${r.totals.goal_days} days`))),
        h('section', { class: 'card' }, h('h2', null, 'Badges earned'), r.badges.length ? h('div', { class: 'row' }, r.badges.map((b) => h('span', { class: 'chip' }, `${b.icon} ${b.name}`))) : h('p', { class: 'muted' }, 'None this year.'))),
      h('section', { class: 'card' }, h('h2', null, 'Books read'), h('ul', { style: { margin: 0, 'padding-left': '20px', 'line-height': 1.9 } }, r.books.map((b) => h('li', null, b.deleted ? 'Deleted book' : b.title, h('span', { class: 'muted small' }, ` · ${duration(b.seconds)}${b.finished_at ? ' · finished' : ''}`)))))));
}
