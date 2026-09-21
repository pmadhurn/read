// Book detail (LB-3, LB-5, IM-4, IM-7, IM-9).
import { api } from '../api.js';
import { h, clear, cover, avatar, num, duration, dateStr, bytes, modal, confirmBox, toast, segmented } from '../ui.js';
import { state, go, ensureAdmin } from '../app.js';

const STAGES = { downloading: 'Downloading from the source', queued: 'Waiting to start', parsing: 'Reading the file', ocr: 'Running OCR (this is slow)', chapters: 'Splitting into chapters', done: 'Done' };

function editDialog(book) {
  return modal((close) => {
    const title = h('input', { type: 'text', value: book.title, required: true, autofocus: true });
    const author = h('input', { type: 'text', value: book.author });
    const tags = h('input', { type: 'text', value: book.tags.join(', '), placeholder: 'fiction, hindi, school' });
    const file = h('input', { type: 'file', accept: 'image/*' });
    return h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      try {
        await api(`/books/${book.id}`, { method: 'PATCH', body: { title: title.value, author: author.value, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean) } });
        if (file.files[0]) await api(`/books/${book.id}/cover`, { method: 'POST', raw: file.files[0] });
        close(true);
      } catch { /* toast shown */ }
    } }, h('h2', null, 'Edit details'),
      h('label', { class: 'field' }, h('span', null, 'Title'), title), h('label', { class: 'field' }, h('span', null, 'Author'), author),
      h('label', { class: 'field' }, h('span', null, 'Tags (comma separated)'), tags), h('label', { class: 'field' }, h('span', null, 'Replace cover'), file),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
  });
}

function collectionsDialog(book, collections) {
  return modal((close) => h('div', { class: 'stack' }, h('h2', null, 'Shared collections'),
    collections.length ? collections.map((c) => h('label', { class: 'switch' }, c.name,
      h('input', { type: 'checkbox', checked: c.book_ids.includes(book.id), onChange: (e) => api(`/collections/${c.id}/books`, { method: 'POST', body: { book_id: book.id, add: e.target.checked } }) })))
      : h('p', { class: 'muted' }, 'No collections yet. Create one from the library page.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onClick: () => close() }, 'Done'))));
}

export async function render(root, { params }) {
  const id = params[0];
  let timer = null;
  const reload = () => { if (root.isConnected) render(clear(root), { params }); };
  let book;
  try { book = await api(`/books/${id}`, { quiet: true }); } catch { root.append(h('p', { class: 'empty' }, 'This book is no longer in the library. ', h('a', { href: '#/library' }, 'Back to the library'))); return; }
  const mine = book.uploaded_by === state.me.id;
  const back = h('a', { href: '#/library', class: 'btn ghost sm' }, '← Library');

  if (book.status !== 'ready') {
    const body = h('div', { class: 'card stack', style: { 'max-width': '560px' } }, h('h1', null, book.title || 'New book'));
    if (book.status === 'processing') {
      body.append(h('p', { role: 'status' }, STAGES[book.stage] || 'Working', '…'),
        h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': book.progress, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: `${Math.max(4, book.progress)}%` } })),
        h('p', { class: 'muted small' }, 'You can leave this page. The book appears in the library when it is ready.'));
      timer = setTimeout(reload, 1500);
    } else if (book.status === 'duplicate') {
      body.append(h('div', { class: 'notice warn' }, `“${book.duplicate?.title}” by ${book.duplicate?.author || 'unknown'} is already in the library.`),
        h('div', { class: 'row' },
          h('a', { class: 'btn', href: `#/book/${book.duplicate?.id}` }, 'Open the existing one'),
          h('button', { class: 'btn', onClick: async () => { await api(`/books/${id}/duplicate`, { method: 'POST', body: { action: 'keep' } }); reload(); } }, 'Keep both'),
          h('button', { class: 'btn danger', onClick: async () => { await api(`/books/${id}/duplicate`, { method: 'POST', body: { action: 'discard' } }); go('#/library'); } }, 'Discard this upload')));
    } else {
      body.append(h('div', { class: 'notice bad', role: 'alert' }, book.error_msg || 'This file could not be processed.'),
        h('div', { class: 'row' },
          book.error_code === 'scanned' && h('button', { class: 'btn primary', onClick: async () => { await api(`/books/${id}/ocr`, { method: 'POST' }); reload(); } }, 'Run OCR'),
          (mine || state.admin) && h('button', { class: 'btn danger', onClick: async () => { await api(`/books/${id}`, { method: 'DELETE' }); go('#/library'); } }, 'Remove')));
    }
    root.append(h('div', { class: 'stack' }, back, body));
    return () => clearTimeout(timer);
  }

  const lib = await api('/books');
  const wpm = state.me.settings.wpm || 300;
  const remaining = book.word_count * (1 - book.fraction);
  const started = book.my_status !== 'to_read' || book.fraction > 0;
  const fav = h('button', { class: 'btn', 'aria-pressed': String(book.favourite), onClick: async () => {
    const r = await api(`/books/${id}/favourite`, { method: 'POST' }); fav.setAttribute('aria-pressed', String(r.favourite)); fav.textContent = r.favourite ? '★ Favourite' : '☆ Favourite';
  } }, book.favourite ? '★ Favourite' : '☆ Favourite');

  const toc = h('ol', { class: 'toc' }, book.chapters.map((c) => h('li', { class: c.ord === book.chapter_ord && started ? 'current' : '' },
    h('button', { onClick: () => go(`#/read/${id}?c=${c.ord}&w=0`) }, h('span', null, c.title), h('span', { class: 'muted small' }, `${duration(c.word_count / wpm * 60)}`)))));

  root.append(h('div', { class: 'stack' }, back,
    h('div', { class: 'detail' },
      h('div', { class: 'stack' }, cover(book, 'full')),
      h('div', { class: 'stack' },
        h('div', null, h('h1', null, book.title), h('p', { class: 'muted', style: { 'font-size': '18px' } }, book.author || 'Unknown author')),
        book.warnings.map((w) => h('div', { class: 'notice warn' }, w.message)),
        h('div', { class: 'row' },
          h('a', { class: 'btn primary', href: `#/read/${id}` }, started && book.my_status !== 'finished' ? `▶ Continue (${Math.round(book.fraction * 100)}%)` : '▶ Read'),
          h('a', { class: 'btn', href: `#/read/${id}?mode=scroll` }, 'Normal reading'), fav,
          h('button', { class: 'btn', onClick: async () => { await collectionsDialog(book, lib.collections); } }, 'Collections')),
        h('div', { class: 'field' }, h('span', null, 'My status'),
          segmented([['to_read', 'To read'], ['reading', 'Reading'], ['finished', 'Finished']], book.my_status, (v) => api(`/books/${id}/status`, { method: 'PUT', body: { status: v } }).then(() => toast('Status saved')), 'My status')),
        h('div', { class: 'grid cols-4' },
          h('div', { class: 'stat' }, h('b', null, num(book.word_count)), h('span', null, 'Words')),
          h('div', { class: 'stat' }, h('b', null, duration(book.word_count / wpm * 60)), h('span', null, `At your ${wpm} WPM`)),
          h('div', { class: 'stat' }, h('b', null, duration(remaining / wpm * 60)), h('span', null, 'Left for you')),
          h('div', { class: 'stat' }, h('b', null, book.chapters.length), h('span', null, 'Chapters'))),
        h('p', { class: 'muted small' }, `${book.format.toUpperCase()} · ${bytes(book.file_size)} · added by ${book.uploader || 'a removed profile'} on ${dateStr(book.uploaded_at)}`,
          book.source_url ? [' · ', h('a', { href: book.source_url, rel: 'noopener noreferrer', target: '_blank' }, 'source')] : null),
        book.tags.length ? h('div', { class: 'row' }, book.tags.map((t) => h('span', { class: 'pill' }, t))) : null,
        h('div', null, h('h3', { style: { 'margin-bottom': '8px' } }, 'Who’s reading'),
          book.readers.length ? h('div', { class: 'row' }, book.readers.map((r) => h('span', { class: 'chip' }, avatar(r), ` ${r.name} · ${r.status === 'finished' ? 'finished' : 'reading'}`)))
            : h('p', { class: 'muted small' }, 'Nobody yet. Be the first.')),
        h('div', { class: 'row' },
          (mine || state.admin) && h('button', { class: 'btn sm', onClick: async () => { if (await editDialog(book)) reload(); } }, 'Edit details'),
          !mine && !state.admin && h('button', { class: 'btn sm', onClick: async () => { if (await ensureAdmin() && await editDialog(book)) reload(); } }, 'Edit (admin)'),
          h('a', { class: 'btn sm', href: `/api/books/${id}/file`, download: '' }, 'Download original'),
          h('button', { class: 'btn sm', onClick: async () => { if (await ensureAdmin()) { await api(`/admin/books/${id}/reprocess`, { method: 'POST' }); reload(); } } }, 'Re-process (admin)'),
          h('button', { class: 'btn sm danger', onClick: async () => {
            if (!await ensureAdmin()) return;
            if (await confirmBox('Delete this book?', 'It is removed for everyone. Reading history stays in stats as “deleted book”.', { danger: true, ok: 'Delete' })) {
              await api(`/books/${id}`, { method: 'DELETE' }); toast('Book deleted'); go('#/library');
            }
          } }, 'Delete (admin)')))),
    book.bookmarks.length ? h('section', { class: 'card' }, h('h2', null, 'My bookmarks'), h('ol', { class: 'toc' }, book.bookmarks.map((m) => h('li', null,
      h('button', { onClick: () => go(`#/read/${id}?c=${m.chapter_ord}&w=${m.word_index}`) }, h('span', null, `“${m.snippet}…”`, m.note ? h('span', { class: 'muted small' }, ` ${m.note}`) : null),
        h('span', { class: 'muted small' }, book.chapters[m.chapter_ord]?.title || '')))))) : null,
    h('section', { class: 'card' }, h('h2', null, 'Contents'), toc)));
  return () => clearTimeout(timer);
}
