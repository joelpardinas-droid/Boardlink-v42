// ============================================================
// routes/ocr.js — Module 3 only (OCR Processing)
//
// Note: Module 4 (AI-powered Document Search) is now served by
// the Digital Archive page itself — see routes/archive.js. The
// previously separate /ocr/search endpoint was retired as part
// of unifying the two search experiences into a single AI-powered
// search powered by Meilisearch.
// ============================================================

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const router  = express.Router();

const ocrController = require('../controllers/ocrController');
const { requireAuth, requireRole } = require('../middleware/auth');
const { heavyLimiter } = require('../middleware/security');

// Same ceiling as the Digital Archive upload; see routes/archive.js.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const upload = multer({
    dest:   require('../config/paths').UPLOAD_DIR,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

router.get ('/',        requireAuth, requireRole('admin', 'secretary'),
                                     ocrController.showOcr);
router.post('/process', heavyLimiter, requireAuth, requireRole('admin', 'secretary'),
                                     upload.single('file'),
                                     ocrController.processOcr);
// The corrected words, as a new Word or PDF file, or saved to the archive.
router.post('/download', heavyLimiter, requireAuth, requireRole('admin', 'secretary'),
                                     ocrController.download);
router.post('/save',    heavyLimiter, requireAuth, requireRole('admin', 'secretary'),
                                     ocrController.saveToArchive);

module.exports = router;
