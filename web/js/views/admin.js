// Admin functions, all behind the PIN (section 9).
import { api } from '../api.js';
import { h, clear, num, bytes, confirmBox, promptBox, toast, mount, dateStr } from '../ui.js';
import { state, go, ensureAdmin } from '../app.js';

export async function render(root) {
  if (!await ensureAdmin()) { go('#/settings'); return; }
  const [o, rules, trash] = await Promise.all([api('/admin/overview'), api('/admin/rules'), api('/admin/trash')]);
  const reload = () => render(clear(root));
  const used = o.files_bytes + o.db_bytes;

  const profiles = h('div', { class: 'admin-profiles' }, o.profiles.map((p) => h('div', { class: 'admin-profile' },
    h('div', { class: 'grow' }, h('b', null, `${p.avatar} ${p.name}`, p.hidden ? h('span', { class: 'pill', style: { 'margin-left': '6px' } }, 'hidden') : null),
      h('div', { class: 'muted small' }, `${num(p.xp)} XP · 🔥 ${p.streak}`)),
    h('div', { class: 'row nowrap' },
      h('button', { class: 'btn sm', onClick: async () => { const name = await promptBox('Rename profile', { label: 'Name', value: p.name }); if (name) { await api(`/admin/profiles/${p.id}`, { method: 'PATCH', body: { name } }); reload(); } } }, 'Rename'),
      h('button', { class: 'btn sm danger', onClick: async () => { if (await confirmBox(`Reset ${p.name}?`, 'Progress, XP, streaks, badges and history are wiped. The profile itself stays.', { danger: true, ok: 'Reset' })) { await api(`/admin/profiles/${p.id}/reset`, { method: 'POST' }); toast('Profile reset'); reload(); } } }, 'Reset'),
      h('button', { class: 'btn sm danger', onClick: async () => { if (await confirmBox(`Delete ${p.name}?`, 'The profile and all of its history are removed for good. Books they uploaded stay.', { danger: true, ok: 'Delete' })) { await api(`/admin/profiles/${p.id}`, { method: 'DELETE' }); toast('Profile deleted'); if (p.id === state.me.id) { localStorage.removeItem('read.profile'); location.hash = ''; location.reload(); } else reload(); } } }, 'Delete')))));

  const passcode = h('input', { type: 'text', autocomplete: 'off', placeholder: 'New family passcode (6+ characters)' });
  const pin = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'New admin PIN (4–12 digits)' });
  const secrets = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    if (!passcode.value && !pin.value) return;
    if (!await confirmBox('Change access codes?', 'Every remembered device, including this one, is signed out and must enter the passcode again.', { ok: 'Change' })) return;
    await api('/admin/secrets', { method: 'POST', body: { passcode: passcode.value, pin: pin.value } }); location.reload();
  } }, h('label', { class: 'field' }, h('span', null, 'Family passcode'), passcode), h('label', { class: 'field' }, h('span', null, 'Admin PIN'), pin), h('div', null, h('button', { class: 'btn primary' }, 'Save new codes')));

  const XP_LABELS = { words_per_xp: 'Words per 1 XP', goal_bonus: 'Daily goal bonus', chapter_bonus: 'Chapter finished bonus', book_bonus: 'Book finished bonus', streak7_multiplier: '7-day streak multiplier', streak30_multiplier: '30-day streak multiplier' };
  const xpInputs = {}, badgeInputs = {};
  const rulesForm = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    await api('/admin/rules', { method: 'PUT', body: { xp: Object.fromEntries(Object.entries(xpInputs).map(([k, el]) => [k, Number(el.value)])), badges: Object.fromEntries(Object.entries(badgeInputs).map(([k, el]) => [k, Number(el.value)])) } });
    toast('Rules saved');
  } },
    h('div', { class: 'grid cols-3' }, Object.entries(XP_LABELS).map(([k, label]) => h('label', { class: 'field' }, h('span', null, label), xpInputs[k] = h('input', { type: 'number', step: 'any', min: 0.01, value: rules.xp[k] })))),
    h('h3', null, 'Badge thresholds'),
    h('div', { class: 'grid cols-3' }, rules.badges.map((b) => h('label', { class: 'field' }, h('span', null, `${b.icon} ${b.name}`), badgeInputs[b.id] = h('input', { type: 'number', step: 'any', min: 1, value: b.threshold })))),
    h('div', null, h('button', { class: 'btn primary' }, 'Save rules')));

  mount(root, h('div', { class: 'page-head' }, h('h1', null, 'Admin'),
    h('button', { class: 'btn', onClick: async () => { await api('/access/admin/logout', { method: 'POST' }); state.admin = false; go('#/settings'); } }, 'Lock admin')),
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h2', null, 'Storage'),
        h('div', { class: 'grid cols-4' }, h('div', { class: 'stat' }, h('b', null, o.books), h('span', null, 'Books')), h('div', { class: 'stat' }, h('b', null, `${o.profiles.length}/${o.max_profiles}`), h('span', null, 'Profiles')),
          h('div', { class: 'stat' }, h('b', null, bytes(o.files_bytes)), h('span', null, 'Book files')), h('div', { class: 'stat' }, h('b', null, bytes(o.db_bytes)), h('span', null, 'Database')), h('div', { class: 'stat' }, h('b', null, bytes(o.disk_free_bytes)), h('span', null, 'Free on disk'))),
        h('div', { class: 'bar', style: { 'margin-top': '14px' }, role: 'progressbar', 'aria-label': 'Storage used of plan', 'aria-valuenow': Math.round(used / o.plan_bytes * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: `${Math.min(100, used / o.plan_bytes * 100)}%` } })),
        h('p', { class: 'muted small', style: { 'margin-top': '6px' } }, `${bytes(used)} of the planned ${bytes(o.plan_bytes)}. Books are deleted, edited and re-processed from each book’s page.`)),
      h('section', { class: 'card' }, h('h2', null, 'Profiles'), profiles),
      h('section', { class: 'card' }, h('h2', null, 'Recently deleted'),
        h('p', { class: 'muted small', style: { 'margin-bottom': '10px' } }, 'Deleted books keep their text and files for 30 days and can be put back. After that only the reading history remains.'),
        trash.books.length ? h('div', { class: 'admin-profiles' }, trash.books.map((b) => h('div', { class: 'admin-profile' },
          h('div', { class: 'grow' }, h('b', null, b.title), h('div', { class: 'muted small' }, `${b.author || 'Unknown author'} · deleted ${dateStr(b.deleted_at)} · ${b.restorable ? `kept until ${dateStr(b.purge_at)}` : 'text already purged'}`)),
          h('div', { class: 'row nowrap' },
            b.restorable && h('button', { class: 'btn sm primary', onClick: async () => { await api(`/admin/books/${b.id}/restore`, { method: 'POST' }); toast('Book restored'); reload(); } }, 'Restore'),
            b.restorable && h('button', { class: 'btn sm danger', onClick: async () => { if (await confirmBox('Delete forever?', `“${b.title}” and its files are removed now instead of in 30 days.`, { danger: true, ok: 'Delete forever' })) { await api(`/admin/books/${b.id}/purge`, { method: 'DELETE' }); reload(); } } }, 'Delete forever')))))
          : h('p', { class: 'muted' }, 'The bin is empty.')),
      h('section', { class: 'card stack' }, h('h2', null, 'Backups'),
        h('p', { class: 'muted small' }, `A database dump is written every day and kept for 14 days; book files are mirrored alongside. ${o.backups.length ? `Latest: ${o.backups[0].name} (${bytes(o.backups[0].bytes)}), ${o.backups.length} kept.` : 'None written yet.'}`),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '/api/admin/backup/download', download: '' }, '⬇ Download full backup'),
          h('button', { class: 'btn', onClick: async (e) => { e.target.disabled = true; await api('/admin/backups', { method: 'POST' }); toast('Backup written'); reload(); } }, 'Back up now'))),
      h('section', { class: 'card' }, h('h2', null, 'Access codes'), secrets),
      h('section', { class: 'card' }, h('h2', null, 'XP and badge rules'), rulesForm)));
}
