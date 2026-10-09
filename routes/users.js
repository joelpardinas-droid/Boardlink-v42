// ============================================================
// routes/users.js — Module 1: User & Access Management
// Only the System Administrator may manage user accounts. Any
// authenticated user can view a profile page (their own).
// ============================================================

const express = require('express');
const router  = express.Router();
const userController = require('../controllers/userController');
const { requireAuth, requireRole } = require('../middleware/auth');

// Listing and creation: admin only
router.get ('/',     requireAuth, requireRole('admin'), userController.list);
router.get ('/add',  requireAuth, requireRole('admin'), userController.showAdd);
router.post('/add',  requireAuth, requireRole('admin'), userController.processAdd);
// User Account Logs (v86): sign-ups, approvals, changes, removals, sign-ins.
router.get ('/logs', requireAuth, requireRole('admin'), userController.logs);

// Profile view: any authenticated user (in practice, the topbar
// links to one's own profile; admins can also view others).
router.get ('/:id',  requireAuth, userController.view);

// Approving sign-ups, removing people (e.g. retired from a council),
// changing account types — System Administrator only. An account made by
// mistake is deleted by choosing that reason under Remove from BOARDLINK.
const admin = [requireAuth, requireRole('admin')];
router.post('/:id/approve',    ...admin, userController.approve);
router.post('/:id/reject',     ...admin, userController.reject);
router.post('/:id/retire',     ...admin, userController.retire);
router.post('/:id/reactivate', ...admin, userController.reactivate);
router.post('/:id/type',       ...admin, userController.changeType);

module.exports = router;
