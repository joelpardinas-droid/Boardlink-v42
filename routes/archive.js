// ============================================================
// routes/archive.js — Module 2: Digital Archiving
// ============================================================

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const router  = express.Router();

const archiveController = require('../controllers/archiveController');
const { requireAuth, requireRole } = require('../middleware/auth');
const { heavyLimiter } = require('../middleware/security');

// File uploads are stored on the application server's local
// filesystem under /uploads. In production this would be mounted
// on persistent storage or replaced by an object store.
// Document uploads (scanned resolutions for OCR). Default 100 MB:
// a 300 DPI grayscale scan runs roughly 1-3 MB per page, so this
// comfortably covers a long minutes excerpt. Override with
// MAX_UPLOAD_MB in .env if the Board Secretary's scanner produces
// larger files.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const upload = multer({
    dest:   require('../config/paths').UPLOAD_DIR,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// The number of waiting access requests, for the Office's tab.
router.use(async (req, res, next) => {
    const u = req.session && req.session.user;
    if (u && ['admin', 'secretary'].includes(u.role)) {
        const [a, d] = await Promise.all([
            require('../services/agendaArchive').pendingCount().catch(() => 0),
            require('../services/documentAccess').pendingCount().catch(() => 0),
        ]);
        res.locals.pendingRequests = a + d;
    }
    next();
});

router.get ('/',        requireAuth, archiveController.list);
router.get ('/documents/upload', requireAuth, requireRole('admin', 'secretary'),
             (req, res, next) => { req.uploadKind = 'document'; next(); }, archiveController.showUpload);
router.get ('/documents', requireAuth, (req, res, next) => { req.archiveSection = 'documents'; next(); }, archiveController.list);
// Meeting Agendas: the agendas of finished meetings, closed to members
// unless the Office of the Board Secretary approves a request.
router.get ('/agendas', requireAuth, archiveController.agendas);
router.post('/agendas/:itemId/request', requireAuth, requireRole('member'),
                                     archiveController.requestAgendaAccess);
router.get ('/requests', requireAuth, requireRole('admin', 'secretary'),
                                     archiveController.accessRequests);
router.post('/requests/:requestId/approve', requireAuth, requireRole('admin', 'secretary'),
                                     archiveController.decideAccessRequest(true));
router.post('/requests/:requestId/decline', requireAuth, requireRole('admin', 'secretary'),
                                     archiveController.decideAccessRequest(false));
// v85: Board Resolutions and documents are closed to members too; they
// ask the Board Secretary, who opens one document to them for one day.
router.post('/doc-requests/:requestId/approve', requireAuth, requireRole('admin', 'secretary'),
                                     archiveController.decideDocumentRequest(true));
router.post('/doc-requests/:requestId/decline', requireAuth, requireRole('admin', 'secretary'),
                                     archiveController.decideDocumentRequest(false));
router.post('/:id(\\d+)/request', requireAuth, requireRole('member'),
                                     archiveController.requestDocumentAccess);
router.get ('/upload',  requireAuth, requireRole('admin', 'secretary'),
                                     archiveController.showUpload);
// Module 2.4: OCR + metadata autofill runs when the user uploads
// a file. The form is then re-rendered with the extracted fields
// pre-filled and any low-confidence fields flagged for review.
router.post('/autofill',requireAuth, requireRole('admin', 'secretary'),
                                     upload.single('file'),
                                     archiveController.processAutofill);
// Module 2.4: JSON endpoint used by the upload page to analyse a
// freshly-chosen file and return the detected title, resolution
// number, year and description for autofill.
router.post('/analyze', heavyLimiter, requireAuth, requireRole('admin', 'secretary'),
                                     upload.single('file'),
                                     archiveController.analyzeDocument);
// The upload form is multipart/form-data (it also carries the file
// input), so multer must parse it; without it req.body is empty and
// every save failed with "Please fill in all required fields".
router.post('/upload', heavyLimiter,  requireAuth, requireRole('admin', 'secretary'),
                                     // v91: also the approved documents of a resolution (up to 20)
                                     upload.fields([{ name: 'file', maxCount: 1 }, { name: 'attFiles', maxCount: 20 }]),
                                     archiveController.processUpload);
// "Add from Google Drive": copy a picked Drive file into the archive (v57).
router.post('/drive-import', heavyLimiter, requireAuth, requireRole('admin', 'secretary'),
                                     archiveController.driveImport);
// v87: the approved document (manual, policy, memorandum) of a resolution.
router.post('/:id(\\d+)/attach', requireAuth, requireRole('admin', 'secretary'),
                                     archiveController.attachExisting);
router.post('/:id(\\d+)/attach-upload', heavyLimiter, requireAuth, requireRole('admin', 'secretary'),
                                     upload.fields([{ name: 'attFiles', maxCount: 20 }, { name: 'files', maxCount: 20 }, { name: 'file', maxCount: 1 }]),
                                     archiveController.attachUpload);
router.post('/:id(\\d+)/detach/:otherId(\\d+)', requireAuth, requireRole('admin', 'secretary'),
                                     archiveController.detach);
// v92: pages inside a resolution's PDF, and agenda items of past meetings.
router.get ('/pages-info', requireAuth, requireRole('admin', 'secretary'), archiveController.pagesInfo);
router.get ('/agenda-search', requireAuth, requireRole('admin', 'secretary'), archiveController.agendaSearch);
router.post('/:id(\\d+)/detach-agenda/:itemId(\\d+)', requireAuth, requireRole('admin', 'secretary'),
                                     archiveController.detachAgenda);
router.get ('/:id/file', requireAuth, archiveController.file);
router.get ('/:id',     requireAuth, archiveController.view);

module.exports = router;
