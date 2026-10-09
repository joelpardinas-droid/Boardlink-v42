// ============================================================
// public/js/resolution-view.js — a Board Resolution with its
// approved documents attached to words in it (v93)
//
//   • The resolution PDF is drawn with PDF.js (served by BOARDLINK).
//   • The Board Secretary selects words and attaches approved
//     documents there.
//   • Those places are highlighted; clicking one opens the floating
//     list of approved documents, showing the ones attached there.
//   • The floating button opens the same list at any time.
// Positions are fractions of the page (0–1), so they stay in place at
// any zoom or screen size.
// ============================================================

import * as pdfjsLib from '/vendor/pdfjs/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const icon = name => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'icon');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.append(u); return s;
};

let items = [];
try { items = JSON.parse(($('rsvData') || {}).textContent || '[]'); } catch (_) { items = []; }

// Documents attached at the same place form one group.
const groupKey = a => a ? a.page + ':' + JSON.stringify(a.rects) : null;
const groups = new Map();
for (const it of items) {
  const k = groupKey(it.anchor);
  if (!k) continue;
  if (!groups.has(k)) groups.set(k, { key: k, anchor: it.anchor, items: [] });
  groups.get(k).items.push(it);
}

// ── Floating list of approved documents ──────────────────────
const fab = $('rsvFab'), panel = $('rsvPanel'), list = $('rsvList'), preview = $('rsvPreview');
// The floating parts live directly in <body>, so they stay fixed on the
// screen whatever the page around them does (scrolling, animations).
[fab, panel, $('rsvDlg')].forEach(n => n && document.body.append(n));
const back = $('rsvBack'), title = $('rsvPanelTitle'), filter = $('rsvFilter');
let filterKey = null;

function openPanel(key = null, flashKey = null) {
  filterKey = key;
  panel.hidden = false; fab.setAttribute('aria-expanded', 'true');
  showList(flashKey);
}
function closePanel() {
  panel.hidden = true; fab.setAttribute('aria-expanded', 'false');
  preview.replaceChildren(); panel.classList.remove('is-wide');
}
function showList(flashKey) {
  previewToken++;
  preview.hidden = true; preview.replaceChildren(); list.hidden = false; back.hidden = true;
  panel.classList.remove('is-wide');
  title.textContent = 'Approved documents';
  const g = filterKey ? groups.get(filterKey) : null;
  filter.hidden = !g;
  if (g) $('rsvFilterText').textContent = g.anchor.text ? '“' + g.anchor.text + '”' : 'Marked area · page ' + g.anchor.page;
  const shown = g ? g.items : items.slice().sort((a, b) => (a.anchor ? a.anchor.page : 9e9) - (b.anchor ? b.anchor.page : 9e9));
  list.replaceChildren();
  if (!shown.length) { list.append(el('div', 'rsv-empty', 'No approved documents yet.')); return; }
  for (const it of shown) list.append(card(it));
  if (flashKey) {
    const c = list.querySelector(`[data-key="${flashKey}"]`);
    if (c) { c.classList.add('is-flash'); c.scrollIntoView({ block: 'nearest' }); setTimeout(() => c.classList.remove('is-flash'), 1600); }
  }
}
function card(it) {
  const c = el('div', 'rsv-doc' + (it.kind === 'agenda' ? ' is-agenda' : '')); c.dataset.key = it.key;
  const ic = el('div', 'rsv-doc-ic'); ic.append(icon(it.kind === 'agenda' ? 'clipboard' : 'file'));
  const m = el('div', 'rsv-doc-main');
  m.append(el('div', 'rsv-doc-t', it.title));
  const s = el('div', 'rsv-doc-s');
  s.append(el('span', 'rsv-tag' + (it.kind === 'pages' ? ' is-pages' : it.kind === 'agenda' ? ' is-agenda' : ''), it.tag), it.sub || '');
  m.append(s);
  if (it.anchor) {
    const q = el('div', 'rsv-doc-q');
    q.append(it.anchor.text ? el('q', null, it.anchor.text) : el('span', null, 'Marked area'));
    q.append(el('span', 'muted', '· p. ' + it.anchor.page));
    m.append(q);
  }
  const act = el('div', 'rsv-doc-act');
  if (it.open) {
    const v = el('button', 'btn btn-navy btn-sm'); v.type = 'button'; v.append(icon('eye'), ' View');
    v.addEventListener('click', () => it.preview ? showPreview(it) : window.open(it.view, '_blank', 'noopener'));
    act.append(v);
  }
  if (it.anchor) {
    const sh = el('button', 'btn btn-light btn-sm'); sh.type = 'button'; sh.append(icon('target'), ' Show in resolution');
    sh.addEventListener('click', () => { if (window.matchMedia('(max-width: 700px)').matches) closePanel(); showPlace(groupKey(it.anchor)); });
    act.append(sh);
  }
  if (it.open && it.download) { const d = el('a', 'btn btn-light btn-sm'); d.href = it.download; d.append(icon('download'), ' Download'); act.append(d); }
  if (it.unlink) {
    const f = el('form'); f.method = 'POST'; f.action = it.unlink;
    f.addEventListener('submit', e => { if (!confirm('Remove this link? Both documents stay in the archive.')) e.preventDefault(); });
    const b = el('button', 'btn btn-light btn-sm', 'Unlink'); b.type = 'submit'; f.append(b); act.append(f);
  }
  m.append(act);
  c.append(ic, m);
  return c;
}
function showPreview(it) {
  list.hidden = true; filter.hidden = true; back.hidden = false;
  panel.classList.add('is-wide');
  title.textContent = it.title;
  const bar = el('div', 'rsv-preview-bar');
  const full = el('a', 'btn btn-light btn-sm', 'Open page'); full.href = it.view;
  const tab = el('a', 'btn btn-light btn-sm', 'Open in new tab'); tab.href = it.preview; tab.target = '_blank'; tab.rel = 'noopener';
  bar.append(full, tab);
  if (it.download) { const d = el('a', 'btn btn-light btn-sm'); d.href = it.download; d.append(icon('download'), ' Download'); bar.append(d); }
  // Drawn with PDF.js (works on phones too, where a PDF inside a page
  // often cannot be shown).
  const view = el('div', 'rsv-pv'); view.append(el('div', 'rsv-loading', 'Opening…'));
  preview.replaceChildren(bar, view); preview.hidden = false;
  drawPreview(it.preview, view);
}
let previewToken = 0;
async function drawPreview(url, box) {
  const token = ++previewToken;
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ url, withCredentials: true, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/', iccUrl: '/vendor/pdfjs/iccs/', isEvalSupported: false }).promise;
  } catch (_) {
    // Not a PDF (e.g. a scanned JPG): show it as a picture.
    const img = el('img'); img.src = url; img.alt = ''; img.className = 'rsv-pv-img';
    box.replaceChildren(img); return;
  }
  if (token !== previewToken) return;
  box.replaceChildren();
  const width = Math.max(box.clientWidth - 24, 240);
  for (let n = 1; n <= doc.numPages; n++) {
    const pg = await doc.getPage(n);
    if (token !== previewToken) return;
    const vp0 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: width / vp0.width });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width * ratio); c.height = Math.floor(vp.height * ratio);
    c.style.width = Math.floor(vp.width) + 'px'; c.style.height = Math.floor(vp.height) + 'px';
    box.append(c);
    await pg.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
  }
}
if (fab) {
  fab.addEventListener('click', () => panel.hidden ? openPanel() : closePanel());
  $('rsvClose').addEventListener('click', closePanel);
  back.addEventListener('click', () => showList());
  $('rsvShowAll').addEventListener('click', () => { filterKey = null; showList(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden && !document.querySelector('dialog[open]')) closePanel(); });
  if (location.hash === '#attachments' || /[?&]attach(Error)?=/.test(location.search)) openPanel();
}

// ── The resolution itself ────────────────────────────────────
const root = $('rsv');
const canAttach = root && root.dataset.canAttach === '1';
const pages = [];
let zoom = 1, fitScale = 1;
const scale = () => fitScale * zoom;

if (root) loadPdf();

async function loadPdf() {
  const pagesEl = $('rsvPages');
  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      url: root.dataset.file, withCredentials: true,
      cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/', iccUrl: '/vendor/pdfjs/iccs/',
      isEvalSupported: false,
    }).promise;
  } catch (err) {
    const a = el('a', null, 'Open the PDF'); a.href = root.dataset.file; a.target = '_blank';
    const box = el('div', 'rsv-loading'); box.append(a);
    pagesEl.replaceChildren(box);
    return;
  }
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= doc.numPages; n++) {
    const pdfPage = await doc.getPage(n);
    const vp = pdfPage.getViewport({ scale: 1 });
    const p = { n, pdfPage, w: vp.width, h: vp.height, renderedScale: 0, rendering: 0, task: null, text: undefined };
    p.shell = el('div', 'rsv-pg'); p.shell.dataset.page = String(n);
    p.shell.append(el('span', 'rsv-pg-no', 'Page ' + n));
    p.hl = el('div', 'rsv-hl-layer');
    p.shell.append(p.hl);
    pages.push(p); frag.append(p.shell);
  }
  pagesEl.replaceChildren(frag);
  fit(); layout(); drawHighlights();
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) render(pages[Number(e.target.dataset.page) - 1]); }), { rootMargin: '600px 0px' });
  pages.forEach(p => io.observe(p.shell));
  window.addEventListener('resize', () => { const old = fitScale; fit(); if (Math.abs(old - fitScale) > 0.01) { layout(); rerender(); } });
  // A link to one place: ?at=<page> opens there.
  const at = Number(new URLSearchParams(location.search).get('at'));
  if (at && pages[at - 1]) pages[at - 1].shell.scrollIntoView({ block: 'start' });
}

function fit() {
  const avail = Math.max($('rsvPages').clientWidth - 28, 200);
  fitScale = Math.min(avail / Math.max(...pages.map(p => p.w)), 1.6);
}
function layout() {
  const s = scale();
  for (const p of pages) {
    p.shell.style.width = Math.floor(p.w * s) + 'px';
    p.shell.style.height = Math.floor(p.h * s) + 'px';
    p.shell.style.setProperty('--scale-factor', s);
    p.shell.style.setProperty('--total-scale-factor', s);
    p.shell.style.setProperty('--scale-round-x', '1px');
    p.shell.style.setProperty('--scale-round-y', '1px');
  }
  $('rsvZoom').textContent = Math.round(zoom * 100) + '%';
}
function rerender() { pages.forEach(p => { p.renderedScale = 0; const r = p.shell.getBoundingClientRect(); if (r.bottom > -600 && r.top < innerHeight + 600) render(p); }); }
$('rsvIn') && $('rsvIn').addEventListener('click', () => { zoom = Math.min(3, +(zoom + 0.25).toFixed(2)); layout(); rerender(); });
$('rsvOut') && $('rsvOut').addEventListener('click', () => { zoom = Math.max(0.5, +(zoom - 0.25).toFixed(2)); layout(); rerender(); });

async function render(p) {
  const s = scale();
  if (!p || p.renderedScale === s || p.rendering === s) return;
  p.rendering = s;
  if (p.task) { try { p.task.cancel(); } catch (_) { /* ignore */ } }
  const viewport = p.pdfPage.getViewport({ scale: s });
  let ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (viewport.width * viewport.height * ratio * ratio > 12e6) ratio = Math.sqrt(12e6 / (viewport.width * viewport.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
  canvas.setAttribute('aria-hidden', 'true');
  p.task = p.pdfPage.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null });
  try { await p.task.promise; } catch (err) { p.rendering = 0; return; }
  if (p.rendering !== s) return;
  const old = p.shell.querySelector('canvas');
  if (old) old.replaceWith(canvas); else p.shell.prepend(canvas);
  p.renderedScale = s; p.rendering = 0;
  // Selectable words (typed PDFs).
  p.shell.querySelector('.textLayer')?.remove();
  if (p.text === undefined) {
    const tc = await p.pdfPage.getTextContent();
    p.text = tc.items.some(i => String(i.str || '').trim()) ? tc : null;
  }
  if (p.text) {
    const div = el('div', 'textLayer'); p.shell.append(div);
    await new pdfjsLib.TextLayer({ textContentSource: p.text, container: div, viewport }).render();
    div.append(el('div', 'endOfContent'));
    div.addEventListener('mousedown', () => div.classList.add('selecting'));
  }
}
document.addEventListener('mouseup', () => document.querySelectorAll('.textLayer.selecting').forEach(d => d.classList.remove('selecting')));

// ── Highlights of the places documents are attached to ───────
function drawHighlights() {
  pages.forEach(p => p.hl.replaceChildren());
  for (const g of groups.values()) {
    const p = pages[g.anchor.page - 1]; if (!p) continue;
    const isArea = !g.anchor.text;
    let last = null;
    for (const [x, y, w, h] of g.anchor.rects) {
      const r = el('div', 'rsv-hl' + (isArea ? ' is-area' : ''));
      Object.assign(r.style, { left: x * 100 + '%', top: y * 100 + '%', width: w * 100 + '%', height: h * 100 + '%' });
      r.dataset.group = g.key;
      r.title = g.items.map(i => i.title).join('\n');
      r.addEventListener('click', e => { e.stopPropagation(); openPanel(g.key); });
      p.hl.append(r); last = [x, y, w, h];
    }
    if (last) {
      const b = el('button', 'rsv-badge'); b.type = 'button'; b.dataset.group = g.key;
      b.append(icon('clip'), String(g.items.length));
      b.setAttribute('aria-label', g.items.length + ' approved document' + (g.items.length > 1 ? 's' : '') + ' attached here');
      b.style.left = (last[0] + last[2]) * 100 + '%'; b.style.top = last[1] * 100 + '%';
      b.addEventListener('click', e => { e.stopPropagation(); openPanel(g.key); });
      p.hl.append(b);
    }
  }
}
function showPlace(key) {
  const g = groups.get(key); if (!g) return;
  const p = pages[g.anchor.page - 1]; if (!p) return;
  const top = p.shell.getBoundingClientRect().top + scrollY + g.anchor.rects[0][1] * p.shell.offsetHeight - 140;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  setTimeout(() => {
    p.hl.querySelectorAll(`[data-group="${CSS.escape(key)}"]`).forEach(n => { n.classList.add('is-flash'); setTimeout(() => n.classList.remove('is-flash'), 1800); });
  }, 350);
}

// ── Attaching (Board Secretary) ──────────────────────────────
if (canAttach) setupAttach();

function setupAttach() {
  const btn = $('rsvAttachBtn'), dlg = $('rsvDlg');
  let pending = null;                         // { page, text, rects }
  document.body.append(btn);

  function placeButton(clientX, clientY) {
    btn.hidden = false;
    const bw = btn.offsetWidth || 160;
    btn.style.left = Math.min(Math.max(8, clientX + scrollX - bw / 2), document.documentElement.scrollWidth - bw - 8) + 'px';
    btn.style.top = (clientY + scrollY + 10) + 'px';
  }
  function hideButton() { btn.hidden = true; }

  // Words: select them (drag with the mouse, or long-press on a phone),
  // then "Attach document". The page is taken from where the words are.
  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const shell = (node.nodeType === 1 ? node : node.parentElement)?.closest('.rsv-pg');
    if (!shell) return null;
    const box = shell.getBoundingClientRect();
    const all = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1);
    const rects = mergeRects(all.map(r => [(r.left - box.left) / box.width, (r.top - box.top) / box.height, r.width / box.width, r.height / box.height]));
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!rects.length || !text) return null;
    return { page: Number(shell.dataset.page), text: text.slice(0, 500), rects, last: all[all.length - 1] };
  }
  function check() {
    const got = readSelection();
    if (!got) { hideButton(); return; }
    pending = { page: got.page, text: got.text, rects: got.rects };
    placeButton(got.last.right - 40, got.last.bottom + (touched ? 34 : 0));   // below the phone's own copy menu
  }
  let touched = false, timer = null;
  const later = (ms) => { clearTimeout(timer); timer = setTimeout(check, ms); };
  const outside = e => { const t = e.target instanceof Element ? e.target : null; return t && t.closest('.rsv-attach-btn, .rsv-panel, .rsv-fab, dialog'); };
  document.addEventListener('mouseup', e => { if (!outside(e)) { touched = false; later(0); } });
  document.addEventListener('touchend', e => { if (!outside(e)) { touched = true; later(350); } }, { passive: true });
  // A long-press (and moving the handles) changes the selection without a mouseup.
  document.addEventListener('selectionchange', () => { if (dlg.open) return; if (touched || matchMedia('(pointer: coarse)').matches) { touched = true; later(450); } });

  btn.addEventListener('mousedown', e => e.preventDefault());           // keep the selection
  btn.addEventListener('click', () => { hideButton(); openDialog(pending); });

  function openDialog(anchor) {
    if (!anchor) return;
    $('rsvAPage').value = anchor.page;
    $('rsvAText').value = anchor.text;
    $('rsvARects').value = JSON.stringify(anchor.rects);
    const q = $('rsvQuote');
    q.hidden = false; q.textContent = '';
    q.append(el('span', 'rsv-quote-pg', 'Page ' + anchor.page), document.createTextNode(' “' + anchor.text + '”'));
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function closeDialog() { if (dlg.open) dlg.close(); else dlg.removeAttribute('open'); }
  $('rsvDlgClose').addEventListener('click', closeDialog);
  $('rsvCancel').addEventListener('click', closeDialog);
  $('rsvForm').addEventListener('submit', e => {
    if (!$('rsvAPage').value || !window.boardlinkApprovedCount || !window.boardlinkApprovedCount()) { e.preventDefault(); return; }
    $('rsvSave').lastChild.textContent = ' Saving…';
  });
}

/** Joins the boxes of one line of selected words into one box each. */
function mergeRects(rs) {
  rs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of rs) {
    const l = out[out.length - 1];
    if (l && Math.abs(l[1] - r[1]) < Math.max(l[3], r[3]) * 0.5 && r[0] <= l[0] + l[2] + 0.02) {
      const x2 = Math.max(l[0] + l[2], r[0] + r[2]), y2 = Math.max(l[1] + l[3], r[1] + r[3]);
      l[0] = Math.min(l[0], r[0]); l[1] = Math.min(l[1], r[1]); l[2] = x2 - l[0]; l[3] = y2 - l[1];
    } else out.push(r.slice());
  }
  return out.slice(0, 60).map(r => r.map(v => +v.toFixed(4)));
}
