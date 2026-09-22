// Find free books online (Project Gutenberg, Internet Archive) and add them straight to the library.
import { api } from '../api.js';
import { h, clear, segmented, toast, compact, mount } from '../ui.js';
import { go } from '../app.js';

const last = { q: '', source: 'all', lang: '', data: null };

function result(r) {
  const img = h('div', { class: 'cover' });
  const fallback = () => img.replaceChildren(h('div', { class: 'fallback' }, h('b', null, r.title), h('span', null, r.author)));
  if (r.has_cover) img.append(h('img', { src: `/api/discover/cover?source=${r.source}&id=${encodeURIComponent(r.id)}`, alt: '', loading: 'lazy', onError: fallback })); else fallback();
  const format = h('select', { 'aria-label': `Format for ${r.title}`, style: { width: 'auto' } }, r.formats.map((f) => h('option', { value: f.key }, f.label)));
  const button = h('button', { class: 'btn primary', onClick: async () => {
    button.disabled = true; button.textContent = 'Adding…';
    try { const out = await api('/discover/add', { method: 'POST', body: { source: r.source, id: r.id, format: format.value } }); toast('Downloading into the library'); go(`#/book/${out.book_id}`); }
    catch { button.disabled = false; button.textContent = 'Add to library'; }
  } }, 'Add to library');
  return h('li', { class: 'card find' }, img,
    h('div', { class: 'stack grow', style: { gap: '6px' } },
      h('b', null, r.title), h('span', { class: 'muted small' }, r.author || 'Unknown author'),
      h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'pill' }, r.source_label), r.language && h('span', { class: 'pill' }, r.language),
        r.downloads ? h('span', { class: 'muted small' }, `${compact(r.downloads)} downloads`) : null,
        h('a', { class: 'small', href: r.page, target: '_blank', rel: 'noopener noreferrer' }, 'View at source')),
      r.in_library ? h('div', { class: 'notice' }, 'A book with this title is already in the library. ', h('a', { href: `#/book/${r.in_library}` }, 'Open it')) : null,
      h('div', { class: 'row' }, format, button)));
}

export async function render(root) {
  const list = h('ul', { class: 'finds' });
  const status = h('p', { class: 'muted', role: 'status' }, 'Search Project Gutenberg and the Internet Archive for free, legally downloadable books. Public-domain classics are the best covered; recent paid books are not there.');
  const input = h('input', { type: 'search', placeholder: 'Title or author', value: last.q, 'aria-label': 'Search online', autofocus: true });
  const lang = h('select', { 'aria-label': 'Language', style: { width: 'auto' }, onChange: () => { last.lang = lang.value; } },
    [['', 'Any language'], ['en', 'English'], ['hi', 'Hindi'], ['sa', 'Sanskrit'], ['gu', 'Gujarati']].map(([v, t]) => h('option', { value: v, selected: last.lang === v }, t)));
  const NAMES = { gutenberg: 'Project Gutenberg', archive: 'Internet Archive' };
  const paint = (data, pending = []) => {
    clear(list).append(...data.results.map(result));
    const down = data.unreachable.map((s) => NAMES[s]).join(' and ');
    status.textContent = (pending.length ? `${data.results.length} so far. Still waiting for ${pending.map((s) => NAMES[s]).join(' and ')}…`
      : data.results.length ? `${data.results.length} results.` : 'Nothing found. Try fewer words, or the author’s name.') + (down ? ` ${down} did not answer.` : '');
  };
  let ticket = 0;
  // Each source is asked separately, so a slow catalogue never holds back the fast one.
  const run = async () => {
    last.q = input.value.trim();
    if (last.q.length < 2) return;
    const mine = ++ticket, sources = last.source === 'all' ? ['archive', 'gutenberg'] : [last.source];
    const data = last.data = { results: [], unreachable: [] };
    let pending = [...sources];
    status.textContent = 'Searching…'; clear(list);
    await Promise.all(sources.map(async (src) => {
      try {
        const part = await api(`/discover?q=${encodeURIComponent(last.q)}&source=${src}&lang=${last.lang}`, { quiet: true });
        if (mine !== ticket) return;
        data.unreachable.push(...part.unreachable);
        // Gutenberg's hand-made editions read better than OCR, so they go first.
        if (src === 'gutenberg') data.results.unshift(...part.results); else data.results.push(...part.results);
      } catch { if (mine === ticket) data.unreachable.push(src); }
      if (mine !== ticket) return;
      pending = pending.filter((x) => x !== src); paint(data, pending);
    }));
  };
  mount(root, h('div', { class: 'stack' },
    h('a', { href: '#/library', class: 'btn ghost sm', style: { 'align-self': 'flex-start' } }, '← Library'), h('h1', null, 'Find books online'),
    h('form', { class: 'toolbar', role: 'search', onSubmit: (e) => { e.preventDefault(); run(); } }, input, lang,
      segmented([['all', 'All'], ['gutenberg', 'Gutenberg'], ['archive', 'Archive.org']], last.source, (v) => { last.source = v; }, 'Source'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Search')),
    status, list));
  if (last.data) paint(last.data);
}
