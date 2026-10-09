// ============================================================
// routes/auth.js — Login, Dashboard, Logout
// ============================================================

const express = require('express');
const router  = express.Router();
const authController = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');
const { loginLimiter, loginIpLimiter, codeLimiter } = require('../middleware/security');
const account = require('../controllers/accountController');

router.get ('/',          authController.showLogin);
// loginLimiter counts only FAILED sign-ins, so ordinary use is
// unaffected while password guessing is throttled.
router.post('/login',     loginIpLimiter, loginLimiter, authController.processLogin);
router.get ('/dashboard', requireAuth, authController.showDashboard);
router.get ('/logout',    authController.logout);

// Sign-up with a Gmail code, and "Forgot password?" (v56)
router.get ('/signup',          account.showSignup);
router.post('/signup',          loginIpLimiter, codeLimiter, account.processSignup);
router.post('/signup/verify',   loginIpLimiter, loginLimiter, account.processSignupVerify);
router.get ('/forgot-password', account.showForgot);
router.post('/forgot-password', loginIpLimiter, codeLimiter, account.processForgot);
router.post('/reset-password',  loginIpLimiter, loginLimiter, account.processReset);

// Sign in / sign up with Google
router.get ('/auth/google',          account.startGoogle);
router.get ('/auth/google/callback', loginIpLimiter, account.googleCallback);
router.get ('/signup/google',        account.showGoogleFinish);
router.post('/signup/google',        loginIpLimiter, account.processGoogleFinish);

module.exports = router;
