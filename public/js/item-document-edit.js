// ============================================================
// public/js/item-document-edit.js — the Secretary's page editor
//
// Shows every page of the item's PDF as a thumbnail that can be
// moved, turned or removed, and lets pages from another PDF be added.
// Nothing is changed on the server until Save; the form then sends the
// page plan, and the server rebuilds the document and moves the
// members' comments with their pages.
// ============================================================

import * as pdfjsLib from '/vendor/pdfjs/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';

const dataEl = document.getElementById('deData');
if (dataEl) start(JSON.parse(dataEl.textContent));

function start(cfg) {
  const grid = document.getElementById('deGrid');
  const form = document.getElementById('deForm');
  const pagesField = document.getElementById('dePages');
  const countEl = document.getElementById('deCount');
  const errorEl = document.getElementById('deError');
  const insertEl = document.getElementById('deInsert');
  const saveBtn = document.getElementById('deSave');

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const say = msg => {
    errorEl.textContent = msg || '';
    errorEl.hidden = !msg;
    if (msg) errorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // src key → { doc, label, fileInput }
  const sources = new Map();
  let pages = [];        // { src, page, rotate, removed, el }
  let nextUpload = 0;

  const opts = {
    cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    wasmUrl: '/vendor/pdfjs/wasm/', iccUrl: '/vendor/pdfjs/iccs/',
    isEvalSupported: false,
  };

  async function loadOriginal() {
    try {
      const doc = await pdfjsLib.getDocument({ url: cfg.file, withCredentials: true, ...opts }).promise;
      sources.set('current', { doc, label: 'this document' });
      pages = [];
      for (let n = 1; n <= doc.numPages; n++) pages.push({ src: 'current', page: n, rotate: 0, removed: false });
      render();
    } catch (err) {
      grid.replaceChildren(el('p', 'de-loading', 'The document could not be opened.'));
      console.error('[document edit]', err);
    }
  }

  // ── Adding pages from another PDF ──────────────────────────
  insertEl.addEventListener('change', async () => {
    const chosen = [...insertEl.files];
    insertEl.value = '';
    for (const file of chosen) {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        say(`"${file.name}" is not a PDF.`);
        continue;
      }
      if (file.size > cfg.maxMb * 1024 * 1024) {
        say(`"${file.name}" is larger than ${cfg.maxMb} MB.`);
        continue;
      }
      const key = 'u' + (nextUpload++);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjsLib.getDocument({ data: bytes, ...opts }).promise;
        // The file itself travels with the form, under its own name.
        const hidden = document.createElement('input');
        hidden.type = 'file';
        hidden.name = 'insert_pdf__' + key;
        hidden.hidden = true;
        const dt = new DataTransfer();
        dt.items.add(file);
        hidden.files = dt.files;
        form.append(hidden);
        sources.set(key, { doc, label: file.name });
        for (let n = 1; n <= doc.numPages; n++) pages.push({ src: key, page: n, rotate: 0, removed: false });
        say('');
      } catch (err) {
        say(`"${file.name}" could not be opened.`);
      }
    }
    render();
  });

  // ── Drawing the pages ──────────────────────────────────────
  async function thumbnail(canvas, entry) {
    const src = sources.get(entry.src);
    if (!src) return;
    const page = await src.doc.getPage(entry.page);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(190 / base.width, 250 / base.height);
    const viewport = page.getViewport({ scale, rotation: (base.rotation + entry.rotate) % 360 });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    await page.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    }).promise;
    page.cleanup();
  }

  function card(entry, index) {
    const wrap = el('div', 'de-card' + (entry.removed ? ' is-removed' : ''));
    wrap.dataset.index = String(index);

    const head = el('div', 'de-card-head');
    head.append(el('span', 'de-pos', entry.removed ? '—' : String(livePosition(index))));
    const from = entry.src === 'current'
      ? `page ${entry.page}`
      : `${sources.get(entry.src).label}, page ${entry.page}`;
    head.append(el('span', 'de-from', from));
    if (entry.src !== 'current') head.append(el('span', 'badge b-blue', 'new'));
    wrap.append(head);

    const shot = el('div', 'de-shot');
    const canvas = document.createElement('canvas');
    shot.append(canvas);
    wrap.append(shot);
    thumbnail(canvas, entry);

    const n = entry.src === 'current' ? (cfg.comments[entry.page] || 0) : 0;
    if (n) {
      const tag = el('span', 'de-comments', `${n} comment${n === 1 ? '' : 's'}`);
      wrap.append(tag);
    }

    const tools = el('div', 'de-tools');
    const button = (label, title, fn, cls) => {
      const b = el('button', 'de-btn' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', `${title}, ${from}`);
      b.addEventListener('click', fn);
      return b;
    };
    if (entry.removed) {
      tools.append(button('Undo', 'Keep this page', () => { entry.removed = false; render(); }, 'is-undo'));
    } else {
      tools.append(
        button('←', 'Move earlier', () => move(index, -1)),
        button('→', 'Move later', () => move(index, 1)),
        button('⟲', 'Turn left', () => { entry.rotate = (entry.rotate + 270) % 360; render(); }),
        button('⟳', 'Turn right', () => { entry.rotate = (entry.rotate + 90) % 360; render(); }),
        button('✕', 'Remove this page', () => removePage(entry, index), 'is-danger'),
      );
    }
    wrap.append(tools);
    return wrap;
  }

  const kept = () => pages.filter(p => !p.removed);
  const livePosition = index => pages.slice(0, index + 1).filter(p => !p.removed).length;

  function move(index, by) {
    const list = pages;
    let j = index + by;
    while (j >= 0 && j < list.length && list[j].removed) j += by;   // step over removed pages
    if (j < 0 || j >= list.length) return;
    const [entry] = list.splice(index, 1);
    list.splice(j, 0, entry);
    render(j);
  }

  function removePage(entry, index) {
    const n = entry.src === 'current' ? (cfg.comments[entry.page] || 0) : 0;
    if (n && !window.confirm(
      `Page ${entry.page} carries ${n} comment${n === 1 ? '' : 's'}. ` +
      'Removing the page keeps the comments, but they will no longer point anywhere in the document. Remove it?')) return;
    if (kept().length <= 1) { say('A document must keep at least one page.'); return; }
    entry.removed = true;
    render();
  }

  function render(focusIndex) {
    const frag = document.createDocumentFragment();
    pages.forEach((entry, i) => frag.append(card(entry, i)));
    grid.replaceChildren(frag);
    const n = kept().length;
    countEl.textContent = `${n} page${n === 1 ? '' : 's'}` +
      (pages.length - n ? `, ${pages.length - n} to be removed` : '');
    saveBtn.disabled = n === 0;
    if (focusIndex != null) {
      const card = grid.querySelector(`.de-card[data-index="${focusIndex}"] .de-btn`);
      if (card) card.focus();
    }
  }

  document.getElementById('deReset').addEventListener('click', () => {
    if (!window.confirm('Undo all the changes on this page?')) return;
    form.querySelectorAll('input[name^="insert_pdf__"]').forEach(i => i.remove());
    sources.forEach((v, k) => { if (k !== 'current') sources.delete(k); });
    nextUpload = 0;
    say('');
    loadOriginal();
  });

  form.addEventListener('submit', e => {
    const plan = kept().map(p => ({ src: p.src, page: p.page, rotate: p.rotate }));
    if (!plan.length) {
      e.preventDefault();
      say('A document must keep at least one page.');
      return;
    }
    pagesField.value = JSON.stringify(plan);
    saveBtn.disabled = true;
  });

  loadOriginal();
}
