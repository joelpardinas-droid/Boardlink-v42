// ============================================================
// public/js/item-word-edit.js — correcting the words on the page
// ============================================================
//
// The Board Secretary opens this and BOARDLINK shows the document's
// paragraphs, ready to correct, with the members' comments beside
// them. Only the paragraphs she actually changes are sent back, so the
// rest of the document is left exactly as it was.
//
// Each paragraph is its own editable box rather than one long editable
// area: that keeps the text easy to read back, lets a comment be
// pointed at its own paragraph, and means a stray keystroke cannot
// merge two paragraphs together.

const cfgEl = document.getElementById('weData');
const cfg = cfgEl ? JSON.parse(cfgEl.textContent) : { ready: false };

const $ = id => document.getElementById(id);
const blocksEl   = $('weBlocks');
const statusEl   = $('weStatus');
const changedEl  = $('weChanged');
const saveBtn    = $('weSave');
const undoBtn    = $('weUndo');
const errorEl    = $('weError');
const commentsEl = $('weComments');

const state = {
    version: null,
    original: new Map(),     // block id → the words as they arrived
    boxes: new Map(),        // block id → the editable element
    saving: false,
};

// ── small helpers ────────────────────────────────────────────

function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
    errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function clearError() { if (errorEl) errorEl.hidden = true; }

function setStatus(text, spinning) {
    if (!statusEl) return;
    statusEl.innerHTML = '';
    if (spinning) {
        const s = document.createElement('span');
        s.className = 'we-spin';
        s.setAttribute('aria-hidden', 'true');
        statusEl.append(s);
    }
    statusEl.append(document.createTextNode(text));
}

const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ── loading the document ─────────────────────────────────────

async function load() {
    if (!cfg.ready || !blocksEl) return;
    try {
        const res = await fetch(cfg.blocksUrl, { headers: { accept: 'application/json' } });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            blocksEl.innerHTML = '';
            setStatus('This document could not be opened for editing.', false);
            showError(body.error || 'This document could not be opened for editing.');
            return;
        }
        state.version = body.version;
        render(body.blocks || []);
        markComments(body.comments || []);
        const n = state.boxes.size;
        setStatus(`${n} paragraph${n === 1 ? '' : 's'} ready to edit.`, false);
        if (saveBtn) saveBtn.disabled = true;
    } catch (err) {
        blocksEl.innerHTML = '';
        setStatus('This document could not be opened for editing.', false);
        showError('BOARDLINK could not reach the server. Check the connection and reload the page.');
    }
}

function render(blocks) {
    blocksEl.innerHTML = '';
    state.original.clear();
    state.boxes.clear();

    const shown = blocks.filter(b => norm(b.text).length > 0);
    if (!shown.length) {
        const p = document.createElement('p');
        p.className = 'we-loading';
        p.textContent = 'No editable words were found in this document.';
        blocksEl.append(p);
        return;
    }

    for (const b of shown) {
        const row = document.createElement('div');
        row.className = 'we-row';
        row.dataset.id = b.id;

        const box = document.createElement('div');
        box.className = 'we-box';
        box.contentEditable = 'true';
        box.spellcheck = true;
        box.setAttribute('role', 'textbox');
        box.setAttribute('aria-multiline', 'true');
        box.setAttribute('aria-label', 'Paragraph of the document');
        box.dataset.id = b.id;
        // A paragraph can hold several lines (the document's own line
        // breaks); they are kept as real line breaks in the box.
        box.textContent = b.text;

        const flag = document.createElement('span');
        flag.className = 'we-row-flag';
        flag.hidden = true;

        row.append(flag, box);
        blocksEl.append(row);
        state.original.set(b.id, b.text);
        state.boxes.set(b.id, box);

        box.addEventListener('input', onEdit);
        box.addEventListener('blur', onEdit);
        // Enter makes a new line inside the paragraph, never a new
        // paragraph: paragraphs are added in Word, not here.
        box.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                insertNewline(box);
            }
        });
        // Paste as plain words, so formatting from elsewhere cannot
        // sneak into the document.
        box.addEventListener('paste', e => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData).getData('text');
            insertText(box, String(text || '').replace(/\r\n?/g, '\n'));
        });
    }
}

function insertText(box, text) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) { box.textContent += text; onEdit(); return; }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    onEdit();
}

function insertNewline(box) { insertText(box, '\n'); }

/** What the box says now, with its line breaks. */
function textOf(box) {
    // innerText gives the line breaks as the person sees them; the
    // fallback keeps things working if it is unavailable.
    const text = box.innerText !== undefined ? box.innerText : box.textContent;
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/ /g, ' ');
}

// ── tracking what changed ────────────────────────────────────

function changedIds() {
    const out = [];
    for (const [id, box] of state.boxes) {
        if (textOf(box) !== state.original.get(id)) out.push(id);
    }
    return out;
}

function onEdit() {
    const changed = changedIds();
    for (const [id, box] of state.boxes) {
        box.closest('.we-row').classList.toggle('is-changed', changed.includes(id));
    }
    if (changedEl) {
        changedEl.hidden = changed.length === 0;
        changedEl.textContent = changed.length
            ? `${changed.length} paragraph${changed.length === 1 ? '' : 's'} changed`
            : '';
    }
    if (saveBtn) saveBtn.disabled = changed.length === 0 || state.saving;
    if (undoBtn) undoBtn.hidden = changed.length === 0;
    warnOnChangedQuotes(changed);
}

/** Tells her when she has just changed words a comment was made on. */
function warnOnChangedQuotes(changed) {
    for (const card of commentsEl ? commentsEl.querySelectorAll('.we-c') : []) {
        const id = card.dataset.blockId;
        const where = card.querySelector('.we-c-where');
        if (!id || !where) continue;
        const box = state.boxes.get(id);
        if (!box) continue;
        const quote = norm(card.dataset.quote).toLowerCase();
        const gone = quote.length > 3 && !norm(textOf(box)).toLowerCase().includes(quote);
        card.classList.toggle('is-touched', changed.includes(id));
        card.classList.toggle('is-gone', gone);
        if (gone) {
            where.hidden = false;
            where.textContent = 'These words are no longer in the paragraph. '
                + 'This comment will be kept and marked, with its old words still shown.';
        } else if (changed.includes(id)) {
            where.hidden = false;
            where.textContent = 'You changed this paragraph; the words above are still in it.';
        } else {
            where.hidden = true;
        }
    }
}

// ── linking a comment to its paragraph ───────────────────────

function markComments(comments) {
    for (const c of comments) {
        const card = commentsEl && commentsEl.querySelector(`.we-c[data-id="${c.id}"]`);
        if (!card) continue;
        if (c.blockId && state.boxes.has(c.blockId)) {
            card.dataset.blockId = c.blockId;
            card.classList.add('is-linked');
            const row = state.boxes.get(c.blockId).closest('.we-row');
            const flag = row.querySelector('.we-row-flag');
            const n = Number(row.dataset.comments || 0) + 1;
            row.dataset.comments = String(n);
            row.classList.add('has-comment');
            flag.hidden = false;
            flag.textContent = n === 1 ? '1 comment' : `${n} comments`;
            flag.title = 'A member commented on words in this paragraph';
        }
        card.addEventListener('click', () => focusComment(card));
    }
}

function focusComment(card) {
    for (const other of commentsEl.querySelectorAll('.we-c')) other.classList.remove('is-active');
    card.classList.add('is-active');
    for (const row of blocksEl.querySelectorAll('.we-row')) row.classList.remove('is-pointed');
    const id = card.dataset.blockId;
    if (!id || !state.boxes.has(id)) return;
    const row = state.boxes.get(id).closest('.we-row');
    row.classList.add('is-pointed');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── saving ───────────────────────────────────────────────────

async function save() {
    if (state.saving) return;
    const changed = changedIds();
    if (!changed.length) return;
    clearError();
    state.saving = true;
    saveBtn.disabled = true;
    const label = saveBtn.textContent;
    saveBtn.textContent = 'Saving — this takes a few seconds…';
    setStatus('Writing your words back into the document…', true);

    const edits = changed.map(id => ({ id, text: textOf(state.boxes.get(id)) }));
    try {
        const res = await fetch(cfg.saveUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ version: state.version, edits }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.to) {
            window.removeEventListener('beforeunload', guard);
            window.location.assign(body.to);
            return;
        }
        state.saving = false;
        saveBtn.disabled = false;
        saveBtn.textContent = label;
        setStatus('Not saved.', false);
        showError(body.error || 'The changes could not be saved.');
        if (body.stale) {
            const again = document.createElement('p');
            again.innerHTML = '<a href="">Reload this page</a> to start from the latest version. '
                + 'Copy anything you still need first.';
            errorEl.append(again);
        }
    } catch (err) {
        state.saving = false;
        saveBtn.disabled = false;
        saveBtn.textContent = label;
        setStatus('Not saved.', false);
        showError('BOARDLINK could not reach the server. Your changes are still on this page — try Save again.');
    }
}

function undo() {
    if (!confirm('Put every paragraph back the way it was? Your changes on this page will be lost.')) return;
    for (const [id, box] of state.boxes) box.textContent = state.original.get(id);
    onEdit();
    clearError();
}

// Nobody should lose a correction by closing the tab.
function guard(e) {
    if (state.saving || !changedIds().length) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
}

// ── the Word download and send-back, below the editor ────────

const upInput = $('weFile');
const upLabel = $('weFileLabel');
const upForm  = $('weUpForm');
const upSave  = $('weUpSave');
if (upInput && upForm) {
    const idle = upLabel ? upLabel.textContent : '';
    upInput.addEventListener('change', () => {
        const file = upInput.files && upInput.files[0];
        if (upLabel) upLabel.textContent = file ? file.name : idle;
        if (file && !/\.docx$/i.test(file.name)) {
            showError('Please choose the .docx file you saved from Word.');
            upInput.value = '';
            if (upLabel) upLabel.textContent = idle;
        }
    });
    upForm.addEventListener('submit', e => {
        if (!upInput.files || !upInput.files.length) {
            e.preventDefault();
            showError('Choose the edited Word file first.');
            return;
        }
        if (changedIds().length &&
            !confirm('You have unsaved changes on this page. Sending the Word file back will replace the '
                   + 'document and those changes will be lost. Continue?')) {
            e.preventDefault();
            return;
        }
        window.removeEventListener('beforeunload', guard);
        if (upSave) {
            upSave.disabled = true;
            upSave.textContent = 'Saving…';
        }
    });
}

if (saveBtn) saveBtn.addEventListener('click', save);
if (undoBtn) undoBtn.addEventListener('click', undo);
window.addEventListener('beforeunload', guard);
load();
