// RSVP reader (RD-*, SP-*, NV-*), plus the normal scrolling mode (NV-7).
import { api, queueBeat, onBeatResult, session } from '../api.js';
import { h, clear, duration, toast, promptBox } from '../ui.js';
import { state, go, setMe, celebrate, applyTheme } from '../app.js';
import { readerControls, FONTS } from './settings.js';

const segmenter = 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
// Grapheme clusters, so Devanagari/Gujarati conjuncts and vowel signs are never split (RD-6).
export const graphemes = (s) => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s));
const WORDY = /[\p{L}\p{N}]/u;
const SENTENCE_END = /[.!?।॥…]["'”’)\]»]*$/;
const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;

// ORP by word length: 1 → 1st letter, 2–5 → 2nd, 6–9 → 3rd, 10–13 → 4th, 14+ → 5th (RD-2).
export function orpIndex(length) {
  return length <= 1 ? 0 : length <= 5 ? 1 : length <= 9 ? 2 : length <= 13 ? 3 : 4;
}

export function splitAtOrp(word) {
  const g = graphemes(word);
  let lead = 0;
  while (lead < g.length - 1 && !WORDY.test(g[lead])) lead++;
  let trail = 0;
  while (trail < g.length - lead - 1 && !WORDY.test(g[g.length - 1 - trail])) trail++;
  const p = lead + orpIndex(g.length - lead - trail);
  return [g.slice(0, p).join(''), g[p] || '', g.slice(p + 1).join(''), g.length - lead - trail];
}

export function tokenize(text) {
  const words = [], para = [];
  text.split('\n').forEach((p, pi) => { for (const w of p.split(' ')) if (w) { words.push(w); para.push(pi); } });
  return { words, para };
}

export async function render(root, { params, query }) {
  const bookId = Number(params[0]);
  let book;
  try { book = await api(`/books/${bookId}`); } catch { go('#/library'); return; }
  if (book.status !== 'ready') { go(`#/book/${bookId}`); return; }

  const s = { ...state.me.settings };
  const sessionId = (crypto.randomUUID?.() || String(Math.random()).slice(2)) + Date.now().toString(36);
  const debug = query.get('debug') === '1';
  const posKey = `read.pos.${session.profileId}.${bookId}`;
  const chapters = new Map();
  let mode = query.get('mode') === 'scroll' ? 'scroll' : 'rsvp';
  let ch = null, idx = 0, shown = 1, playing = false, timer = null, due = 0, playStart = 0, lastTick = 0;
  let lastFlush = 0, ranges = [], activeMs = 0, pendingEvents = [], wakeLock = null, panel = null, dead = false;
  const timing = []; window.__readerTiming = timing;

  async function loadChapter(ord) {
    if (!chapters.has(ord)) {
      const data = await api(`/books/${bookId}/chapters/${ord}`);
      chapters.set(ord, { ...data, ...tokenize(data.text) });
    }
    return chapters.get(ord);
  }

  // ---------------------------------------------------------------- elements
  const pre = h('span', { class: 'pre' }), pivot = h('span', { class: 'pivot' }), post = h('span', { class: 'post' });
  const word = h('div', { class: 'word', 'aria-hidden': 'true' }, pre, pivot, post);
  const wpmTag = h('div', { class: 'wpm-tag', 'aria-live': 'off' });
  const rsvp = h('div', { class: 'rsvp' }, h('i', { class: 'rule top' }), h('i', { class: 'rule bot' }), h('i', { class: 'guide top' }), h('i', { class: 'guide bot' }), word);
  const context = h('div', { class: 'context', hidden: true });
  const scrollView = h('div', { class: 'scrollmode', hidden: true, tabindex: '0' });
  const debugBox = debug ? h('div', { class: 'debug' }) : null;
  const stage = h('div', { class: 'stage', tabindex: '0', 'aria-label': 'Reader. Space plays or pauses.' }, rsvp, wpmTag, context, scrollView, debugBox);
  const titleEl = h('b'), chapterEl = h('span');
  const barFill = h('i'), leftChapter = h('span'), leftBook = h('span');
  const playBtn = h('button', { class: 'btn primary play', onClick: () => toggle(), 'aria-label': 'Play' }, '▶');
  const speedOut = h('output', { 'aria-live': 'polite' });
  const slider = h('input', { type: 'range', min: 100, max: 1000, step: 25, 'aria-label': 'Reading speed in words per minute', onInput: () => setWpm(Number(slider.value)) });
  const presets = h('div', { class: 'row', style: { 'justify-content': 'center', gap: '6px' } });
  const modeBtn = h('button', { class: 'btn sm', onClick: () => setMode(mode === 'rsvp' ? 'scroll' : 'rsvp') });
  const ctl = (label, text, fn) => h('button', { class: 'btn', 'aria-label': label, title: label, onClick: fn }, text);
  const controls = h('div', { class: 'controls' },
    ctl('Previous chapter', '⏮', () => jumpChapter(-1)), ctl('Previous sentence', '⏪', () => sentence(-1)), ctl('Previous word', '◀', () => step(-1)),
    playBtn, ctl('Next word', '▶︎', () => step(1)), ctl('Next sentence', '⏩', () => sentence(1)), ctl('Next chapter', '⏭', () => jumpChapter(1)));
  const speedRow = h('div', { class: 'speed' }, ctl('Slower by 25', '−', () => setWpm(s.wpm - 25)), slider, ctl('Faster by 25', '+', () => setWpm(s.wpm + 25)), speedOut);
  const el = h('div', { class: 'reader' },
    h('div', { class: 'reader-top' },
      h('button', { class: 'btn icon', 'aria-label': 'Close reader', onClick: () => exit() }, '✕'),
      h('div', { class: 'reader-title' }, titleEl, chapterEl),
      modeBtn,
      h('button', { class: 'btn icon', 'aria-label': 'Add bookmark', title: 'Bookmark', onClick: () => addBookmark() }, '🔖'),
      h('button', { class: 'btn icon', 'aria-label': 'Contents and bookmarks', title: 'Contents', onClick: () => openPanel('toc') }, '☰'),
      h('button', { class: 'btn icon', 'aria-label': 'Reader settings', title: 'Settings', onClick: () => openPanel('settings') }, 'Aa')),
    stage,
    h('div', { class: 'reader-bottom' },
      h('div', { class: 'scrubber' }, leftChapter, h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Chapter progress', 'aria-valuemin': 0, 'aria-valuemax': 100 }, barFill), leftBook),
      controls, speedRow, presets));
  root.append(el);
  titleEl.textContent = book.title;

  // ---------------------------------------------------------------- appearance
  function applyLook() {
    el.style.setProperty('--reader-size', `${s.size}px`);
    el.style.setProperty('--reader-font', FONTS[s.font]?.css || FONTS.serif.css);
    el.style.setProperty('--orp', s.orp_color);
    rsvp.classList.toggle('no-guides', !s.guides);
    wpmTag.hidden = !s.show_wpm || mode !== 'rsvp';
    slider.value = s.wpm; speedOut.textContent = `${s.wpm} WPM`; wpmTag.textContent = `${s.wpm} wpm`;
    clear(presets).append(...(s.presets || []).map((p) => h('button', { class: 'btn sm', 'aria-pressed': String(p === s.wpm), onClick: () => setWpm(p) }, String(p))));
    modeBtn.replaceChildren(mode === 'rsvp' ? '📄' : '⚡', h('span', { class: 'mode-label' }, mode === 'rsvp' ? ' Normal' : ' RSVP'));
    modeBtn.setAttribute('aria-label', mode === 'rsvp' ? 'Switch to normal reading' : 'Switch to RSVP');
    controls.hidden = speedRow.hidden = presets.hidden = mode !== 'rsvp';
    applyTheme(s);
  }
  let saveTimer = null;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api('/me', { method: 'PATCH', body: { settings: s }, quiet: true }).then(setMe).catch(() => {}), 600);
  }
  function setWpm(v) {
    s.wpm = Math.max(100, Math.min(1000, Math.round(v / 25) * 25));
    applyLook(); saveSettings(); paintProgress();
  }

  // ---------------------------------------------------------------- display
  function chunkAt(i) {
    // Up to `chunk` words per flash, never running past the end of a sentence.
    const n = Math.max(1, Math.min(3, s.chunk || 1));
    let count = 1;
    while (count < n && i + count < ch.words.length && !SENTENCE_END.test(ch.words[i + count - 1]) && ch.para[i + count] === ch.para[i]) count++;
    return count;
  }

  function show() {
    if (!ch || idx >= ch.words.length) return;
    shown = chunkAt(idx);
    const group = ch.words.slice(idx, idx + shown);
    const mid = Math.floor((shown - 1) / 2);
    const [a, p, b] = splitAtOrp(group[mid]);
    pre.textContent = [...group.slice(0, mid), a].join(' ');
    pivot.textContent = p;
    post.textContent = [b, ...group.slice(mid + 1)].join(' ');
    // Shrink a word that would not fit the screen instead of clipping it.
    const len = graphemes(group.join(' ')).length;
    const fit = stage.clientWidth * 0.58 / (len * 0.56);
    word.style.fontSize = fit < s.size ? `${Math.max(14, fit)}px` : '';
  }

  function wordDelay(i, count) {
    const elapsed = performance.now() - playStart;
    const speed = s.ramp && elapsed < 2000 ? s.wpm * (0.6 + 0.4 * elapsed / 2000) : s.wpm;   // SP-5
    const base = 60000 / speed;
    let total = 0;
    for (let k = i; k < i + count; k++) {
      const w = ch.words[k];
      const len = splitAtOrp(w)[3];
      let f = 1;
      if (len > 12) f = 1.5; else if (len > 8) f = 1.3;                                       // SP-4
      if (/\d/.test(w)) f = Math.max(f, 1.5);
      total += base * f;
    }
    const last = ch.words[i + count - 1];
    const lastInPara = i + count >= ch.words.length || ch.para[i + count] !== ch.para[i + count - 1];
    const mult = lastInPara ? s.pause_paragraph : SENTENCE_END.test(last) ? s.pause_sentence : CLAUSE_END.test(last) ? s.pause_comma : 1;
    return total + base * (mult - 1) * s.pause_strength;                                      // SP-3
  }

  function paintProgress() {
    if (!ch) return;
    const frac = ch.words.length ? idx / ch.words.length : 0;
    barFill.style.width = `${frac * 100}%`;
    barFill.parentElement.setAttribute('aria-valuenow', Math.round(frac * 100));
    const leftInChapter = ch.words.length - idx;
    const after = book.chapters.filter((c) => c.ord > ch.ord).reduce((n, c) => n + c.word_count, 0);
    leftChapter.textContent = `Chapter ${duration(leftInChapter / s.wpm * 60)}`;
    leftBook.textContent = `Book ${duration((leftInChapter + after) / s.wpm * 60)}`;
    chapterEl.textContent = `${ch.title} · ${ch.ord + 1}/${book.chapters.length}`;
  }

  // ---------------------------------------------------------------- precise scheduling (SP-6)
  // Absolute deadlines: each word is due at the previous deadline plus its own
  // duration, so timer lateness never accumulates. setTimeout gets us close, then
  // a MessageChannel spin lands within a millisecond or two of the deadline.
  const channel = new MessageChannel();
  channel.port1.onmessage = () => spin();
  function spin() {
    if (!playing) return;
    if (performance.now() >= due) advance(); else channel.port2.postMessage(0);
  }
  function schedule() {
    timer = setTimeout(spin, Math.max(0, due - performance.now() - 8));
  }
  function present() {
    const now = performance.now();
    show();
    // Only words really displayed while playing are reported (section 7).
    const lastRange = ranges[ranges.length - 1];
    if (lastRange && lastRange[1] === idx) lastRange[1] = idx + shown; else ranges.push([idx, idx + shown]);
    const delay = wordDelay(idx, shown);
    due = (due && now - due < 100 ? due : now) + delay;
    activeMs += now - lastTick; lastTick = now;
    schedule();
    // Housekeeping runs right after a word appears, where the whole word interval
    // is free, never just before a deadline.
    if (now - lastFlush > 5000) { lastFlush = now; setTimeout(() => { if (playing) flush(); }, 0); }
    else if (idx % 8 === 0) paintProgress();
  }
  async function advance() {
    const late = performance.now() - due;
    timing.push(late); if (timing.length > 2000) timing.shift();
    if (debugBox && timing.length % 10 === 0) {
      const sorted = [...timing].sort((x, y) => x - y);
      debugBox.textContent = `n=${timing.length}  mean=${(timing.reduce((x, y) => x + y, 0) / timing.length).toFixed(2)}ms  p95=${sorted[Math.floor(sorted.length * 0.95)].toFixed(2)}ms  max=${sorted[sorted.length - 1].toFixed(2)}ms`;
    }
    idx += shown;
    if (idx >= ch.words.length) return chapterEnd();
    present();
  }

  async function chapterEnd() {
    const last = ch.ord >= book.chapters.length - 1;
    activeMs += performance.now() - lastTick; lastTick = performance.now();
    if (last) {
      idx = ch.words.length - 1;
      pause({ chapter_end: true, book_end: true });
      return;
    }
    flush({ chapter_end: true, position: { chapter_ord: ch.ord + 1, word_index: 0 } });
    const wasPlaying = playing;
    ch = await loadChapter(ch.ord + 1); idx = 0; due = 0;
    paintProgress(); prefetch();
    if (wasPlaying && playing) present(); else show();
  }

  // ---------------------------------------------------------------- play / pause
  function play() {
    if (playing || mode !== 'rsvp' || !ch) return;
    if (idx >= ch.words.length - 1 && ch.ord >= book.chapters.length - 1) idx = 0;
    closePanel();
    playing = true; playStart = lastTick = lastFlush = performance.now(); due = 0;
    context.hidden = true; rsvp.hidden = false;
    playBtn.textContent = '⏸'; playBtn.setAttribute('aria-label', 'Pause');
    if (s.focus) el.classList.add('focus');                                                  // NV-10
    navigator.wakeLock?.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
    stage.focus({ preventScroll: true });
    present();
  }
  function pause(extra = {}) {
    if (playing) { activeMs += performance.now() - lastTick; }
    playing = false; clearTimeout(timer);
    playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', 'Play');
    el.classList.remove('focus');
    wakeLock?.release().catch(() => {}); wakeLock = null;
    flush(extra);
    paintProgress(); showContext();
    if (pendingEvents.length) { const events = pendingEvents; pendingEvents = []; celebrate(events); }
  }
  const toggle = () => (playing ? pause() : play());

  // ---------------------------------------------------------------- heartbeats (NV-6, NF-4)
  function flush(extra = {}) {
    if (!ch) return;
    const position = extra.position || { chapter_ord: ch.ord, word_index: Math.min(idx, Math.max(0, ch.words.length - 1)) };
    localStorage.setItem(posKey, JSON.stringify({ ...position, at: Date.now() }));
    const beat = { session_id: sessionId, book_id: bookId, chapter_ord: ch.ord, ranges, active_ms: Math.round(activeMs), ...extra, position };
    ranges = []; activeMs = 0;
    queueBeat(beat);
  }
  const stopListening = onBeatResult((data, beat) => {
    if (beat.session_id !== sessionId) return;
    setMe(data.me);
    if (data.events.length) { if (playing) pendingEvents.push(...data.events); else celebrate(data.events); }
  });

  // ---------------------------------------------------------------- navigation
  function moveTo(i) {
    const wasPlaying = playing;
    if (playing) { playing = false; clearTimeout(timer); activeMs += performance.now() - lastTick; }
    idx = Math.max(0, Math.min(ch.words.length - 1, i)); due = 0;
    if (wasPlaying) { playing = true; lastTick = performance.now(); present(); } else { show(); paintProgress(); showContext(); flushSoon(); }
  }
  let soon = null;
  const flushSoon = () => { clearTimeout(soon); soon = setTimeout(() => flush(), 800); };
  const step = (d) => moveTo(idx + d * (d > 0 ? shown : 1));
  const isSentenceStart = (i) => i === 0 || SENTENCE_END.test(ch.words[i - 1]) || ch.para[i] !== ch.para[i - 1];
  function sentence(d) {
    let i = idx;
    if (d < 0) { i--; while (i > 0 && !isSentenceStart(i)) i--; } else { i++; while (i < ch.words.length - 1 && !isSentenceStart(i)) i++; }
    moveTo(i);
  }
  async function jumpTo(ord, w = 0) {
    if (ord < 0 || ord >= book.chapters.length) return;
    const wasPlaying = playing;
    if (playing) pause(); else flush();
    ch = await loadChapter(ord); idx = Math.max(0, Math.min(ch.words.length - 1, w)); due = 0;
    show(); paintProgress(); flush(); prefetch();
    if (mode === 'scroll') renderScroll(); else if (wasPlaying) play(); else showContext();
  }
  const jumpChapter = (d) => jumpTo(ch.ord + d, 0);

  // ---------------------------------------------------------------- paused context (NV-4, NV-9)
  function showContext() {
    if (mode !== 'rsvp' || playing || !ch) return;
    const p = ch.para[idx];
    const first = Math.max(0, p - 2), lastPara = p + 2;
    let i = ch.para.indexOf(first);
    const marks = new Set(book.bookmarks.filter((m) => m.chapter_ord === ch.ord).map((m) => m.word_index));
    clear(context);
    let paraEl = null, current = -1, target = null;
    for (; i < ch.words.length && ch.para[i] <= lastPara; i++) {
      if (ch.para[i] !== current) { current = ch.para[i]; paraEl = h('p'); context.append(paraEl); }
      const span = h('span', { class: `w ${i === idx ? 'cur' : ''} ${marks.has(i) ? 'bm' : ''}`, 'data-i': i }, ch.words[i]);
      if (i === idx) target = span;
      paraEl.append(span, ' ');
    }
    context.append(h('p', { class: 'muted small', style: { 'text-align': 'center', 'font-family': 'var(--font-ui)' } },
      h('button', { class: 'btn sm', onClick: (e) => { e.stopPropagation(); define(); } }, '📖 Define this word'), '  Tap any word to jump there.'));
    rsvp.hidden = true; context.hidden = false;
    target?.scrollIntoView({ block: 'center' });
  }
  async function define() {
    const clean = ch.words[idx].replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    try {
      const d = await api(`/dictionary/${encodeURIComponent(clean)}`, { quiet: true });
      const { modal } = await import('../ui.js');
      modal((close) => [h('h2', null, d.word), ...d.meanings.map((m) => h('div', null, h('i', { class: 'muted' }, m.part), h('ol', { style: { margin: '4px 0 0', 'padding-left': '20px' } }, m.definitions.map((x) => h('li', null, x))))),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', autofocus: true, onClick: () => close() }, 'Close'))]);
    } catch (e) { toast(e.status === 404 ? `No definition found for “${clean}”.` : e.message); }
  }
  async function addBookmark() {
    if (playing) pause();
    const note = await promptBox('Add bookmark', { label: 'Note (optional)', ok: 'Save bookmark' });
    if (note === undefined) return;
    const snippet = ch.words.slice(idx, idx + 8).join(' ');
    const mark = await api('/bookmarks', { method: 'POST', body: { book_id: bookId, chapter_ord: ch.ord, word_index: idx, snippet, note } });
    book.bookmarks.push(mark); toast('Bookmark saved'); showContext();
  }

  // ---------------------------------------------------------------- side panel (NV-5, NV-8, AP-7)
  function closePanel() { panel?.remove(); panel = null; }
  function openPanel(kind) {
    if (playing) pause();
    closePanel();
    const body = h('div', { class: 'body' });
    panel = h('aside', { class: 'panel', 'aria-label': kind === 'toc' ? 'Contents' : 'Reader settings' },
      h('header', null, h('h2', { class: 'grow' }, kind === 'toc' ? 'Contents' : 'Reader settings'), h('button', { class: 'btn icon', 'aria-label': 'Close panel', onClick: closePanel }, '✕')), body);
    if (kind === 'toc') {
      body.append(h('ol', { class: 'toc' }, book.chapters.map((c) => h('li', { class: c.ord === ch.ord ? 'current' : '' },
        h('button', { onClick: () => { closePanel(); jumpTo(c.ord, 0); } }, h('span', null, c.title), h('span', { class: 'muted small' }, duration(c.word_count / s.wpm * 60)))))));
      if (book.bookmarks.length) {
        body.append(h('h3', { style: { margin: '20px 0 6px' } }, 'Bookmarks'), h('ol', { class: 'toc' }, book.bookmarks.map((m) => h('li', null, h('div', { class: 'row nowrap' },
          h('button', { class: 'grow', onClick: () => { closePanel(); jumpTo(m.chapter_ord, m.word_index); } }, h('span', null, `“${m.snippet}…”`, m.note ? h('div', { class: 'muted small' }, m.note) : null)),
          h('button', { class: 'btn sm icon', style: { width: 'auto' }, 'aria-label': 'Delete bookmark', onClick: async () => { await api(`/bookmarks/${m.id}`, { method: 'DELETE' }); book.bookmarks = book.bookmarks.filter((x) => x.id !== m.id); openPanel('toc'); } }, '🗑'))))));
      }
    } else {
      body.append(readerControls(s, () => { applyLook(); show(); saveSettings(); }));
    }
    stage.append(panel);
    panel.querySelector('button')?.focus();
  }

  // ---------------------------------------------------------------- normal reading mode (NV-7)
  let scrollSave = null;
  function renderScroll() {
    clear(scrollView).append(h('h2', null, ch.title));
    let paraEl = null, current = -1;
    ch.words.forEach((w, i) => {
      if (ch.para[i] !== current) { current = ch.para[i]; paraEl = h('p', { 'data-i': i }); scrollView.append(paraEl); }
      paraEl.append(w, ' ');
    });
    scrollView.append(h('div', { class: 'row', style: { 'justify-content': 'center', margin: '24px 0', 'font-family': 'var(--font-ui)' } },
      ch.ord > 0 && h('button', { class: 'btn', onClick: () => jumpTo(ch.ord - 1, 0) }, '← Previous chapter'),
      ch.ord < book.chapters.length - 1 ? h('button', { class: 'btn primary', onClick: () => jumpTo(ch.ord + 1, 0) }, 'Next chapter →')
        : h('button', { class: 'btn primary', onClick: async () => { await api(`/books/${bookId}/status`, { method: 'PUT', body: { status: 'finished' } }); toast('Marked as finished'); exit(); } }, 'Mark as finished')));
    const paras = [...scrollView.querySelectorAll('p[data-i]')];
    const at = paras.filter((p) => Number(p.dataset.i) <= idx).pop();
    requestAnimationFrame(() => { scrollView.scrollTop = at ? at.offsetTop - 80 : 0; });
    scrollView.onscroll = () => {
      clearTimeout(scrollSave);
      scrollSave = setTimeout(() => {
        const top = scrollView.scrollTop + 100;
        const seen = paras.filter((p) => p.offsetTop <= top).pop();
        if (seen) idx = Number(seen.dataset.i);
        paintProgress();
        localStorage.setItem(posKey, JSON.stringify({ chapter_ord: ch.ord, word_index: idx, at: Date.now() }));
        api('/reading/position', { method: 'PUT', body: { book_id: bookId, chapter_ord: ch.ord, word_index: idx }, quiet: true }).catch(() => {});
      }, 700);
    };
  }
  function setMode(next) {
    if (playing) pause();
    mode = next;
    scrollView.hidden = mode !== 'scroll';
    rsvp.hidden = mode === 'scroll'; context.hidden = true;
    applyLook();
    if (mode === 'scroll') { renderScroll(); scrollView.focus(); } else { show(); showContext(); }
  }

  // ---------------------------------------------------------------- input (NV-2, NV-3)
  function onKey(e) {
    if (document.querySelector('.backdrop') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); if (panel) closePanel(); else if (playing) pause(); else exit(); return; }
    if (k === 'f' || k === 'F') { e.preventDefault(); document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.().catch(() => {}); return; }
    if (mode !== 'rsvp') return;
    if (k === ' ') { if (e.target.tagName === 'BUTTON' && e.target !== playBtn) return; e.preventDefault(); toggle(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? sentence(-1) : step(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); e.shiftKey ? sentence(1) : step(1); }
    else if (k === 'ArrowUp') { e.preventDefault(); setWpm(s.wpm + 25); }
    else if (k === 'ArrowDown') { e.preventDefault(); setWpm(s.wpm - 25); }
  }
  document.addEventListener('keydown', onKey);

  let down = null;
  stage.addEventListener('pointerdown', (e) => { if (mode === 'rsvp' && !e.target.closest('.panel, button')) down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  stage.addEventListener('pointerup', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y; const start = down; down = null;
    if (playing || context.hidden) {
      if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) { setWpm(s.wpm + (dy < 0 ? 25 : -25)); return; }   // swipe up faster, down slower
    } else if (Math.abs(dy) > 10 || Math.abs(dx) > 10) return;                                                  // scrolling the context view
    if (performance.now() - start.t > 600) return;
    const wordEl = e.target.closest('.w');
    if (wordEl) { moveTo(Number(wordEl.dataset.i)); return; }
    const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    if (x < 0.22) step(-1); else if (x > 0.78) step(1); else toggle();
  });
  const onHide = () => { if (document.hidden && playing) pause(); };                                             // hidden tabs never count
  document.addEventListener('visibilitychange', onHide);
  const onLeave = () => { if (playing) { activeMs += performance.now() - lastTick; lastTick = performance.now(); } flush(); };
  window.addEventListener('pagehide', onLeave);

  const exit = () => go(`#/book/${bookId}`);

  // Warm the rest of the book quietly, so the service worker holds it for offline reading (NF-9).
  let prefetching = false;
  async function prefetch() {
    if (prefetching) return; prefetching = true;
    try {
      const order = book.chapters.map((c) => c.ord).sort((a, b) => Math.abs(a - ch.ord - 0.4) - Math.abs(b - ch.ord - 0.4));
      for (const ord of order) {
        if (dead) return;
        if (chapters.has(ord)) continue;
        // While words are flashing only the next chapter is fetched; the rest waits for a pause.
        while (playing && ord !== ch.ord + 1 && !dead) await new Promise((r) => setTimeout(r, 1000));
        await loadChapter(ord).catch(() => {});
        await new Promise((r) => setTimeout(r, 150));
      }
    } finally { prefetching = false; }
  }

  // ---------------------------------------------------------------- start
  let startOrd = book.chapter_ord || 0, startWord = book.word_index || 0;
  try {
    const local = JSON.parse(localStorage.getItem(posKey));
    if (local && (!book.read_at || local.at > new Date(book.read_at).getTime())) { startOrd = local.chapter_ord; startWord = local.word_index; }
  } catch { /* no local position */ }
  if (query.has('c')) { startOrd = Number(query.get('c')); startWord = Number(query.get('w') || 0); }
  startOrd = Math.max(0, Math.min(book.chapters.length - 1, startOrd));
  ch = await loadChapter(startOrd);
  idx = Math.max(0, Math.min(ch.words.length - 1, startWord));
  applyLook(); show(); paintProgress();
  if (mode === 'scroll') setMode('scroll'); else showContext();
  if (!book.read_at) api('/reading/position', { method: 'PUT', body: { book_id: bookId, chapter_ord: ch.ord, word_index: idx }, quiet: true }).catch(() => {});
  stage.focus({ preventScroll: true });
  setTimeout(prefetch, 2500);

  return () => {
    dead = true;
    if (playing) { activeMs += performance.now() - lastTick; playing = false; }
    clearTimeout(timer); clearTimeout(soon); clearTimeout(scrollSave);
    flush(); stopListening();
    document.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', onLeave);
    wakeLock?.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    applyTheme();
  };
}
