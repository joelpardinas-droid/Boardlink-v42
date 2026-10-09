// ============================================================
// controllers/archiveController.js — Module 2 + 2.4
//   Module 2:   Digital Archiving
//   Module 2.4: OCR-based Document Processing and Metadata Autofill
// BOARDLINK | Chapter 1 Sec. 1.3 — SO2
// ============================================================
//
// The upload flow now integrates with the OCR service in two
// stages:
//
//   1. User uploads a scanned board document.
//   2. Tesseract OCR extracts text and attempts to identify
//      the document's structured metadata (document number,
//      type, year, date).
//   3. The form is pre-populated with whatever was confidently
//      identified. Fields that could not be read are flagged in
//      `reviewFields` so the Board Secretary can manually correct
//      them before the document is finally archived.

const fs   = require('fs');
const path = require('path');
const Document           = require('../models/Document');
const tesseractService   = require('../services/tesseractService');
const meilisearchService = require('../services/meilisearchService');
const llmService         = require('../services/llmService');
const documentIndexer    = require('../services/documentIndexer');
const documentAccess     = require('../services/documentAccess');
const documentAttachments = require('../services/documentAttachments');

// Module 2 + Module 4 (unified):
//   When the user types in the search box on the Digital Archive
//   page, the query is routed to Meilisearch — the same on-premise
//   AI search engine described in Chapter 1 Module 2.5. Listing
//   without a query returns the standard MySQL-backed catalog.
//   This unifies what were previously two separate search
//   experiences (basic SQL filter on /archive vs Meilisearch on
//   the legacy /ocr/search page) into a single AI-powered search.
exports.list = async (req, res) => {
    const q    = String(req.query.q || '').trim().slice(0, 200);
    // v96: two sections — Board Resolutions (year folders) and Documents
    // (manuals, policies, memoranda, other), each with its own search.
    const section = req.archiveSection === 'documents' ? 'documents' : 'resolutions';
    const DOC_TYPES = section === 'documents' ? ['Manual', 'Policy', 'Memorandum', 'Other'] : ['Resolution'];
    const type = DOC_TYPES.includes(req.query.type) ? req.query.type : '';
    if (section === 'resolutions' && ['Manual', 'Policy', 'Memorandum', 'Other'].includes(req.query.type)) {
        const p = new URLSearchParams(req.query); return res.redirect('/archive/documents?' + p.toString());
    }
    const user = req.session.user;
    const office = documentAccess.isOffice(user);
    const GROUPS = require('../services/agendaArchive').GROUPS;
    const body = GROUPS[req.query.body] ? req.query.body : '';
    const bodies = body ? GROUPS[body] : null;
    let year = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : null;
    // A link to one document (/archive?doc=ID, e.g. from a notification)
    // opens the year folder of that resolution, so its row can be shown.
    if (!year && !q && !type && /^\d+$/.test(String(req.query.doc || ''))) {
        let d = null;
        try {
            [[d]] = await require('../config/db').query('SELECT doc_type, doc_year FROM documents WHERE document_id = ?', [Number(req.query.doc)]);
        } catch (_) { /* no database */ }
        if (d && d.doc_type === 'Resolution' && section === 'resolutions') year = Number(d.doc_year);
        // A manual, policy or memorandum is shown in the Documents section.
        if (d && d.doc_type !== 'Resolution' && section === 'resolutions') {
            const qs = req.originalUrl.indexOf('?') >= 0 ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
            return res.redirect('/archive/documents' + qs);
        }
    }

    // v87: three views of the same archive.
    //   folders — a folder for each year of Board Resolutions;
    //   year    — the Board Resolutions of one year, by number;
    //   search  — everything that matches the search, all years.
    //   documents — (v96) the manuals, policies, memoranda and others.
    const mode = section === 'documents' ? 'documents' : (year ? 'year' : (q ? 'search' : 'folders'));
    let documents = [], years = [], others = [], searchEngine = null;

    try {
        if (mode === 'documents') {
            documents = await Document.findAll({ q, type, notType: 'Resolution', bodies, titleOnly: !office });
            searchEngine = 'database';
        } else if (mode === 'folders') {
            // v93: a folder for every year from 1985 (the first Board
            // Resolutions of CSPC kept here) to this year, even when it is
            // still empty, like folders in Google Drive.
            const counts = new Map((await Document.resolutionYears({ bodies })).map(y => [y.year, y.n]));
            const thisYear = new Date().getFullYear();
            const all = new Set([...counts.keys()]);
            for (let y = FIRST_YEAR; y <= thisYear; y++) all.add(y);
            years = [...all].sort((a, b) => b - a).map(y => ({ year: y, n: counts.get(y) || 0 }));
            // v91: the manuals, policies and memoranda are no longer listed
            // here; they appear under the resolution that approved them and
            // in search (and with the type filter).
        } else if (mode === 'year') {
            documents = await Document.findAll({ q, type: 'Resolution', year, bodies, titleOnly: !office });
            searchEngine = q ? 'database' : null;
        } else if (!office) {
            documents = await Document.findAll({ q, type: 'Resolution', titleOnly: true });
            searchEngine = 'database';
        } else {
            ({ documents, searchEngine } = await officeSearch(q, 'Resolution'));
        }
    } catch (err) {
        console.error('[archive] list:', err.message);
    }

    // The approved documents attached to each resolution, and the
    // resolutions that approved each manual / policy (v87).
    const shown = mode === 'folders' ? others : documents;
    for (const d of shown) if (!d.document_id) d.document_id = d.id;
    await documentAttachments.decorate(shown).catch(err => console.warn('[archive] attachments:', err.message));

    // What a Trustee or council member may open (titles only, v85).
    if (!office) {
        const ids = new Set();
        for (const d of shown) {
            ids.add(Number(d.document_id));
            d.attached.forEach(x => { if (x.document_id) ids.add(Number(x.document_id)); });
            d.approvedBy.forEach(x => { if (x.document_id) ids.add(Number(x.document_id)); });
        }
        const states = await documentAccess.statesFor(user, [...ids]).catch(() => new Map());
        const st = id => states.get(Number(id)) || { state: 'locked' };
        for (const d of shown) {
            d.snippet = '';
            d.access = st(d.document_id);
            d.attached.forEach(x => { x.access = x.kind === 'agenda' ? d.access : st(x.document_id); });
            d.approvedBy.forEach(x => { x.access = st(x.document_id); });
        }
    }

    const notices = {
        sent: 'Your request was sent to the Board Secretary. You will be notified when it is answered.',
        pending: 'You already asked for this document. The Board Secretary has not answered yet.',
        open: 'You can already open this document.',
        locked: 'This document is closed. Ask the Board Secretary for permission to open it.',
    };
    res.render('archive', {
        active: 'archive', tab: section === 'documents' ? 'documents' : 'docs', section, q, type, mode, year, years, body, others, documents,
        resultCount: documents.length, searchEngine,
        member: !office,
        focusDoc: /^\d+$/.test(String(req.query.doc || '')) ? Number(req.query.doc) : null,
        notice: office ? null : (notices[req.query.request] || null),
        error: req.query.error ? String(req.query.error).slice(0, 200) : null,
        accessHours: documentAccess.ACCESS_HOURS(),
    });
};

const FIRST_YEAR = Number(process.env.ARCHIVE_FIRST_YEAR || 1985);

/** The Board Secretary's search: Meilisearch first, the database as a fallback. */
async function officeSearch(q, type) {
    let documents = [];
    let searchEngine = null;   // which path produced the results

    try {
        if (q) {
            // Preferred path: Meilisearch, which searches the full OCR
            // body and ranks by relevance.
            try {
                const hits = await meilisearchService.search(q);
                documents = hits.map(h => ({
                    id:        h.id,
                    title:     h.title,
                    doc_type:  h.type,
                    doc_year:  h.year,
                    category:  h.category || '',
                    snippet:   (h._formatted && (h._formatted.fullText || h._formatted.content)) || h.snippet || '',
                }));
                // Records saved while Meilisearch was down, or created
                // without a scan (drafted resolutions), may be missing
                // from its index. Add any database matches it missed.
                try {
                    const seen = new Set(documents.map(d => String(d.id)));
                    const extra = await Document.findAll({ q, type });
                    for (const r of extra) {
                        if (seen.has(String(r.document_id))) continue;
                        documents.push({ id: r.document_id, title: r.title, doc_type: r.doc_type,
                                         doc_year: r.doc_year, category: r.category || '', snippet: r.snippet || '' });
                    }
                } catch (dbErr) {
                    console.warn('[archive] database search skipped:', dbErr.message);
                }
                if (type) documents = documents.filter(d => d.doc_type === type);
                searchEngine = 'meilisearch';
            } catch (searchErr) {
                // Meilisearch is not running. Previously this produced an
                // empty page, which looks identical to "no such resolution
                // exists" — the worst possible failure for an archive.
                // Fall back to searching MySQL directly instead.
                console.warn('[archive] Meilisearch unavailable, using database search:',
                             searchErr.message);
                documents    = await Document.findAll({ q, type });
                searchEngine = 'database';
            }
        } else {
            documents = await Document.findAll({ q: '', type });
        }
    } catch (err) {
        console.error('[archive] search failed:', err.message);
        documents = [];
    }

    // A search-index entry whose record was deleted from the archive is
    // not shown (it would open a "not found" page).
    if (documents.length) {
        try {
            const pool = require('../config/db');
            const [live] = await pool.query('SELECT document_id FROM documents WHERE document_id IN (?)',
                [documents.map(d => Number(d.id || d.document_id)).filter(Boolean)]);
            const ok = new Set(live.map(r => r.document_id));
            documents = documents.filter(d => ok.has(Number(d.id || d.document_id)));
        } catch (_) { /* keep the list as it is */ }
    }
    return { documents, searchEngine };
}

/** The upload page, with the lists for the "approved document" pickers (v87). */
async function renderUpload(res, data) {
    let picks = { resolutions: [], others: [] };
    try { picks = await documentAttachments.choices(); } catch (_) { /* no database */ }
    // v96: two forms — 'resolution' (Upload Resolution) and 'document'
    // (Upload Documents: manuals, policies, memoranda, other).
    const kind = (data.kind || res.locals.uploadKind) === 'document' ? 'document' : 'resolution';
    return res.render('upload', { picks, savedId: null, savedType: null, attachTo: null, attachedIds: [], ...data, kind });
}

exports.showUpload = async (req, res) => {
    res.locals.uploadKind = req.uploadKind === 'document' || req.query.kind === 'document' ? 'document' : 'resolution';
    // v91: "Add approved documents" from a resolution's page opens this
    // page for that resolution only.
    const forId = parseInt(req.query.for, 10);
    if (forId > 0) {
        let resDoc = null;
        try { resDoc = await Document.findById(forId); } catch (_) { /* no database */ }
        // v93: approved documents are attached inside the resolution itself.
        if (resDoc && resDoc.doc_type === 'Resolution') return res.redirect(`/archive/${forId}#attachments`);
    }
    renderUpload(res, {
        active:  'archive',
        success: null,
        error:   null,
        autofilled: null,
        reviewFields: [],
    });
};

// Module 2.4: When a file is uploaded, run OCR + metadata
// autofill immediately and return the form pre-populated.
exports.processAutofill = async (req, res) => {
    if (!req.file) {
        return renderUpload(res, {
            active:       'archive',
            error:        'Please upload a scanned document.',
            success:      null,
            autofilled:   null,
            reviewFields: [],
        });
    }

    let autofilled   = null;
    let reviewFields = [];

    try {
        const ocr      = await tesseractService.extractText(req.file.path);
        const metadata = tesseractService.extractMetadata(ocr.text);
        autofilled = {
            docTitle:    '',                              // user still provides a human-friendly title
            docType:     metadata.documentType || '',
            docYear:     metadata.year         || '',
            docCategory: metadata.documentNumber || '',   // using doc number as category stub
            uploadedFile: req.file.filename,
            ocrText:     ocr.text,
        };
        reviewFields = metadata.review;
    } catch (_err) {
        // Tesseract failed or is unavailable — still let the user
        // fill in the form manually.
        autofilled = {
            docTitle:    '',
            docType:     '',
            docYear:     '',
            docCategory: '',
            uploadedFile: req.file.filename,
            ocrText:     '',
        };
        reviewFields = ['documentNumber', 'documentType', 'year', 'date'];
    }

    renderUpload(res, {
        active:       'archive',
        success:      null,
        error:        null,
        autofilled,
        reviewFields,
    });
};

// ── Module 2.4: live document analysis (JSON) ────────────────
//
// Called by the upload page as soon as the user picks a file, so
// the Title / Resolution Number / Year / Description fields fill
// themselves in before the form is submitted. Returns JSON rather
// than a re-rendered page so the user never loses what they have
// already typed.
//
// Every field is returned together with the list of fields that
// could NOT be determined (`review`), so the interface can mark
// those for the uploader's attention instead of silently leaving
// them blank. Nothing here is authoritative — the uploader can
// overwrite any field before saving.
exports.analyzeDocument = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'No file received.' });
    }

    // Hard ceiling on OCR. Tesseract can hang rather than fail - most
    // notably when it tries to fetch language data and the server has
    // no route to the internet. A hang would leave the upload page
    // spinning forever, so we time out and fall back to manual entry.
    const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 120000);
    function withTimeout(promise, ms, label) {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)),
        ]);
    }

    let ocrText = '';
    let confidence = null;
    let pagesRead = null, totalPages = null;
    try {
        // Only the first page is read here. The resolution number,
        // title and year all appear on it, and reading an 11-page
        // excerpt in full measured ~9x slower for no extra benefit
        // on this form. Full-text OCR for search runs separately.
        const ocr  = await withTimeout(tesseractService.extractText(req.file.path),
                                       OCR_TIMEOUT_MS, 'OCR');
        ocrText    = ocr.text || '';
        confidence = typeof ocr.confidence === 'number' ? Number(ocr.confidence.toFixed(1)) : null;
        pagesRead  = ocr.pagesRead  || null;
        totalPages = ocr.totalPages || null;
    } catch (err) {
        console.error('[archive analyze] OCR unavailable:', err.message);
        // OCR itself failed (engine missing, unreadable scan). The file
        // is still uploaded; the uploader just fills the form manually.
        return res.json({
            ok: true,
            ocrAvailable: false,
            uploadedFile: req.file.filename,
            fields: { title: '', number: '', year: '', description: '' },
            review: ['title', 'number', 'year', 'description'],
            note:   'Text could not be read from this file. Please enter the details manually.',
        });
    }

    const metadata = tesseractService.extractMetadata(ocrText);
    const title    = tesseractService.extractTitle(ocrText);

    // A CSPC minutes excerpt routinely carries several resolutions
    // (the 85th Regular Meeting excerpt holds 18-35 through 18-41).
    // The archive stores one resolution per record, so surface the
    // full list and let the uploader see exactly what was found
    // rather than silently keeping only the first.
    const resolutions   = tesseractService.extractResolutions(ocrText);
    const meetingHeader = tesseractService.extractMeetingHeader(ocrText);

    // Description: prefer the local LLM for a clean one-liner, but never
    // let a missing/slow Ollama block the upload — fall back to the
    // extractive summary built from the RESOLVED clause.
    let description = '';
    let descriptionSource = 'extractive';
    try {
        const llmText = await withTimeout(llmService.describeDocument(ocrText),
                                          Number(process.env.LLM_TIMEOUT_MS || 60000), 'LLM');
        if (llmText && llmText.trim().length > 15) {
            description = llmText.trim().replace(/^["'“]|["'”]$/g, '');
            descriptionSource = 'llm';
        }
    } catch (_err) {
        // Ollama unavailable — expected in many deployments.
    }
    if (!description) {
        description = tesseractService.buildDescription(ocrText);
    }

    const fields = {
        title:       title || '',
        number:      metadata.documentNumber || '',
        year:        metadata.year || '',
        description: description || '',
    };

    // Report which of the four user-facing fields still need attention.
    const review = Object.entries(fields)
        .filter(([, v]) => !String(v).trim())
        .map(([k]) => k);

    res.json({
        ok: true,
        ocrAvailable: true,
        uploadedFile: req.file.filename,
        confidence,
        fields,
        review,
        descriptionSource,
        pagesRead,
        totalPages,
        meetingHeader,                 // ordinal / kind / date / venue, when it is an excerpt
        resolutions,                   // every resolution found in the file
        resolutionCount: resolutions.length,
        fileName: req.driveName || (req.file && req.file.originalname) || null,
    });
};

/**
 * "Add from Google Drive": the Board Secretary picked a file in Google's
 * picker; the browser sends its id and a short-lived Google permission
 * that covers only that file. BOARDLINK copies it into the archive's own
 * storage and reads it exactly like an uploaded file, so the form fills
 * in the same way.
 */
/**
 * Copies one picked Google Drive file into the archive's own storage
 * (a Word file is turned into a PDF). Returns { path, filename,
 * originalname, mimeType }; throws with a message for the user.
 */
async function copyFromDrive(fileId, accessToken) {
    const drive = require('../services/googleDrive');
    let got;
    try {
        got = await drive.download(String(fileId), accessToken);
    } catch (err) {
        const e = new Error(err.auth || err.status === 401
            ? 'Your Google sign-in has expired. Click "Add from Google Drive" again.'
            : err.status === 403 ? 'Google Drive did not allow BOARDLINK to open that file. Pick it again in the Google Drive window.'
            : err.message);
        e.status = err.status === 404 ? 404 : 400;
        throw e;
    }
    if (got.wasWord) {
        const wordEdit = require('../services/wordEditService');
        const dir = wordEdit.tempDir();
        try {
            const named = path.join(dir, 'document.docx');
            fs.copyFileSync(got.path, named);
            const made = await wordEdit.wordToPdf(named);
            if (!made.ok) throw new Error(made.message);
            fs.copyFileSync(made.path, got.path);
            wordEdit.removeDir(made.dir);
            got.originalname = got.originalname.replace(/\.docx$/i, '') + '.pdf';
        } catch (err) {
            fs.unlink(got.path, () => {});
            const e = new Error(`This Word file could not be turned into a PDF: ${err.message}`); e.status = 400; throw e;
        } finally {
            wordEdit.removeDir(dir);
        }
    }
    return got;
}

exports.driveImport = async (req, res) => {
    const { fileId, accessToken } = req.body || {};
    if (!fileId || !accessToken || typeof accessToken !== 'string' || accessToken.length > 4096) {
        return res.status(400).json({ ok: false, error: 'No Google Drive file was received.' });
    }
    let got;
    try { got = await copyFromDrive(fileId, accessToken); }
    catch (err) {
        console.warn('[archive drive import] failed:', err.message);
        return res.status(err.status || 400).json({ ok: false, error: err.message });
    }
    console.log(`[archive drive import] ${req.session.user.email} imported "${got.originalname}" from Google Drive`);
    req.file = { path: got.path, filename: got.filename, originalname: got.originalname, mimetype: got.mimeType };
    req.driveName = got.originalname;
    return exports.analyzeDocument(req, res);
};

exports.processUpload = async (req, res) => {
    // v91: the form also carries the approved documents' files.
    if (req.files && !req.file) req.file = (req.files.file || [])[0] || null;
    const body = req.body || {};
    const docTitle    = String(body.docTitle || '').trim();
    // v96: the Upload Resolution form saves Board Resolutions only; the
    // Upload Documents form saves a manual, policy, memorandum or other.
    const kind        = body.kind === 'document' || (!body.kind && ['Manual', 'Policy', 'Memorandum', 'Other'].includes(String(body.docType || '').trim())) ? 'document' : 'resolution';
    res.locals.uploadKind = kind;
    const DOC_TYPES   = kind === 'document' ? ['Manual', 'Policy', 'Memorandum', 'Other'] : ['Resolution'];
    const docType     = DOC_TYPES.includes(String(body.docType || '').trim()) ? String(body.docType).trim() : DOC_TYPES[0];
    const docYear     = String(body.docYear || '').trim();
    const docCategory = String(body.docCategory || '').trim();
    const governingBody = Document.GOVERNING_BODIES.includes(body.governingBody) ? body.governingBody : 'Board of Trustees';
    // The file was already stored when it was analysed; its name comes
    // back in the hidden field. A file re-sent with the form is only
    // used when that step did not happen.
    const uploadedFile = /^[a-f0-9]{16,64}$/i.test(String(body.uploadedFile || '')) ? body.uploadedFile : '';
    if (uploadedFile && req.file) { require('fs').unlink(req.file.path, () => {}); req.file = null; }
    // Only a Board Resolution must have a number; a manual may have none.
    if (!docTitle || !docType || !docYear || (docType === 'Resolution' && !docCategory)) {
        return renderUpload(res, {
            active:       'archive',
            error:        'Please fill in all required fields.',
            success:      null,
            autofilled:   null,
            reviewFields: [],
        });
    }
    const filename = uploadedFile || (req.file ? req.file.filename : null);
    let queuedForOcr = false;
    let savedId = null, linkedNote = '';

    try {
        const documentId = await Document.create({
            title:      docTitle,
            docType,
            docYear,
            category:   docCategory || null,
            filename,
            uploadedBy: req.session.user ? req.session.user.id : 0,
            governingBody,
        });
        savedId = documentId;

        // v87: the approved document of a resolution, or the resolution
        // that approved this manual / policy / memorandum.
        // v91: the approved documents chosen on the same page (files from
        // this computer, from Google Drive, and ticked ones).
        if (documentId && docType === 'Resolution') {
            const resDoc = { document_id: documentId, doc_year: Number(docYear), governing_body: governingBody, file_path: filename };
            const r = await addApprovedDocuments(req, resDoc);
            if (r.count) linkedNote = ` ${r.count} approved document${r.count > 1 ? 's were' : ' was'} attached to it.`;
            if (r.error) linkedNote += ` ${r.error}`;
        }
        // A manual / policy / memorandum: the resolution that approved it.
        const picks = documentId && docType !== 'Resolution' ? idList(body.approvedById) : [];
        const linked = [];
        for (const pick of picks) {
            const r = docType === 'Resolution'
                ? await documentAttachments.attach(documentId, pick, req.session.user && req.session.user.id)
                : await documentAttachments.attach(pick, documentId, req.session.user && req.session.user.id);
            if (r.ok) {
                const [[other]] = await require('../config/db').query('SELECT title, category, doc_type FROM documents WHERE document_id = ?', [pick]);
                if (other) linked.push(other);
            }
        }
        if (linked.length) linkedNote = ` It is attached to ${linked.map(o => `Resolution No. ${o.category || o.title}`).join(', ')}.`;

        // Read the whole document and store its text so the resolution
        // becomes searchable by its contents, not just its title. This
        // runs in the background: OCR of a long scan takes tens of
        // seconds and the uploader should not wait for it.
        if (documentId && filename) {
            documentIndexer.indexInBackground({
                document_id: documentId,
                title:       docTitle,
                doc_type:    docType,
                doc_year:    docYear,
                category:    docCategory,
                file_path:   filename,
            });
            queuedForOcr = true;
            // A copy goes to the Google Drive backup folder, when connected.
            require('../services/driveBackup').backupInBackground(documentId);
        }
    } catch (err) {
        // Do not report success when nothing was saved.
        console.error('[archive upload] save failed:', err.message);
        return renderUpload(res.status(500), {
            active:       'archive',
            error:        'The document could not be saved to the archive. Please try again, or ask the System Administrator to check the database.',
            success:      null,
            autofilled:   null,
            reviewFields: [],
        });
    }

    renderUpload(res, {
        active:       'archive',
        success:      (queuedForOcr
            ? `"${docTitle}" was archived. Its full text is being read now and will be searchable shortly.`
            : `"${docTitle}" was archived.`) + linkedNote,
        savedId, savedType: docType,
        error:        null,
        autofilled:   null,
        reviewFields: [],
    });
};

exports.view = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    let doc = null;
    try { if (id > 0) doc = await Document.findById(id); }
    catch (err) {
        console.error('[archive] view:', err.code || err.message);
        return res.status(503).render('404', { active: 'archive' });
    }
    if (!doc) return res.status(404).render('404', { active: 'archive' });

    // v85: a Trustee or council member opens a document only with the
    // Board Secretary's permission (one day).
    let access;
    try { access = await documentAccess.accessFor(req.session.user, doc.document_id); }
    catch (err) { console.error('[archive] access check:', err.message); access = { state: 'locked' }; }
    if (access.state !== 'open') {
        return res.redirect(`/archive?doc=${doc.document_id}&request=locked#doc-${doc.document_id}`);
    }

    const text = String(doc.ocr_text || '').trim();
    const file = doc.file_path ? documentIndexer.resolveFile(doc.file_path) : null;
    res.render('doc-view', {
        active: 'archive',
        doc,
        hasFile: !!file,
        isPdf: !!file && itemPdfIsPdf(file),
        text,
        words: text ? text.split(/\s+/).filter(Boolean).length : 0,
        savedFromOcr: req.query.saved === 'ocr',
        accessUntil: access.office ? null : access.until,
        viaResolution: access.viaResolution || null,
        ...(await attachmentsFor(req.session.user, doc)),
        attachDone: (() => {
            const n = /^\d+$/.test(String(req.query.n || '')) ? Number(req.query.n) : 1;
            const what = n > 1 ? `${n} documents were` : 'The approved document was';
            return { attached: `${what} attached.`, removed: 'The document is no longer attached.',
                     uploaded: `${what} uploaded and attached. ${n > 1 ? 'Their' : 'Its'} words are being read now.` }[req.query.attach] || null;
        })(),
        attachError: req.query.attachError ? String(req.query.attachError).slice(0, 200) : null,
    });
};

/** The archived file itself, shown in the page or downloaded. */
exports.file = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    let doc = null;
    try { if (id > 0) doc = await Document.findById(id); } catch (_) { /* no database */ }
    if (doc) {
        let ok = false;
        try { ok = await documentAccess.hasAccess(req.session.user, doc.document_id); }
        catch (err) { console.error('[archive] access check:', err.message); }
        if (!ok) return res.status(403).send('You need the Board Secretary\'s permission to open this document.');
    }
    const file = doc && doc.file_path ? documentIndexer.resolveFile(doc.file_path) : null;
    // Only files inside uploads/ are ever sent.
    const uploads = require('../config/paths').UPLOAD_DIR + path.sep;
    if (!file || !path.resolve(file).startsWith(uploads)) return res.status(404).send('File not found');
    const pdf = itemPdfIsPdf(file);
    const safe = String(doc.category || `document-${doc.document_id}`).replace(/[^A-Za-z0-9._-]+/g, '_');
    const name = `Resolution_No_${safe}${pdf ? '.pdf' : ''}`;
    res.setHeader('Content-Type', pdf ? 'application/pdf' : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
};

// Kept under its earlier name too.
exports.download = (req, res) => exports.file(req, res);

function itemPdfIsPdf(file) {
    try {
        const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(5);
        fs.readSync(fd, b, 0, 5, 0); fs.closeSync(fd);
        return b.toString('latin1') === '%PDF-';
    } catch (_) { return false; }
}

// ── Meeting Agendas: the agendas of finished meetings ────────
// Closed after the meeting: the Office of the Board Secretary opens
// them; members ask the Office for permission per agenda item.
const agendaArchive = require('../services/agendaArchive');

exports.agendas = async (req, res) => {
    const user = req.session.user;
    const q = String(req.query.q || '').trim().slice(0, 200);
    const office = agendaArchive.isOffice(user);
    const body = office && agendaArchive.GROUPS[req.query.body] ? req.query.body : '';
    let groups = [], failed = false;
    try { groups = await agendaArchive.list(user, { q, body }); }
    catch (err) { console.error('[archive agendas]', err.message); failed = true; }
    const notices = {
        sent: 'Your request was sent to the Office of the Board Secretary. You will be notified when it is answered.',
        pending: 'You already asked for this agenda item. The Office of the Board Secretary has not answered yet.',
        open: 'You can already view this agenda item.',
    };
    res.render('archive-agendas', {
        active: 'archive', tab: 'agendas', groups, q, body, failed,
        bodyCounts: office ? await agendaArchive.groupCounts().catch(() => null) : null,
        memberBody: office ? null : agendaArchive.memberBody(user),
        office: agendaArchive.isOffice(user),
        focusItem: /^\d+$/.test(String(req.query.item || '')) ? Number(req.query.item) : null,
        notice: notices[req.query.request] || null,
        error: req.query.error ? String(req.query.error).slice(0, 200) : null,
        accessDays: agendaArchive.ACCESS_DAYS(),
    });
};

exports.requestAgendaAccess = async (req, res) => {
    const itemId = parseInt(req.params.itemId, 10);
    const back = `/archive/agendas?item=${itemId}`;
    if (!itemId) return res.redirect('/archive/agendas');
    try {
        const r = await agendaArchive.requestAccess(req.session.user, itemId, req.body && req.body.reason);
        if (!r.ok) return res.redirect(`${back}&error=${encodeURIComponent(r.message)}#item-${itemId}`);
        res.redirect(`${back}&request=${r.already || 'sent'}#item-${itemId}`);
    } catch (err) {
        console.error('[archive request access]', err.message);
        res.redirect(`${back}&error=${encodeURIComponent('The request could not be sent. Please try again.')}#item-${itemId}`);
    }
};

exports.accessRequests = async (req, res) => {
    let requests = [], docRequests = [];
    try { requests = await agendaArchive.listRequests(); }
    catch (err) { console.error('[archive requests]', err.message); }
    try { docRequests = await documentAccess.listRequests(); }
    catch (err) { console.error('[archive document requests]', err.message); }
    res.render('archive-requests', {
        active: 'archive', tab: 'requests', requests, docRequests,
        accessHours: documentAccess.ACCESS_HOURS(),
        done: { approved: 'Approved. The member was notified.', declined: 'Declined. The member was notified.',
                gone: 'That request was already answered.' }[req.query.done] || null,
        accessDays: agendaArchive.ACCESS_DAYS(),
    });
};

exports.decideAccessRequest = (approve) => async (req, res) => {
    const id = parseInt(req.params.requestId, 10);
    let ok = false;
    try { ok = id && await agendaArchive.decide(id, req.session.user, approve, req.body && req.body.note); }
    catch (err) { console.error('[archive decide]', err.message); }
    res.redirect(`/archive/requests?done=${ok ? (approve ? 'approved' : 'declined') : 'gone'}#request-${id}`);
};

// ── v85: permission to open a Board Resolution or document ───

exports.requestDocumentAccess = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.redirect('/archive');
    const back = `/archive?doc=${id}`;
    try {
        const r = await documentAccess.requestAccess(req.session.user, id, req.body && req.body.reason);
        if (!r.ok) return res.redirect(`${back}&error=${encodeURIComponent(r.message)}#doc-${id}`);
        res.redirect(`${back}&request=${r.already || 'sent'}#doc-${id}`);
    } catch (err) {
        console.error('[archive request document]', err.message);
        res.redirect(`${back}&error=${encodeURIComponent('The request could not be sent. Please try again.')}#doc-${id}`);
    }
};

exports.decideDocumentRequest = (approve) => async (req, res) => {
    const id = parseInt(req.params.requestId, 10);
    let ok = false;
    try { ok = id && await documentAccess.decide(id, req.session.user, approve, req.body && req.body.note); }
    catch (err) { console.error('[archive decide document]', err.message); }
    res.redirect(`/archive/requests?done=${ok ? (approve ? 'approved' : 'declined') : 'gone'}#doc-request-${id}`);
};

// ── v87: the approved document of a Board Resolution ─────────

/** What the document page shows about attachments, for this user. */
async function attachmentsFor(user, doc) {
    const office = documentAccess.isOffice(user);
    const out = { attached: [], approvedBy: [], picks: null, office };
    try {
        const id = Number(doc.document_id);
        if (doc.doc_type === 'Resolution') out.attached = (await documentAttachments.attachedTo([id])).get(id) || [];
        else out.approvedBy = (await documentAttachments.approvedBy([id])).get(id) || [];
        if (!office) {
            const list = out.attached.concat(out.approvedBy).filter(x => x.document_id);
            const states = await documentAccess.statesFor(user, list.map(x => x.document_id));
            for (const x of list) x.access = states.get(Number(x.document_id)) || { state: 'locked' };
        } else {
            out.picks = await documentAttachments.choices();
        }
    } catch (err) { console.warn('[archive] attachments:', err.message); }
    return out;
}

const backToDoc = (res, id, q) => res.redirect(`/archive/${id}?${new URLSearchParams(q)}#attachments`);

/** A form value that may be one id or several (ticked boxes). */
function idList(v) {
    return [...new Set([].concat(v || []).map(x => parseInt(x, 10)).filter(x => x > 0))].slice(0, 50);
}
const asList = v => [].concat(v === undefined ? [] : v);

/** Attach documents that are already in the archive (one or several, v88). */
exports.attachExisting = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const others = idList((req.body || {}).documentId);
    if (!others.length) return backToDoc(res, id, { attachError: 'Tick the document(s) to attach.' });
    let done = 0, problem = null;
    try {
        const [[doc]] = await require('../config/db').query('SELECT doc_type FROM documents WHERE document_id = ?', [id]);
        if (!doc) return res.status(404).render('404', { active: 'archive' });
        for (const other of others) {
            const r = doc.doc_type === 'Resolution'
                ? await documentAttachments.attach(id, other, req.session.user.id)
                : await documentAttachments.attach(other, id, req.session.user.id);
            if (r.ok) done++; else problem = problem || r.message;
        }
    } catch (err) { console.error('[archive attach]', err.message); problem = 'It could not be attached. Please try again.'; }
    if (!done) return backToDoc(res, id, { attachError: problem || 'Nothing was attached.' });
    backToDoc(res, id, problem ? { attach: 'attached', n: done, attachError: problem } : { attach: 'attached', n: done });
};

/**
 * v91: saves the approved documents of a resolution, from the Upload
 * Document page — files from this computer, files picked in Google Drive,
 * and documents already in the archive that were ticked. Each new file
 * becomes its own archived document attached to the resolution.
 * Returns { count, error }.
 */
async function addApprovedDocuments(req, resDoc) {
    const b = req.body || {};
    const fx = req.files || {};
    // (On the "add to an existing resolution" page the older field names
    // files / file / title / docType / category / docYear are accepted too.)
    const files = [].concat(fx.attFiles || [], fx.files || [], req.attachOnly ? (fx.file || []) : []);
    const titles = asList(b.attTitle !== undefined ? b.attTitle : b.title);
    const types  = asList(b.attType  !== undefined ? b.attType  : (req.attachOnly ? b.docType : undefined));
    const refs   = asList(b.attRef   !== undefined ? b.attRef   : (req.attachOnly ? b.category : undefined));
    const driveIds = asList(b.driveId).map(String).filter(x => /^[A-Za-z0-9_-]{10,200}$/.test(x)).slice(0, 20);
    const token = typeof b.accessToken === 'string' && b.accessToken.length <= 4096 ? b.accessToken : '';
    const ticked = idList(b.approvedDocId);
    // v93: the place in the resolution these documents are attached to.
    const anchor = b.anchorPage ? { page: b.anchorPage, text: b.anchorText, rects: b.anchorRects } : null;
    const drop = () => files.forEach(f => fs.unlink(f.path, () => {}));
    if (driveIds.length && !token) { drop(); return { count: 0, error: 'Your Google sign-in has expired. Click "Add from Google Drive" again.' }; }
    if (files.length + driveIds.length > 20) { drop(); return { count: 0, error: 'Choose up to 20 files at a time.' }; }
    for (const fid of driveIds) {
        try {
            const got = await copyFromDrive(fid, token);
            files.push({ path: got.path, filename: got.filename, originalname: got.originalname, fromDrive: true });
        } catch (err) {
            console.warn('[archive approved drive] failed:', err.message);
            drop(); return { count: 0, error: err.message };
        }
    }
    const TYPES = ['Manual', 'Policy', 'Memorandum', 'Other'];
    const yearIn = b.attYear !== undefined ? b.attYear : (req.attachOnly ? b.docYear : undefined);
    const docYear = /^\d{4}$/.test(String(yearIn || '')) ? Number(yearIn) : resDoc.doc_year;
    const fromName = f => String(f.originalname || 'Approved document').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim();
    let count = 0, error = null;
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const title = (String(titles[i] || '').trim() || fromName(f)).slice(0, 255);
        const docType = TYPES.includes(types[i]) ? types[i] : (TYPES.includes(types[0]) ? types[0] : 'Manual');
        const category = String(refs[i] || '').trim().slice(0, 100) || null;
        try {
            const newId = await Document.create({
                title, docType, docYear, category, filename: f.filename, uploadedBy: req.session.user.id,
                governingBody: resDoc.governing_body || 'Board of Trustees',
            });
            await documentAttachments.attach(resDoc.document_id, newId, req.session.user.id, { anchor });
            documentIndexer.indexInBackground({ document_id: newId, title, doc_type: docType, doc_year: docYear,
                                                category: category || '', file_path: f.filename });
            require('../services/driveBackup').backupInBackground(newId);
            count++;
            console.log(`[archive] ${req.session.user.email} attached "${title}"${f.fromDrive ? ' (from Google Drive)' : ''} to resolution ${resDoc.document_id}`);
        } catch (err) {
            console.error('[archive approved upload]', err.message);
            error = `Only ${count} of ${files.length} file(s) could be saved. Please add the rest again.`;
            break;
        }
    }
    for (const other of ticked) {
        const r = await documentAttachments.attach(resDoc.document_id, other, req.session.user.id, { anchor }).catch(() => ({ ok: false }));
        if (r.ok) count++; else error = error || r.message;
    }

    // v92: pages inside the resolution's own PDF, copied into their own document.
    const pFrom = asList(b.pageFrom), pTo = asList(b.pageTo), pTitle = asList(b.pageTitle), pType = asList(b.pageType);
    if (pFrom.length) {
        const resFile = resDoc.file_path ? documentIndexer.resolveFile(resDoc.file_path) : null;
        for (let i = 0; i < pFrom.length && i < 20; i++) {
            const from = parseInt(pFrom[i], 10), to = parseInt(pTo[i], 10);
            const title = String(pTitle[i] || '').trim().slice(0, 255) || `Approved document (pages ${from}–${to})`;
            const docType = TYPES.includes(pType[i]) ? pType[i] : 'Manual';
            try {
                if (!resFile) throw new Error('This resolution has no PDF file to take pages from.');
                const made = await documentAttachments.copyPages(resFile, from, to);
                const newId = await Document.create({
                    title, docType, docYear, category: null, filename: made.filename, uploadedBy: req.session.user.id,
                    governingBody: resDoc.governing_body || 'Board of Trustees',
                });
                await documentAttachments.attach(resDoc.document_id, newId, req.session.user.id, { source: 'pages', pageFrom: from, pageTo: to, anchor });
                documentIndexer.indexInBackground({ document_id: newId, title, doc_type: docType, doc_year: docYear, category: '', file_path: made.filename });
                require('../services/driveBackup').backupInBackground(newId);
                count++;
                console.log(`[archive] ${req.session.user.email} took pages ${from}-${to} of resolution ${resDoc.document_id} as "${title}"`);
            } catch (err) {
                error = error || err.message;
            }
        }
    }

    // v92: agenda items of past meetings (the papers presented to the Board).
    for (const itemId of idList(b.agendaItemId)) {
        const r = await documentAttachments.attachAgenda(resDoc.document_id, itemId, req.session.user.id, { anchor }).catch(e => ({ ok: false, message: e.message }));
        if (r.ok) count++; else error = error || r.message;
    }
    return { count, error };
}

/**
 * v92: the number of pages of a resolution's PDF, and a guess of where an
 * attached document (ANNEX, MANUAL, GUIDELINES…) starts and ends inside it.
 *   ?file=<stored upload name>  (Upload Document page, before saving)
 *   ?doc=<document id>          (a resolution already archived)
 */
exports.pagesInfo = async (req, res) => {
    let file = null;
    const stored = String(req.query.file || '');
    if (/^[a-f0-9]{16,64}$/i.test(stored)) file = documentIndexer.resolveFile(stored);
    else if (/^\d+$/.test(String(req.query.doc || ''))) {
        const d = await Document.findById(Number(req.query.doc)).catch(() => null);
        if (d && d.file_path) file = documentIndexer.resolveFile(d.file_path);
    }
    if (!file || !itemPdfIsPdf(file)) return res.json({ ok: false, error: 'Pages can only be taken from a PDF resolution.' });
    try {
        const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const task = lib.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, verbosity: 0 });
        const doc = await task.promise;
        const total = doc.numPages, starts = [];
        const { linesFromTextContent } = require('../services/itemTextService');
        const HEAD = /^(annex|appendix|attachment|enclosure)\b|\b(manual|guidelines|policy|policies|handbook|memorandum|code of|curriculum|rules and regulations|implementing rules)\b/i;
        for (let n = 2; n <= Math.min(total, 300); n++) {
            const page = await doc.getPage(n);
            const lines = linesFromTextContent((await page.getTextContent()).items).slice(0, 6);
            page.cleanup();
            const head = lines.find(l => l.length >= 5 && l.length <= 140 && HEAD.test(l) && l === l.toUpperCase());
            if (head) starts.push({ from: n, title: head.replace(/\s+/g, ' ').trim() });
        }
        await task.destroy();
        const guesses = starts.map((g, i) => ({
            from: g.from, to: i + 1 < starts.length ? starts[i + 1].from - 1 : total,
            title: titleCase(g.title),
        }));
        res.json({ ok: true, totalPages: total, guesses });
    } catch (err) {
        console.warn('[archive pages info]', err.message);
        res.json({ ok: false, error: 'This PDF could not be read.' });
    }
};

/**
 * v92: agenda items of past meetings, for linking to a resolution.
 *   ?q=<words>  — search; ?hint=<resolution title> — best matches first.
 */
exports.agendaSearch = async (req, res) => {
    const pool = require('../config/db');
    await agendaArchive.ensureTables();
    const words = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/)
        .filter(w => w.length >= 3 && !STOP.has(w)).slice(0, 12);
    const q = words(req.query.q), hint = words(req.query.hint);
    const where = [], params = [];
    for (const t of q) {
        where.push('(item_title LIKE ? OR meeting_title LIKE ? OR meeting_number LIKE ? OR meeting_type LIKE ?)');
        params.push(`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`);
    }
    const [rows] = await pool.query(
        `SELECT item_id, meeting_id, item_title, item_order, item_category, meeting_title, meeting_type, meeting_number,
                meeting_date, file_kind
           FROM agenda_archive ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY meeting_date DESC, item_order LIMIT 300`, params);
    const score = r => hint.reduce((n, w) => n + (String(r.item_title).toLowerCase().includes(w) ? 1 : 0), 0);
    const list = rows.map(r => ({ ...r, score: score(r) }))
        .sort((a, b) => b.score - a.score || new Date(b.meeting_date) - new Date(a.meeting_date))
        .slice(0, 20)
        .map(r => ({
            itemId: r.item_id, meetingId: r.meeting_id, title: r.item_title, order: r.item_order,
            meeting: `${r.meeting_title || r.meeting_type}${r.meeting_number ? ' · ' + r.meeting_number : ''}`,
            date: r.meeting_date ? new Date(r.meeting_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
            kind: r.file_kind || '', match: r.score > 0,
        }));
    res.json({ ok: true, items: list });
};
/** "ICTU OPERATIONS MANUAL" → "ICTU Operations Manual"; "ANNEX A" → "Annex A". */
function titleCase(t) {
    const small = new Set(['of', 'the', 'and', 'on', 'in', 'for', 'to', 'a', 'an', 'or', 'by', 'at']);
    return String(t).split(/\s+/).map((w, i) => {
        const low = w.toLowerCase();
        if (i > 0 && small.has(low) && w.length > 1) return low;
        if (w.length <= 4 && /^[A-Z0-9-]+$/.test(w) && !small.has(low)) return w;     // ICTU, CSPC, A, 2026
        return low.charAt(0).toUpperCase() + low.slice(1);
    }).join(' ');
}
const STOP = new Set(['the', 'and', 'for', 'approving', 'approval', 'approve', 'of', 'resolution', 'board', 'trustees',
    'camarines', 'sur', 'polytechnic', 'colleges', 'cspc', 'subject', 'with', 'under', 'its', 'this', 'that', 'from', 'revised', 'new']);

exports.detachAgenda = async (req, res) => {
    const id = parseInt(req.params.id, 10), itemId = parseInt(req.params.itemId, 10);
    let ok = false;
    try { ok = await documentAttachments.detachAgenda(id, itemId); } catch (err) { console.error('[archive detach agenda]', err.message); }
    backToDoc(res, id, ok ? { attach: 'removed' } : { attachError: 'It was not linked.' });
};

/**
 * Adds approved documents to a resolution that is already archived
 * (the Upload Document page opened from the resolution's page).
 */
exports.attachUpload = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    let resDoc = null;
    try { resDoc = await Document.findById(id); } catch (_) { /* no database */ }
    const fx = req.files || {};
    const all = [].concat(fx.attFiles || [], fx.files || [], fx.file || []);
    if (!resDoc || resDoc.doc_type !== 'Resolution') {
        all.forEach(f => fs.unlink(f.path, () => {}));
        return backToDoc(res, id, { attachError: 'Approved documents can only be attached to a Board Resolution.' });
    }
    req.attachOnly = true;
    const r = await addApprovedDocuments(req, resDoc);
    if (!r.count) return backToDoc(res, id, { attachError: r.error || 'Choose the approved document(s) first.' });
    backToDoc(res, id, r.error ? { attach: 'uploaded', n: r.count, attachError: r.error } : { attach: 'uploaded', n: r.count });
};

exports.detach = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const other = parseInt(req.params.otherId, 10);
    try {
        // Works from either page: the resolution's or the manual's.
        const ok = await documentAttachments.detach(id, other) || await documentAttachments.detach(other, id);
        return backToDoc(res, id, ok ? { attach: 'removed' } : { attachError: 'It was not attached.' });
    } catch (err) {
        console.error('[archive detach]', err.message);
        backToDoc(res, id, { attachError: 'It could not be removed. Please try again.' });
    }
};
