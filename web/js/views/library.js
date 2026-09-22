// Shared library (LB-1..7).
import { api } from '../api.js';
import { h, clear, cover, segmented, promptBox, toast, mount } from '../ui.js';
import { isKept } from '../offline.js';

const prefs = JSON.parse(localStorage.getItem('read.library') || '{}');
const save = () => localStorage.setItem('read.library', JSON.stringify(prefs));

export function bookCard(b, list) {
  const pct = Math.round(b.fraction * 100);
  const state = b.status === 'processing' ? h('span', { class: 'pill warn badge' }, 'Processing…')
    : b.status === 'error' ? h('span', { class: 'pill bad badge' }, 'Failed')
      : b.status === 'duplicate' ? h('span', { class: 'pill warn badge' }, 'Duplicate?')
        : b.my_status === 'finished' ? h('span', { class: 'pill good badge' }, '✓ Finished') : null;
  const c = cover(b);
  if (state) c.append(state);
  if (isKept(b.id)) c.append(h('span', { class: 'pill badge offline-pill', title: 'Saved on this device' }, '⬇'));
  if (b.my_status === 'reading' && b.status === 'ready') c.append(h('div', { class: 'progress' }, h('i', { style: { width: `${pct}%` } })));
  return h('a', { class: 'book', href: `#/book/${b.id}`, 'aria-label': `${b.title}${b.author ? ' by ' + b.author : ''}${b.my_status === 'reading' ? `, ${pct}% read` : ''}` }, c,
    h('div', { class: 'meta' }, h('div', { class: 't' }, b.favourite ? '★ ' : '', b.title), h('div', { class: 'a' }, b.author || ' '),
      list && h('div', { class: 'small muted' }, `${Math.round(b.word_count / 1000)}k words · added by ${b.uploader || 'someone'}`)));
}

export async function render(root) {
  const data = await api('/books');
  const tags = [...new Set(data.books.flatMap((b) => b.tags))].sort();
  const grid = h('div', { class: 'books' });
  const count = h('span', { class: 'muted small' });
  const search = h('input', { type: 'search', placeholder: 'Search title or author', 'aria-label': 'Search books', value: prefs.q || '', onInput: () => { prefs.q = search.value; paint(); } });
  const sort = h('select', { 'aria-label': 'Sort by', onChange: () => { prefs.sort = sort.value; save(); paint(); } },
    [['added', 'Recently added'], ['read', 'Recently read'], ['title', 'Title'], ['author', 'Author']].map(([v, t]) => h('option', { value: v, selected: (prefs.sort || 'added') === v }, t)));
  const filter = h('select', { 'aria-label': 'Filter', onChange: () => { prefs.filter = filter.value; save(); paint(); } },
    h('option', { value: '' }, 'All books'),
    [['s:to_read', 'To read'], ['s:reading', 'Reading'], ['s:finished', 'Finished'], ['fav', '★ Favourites'], ['offline', '⬇ Saved on this device']].map(([v, t]) => h('option', { value: v }, t)),
    tags.length ? h('optgroup', { label: 'Tags' }, tags.map((t) => h('option', { value: `t:${t}` }, t))) : null,
    data.collections.length ? h('optgroup', { label: 'Collections' }, data.collections.map((c) => h('option', { value: `c:${c.id}` }, c.name))) : null);
  filter.value = [...filter.options].some((o) => o.value === prefs.filter) ? prefs.filter : '';

  function paint() {
    const needle = (prefs.q || '').trim().toLowerCase();
    const f = filter.value;
    let books = data.books.filter((b) => {
      if (needle && !`${b.title} ${b.author}`.toLowerCase().includes(needle)) return false;
      if (f.startsWith('s:')) return b.my_status === f.slice(2);
      if (f === 'fav') return b.favourite;
      if (f === 'offline') return isKept(b.id);
      if (f.startsWith('t:')) return b.tags.includes(f.slice(2));
      if (f.startsWith('c:')) return data.collections.find((c) => String(c.id) === f.slice(2))?.book_ids.includes(b.id);
      return true;
    });
    const key = sort.value;
    books.sort((a, b) => key === 'title' ? a.title.localeCompare(b.title) : key === 'author' ? (a.author || '~').localeCompare(b.author || '~')
      : key === 'read' ? (b.read_at || '').localeCompare(a.read_at || '') : b.uploaded_at.localeCompare(a.uploaded_at));
    grid.className = `books ${prefs.view === 'list' ? 'list' : ''}`;
    clear(grid).append(...books.map((b) => bookCard(b, prefs.view === 'list')));
    count.textContent = `${books.length} of ${data.books.length} books`;
    if (!books.length) grid.append(h('p', { class: 'empty', style: { 'grid-column': '1 / -1' } }, data.books.length ? 'No books match.' : 'The library is empty. Upload the first book.'));
  }

  mount(root, 
    h('div', { class: 'page-head' }, h('h1', null, 'Library'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onClick: async () => {
          const name = await promptBox('New shared collection', { label: 'Name', ok: 'Create' });
          if (name) { await api('/collections', { method: 'POST', body: { name } }); toast('Collection created. Add books from a book’s page.'); render(clear(root)); }
        } }, '＋ Collection'),
        h('a', { class: 'btn', href: '#/discover' }, '🔎 Find online'),
        h('a', { class: 'btn primary', href: '#/upload' }, '⬆ Add a book'))),
    h('div', { class: 'toolbar' }, search, filter, sort,
      segmented([['grid', '▦ Grid'], ['list', '☰ List']], prefs.view || 'grid', (v) => { prefs.view = v; save(); paint(); }, 'Layout')),
    count, h('div', { style: { height: '10px' } }), grid);
  paint();
  // Books still processing: refresh quietly until they settle.
  let timer = null;
  if (data.books.some((b) => b.status === 'processing')) timer = setTimeout(() => { if (root.isConnected) render(clear(root)); }, 4000);
  return () => clearTimeout(timer);
}
