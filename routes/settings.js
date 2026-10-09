// Settings — System Administrator only (v57: Google Drive backup).
const express = require('express');
const router  = express.Router();
const settings = require('../controllers/settingsController');
const { requireAuth, requireRole } = require('../middleware/auth');

// Google Drive Backup belongs to the Board Secretary (not the System Administrator).
const admin = [requireAuth, requireRole('secretary')];
router.get ('/drive',            ...admin, settings.show);
router.get ('/drive/connect',    ...admin, settings.connect);
router.get ('/drive/callback',   ...admin, settings.callback);
router.post('/drive/backup-now', ...admin, settings.backupNow);
router.get ('/drive/choose',     ...admin, settings.choose);
router.post('/drive/backup-selected', ...admin, settings.backupSelected);
router.post('/drive/disconnect', ...admin, settings.disconnect);

module.exports = router;
