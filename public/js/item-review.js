// ============================================================
// public/js/item-review.js — read an agenda item's PDF and comment
// on words or areas in it.
//
// Uses the PDF.js copy served by BOARDLINK itself (/vendor/pdfjs),
// so it works with no internet connection.
//
// Positions are stored as fractions of the page (0–1). Highlights
// are therefore drawn in percentages and stay in place at any zoom
// level or screen size.
// ============================================================

import * as pdfjsLib from '/vendor/pdfjs/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';

const root = document.getElementById('review');
if (root) init(root);

function init(root) {
  const cfg = {
    meetingId:  root.dataset.meeting,
    itemId:     root.dataset.item,
    fileUrl:    root.dataset.file,
    canComment: root.dataset.canComment === '1',
    isMinutes:  root.dataset.previousMinutes === '1',
  };
  const base = `/meeting/${cfg.meetingId}/item/${cfg.itemId}`;
  const TIME_ZONE = 'Asia/Manila';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const narrow = () => window.matchMedia('(max-width: 900px)').matches;

  const $ = id => document.getElementById(id);
  const docEl     = root.querySelector('.rv-doc');
  const pagesEl   = $('rvPages');
  const zoomLabel = $('rvZoomLabel');
  const ocrBanner = $('rvOcr');
  const selBtn    = $('rvSelBtn');
  const areaBtn   = $('rvAreaBtn');
  const side      = $('rvSide');
  const listEl    = $('rvList');
  const countEl   = $('rvCount');
  const countFab  = $('rvCountFab');
  const composer  = $('rvComposer');
  const textEl    = $('rvText');
  const targetEl  = $('rvTarget');
  const msgEl     = $('rvMsg');
  const cancelBtn = $('rvCancel');
  const postBtn   = $('rvPost');

  const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const state = {
    doc: null,
    pages: [],          // { n, pdfPage, w, h, shell, hlLayer, pinLayer, renderedScale, task, textKind, ocr }
    fitScale: 1,
    zoom: 1,
    comments: [],
    canMarkAddressed: false,
    activeId: null,
    draft: null,        // { type, page, quote, rects }
    boxEdit: null,      // the box being moved or resized
    pendingSel: null,
    areaMode: false,
    visible: new Set(),
  };

  // ── Helpers ────────────────────────────────────────────────
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const scale = () => state.fitScale * state.zoom;
  const fmtTime = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE,
    });
  };
  const topOf = c => (c.anchor ? Math.min(...c.anchor.rects.map(r => r[1])) : 0);
  const leftOf = c => (c.anchor ? Math.min(...c.anchor.rects.map(r => r[0])) : 0);

  function setMsg(text, isError) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.classList.toggle('is-error', !!isError);
  }

  async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' }
                    : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || 'Something went wrong. Please try again.');
    }
    return data;
  }

  // ── Loading the document ───────────────────────────────────
  async function loadDocument() {
    const task = pdfjsLib.getDocument({
      url: cfg.fileUrl,
      withCredentials: true,
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
      iccUrl: '/vendor/pdfjs/iccs/',
      isEvalSupported: false,
    });
    try {
      state.doc = await task.promise;
    } catch (err) {
      pagesEl.replaceChildren();
      const box = el('div', 'rv-error');
      box.append('The document could not be displayed here. ');
      const a = el('a', null, 'Download the PDF instead');
      a.href = `${cfg.fileUrl}?download=1`;
      box.append(a, '.');
      pagesEl.append(box);
      console.error('[review] PDF load failed', err);
      return;
    }

    const frag = document.createDocumentFragment();
    for (let n = 1; n <= state.doc.numPages; n++) {
      const pdfPage = await state.doc.getPage(n);
      const vp = pdfPage.getViewport({ scale: 1 });
      const p = { n, pdfPage, w: vp.width, h: vp.height, renderedScale: 0, task: null, textKind: null, ocr: null };
      p.shell = el('div', 'rv-pg');
      p.shell.dataset.page = String(n);
      p.shell.setAttribute('role', 'region');
      p.shell.setAttribute('aria-label', `Page ${n} of ${state.doc.numPages}`);
      p.shell.append(el('span', 'rv-pg-no', `Page ${n}`));
      p.hlLayer = el('div', 'rv-hl-layer');
      p.pinLayer = el('div', 'rv-pin-layer');
      p.shell.append(p.hlLayer, p.pinLayer);
      state.pages.push(p);
      frag.append(p.shell);
    }
    pagesEl.replaceChildren(frag);
    computeFit();
    layout();
    observePages();
    drawAnnotations();
  }

  function computeFit() {
    const avail = Math.max(pagesEl.clientWidth - 30, 200);
    const widest = Math.max(...state.pages.map(p => p.w));
    state.fitScale = Math.min(avail / widest, 2);
  }

  function layout() {
    const s = scale();
    for (const p of state.pages) {
      p.shell.style.width = `${Math.floor(p.w * s)}px`;
      p.shell.style.height = `${Math.floor(p.h * s)}px`;
      p.shell.style.setProperty('--scale-factor', s);
      p.shell.style.setProperty('--total-scale-factor', s);
      p.shell.style.setProperty('--scale-round-x', '1px');
      p.shell.style.setProperty('--scale-round-y', '1px');
    }
    zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  let io = null;
  function observePages() {
    io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const p = state.pages[Number(e.target.dataset.page) - 1];
        if (e.isIntersecting) { state.visible.add(p); renderPage(p); }
        else state.visible.delete(p);
      }
    }, { rootMargin: '600px 0px' });
    state.pages.forEach(p => io.observe(p.shell));
  }

  // ── Drawing one page ───────────────────────────────────────
  async function renderPage(p) {
    const s = scale();
    if (p.renderedScale === s || p.rendering === s) return;
    p.rendering = s;
    if (p.task) { try { p.task.cancel(); } catch (_) {} }

    const viewport = p.pdfPage.getViewport({ scale: s });
    let ratio = Math.min(window.devicePixelRatio || 1, 2);
    const maxPixels = 12e6;
    if (viewport.width * viewport.height * ratio * ratio > maxPixels) {
      ratio = Math.sqrt(maxPixels / (viewport.width * viewport.height));
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d', { alpha: false });

    p.task = p.pdfPage.render({
      canvasContext: ctx,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    });
    try {
      await p.task.promise;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      console.error(`[review] page ${p.n} failed to render`, err);
      p.rendering = 0;
      return;
    }
    if (p.rendering !== s) return;          // zoom changed meanwhile
    const old = p.shell.querySelector('canvas');
    if (old) old.replaceWith(canvas); else p.shell.prepend(canvas);
    p.renderedScale = s;
    p.rendering = 0;
    await buildTextLayer(p, viewport);
  }

  async function buildTextLayer(p, viewport) {
    p.shell.querySelectorAll('.textLayer, .ocrLayer').forEach(n => n.remove());

    if (p.textKind === null) {
      const tc = await p.pdfPage.getTextContent();
      const chars = tc.items.reduce((n, it) => n + String(it.str || '').replace(/\s+/g, '').length, 0);
      p.textKind = chars > 0 ? 'pdf' : 'scan';
      p.textContent = chars > 0 ? tc : null;
    }

    if (p.textKind === 'pdf') {
      const div = el('div', 'textLayer');
      p.shell.append(div);
      const layer = new pdfjsLib.TextLayer({
        textContentSource: p.textContent,
        container: div,
        viewport,
      });
      await layer.render();
      const end = el('div', 'endOfContent');
      div.append(end);
      div.addEventListener('mousedown', () => div.classList.add('selecting'));
      return;
    }

    // Scanned page: use the words BOARDLINK read with OCR, if ready.
    if (!p.ocr || p.ocr.status === 'pending') await fetchOcr(p);
    if (p.ocr && p.ocr.status === 'done' && p.ocr.words && p.ocr.words.length) {
      p.shell.append(buildOcrLayer(p));
    }
    updatePageStatus(p);
  }

  document.addEventListener('mouseup', () => {
    document.querySelectorAll('.textLayer.selecting').forEach(d => d.classList.remove('selecting'));
  });

  // ── Scanned pages (OCR words) ──────────────────────────────
  const measureCtx = document.createElement('canvas').getContext('2d');

  async function fetchOcr(p) {
    try {
      const data = await api(`${base}/pages/${p.n}/text`);
      p.ocr = { status: data.status, words: data.words };
    } catch (_) {
      p.ocr = { status: 'failed', words: null };
    }
    if (p.ocr.status === 'pending') scheduleOcrPoll(p);
    updateOcrBanner();
  }

  function scheduleOcrPoll(p) {
    if (p.ocrTimer) return;
    p.ocrTimer = setTimeout(async () => {
      p.ocrTimer = null;
      if (!state.visible.has(p)) { scheduleOcrPoll(p); return; }
      await fetchOcr(p);
      if (p.ocr.status !== 'pending' && p.renderedScale) {
        await buildTextLayer(p, p.pdfPage.getViewport({ scale: p.renderedScale }));
      }
    }, 6000);
  }

  function buildOcrLayer(p) {
    const W = p.w * scale();
    const H = p.h * scale();
    const layer = el('div', 'ocrLayer');
    const words = p.ocr.words;
    for (let i = 0; i < words.length; i++) {
      const [x, y, w, h, text, line] = words[i];
      const next = words[i + 1];
      const sameLine = next && next[5] === line && line !== -1;
      const span = el('span', null, sameLine ? `${text} ` : text);
      const fontPx = Math.max(h * H * 0.95, 4);
      span.style.left = `${x * 100}%`;
      span.style.top = `${y * 100}%`;
      span.style.fontSize = `${fontPx}px`;
      measureCtx.font = `${fontPx}px sans-serif`;
      const natural = measureCtx.measureText(span.textContent).width;
      const target = (sameLine ? Math.max(next[0] - x, w) : w) * W;
      if (natural > 0) span.style.transform = `scaleX(${target / natural})`;
      layer.append(span);
      if (!sameLine) layer.append(document.createElement('br'));
    }
    return layer;
  }

  function updatePageStatus(p) {
    p.shell.querySelector('.rv-pg-status')?.remove();
    if (p.textKind !== 'scan' || !p.ocr) return;
    let text = null;
    if (p.ocr.status === 'pending') text = 'Reading scanned text…';
    else if (p.ocr.status !== 'done' || !(p.ocr.words || []).length) {
      text = cfg.canComment ? 'Text not selectable here: mark an area instead' : null;
    }
    if (text) p.shell.append(el('span', 'rv-pg-status', text));
  }

  function updateOcrBanner() {
    const pending = state.pages.filter(p => p.ocr && p.ocr.status === 'pending').length;
    if (!pending) { ocrBanner.hidden = true; return; }
    ocrBanner.hidden = false;
    ocrBanner.replaceChildren(el('span', 'rv-spin'),
      `This is a scanned document. BOARDLINK is still reading its text, so some words are not selectable yet.` +
      (cfg.canComment ? ' You can already mark an area on any page.' : ''));
  }

  // ── Zoom ───────────────────────────────────────────────────
  function anchorScroll() {
    const mid = window.innerHeight * 0.35;
    for (const p of state.pages) {
      const r = p.shell.getBoundingClientRect();
      if (r.bottom > mid) return { p, ratio: (mid - r.top) / r.height };
    }
    return null;
  }

  function applyZoom(z) {
    const keep = anchorScroll();
    state.zoom = z;
    layout();
    if (keep) {
      const r = keep.p.shell.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + r.top + keep.ratio * r.height - window.innerHeight * 0.35 });
    }
    state.visible.forEach(p => renderPage(p));
  }

  root.querySelectorAll('[data-zoom]').forEach(btn => btn.addEventListener('click', () => {
    const i = ZOOMS.indexOf(state.zoom);
    const kind = btn.dataset.zoom;
    if (kind === 'fit') return applyZoom(1);
    const idx = kind === 'in' ? Math.min((i < 0 ? 3 : i) + 1, ZOOMS.length - 1)
                              : Math.max((i < 0 ? 3 : i) - 1, 0);
    applyZoom(ZOOMS[idx]);
  }));

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.pages.length) return;
      const before = state.fitScale;
      computeFit();
      if (Math.abs(before - state.fitScale) > 0.01) applyZoom(state.zoom);
    }, 200);
  });

  // ── Highlights and pins ────────────────────────────────────
  function spotKey(c) {
    return `${c.page}|${Math.round(topOf(c) * 300)}|${Math.round(leftOf(c) * 50)}`;
  }

  function drawAnnotations() {
    for (const p of state.pages) {
      p.hlLayer.replaceChildren();
      p.pinLayer.replaceChildren();
    }
    const spots = new Map();
    for (const c of state.comments) {
      if (!c.anchor || !c.page) continue;
      const p = state.pages[c.page - 1];
      if (!p) continue;
      if (state.boxEdit && state.boxEdit.kind === 'comment' && state.boxEdit.id === c.id) continue;
      for (const [x, y, w, h] of c.anchor.rects) {
        const d = el('div', 'rv-hl');
        if (c.anchor.type === 'area') d.classList.add('is-area');
        if (c.status === 'Addressed') d.classList.add('is-addressed');
        if (c.stale) d.classList.add('is-stale');
        if (c.id === state.activeId) d.classList.add('is-active');
        d.dataset.id = String(c.id);
        Object.assign(d.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
        p.hlLayer.append(d);
      }
      const key = spotKey(c);
      if (!spots.has(key)) spots.set(key, { p, top: topOf(c), ids: [], addressed: true });
      const s = spots.get(key);
      s.ids.push(c.id);
      if (c.status !== 'Addressed') s.addressed = false;
    }
    for (const s of spots.values()) {
      const pin = el('button', 'rv-pin', String(s.ids.length));
      pin.type = 'button';
      pin.style.top = `calc(${s.top * 100}% - 4px)`;
      pin.setAttribute('aria-label', `${s.ids.length} comment${s.ids.length === 1 ? '' : 's'} here`);
      if (s.addressed) pin.classList.add('is-addressed');
      if (s.ids.includes(state.activeId)) pin.classList.add('is-active');
      pin.addEventListener('click', e => {
        e.stopPropagation();
        activate(s.ids[0], { scrollList: true });
        openSide();
      });
      s.p.pinLayer.append(pin);
    }
    drawDraft();
  }

  // ── Moving and resizing a marked area ──────────────────────
  // Used both for the box just drawn (before posting) and for the
  // area of a posted comment the author is changing.
  const MIN_W = 0.012, MIN_H = 0.008;
  const HANDLES = [
    ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0],
    ['w', 0, 0.5], ['e', 1, 0.5],
    ['sw', 0, 1], ['s', 0.5, 1], ['se', 1, 1],
  ];

  function makeBoxEditor(pageObj, rect, { variant = 'draft', label = 'Marked area' } = {}) {
    let [x, y, w, h] = rect;
    const box = el('div', `rv-box is-${variant}`);
    box.tabIndex = 0;
    box.setAttribute('role', 'application');
    box.setAttribute('aria-label', `${label}. Drag to move, or use the arrow keys. Hold Shift with the arrow keys to resize.`);
    const paint = () => Object.assign(box.style, {
      left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`,
    });
    paint();
    for (const [dir, hx, hy] of HANDLES) {
      const grip = el('span', `rv-handle rv-handle-${dir}`);
      grip.dataset.dir = dir;
      grip.style.left = `${hx * 100}%`;
      grip.style.top = `${hy * 100}%`;
      box.append(grip);
    }
    pageObj.shell.append(box);

    const clampRect = () => {
      w = Math.max(MIN_W, Math.min(w, 1));
      h = Math.max(MIN_H, Math.min(h, 1));
      x = Math.max(0, Math.min(x, 1 - w));
      y = Math.max(0, Math.min(y, 1 - h));
    };

    let move = null;
    box.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button !== 0) return;
      const dir = e.target.dataset ? e.target.dataset.dir : null;
      const pageBox = pageObj.shell.getBoundingClientRect();
      move = {
        id: e.pointerId, dir, pageBox,
        px: (e.clientX - pageBox.left) / pageBox.width,
        py: (e.clientY - pageBox.top) / pageBox.height,
        start: [x, y, w, h],
      };
      box.classList.add(dir ? 'is-resizing' : 'is-moving');
      box.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    box.addEventListener('pointermove', e => {
      if (!move || e.pointerId !== move.id) return;
      const dx = (e.clientX - move.pageBox.left) / move.pageBox.width - move.px;
      const dy = (e.clientY - move.pageBox.top) / move.pageBox.height - move.py;
      const [sx, sy, sw, sh] = move.start;
      if (!move.dir) {
        x = sx + dx; y = sy + dy; w = sw; h = sh;
      } else {
        let left = sx, top = sy, right = sx + sw, bottom = sy + sh;
        if (move.dir.includes('w')) left = Math.min(sx + dx, right - MIN_W);
        if (move.dir.includes('e')) right = Math.max(sx + sw + dx, left + MIN_W);
        if (move.dir.includes('n')) top = Math.min(sy + dy, bottom - MIN_H);
        if (move.dir.includes('s')) bottom = Math.max(sy + sh + dy, top + MIN_H);
        x = Math.max(0, left); y = Math.max(0, top);
        w = Math.min(right, 1) - x; h = Math.min(bottom, 1) - y;
      }
      clampRect();
      paint();
      e.preventDefault();
    });
    const stop = e => {
      if (!move || e.pointerId !== move.id) return;
      move = null;
      box.classList.remove('is-moving', 'is-resizing');
    };
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointercancel', stop);
    // Keyboard: arrows move, Shift + arrows resize.
    box.addEventListener('keydown', e => {
      const step = e.altKey ? 0.002 : 0.01;
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return;
      if (e.shiftKey) { w += d[0] * step; h += d[1] * step; }
      else { x += d[0] * step; y += d[1] * step; }
      clampRect();
      paint();
      e.preventDefault();
    });

    const r4 = v => Math.round(v * 10000) / 10000;
    return {
      el: box,
      getRect: () => [r4(x), r4(y), r4(w), r4(h)],
      focus: () => box.focus({ preventScroll: true }),
      destroy: () => box.remove(),
    };
  }

  function stopBoxEdit() {
    if (state.boxEdit) {
      state.boxEdit.editor.destroy();
      state.boxEdit = null;
    }
  }

  function drawDraft() {
    root.querySelectorAll('.rv-hl.is-draft').forEach(n => n.remove());
    if (state.boxEdit && state.boxEdit.kind === 'draft') stopBoxEdit();
    const d = state.draft;
    if (!d) return;
    const p = state.pages[d.page - 1];
    if (!p) return;
    if (d.type === 'area') {
      // The drawn box stays adjustable until the comment is posted.
      const editor = makeBoxEditor(p, d.rects[0], { variant: 'draft', label: `Marked area on page ${d.page}` });
      state.boxEdit = { kind: 'draft', editor, page: d.page };
      return;
    }
    for (const [x, y, w, h] of d.rects) {
      const n = el('div', 'rv-hl is-draft');
      if (d.type === 'area') n.classList.add('is-area');
      Object.assign(n.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
      p.hlLayer.append(n);
    }
  }

  function scrollToSpot(c) {
    const p = state.pages[c.page - 1];
    if (!p) return;
    const r = p.shell.getBoundingClientRect();
    const y = window.scrollY + r.top + topOf(c) * r.height - window.innerHeight * 0.3;
    window.scrollTo({ top: Math.max(0, y), behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function activate(id, { scrollDoc = false, scrollList = false } = {}) {
    state.activeId = id;
    listEl.querySelectorAll('.rv-c').forEach(n => n.classList.toggle('is-active', n.dataset.id === String(id)));
    root.querySelectorAll('.rv-hl[data-id]').forEach(n => n.classList.toggle('is-active', n.dataset.id === String(id)));
    drawAnnotations();
    const c = state.comments.find(x => x.id === id);
    if (c && c.anchor && scrollDoc) {
      scrollToSpot(c);
      if (narrow()) closeSide();
    }
    if (scrollList) {
      listEl.querySelector(`.rv-c[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  // ── Comment list ───────────────────────────────────────────
  async function loadComments() {
    try {
      const data = await api(`${base}/comments`);
      state.comments = data.comments;
      state.canMarkAddressed = data.canMarkAddressed;
      renderList();
      drawAnnotations();
    } catch (err) {
      listEl.replaceChildren(el('p', 'rv-muted', err.message));
    }
  }

  function sortComments() {
    const t = c => new Date(c.createdAt || 0).getTime();
    const anchored = state.comments.filter(c => c.anchor)
      .sort((a, b) => a.page - b.page || topOf(a) - topOf(b) || leftOf(a) - leftOf(b) || t(a) - t(b));
    const general = state.comments.filter(c => !c.anchor)
      .sort((a, b) => (a.page || 0) - (b.page || 0) || (a.line || 0) - (b.line || 0) || t(a) - t(b));
    return { anchored, general };
  }

  function renderList() {
    const n = state.comments.length;
    countEl.textContent = String(n);
    if (countFab) countFab.textContent = String(n);
    const { anchored, general } = sortComments();
    const frag = document.createDocumentFragment();
    if (!n) {
      frag.append(el('p', 'rv-muted', cfg.canComment
        ? 'No comments yet. Select words in the document, or mark an area, to add the first one.'
        : 'No comments on this document yet.'));
    }
    if (anchored.length) {
      frag.append(el('h3', 'rv-group-title', 'In the document'));
      anchored.forEach(c => frag.append(card(c)));
    }
    if (general.length) {
      frag.append(el('h3', 'rv-group-title', 'On the item as a whole'));
      general.forEach(c => frag.append(card(c)));
    }
    listEl.replaceChildren(frag);
  }

  function whereLine(c) {
    const box = el('div', 'rv-c-where');
    if (c.anchor) {
      box.append(el('span', 'rv-c-page', `p. ${c.page}`));
      box.append(c.anchor.type === 'text'
        ? el('span', 'rv-c-quote', `“${c.anchor.quote}”`)
        : el('span', 'rv-c-area', 'Marked area'));
      return box;
    }
    if (c.page) {
      box.append(el('span', 'rv-c-page', c.line ? `p. ${c.page}, line ${c.line}` : `p. ${c.page}`));
      return box;
    }
    // The document was reworded and these words are gone, so the comment
    // has no place in it any more. The words it was about are still shown.
    if (c.lost) {
      if (c.quote) box.append(el('span', 'rv-c-quote', `“${c.quote}”`));
      box.append(el('span', 'rv-c-lost', 'these words were changed by the Secretary'));
      return box;
    }
    return null;
  }

  /** "Check this still marks the right place", after a re-wording. */
  function staleNote(c) {
    const note = el('div', 'rv-c-stale');
    note.append(el('span', null, c.anchor && c.anchor.type === 'area'
      ? 'The words on this page were edited. Check this box still marks the right thing.'
      : 'The words on this page were edited. Check this highlight is still in the right place.'));
    return note;
  }

  function card(c) {
    const art = el('article', 'rv-c');
    art.dataset.id = String(c.id);
    if (c.anchor) art.classList.add('is-anchored');
    if (c.status === 'Addressed') art.classList.add('is-addressed');
    if (c.id === state.activeId) art.classList.add('is-active');

    if (c.lost) art.classList.add('is-lost');
    if (c.stale) art.classList.add('is-stale');

    const where = whereLine(c);
    if (where) art.append(where);
    if (c.stale) art.append(staleNote(c));

    const who = el('div', 'rv-c-who');
    who.append(el('strong', null, c.mine ? `${c.author} (you)` : c.author));
    const meta = [c.roleLabel, fmtTime(c.createdAt)];
    if (c.editedAt) meta.push('edited');
    who.append(el('span', 'rv-c-meta', meta.join(', ')));
    art.append(who);

    const body = el('div', 'rv-c-text', c.text);
    art.append(body);

    const tags = el('div', 'rv-c-tags');
    if (c.phase === 'In-Session') tags.append(el('span', 'badge b-orange', 'In-Session'));
    if (cfg.isMinutes || state.canMarkAddressed || c.status === 'Addressed') {
      tags.append(el('span', `badge ${c.status === 'Addressed' ? 'b-green' : 'b-blue'}`,
        c.status === 'Addressed' ? 'Done' : 'Open'));
    }
    if (tags.childElementCount) art.append(tags);

    const actions = el('div', 'rv-c-actions');
    if (c.anchor) {
      const show = el('button', 'rv-link', 'Show in document');
      show.type = 'button';
      show.addEventListener('click', e => { e.stopPropagation(); activate(c.id, { scrollDoc: true }); });
      actions.append(show);
    }
    if (c.canEdit && c.anchor && c.anchor.type === 'area') {
      const area = el('button', 'rv-link', 'Edit area');
      area.type = 'button';
      area.addEventListener('click', e => { e.stopPropagation(); startAreaEdit(c); });
      actions.append(area);
    }
    if (c.canEdit) {
      const edit = el('button', 'rv-link', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', e => { e.stopPropagation(); startEdit(art, body, c); });
      const del = el('button', 'rv-link is-danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', e => { e.stopPropagation(); removeComment(c); });
      actions.append(edit, del);
    }
    if (state.canMarkAddressed && c.status !== 'Addressed') {
      const mark = el('button', 'rv-done', 'Done');
      mark.title = 'Mark this comment as done. The member who wrote it is notified.';
      mark.type = 'button';
      mark.addEventListener('click', e => { e.stopPropagation(); markAddressed(c); });
      actions.append(mark);
    }
    const editingArea = state.boxEdit && state.boxEdit.kind === 'comment' && state.boxEdit.id === c.id;
    if (editingArea) {
      art.classList.add('is-editing-area');
      art.append(areaEditBar(c));
    } else if (actions.childElementCount) {
      art.append(actions);
    }

    if (c.anchor && !editingArea) art.addEventListener('click', () => activate(c.id, { scrollDoc: true }));
    return art;
  }

  function startEdit(art, body, c) {
    if (art.querySelector('.rv-edit')) return;
    const form = el('form', 'rv-edit');
    form.setAttribute('data-no-spinner', '');
    const ta = el('textarea');
    ta.value = c.text;
    ta.maxLength = 4000;
    ta.setAttribute('aria-label', 'Edit your comment');
    const row = el('div', 'rv-edit-row');
    const err = el('span', 'rv-msg is-error');
    const cancel = el('button', 'btn btn-light btn-sm', 'Cancel');
    cancel.type = 'button';
    const save = el('button', 'btn btn-navy btn-sm', 'Save changes');
    save.type = 'submit';
    row.append(err, cancel, save);
    form.append(ta, row);
    body.hidden = true;
    art.querySelector('.rv-c-actions')?.setAttribute('hidden', '');
    art.append(form);
    ta.focus();
    form.addEventListener('click', e => e.stopPropagation());
    const close = () => { form.remove(); body.hidden = false; art.querySelector('.rv-c-actions')?.removeAttribute('hidden'); };
    cancel.addEventListener('click', close);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) { err.textContent = 'A comment cannot be empty. Use Delete to remove it.'; return; }
      save.disabled = true;
      try {
        const data = await api(`/meeting/${cfg.meetingId}/comment/${c.id}/edit`, { method: 'POST', body: { text } });
        Object.assign(c, data.comment);
        renderList();
        activate(c.id);
      } catch (ex) {
        err.textContent = ex.message;
        save.disabled = false;
      }
    });
  }

  // Move or resize the area of a posted comment (author only).
  function startAreaEdit(c) {
    if (state.boxEdit && state.boxEdit.kind === 'comment' && state.boxEdit.id === c.id) return;
    stopBoxEdit();
    clearDraft();
    const p = state.pages[c.page - 1];
    if (!p) return;
    activate(c.id);
    const editor = makeBoxEditor(p, c.anchor.rects[0], { variant: 'comment', label: `Marked area on page ${c.page}` });
    state.boxEdit = { kind: 'comment', id: c.id, editor, page: c.page };
    drawAnnotations();
    scrollToSpot(c);
    editor.focus();
    renderList();
  }

  function areaEditBar(c) {
    const bar = el('div', 'rv-area-edit');
    bar.append(el('p', 'rv-area-hint', 'Drag the box to move it, or drag a corner to resize. Arrow keys work too.'));
    const row = el('div', 'rv-edit-row');
    const err = el('span', 'rv-msg is-error');
    const cancel = el('button', 'btn btn-light btn-sm', 'Cancel');
    cancel.type = 'button';
    const save = el('button', 'btn btn-navy btn-sm', 'Save area');
    save.type = 'button';
    row.append(err, cancel, save);
    bar.append(row);
    bar.addEventListener('click', e => e.stopPropagation());
    cancel.addEventListener('click', () => { stopBoxEdit(); renderList(); drawAnnotations(); });
    save.addEventListener('click', async () => {
      const rect = state.boxEdit.editor.getRect();
      save.disabled = true;
      try {
        const data = await api(`/meeting/${cfg.meetingId}/comment/${c.id}/edit`, {
          method: 'POST',
          body: { text: c.text, anchor: { type: 'area', page: state.boxEdit.page, rects: [rect] } },
        });
        Object.assign(c, data.comment);
        stopBoxEdit();
        renderList();
        drawAnnotations();
        activate(c.id);
      } catch (ex) {
        err.textContent = ex.message;
        save.disabled = false;
      }
    });
    return bar;
  }

  async function removeComment(c) {
    if (!window.confirm('Delete this comment? This cannot be undone.')) return;
    try {
      await api(`/meeting/${cfg.meetingId}/comment/${c.id}/delete`, { method: 'POST', body: {} });
      state.comments = state.comments.filter(x => x.id !== c.id);
      if (state.activeId === c.id) state.activeId = null;
      renderList();
      drawAnnotations();
    } catch (ex) {
      window.alert(ex.message);
    }
  }

  async function markAddressed(c) {
    try {
      // The route answers with a redirect to the meeting page; there is
      // no need to load that page here, only to refresh this list.
      const res = await fetch(`/meeting/${cfg.meetingId}/comment/${c.id}/addressed`, {
        method: 'POST', credentials: 'same-origin', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'from=review',
      });
      if (res.type !== 'opaqueredirect' && !res.ok) throw new Error(String(res.status));
      await loadComments();
    } catch (_) {
      window.alert('The comment could not be marked as done.');
    }
  }

  // ── Selecting words ────────────────────────────────────────
  const pageOf = node => {
    const e = node && (node.nodeType === 1 ? node : node.parentElement);
    return e ? e.closest('.rv-pg') : null;
  };

  function mergeRects(rects) {
    const out = [];
    rects.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const r of rects) {
      const m = out.find(o => {
        const overlap = Math.min(o[1] + o[3], r[1] + r[3]) - Math.max(o[1], r[1]);
        const gap = Math.max(r[0] - (o[0] + o[2]), o[0] - (r[0] + r[2]));
        return overlap >= 0.5 * Math.min(o[3], r[3]) && gap <= 0.015;
      });
      if (m) {
        const x1 = Math.min(m[0], r[0]), y1 = Math.min(m[1], r[1]);
        const x2 = Math.max(m[0] + m[2], r[0] + r[2]), y2 = Math.max(m[1] + m[3], r[1] + r[3]);
        m[0] = x1; m[1] = y1; m[2] = x2 - x1; m[3] = y2 - y1;
      } else {
        out.push([...r]);
      }
    }
    const r4 = v => Math.round(v * 10000) / 10000;
    return out.map(r => r.map(r4)).slice(0, 60);
  }

  function rectsFromRange(range, shell) {
    const box = shell.getBoundingClientRect();
    const rects = [];
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const x = (r.left - box.left) / box.width;
      const y = (r.top - box.top) / box.height;
      const w = r.width / box.width;
      const h = r.height / box.height;
      if (h > 0.12 || x > 1 || y > 1 || x + w < 0 || y + h < 0) continue;   // layer boxes, not text
      const cx = Math.max(0, x), cy = Math.max(0, y);
      rects.push([cx, cy, Math.min(1, x + w) - cx, Math.min(1, y + h) - cy]);
    }
    return mergeRects(rects);
  }

  function hideSelBtn() {
    selBtn.hidden = true;
    state.pendingSel = null;
  }

  function readSelection() {
    if (!cfg.canComment || state.areaMode) return hideSelBtn();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return hideSelBtn();
    const range = sel.getRangeAt(0);
    const a = pageOf(range.startContainer);
    const b = pageOf(range.endContainer);
    if (!a && !b) return hideSelBtn();
    if (!a || !b || a !== b) {
      hideSelBtn();
      setMsg('Select text on one page at a time.', true);
      return;
    }
    const quote = sel.toString().replace(/\s+/g, ' ').trim();
    if (!quote) return hideSelBtn();
    const rects = rectsFromRange(range, a);
    if (!rects.length) return hideSelBtn();
    setMsg('');
    state.pendingSel = { type: 'text', page: Number(a.dataset.page), quote, rects };

    const last = [...range.getClientRects()].filter(r => r.width > 0).pop();
    const host = docEl.getBoundingClientRect();
    if (last) {
      const left = Math.min(Math.max(last.right - host.left - 40, 4), host.width - 120);
      selBtn.style.left = `${left}px`;
      selBtn.style.top = `${last.bottom - host.top + 8}px`;
      selBtn.hidden = false;
    }
  }

  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(readSelection, 150);
  });
  selBtn.addEventListener('mousedown', e => e.preventDefault());     // keep the selection alive
  selBtn.addEventListener('click', () => {
    if (!state.pendingSel) return;
    setDraft(state.pendingSel);
    window.getSelection()?.removeAllRanges();
    hideSelBtn();
  });

  // ── Marking an area ────────────────────────────────────────
  function setAreaMode(on) {
    state.areaMode = on;
    root.classList.toggle('is-area-mode', on);
    if (areaBtn) {
      areaBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      areaBtn.lastChild.textContent = on ? ' Drag on a page… (Esc to stop)' : ' Mark an area';
    }
    if (on) { window.getSelection()?.removeAllRanges(); hideSelBtn(); }
  }
  areaBtn?.addEventListener('click', () => setAreaMode(!state.areaMode));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (state.boxEdit && state.boxEdit.kind === 'comment') { stopBoxEdit(); renderList(); drawAnnotations(); }
      else if (state.areaMode) setAreaMode(false);
      else if (narrow() && side.classList.contains('is-open')) closeSide();
    }
  });

  let drag = null;
  pagesEl.addEventListener('pointerdown', e => {
    if (!state.areaMode || e.button !== 0) return;
    const shell = e.target.closest('.rv-pg');
    if (!shell || e.target.closest('.rv-pin')) return;
    e.preventDefault();
    const box = shell.getBoundingClientRect();
    const x0 = (e.clientX - box.left) / box.width;
    const y0 = (e.clientY - box.top) / box.height;
    const rectEl = el('div', 'rv-draw');
    shell.append(rectEl);
    drag = { shell, box, x0, y0, x1: x0, y1: y0, rectEl, id: e.pointerId };
    shell.setPointerCapture(e.pointerId);
  });
  pagesEl.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const clamp = v => Math.min(1, Math.max(0, v));
    drag.x1 = clamp((e.clientX - drag.box.left) / drag.box.width);
    drag.y1 = clamp((e.clientY - drag.box.top) / drag.box.height);
    const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
    Object.assign(drag.rectEl.style, {
      left: `${x * 100}%`, top: `${y * 100}%`,
      width: `${Math.abs(drag.x1 - drag.x0) * 100}%`, height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
    });
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    d.rectEl.remove();
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 0.01 || h < 0.005) { setMsg('Drag a larger box to mark an area.', true); return; }
    const r4 = v => Math.round(v * 10000) / 10000;
    setAreaMode(false);
    setDraft({ type: 'area', page: Number(d.shell.dataset.page), quote: null, rects: [[r4(x), r4(y), r4(w), r4(h)]] });
  };
  pagesEl.addEventListener('pointerup', endDrag);
  pagesEl.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.id) { drag.rectEl.remove(); drag = null; } });

  // ── Composer ───────────────────────────────────────────────
  function renderTarget() {
    if (!targetEl) return;
    targetEl.replaceChildren();
    const d = state.draft;
    targetEl.classList.toggle('is-set', !!d);
    if (!d) {
      targetEl.append(el('span', 'rv-target-label', 'Commenting on the item as a whole'));
      cancelBtn.hidden = true;
      return;
    }
    targetEl.append(el('span', 'rv-c-page', `p. ${d.page}`));
    if (d.type === 'text') {
      targetEl.append(el('span', 'rv-c-quote', `“${d.quote}”`));
    } else {
      targetEl.append(el('span', 'rv-c-area', 'Marked area'));
      const redraw = el('button', 'rv-link', 'Draw again');
      redraw.type = 'button';
      redraw.addEventListener('click', () => { clearDraft(); setAreaMode(true); setMsg('Drag on a page to mark the area.'); });
      targetEl.append(redraw);
      targetEl.append(el('span', 'rv-target-hint', 'Drag the box on the page to adjust it.'));
    }
    cancelBtn.hidden = false;
  }

  function setDraft(d) {
    if (state.boxEdit && state.boxEdit.kind === 'comment') { stopBoxEdit(); renderList(); }
    state.draft = d;
    renderTarget();
    drawDraft();
    setMsg('');
    openSide();
    textEl?.focus({ preventScroll: !narrow() });
  }

  function clearDraft() {
    if (state.boxEdit && state.boxEdit.kind === 'draft') stopBoxEdit();
    state.draft = null;
    renderTarget();
    drawDraft();
  }

  cancelBtn?.addEventListener('click', () => { clearDraft(); setMsg(''); });

  composer?.addEventListener('submit', async e => {
    e.preventDefault();
    const text = textEl.value.trim();
    if (!text) { setMsg('Write a comment first.', true); textEl.focus(); return; }
    postBtn.disabled = true;
    setMsg('Posting…');
    try {
      const d = state.draft;
      // Take the box as it stands now: it may have been moved or resized.
      const rects = (d && d.type === 'area' && state.boxEdit && state.boxEdit.kind === 'draft')
        ? [state.boxEdit.editor.getRect()] : (d ? d.rects : null);
      const data = await api(`${base}/comments`, {
        method: 'POST',
        body: { text, anchor: d ? { type: d.type, page: d.page, quote: d.quote, rects } : null },
      });
      state.comments.push(data.comment);
      textEl.value = '';
      clearDraft();
      renderList();
      activate(data.comment.id, { scrollList: true });
      setMsg('Comment posted.');
    } catch (ex) {
      setMsg(ex.message, true);
    } finally {
      postBtn.disabled = false;
    }
  });
  textEl?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) composer.requestSubmit();
  });

  // ── Phone layout: comments as a bottom sheet ───────────────
  function openSide() { if (narrow()) side.classList.add('is-open'); }
  function closeSide() { side.classList.remove('is-open'); }
  $('rvSideOpen')?.addEventListener('click', openSide);
  $('rvSideClose')?.addEventListener('click', closeSide);

  // ── Start ──────────────────────────────────────────────────
  renderTarget();
  loadComments();
  loadDocument();

  // Opened from the meeting page with #comment-<id>: jump to it.
  const m = /^#comment-(\d+)$/.exec(window.location.hash);
  if (m) {
    const wanted = Number(m[1]);
    const wait = setInterval(() => {
      if (state.pages.length && state.comments.length) {
        clearInterval(wait);
        if (state.comments.some(c => c.id === wanted)) activate(wanted, { scrollDoc: true, scrollList: true });
      }
    }, 200);
    setTimeout(() => clearInterval(wait), 15000);
  }
}
