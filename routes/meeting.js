// ============================================================
// routes/meeting.js — Modules 5, 6, 7, 8
//
// NOTE on URL ordering: specific paths like /create, /summary,
// /transcription must be declared BEFORE the catch-all /:id so
// Express matches them first.
// ============================================================

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const router  = express.Router();

const meetingController = require('../controllers/meetingController');
const reviewController  = require('../controllers/reviewController');
const { requireAuth, requireRole } = require('../middleware/auth');
const { heavyLimiter } = require('../middleware/security');

// Meeting audio for transcription is much larger than a scanned
// document, so it keeps its own higher ceiling.
const MAX_AUDIO_MB = Number(process.env.MAX_AUDIO_UPLOAD_MB || 200);

// Videos attached to agenda items (e.g. the President's Report) are
// large — about 100 MB for every minute of 1080p phone video.
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_UPLOAD_MB || 1024);
const upload = multer({
    dest:   require('../config/paths').UPLOAD_DIR,
    limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024 },
});

// Agenda item PDFs use the document size limit (MAX_UPLOAD_MB), not
// the larger audio one. Only the expected field names are accepted:
// one PDF per agenda row, or a single replacement PDF.
const MAX_DOC_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const MAX_ITEM_FILES = Number(process.env.MAX_ITEM_FILES || 80);
const docUpload = multer({
    dest:   require('../config/paths').UPLOAD_DIR,
    // Browsers send file names as UTF-8; without this, names such as
    // "Peña" or ones containing an en dash arrive garbled.
    defParamCharset: 'utf8',
    // An agenda item may be a VIDEO (e.g. the President's Report), so a
    // file may be as large as a video; PDF and Word files are still held
    // to MAX_UPLOAD_MB when they are checked (itemPdfService.acceptUpload).
    limits: { fileSize: Math.max(MAX_DOC_MB, MAX_VIDEO_MB) * 1024 * 1024, files: MAX_ITEM_FILES },
    fileFilter: (req, file, cb) => {
        const okName = file.fieldname === 'item_pdf'
            || file.fieldname === 'word_file'
            || /^item_pdf__[A-Za-z0-9]{1,16}$/.test(file.fieldname)
            || /^insert_pdf__[A-Za-z0-9]{1,8}$/.test(file.fieldname);
        cb(null, okName);   // unknown fields are skipped, not stored
    },
});

// List all meetings — any authenticated user
router.get ('/', requireAuth, meetingController.list);

// Module 5+6: Create a new meeting (Secretary or admin only)
// Optional uploads, handled by multer:
//   - `item_pdf__<row key>` — one PDF per agenda item, which members
//                             read and comment on inside BOARDLINK
router.get ('/create', requireAuth, requireRole('admin', 'secretary'),
                                    meetingController.showCreate);
router.post('/create', requireAuth, requireRole('admin', 'secretary'),
                                    docUpload.any(),
                                    meetingController.processCreate);

// ── Editing and deleting a meeting (Board Secretary) ─────────
router.get ('/:id/edit',   requireAuth, requireRole('admin', 'secretary'), meetingController.showEdit);
router.post('/:id/edit',   requireAuth, requireRole('admin', 'secretary'),
                           docUpload.any(), meetingController.processEdit);
router.get ('/:id/delete', requireAuth, requireRole('admin', 'secretary'), meetingController.showDelete);
router.post('/:id/delete', requireAuth, requireRole('admin', 'secretary'), meetingController.processDelete);

// ── Agenda item documents and comments ──────────────────────
// Reading an item's PDF and commenting on words or areas in it.
// Access is checked per request in reviewController (meeting
// scoping + the item must belong to the meeting in the URL).
router.get ('/:id/item/:itemId/review', requireAuth, reviewController.showReview);
router.get ('/:id/item/:itemId/file',   requireAuth, reviewController.serveFile);
router.get ('/:id/item/:itemId/pages/:page/text', requireAuth, reviewController.pageText);
router.get ('/:id/item/:itemId/comments', requireAuth, reviewController.listComments);
router.post('/:id/item/:itemId/comments', requireAuth, requireRole('member'),
                                          reviewController.createComment);
// Secretary edits the pages of an item's document (reorder, turn,
// remove, add pages from another PDF) and reads earlier versions.
router.get ('/:id/item/:itemId/document/edit', requireAuth, requireRole('admin', 'secretary'),
                                      reviewController.showDocumentEdit);
router.post('/:id/item/:itemId/document/edit', heavyLimiter, requireAuth, requireRole('admin', 'secretary'),
                                      docUpload.any(), reviewController.processDocumentEdit);
// Secretary corrects the wording itself: the document goes out as a
// Word file and comes back as the item's new PDF. Comments are put
// back on their words (services/reanchorService.js).
router.get ('/:id/item/:itemId/document/words', requireAuth, requireRole('admin', 'secretary'),
                                      reviewController.showWordEdit);
// The paragraphs for the editor on the page. Converting the document
// happens here, not while the page loads.
router.get ('/:id/item/:itemId/document/words/blocks', heavyLimiter, requireAuth,
                                      requireRole('admin', 'secretary'),
                                      reviewController.wordBlocks);
router.get ('/:id/item/:itemId/document/word.docx', heavyLimiter, requireAuth, requireRole('admin', 'secretary'),
                                      reviewController.downloadWord);
// After installing the two programs, look for them again instead of
// restarting the whole application.
router.post('/:id/item/:itemId/document/words/recheck', heavyLimiter, requireAuth,
                                      requireRole('admin', 'secretary'),
                                      reviewController.recheckWordTools);
// Saving accepts either the edited paragraphs as JSON (the editor on
// the page) or a Word file sent back. A long document's paragraphs can
// run past the app-wide 1 MB JSON limit, so this route allows more.
router.post('/:id/item/:itemId/document/words', heavyLimiter, requireAuth, requireRole('admin', 'secretary'),
                                      express.json({ limit: '8mb' }),
                                      docUpload.any(), reviewController.processWordEdit);
router.get ('/:id/item/:itemId/document/v:version.pdf', requireAuth, requireRole('admin', 'secretary'),
                                      reviewController.downloadVersion);

// Secretary attaches or replaces an item's PDF after the meeting exists.
router.post('/:id/item/:itemId/file', heavyLimiter, requireAuth, requireRole('admin', 'secretary'),
                                      docUpload.single('item_pdf'),
                                      reviewController.uploadItemFile);
// An item whose paper is a VIDEO (e.g. the President's Report):
// the video, its subtitles, and comments at a moment in it.
router.get ('/:id/item/:itemId/video',          requireAuth, reviewController.serveVideo);
router.get ('/:id/item/:itemId/video/captions.vtt', requireAuth, reviewController.videoCaptions);
router.get ('/:id/item/:itemId/video/words.txt', requireAuth, reviewController.videoTranscript);
router.get ('/:id/item/:itemId/video/status',   requireAuth, reviewController.videoStatus);
router.post('/:id/item/:itemId/video/retry',    requireAuth, requireRole('admin', 'secretary'),
                                                reviewController.videoRetry);
router.post('/:id/item/:itemId/video/comment',  requireAuth, requireRole('member'),
                                                reviewController.createVideoComment);
// Members edit or delete their own comments (JSON or plain form).
router.post('/:id/comment/:commentId/edit',   requireAuth, requireRole('member'),
                                              reviewController.editComment);
router.post('/:id/comment/:commentId/delete', requireAuth, requireRole('member'),
                                              reviewController.deleteComment);
// Secretary's compiled comments, as Word and as PDF.
router.get ('/:id/comments/compiled.docx', requireAuth, requireRole('admin', 'secretary'),
                                           reviewController.compileDocx);
router.get ('/:id/comments/compiled.pdf',  requireAuth, requireRole('admin', 'secretary'),
                                           reviewController.compilePdf);

// Mark a minutes-correction comment as Addressed (Secretary only).
router.post('/:id/comment/:commentId/addressed',
            requireAuth, requireRole('admin', 'secretary'),
            meetingController.processMarkAddressed);

// Meeting lifecycle — Secretary flips the status to enable the
// in-session comment composer and freeze the meeting at end.
router.post('/:id/start', requireAuth, requireRole('admin', 'secretary'),
                          meetingController.processStartMeeting);
router.post('/:id/end',   requireAuth, requireRole('admin', 'secretary'),
                          meetingController.processEndMeeting);

// Module 7: Transcription (whisper.cpp)
router.get ('/transcription', requireAuth, requireRole('admin', 'secretary'),
                                           meetingController.showTranscription);
router.post('/transcription', requireAuth, requireRole('admin', 'secretary'),
                                           upload.single('audio'),
                                           meetingController.processTranscription);
router.post('/transcription/quick-summary',
                              requireAuth, requireRole('admin', 'secretary'),
                                           meetingController.processQuickSummary);

// Module 8: Formal AI summary
router.get ('/summary', requireAuth, requireRole('admin', 'secretary'),
                                     meetingController.showSummary);
router.post('/summary', requireAuth, requireRole('admin', 'secretary'),
                                     meetingController.processSummary);

// Per-meeting workflow actions (must come before /:id catch-all)
// RSVP removed: the Office of the Board Secretary does not track attendance in BOARDLINK.
router.post('/:id/comment',  requireAuth, meetingController.processItemComment);
// Trustees and council members may request the briefing too: it is a
// reading aid for the people who have to prepare for the meeting, and
// restricting it to the Secretary meant members could not use it at
// all. Visibility is still governed by canSeeMeeting inside the
// handler, so this grants no access to a meeting they could not
// already open.
router.post('/:id/briefing', heavyLimiter, requireAuth,
            requireRole('admin', 'secretary', 'member'),
                                          meetingController.generateBriefing);
// Cancel button while the items are being summarised.
router.post('/:id/briefing/cancel', requireAuth,
            requireRole('admin', 'secretary', 'member'),
                                          meetingController.cancelBriefing);
router.get ('/:id/briefing/status', requireAuth,
            requireRole('admin', 'secretary', 'member'),
                                          meetingController.briefingStatus);

// Generic per-meeting view (must be LAST among /:id routes)
// (The separate meeting-recording box was removed: a video such as the
// President's Report is now attached to its own agenda item.)

router.get ('/:id', requireAuth, meetingController.view);

module.exports = router;
