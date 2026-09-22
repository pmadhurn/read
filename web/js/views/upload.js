// Add books: chunked file upload with progress, pasted text, web article (IM-1..3, IM-7).
import { api, session } from '../api.js';
import { h, bytes, segmented, toast, mount } from '../ui.js';
import { go } from '../app.js';

const ACCEPT = '.epub,.pdf,.txt,.docx,.html,.htm,.md,.markdown,.mobi,.azw3,.azw';
const MAX = 100 * 1024 * 1024;

function putChunk(uploadId, index, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/uploads/${uploadId}/${index}`);
    xhr.setRequestHeader('X-Profile-Id', String(session.profileId));
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error('Upload failed')));
    xhr.onerror = () => reject(new Error('Connection lost'));
    xhr.send(blob);
  });
}

async function uploadFile(file, row) {
  const bar = row.querySelector('.bar > i'), status = row.querySelector('.status');
  const fail = (msg) => { status.textContent = msg; status.className = 'status small'; status.style.color = 'var(--bad)'; bar.parentElement.hidden = true; };
  if (file.size > MAX) return fail('Too large. Files can be up to 100 MB.');
  let start;
  try { start = await api('/uploads', { method: 'POST', body: { filename: file.name, size: file.size }, quiet: true }); } catch (e) { return fail(e.message); }
  const total = Math.max(1, Math.ceil(file.size / start.chunk_bytes));
  try {
    for (let i = 0; i < total; i++) {
      const offset = i * start.chunk_bytes;
      let attempt = 0;
      for (;;) {
        try {
          await putChunk(start.id, i, file.slice(offset, offset + start.chunk_bytes), (loaded) => {
            const pct = Math.round((offset + loaded) / file.size * 100);
            bar.style.width = `${pct}%`; status.textContent = `Uploading ${pct}%`;
          });
          break;
        } catch (e) { if (++attempt >= 3) throw e; await new Promise((r) => setTimeout(r, 1500 * attempt)); }
      }
    }
    const done = await api(`/uploads/${start.id}/complete`, { method: 'POST', quiet: true });
    status.textContent = 'Uploaded. Processing…';
    for (;;) {
      await new Promise((r) => setTimeout(r, 1200));
      const b = await api(`/books/${done.book_id}`, { quiet: true });
      if (b.status === 'processing') { bar.style.width = `${Math.max(5, b.progress)}%`; status.textContent = `Processing: ${b.stage}…`; continue; }
      bar.parentElement.hidden = true;
      if (b.status === 'ready') { status.replaceChildren('Ready: ', h('a', { href: `#/book/${b.id}` }, b.title)); (b.warnings || []).forEach((w) => row.append(h('div', { class: 'notice warn' }, w.message))); }
      else if (b.status === 'duplicate') status.replaceChildren('Already in the library. ', h('a', { href: `#/book/${b.id}` }, 'Decide what to do'));
      else { fail(b.error_msg); if (b.error_code === 'scanned') row.append(h('a', { class: 'btn sm', href: `#/book/${b.id}` }, 'Open to run OCR')); }
      return;
    }
  } catch (e) { fail(e.message || 'Upload failed'); }
}

export async function render(root) {
  const list = h('div');
  const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'sr', id: 'file', onChange: () => { add(input.files); input.value = ''; } });
  const add = (files) => [...files].forEach((file) => {
    const row = h('div', { class: 'upload-item' }, h('div', { class: 'row', style: { 'justify-content': 'space-between' } }, h('b', null, file.name), h('span', { class: 'muted small' }, bytes(file.size))),
      h('div', { class: 'bar', role: 'progressbar', 'aria-label': `Progress for ${file.name}` }, h('i')), h('div', { class: 'status small muted', role: 'status' }, 'Starting…'));
    list.prepend(row); uploadFile(file, row);
  });
  const drop = h('label', { class: 'drop', for: 'file', tabindex: '0',
    onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
    onDragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, onDragleave: () => drop.classList.remove('over'),
    onDrop: (e) => { e.preventDefault(); drop.classList.remove('over'); add(e.dataTransfer.files); } },
    h('div', { style: { 'font-size': '40px' }, 'aria-hidden': 'true' }, '📥'), h('b', null, 'Choose files or drop them here'),
    h('p', { class: 'muted small' }, 'EPUB, PDF, TXT, DOCX, HTML, Markdown, MOBI, AZW3 · up to 100 MB · DRM-free only'));

  const title = h('input', { type: 'text', placeholder: 'Title' }), author = h('input', { type: 'text', placeholder: 'Author (optional)' }), text = h('textarea', { placeholder: 'Paste the text here' });
  const paste = h('form', { class: 'stack', hidden: true, onSubmit: async (e) => { e.preventDefault(); const r = await api('/books/paste', { method: 'POST', body: { title: title.value, author: author.value, text: text.value } }); toast('Added'); go(`#/book/${r.book_id}`); } },
    h('label', { class: 'field' }, h('span', null, 'Title'), title), h('label', { class: 'field' }, h('span', null, 'Author'), author), h('label', { class: 'field' }, h('span', null, 'Text'), text),
    h('div', null, h('button', { class: 'btn primary' }, 'Add to library')));
  const url = h('input', { type: 'url', placeholder: 'https://…', required: true });
  const urlBtn = h('button', { class: 'btn primary' }, 'Import article');
  const web = h('form', { class: 'stack', hidden: true, onSubmit: async (e) => {
    e.preventDefault(); urlBtn.disabled = true; urlBtn.textContent = 'Fetching…';
    try { const r = await api('/books/url', { method: 'POST', body: { url: url.value } }); toast('Article imported'); go(`#/book/${r.book_id}`); }
    catch { urlBtn.disabled = false; urlBtn.textContent = 'Import article'; }
  } }, h('label', { class: 'field' }, h('span', null, 'Article address'), url), h('div', null, urlBtn));
  const files = h('div', { class: 'stack' }, drop, input, list);

  mount(root, h('div', { class: 'stack', style: { 'max-width': '760px' } },
    h('a', { href: '#/library', class: 'btn ghost sm', style: { 'align-self': 'flex-start' } }, '← Library'), h('h1', null, 'Add a book'),
    segmented([['files', 'Files'], ['paste', 'Paste text'], ['web', 'Web article'], ['find', '🔎 Search online']], 'files', (v) => { if (v === 'find') { go('#/discover'); return; } files.hidden = v !== 'files'; paste.hidden = v !== 'paste'; web.hidden = v !== 'web'; }, 'Source'),
    h('div', { class: 'card' }, files, paste, web)));
}
