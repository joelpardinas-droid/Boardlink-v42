// ============================================================
// services/missingFiles.js — an agenda item whose file is gone
// ============================================================
//
// The database can name a file that is not on this computer — for
// example after a new BOARDLINK version was unzipped into a new folder
// whose "uploads" folder is empty (see config/paths.js, UPLOAD_DIR).
// Such an item is shown as having NO document — no title of a file
// that cannot be opened — and the Secretary is told to attach it again.

const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('../config/paths');

function pdfThere(stored) {
    if (!stored) return false;
    if (String(stored).startsWith('__sample:')) return true;            // demo files
    if (!/^[a-f0-9]{32}$/.test(stored)) return false;
    return fs.existsSync(path.join(UPLOAD_DIR, stored));
}

function videoThere(stored) {
    if (!stored || !/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/.test(stored)) return false;
    return fs.existsSync(path.join(UPLOAD_DIR, 'recordings', stored));
}

/**
 * Changes the item (in memory only — nothing is deleted) so a missing
 * file looks like no file. Returns the item; `missingFile` holds the
 * name of the file that is gone.
 */
function check(item) {
    if (!item) return item;
    if (item.item_pdf && !pdfThere(item.item_pdf)) {
        item.missingFile = item.item_pdf_name || 'the document';
        item.item_pdf = null; item.item_pdf_name = null; item.item_pdf_pages = null;
        item.item_pdf_status = null; item.item_docx = null;
    }
    if (item.item_video && !videoThere(item.item_video)) {
        item.missingFile = item.item_video_name || 'the video';
        item.item_video = null; item.item_video_name = null; item.item_video_status = null;
        item.item_video_segments = null; item.item_video_duration = null;
    }
    return item;
}

function checkAll(items) {
    (items || []).forEach(check);
    return items;
}

module.exports = { check, checkAll, pdfThere, videoThere };
