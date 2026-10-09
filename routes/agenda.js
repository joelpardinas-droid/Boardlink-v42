// ============================================================
// routes/agenda.js — Back-compat redirect router
//
// As of the workflow merge, Agenda Management is integrated
// into the Meeting workflow (Module 5 is now part of the
// Meeting Records page). All /agenda/* URLs redirect to
// /meeting so any existing bookmarks or external links remain
// functional.
// ============================================================

const express = require('express');
const router  = express.Router();

// A path-less `router.use()` matches every method and every sub-path
// mounted under /agenda, without needing any wildcard path syntax.
// (A bare '/*' pattern was used here previously, but newer versions
// of Express's path-to-regexp dependency reject that syntax outright
// — see https://git.new/pathToRegexpError. `router.use()` sidesteps
// the wildcard-syntax question entirely and works across versions.)
router.use((req, res) => res.redirect('/meeting'));

module.exports = router;
