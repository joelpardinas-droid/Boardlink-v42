// ============================================================
// middleware/logger.js — Request Logger
// ============================================================
// Simple per-request console logger used during development.
// In production this would be replaced by a structured logger.

module.exports = function logger(req, res, next) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ${req.method} ${req.url}`);
    next();
};
