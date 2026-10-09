// ============================================================
// services/itemVideoService.js — a VIDEO as an agenda item's paper
// ============================================================
//
// Some agenda items are not papers at all: the CSPC President's Report
// to the Board of Trustees, for example, is a recorded video. The Board
// Secretary attaches it to its agenda item exactly like a Word or PDF
// file. BOARDLINK then, in the background:
//
//   1. keeps the video (uploads/recordings/, beside meeting recordings);
//   2. makes an MP4 copy if a browser could not play the original
//      (e.g. an iPhone .MOV in HEVC);
//   3. writes down the words with whisper.cpp, with the time each
//      sentence was said, for the subtitles on the video;
//   4. asks the local AI to summarise the item from those words.
//
// Members watch it on the item's page with the subtitles on, and can
// comment at a moment in the video ("at 2:15").
//
// An item has ONE paper: attaching a video takes the place of its PDF,
// and attaching a PDF or Word file takes the place of its video.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../config/db');
const recording = require('./recordingService');
const transcription = require('./transcriptionService');

const DIR = recording.DIR;

// ── storage ──────────────────────────────────────────────────

let ready = null;
function ensureColumns() {
    if (!ready) {
        ready = (async () => {
            const want = {
                meeting_agenda_items: [
                    ['item_video',          'VARCHAR(80) NULL'],    // stored name in uploads/recordings
                    ['item_video_name',     'VARCHAR(255) NULL'],   // the uploaded file's own name
                    ['item_video_kind',     'VARCHAR(10) NULL'],    // 'video' or 'audio'
                    ['item_video_status',   'VARCHAR(20) NULL'],    // processing | done | failed
                    ['item_video_step',     'VARCHAR(120) NULL'],
                    ['item_video_error',    'VARCHAR(600) NULL'],
                    ['item_video_duration', 'INT NULL'],
                    ['item_video_segments', 'LONGTEXT NULL'],       // JSON [{start,end,text}]
                    ['item_video_text',     'LONGTEXT NULL'],
                ],
                // The moment in the video a comment is about, in seconds.
                meeting_item_comments: [
                    ['video_time', 'DECIMAL(10,2) NULL'],
                ],
            };
            for (const [table, cols] of Object.entries(want)) {
                const [have] = await pool.query(
                    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
                      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
                const names = new Set(have.map(r => r.c));
                for (const [col, def] of cols) {
                    if (names.has(col)) continue;
                    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
                    console.log(`  ✅  Database updated: ${table}.${col} added (videos as agenda items)`);
                }
            }
        })().catch(err => { ready = null; throw err; });
    }
    return ready;
}

async function setFields(itemId, fields) {
    const keys = Object.keys(fields);
    await pool.query(
        `UPDATE meeting_agenda_items SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE item_id = ?`,
        [...keys.map(k => fields[k]), itemId]);
}

async function currentName(itemId) {
    const [[r]] = await pool.query(`SELECT item_video FROM meeting_agenda_items WHERE item_id = ?`, [itemId]);
    return r ? r.item_video : null;
}

/** The sentences of an item's video, [{start, end, text}]. */
function segmentsOf(item) {
    if (!item || !item.item_video_segments) return [];
    try { return JSON.parse(item.item_video_segments) || []; } catch (_) { return []; }
}

// ── accepting an upload ──────────────────────────────────────

const MAX_VIDEO_MB = () => Number(process.env.MAX_VIDEO_UPLOAD_MB || 1024);

/**
 * Looks at an uploaded file that is not a PDF or Word file. When it is a
 * video (or audio) recording, it is moved into uploads/recordings and
 *   { ok: true, video: true, stored, name, kind, probe }
 * is returned; otherwise { ok: false, reason, message }.
 */
function prepare(file) {
    const p = recording.probe(file.path);
    if (p.missing) {
        return { ok: false, reason: 'ffmpeg',
            message: 'ffmpeg is not installed on this server, so videos cannot be read. Install ffmpeg and add it to PATH.' };
    }
    if (!p.ok || (!p.video && !p.audio)) return { ok: false, reason: 'type' };
    if (file.size && file.size > MAX_VIDEO_MB() * 1024 * 1024) {
        return { ok: false, reason: 'size', message: `The video is larger than the ${MAX_VIDEO_MB() >= 1024 ? MAX_VIDEO_MB() / 1024 + ' GB' : MAX_VIDEO_MB() + ' MB'} limit.` };
    }
    const kind = p.video ? 'video' : 'audio';
    fs.mkdirSync(DIR, { recursive: true });
    const ext = (path.extname(file.originalname || '').toLowerCase().match(/^\.[a-z0-9]{2,5}$/)
        || [kind === 'video' ? '.mp4' : '.mp3'])[0];
    const stored = crypto.randomBytes(16).toString('hex') + ext;
    fs.renameSync(file.path, path.join(DIR, stored));
    const name = String(file.originalname || stored).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 250) || stored;
    return { ok: true, video: true, stored, name, kind, probe: p, file };
}

/** Removes a prepared video that ended up unused. */
function discard(up) {
    if (up && up.video && up.stored) recording.removeFile(up.stored);
}

/**
 * Makes a prepared video the item's paper, in place of any PDF or
 * earlier video, and starts writing down its words.
 */
async function attach(itemId, up) {
    await ensureColumns();
    const [[old]] = await pool.query(
        `SELECT item_pdf, item_docx, item_video FROM meeting_agenda_items WHERE item_id = ?`, [itemId]);
    await setFields(itemId, {
        item_video: up.stored, item_video_name: up.name, item_video_kind: up.kind,
        item_video_status: 'processing', item_video_step: 'Waiting to start', item_video_error: null,
        item_video_duration: Math.round(up.probe.duration) || null,
        item_video_segments: null, item_video_text: null,
        // A video takes the place of the item's PDF.
        item_pdf: null, item_pdf_name: null, item_pdf_pages: null, item_pdf_status: null, item_docx: null,
    });
    await pool.query(`DELETE FROM agenda_item_pages WHERE item_id = ?`, [itemId]);
    if (old && old.item_video && old.item_video !== up.stored) recording.removeFile(old.item_video);
    if (old && old.item_pdf) {
        const itemPdf = require('./itemPdfService');
        // Earlier versions of the PDF stay with the item's history; only
        // the current file is no longer used.
        const [[kept]] = await pool.query(
            `SELECT COUNT(*) AS n FROM agenda_item_file_versions WHERE item_id = ? AND item_pdf = ?`, [itemId, old.item_pdf]);
        if (!Number(kept.n)) itemPdf.removeStored(old.item_pdf);
        if (old.item_docx) itemPdf.removeStored(old.item_docx);
    }
    console.log(`[item video] item ${itemId}: ${up.kind} "${up.name}", ${Math.round(up.probe.duration)}s`);
    queue(itemId, up.stored, up.kind, up.probe);
}

/** A PDF or Word file was attached instead: the item's video goes. */
async function clear(itemId) {
    await ensureColumns();
    const name = await currentName(itemId);
    if (!name) return;
    await setFields(itemId, {
        item_video: null, item_video_name: null, item_video_kind: null, item_video_status: null,
        item_video_step: null, item_video_error: null, item_video_duration: null,
        item_video_segments: null, item_video_text: null,
    });
    recording.removeFile(name);
}

// ── processing ───────────────────────────────────────────────

let chain = Promise.resolve();

function queue(itemId, stored, kind, p) {
    chain = chain.then(() => processVideo(itemId, stored, kind, p)).catch(() => {});
    return chain;
}

async function processVideo(itemId, stored, kind, p) {
    const src = path.join(DIR, stored);
    // A newer upload (or a PDF) replaced this one meanwhile: stop.
    const isCurrent = async name => (await currentName(itemId).catch(() => null)) === name;
    try {
        if (!(await isCurrent(stored))) return;
        let playFile = stored;
        if (!recording.browserPlayable(p)) {
            await setFields(itemId, { item_video_step: kind === 'video' ? 'Preparing the video so every browser can play it' : 'Preparing the audio' });
            const out = await recording.makePlayable(src, kind);
            if (!(await isCurrent(stored))) { fs.unlink(out, () => {}); return; }
            playFile = path.basename(out);
            await setFields(itemId, { item_video: playFile });
            fs.unlink(src, () => {});
        }
        if (!p.audio) {
            await setFields(itemId, { item_video_status: 'failed', item_video_step: null,
                item_video_error: 'This video has no sound, so there are no words for subtitles.' });
            return;
        }
        await setFields(itemId, { item_video_step: 'Writing the subtitles' });
        const t0 = Date.now();
        const { text, segments } = await transcription.transcribeTimed(path.join(DIR, playFile));
        if (!(await isCurrent(playFile))) return;
        await setFields(itemId, {
            item_video_text: text || null,
            item_video_segments: JSON.stringify(segments),
            item_video_status: 'done', item_video_step: null,
            item_video_error: text ? null : 'No speech was found in this video.',
        });
        console.log(`[item video] item ${itemId}: ${segments.length} sentence(s) in ${Math.round((Date.now() - t0) / 1000)}s`);
        // Now the item can be summarised from what was said.
        if (text) require('./briefingService').autoSummarize(itemId);
    } catch (err) {
        console.error(`[item video] item ${itemId} failed:`, err.message);
        await setFields(itemId, { item_video_status: 'failed', item_video_step: null,
            item_video_error: String(err.message).slice(0, 590) }).catch(() => {});
    }
}

/** Writes the subtitles again (e.g. after whisper.cpp was fixed). */
async function retry(itemId) {
    await ensureColumns();
    const name = await currentName(itemId);
    const file = recording.filePath(name);
    if (!file) return false;
    const p = recording.probe(file);
    if (!p.ok) return false;
    await setFields(itemId, { item_video_status: 'processing', item_video_step: 'Waiting to start', item_video_error: null });
    queue(itemId, name, p.video ? 'video' : 'audio', p);
    return true;
}

/** Videos left half-done by a restart are started again. */
async function resumePending() {
    try {
        await ensureColumns();
        const [rows] = await pool.query(`SELECT item_id FROM meeting_agenda_items WHERE item_video_status = 'processing'`);
        for (const r of rows) await retry(r.item_id);
        if (rows.length) console.log(`[item video] resuming ${rows.length} video(s)`);
    } catch (_) { /* no database */ }
}

/** Stored video names of these items (for removing them from disk). */
async function filesOf(itemIds) {
    if (!itemIds || !itemIds.length) return [];
    await ensureColumns();
    const [rows] = await pool.query(
        `SELECT item_video FROM meeting_agenda_items WHERE item_id IN (?) AND item_video IS NOT NULL`, [itemIds]);
    return rows.map(r => r.item_video);
}

async function filesOfMeeting(meetingId) {
    await ensureColumns();
    const [rows] = await pool.query(
        `SELECT item_video FROM meeting_agenda_items WHERE meeting_id = ? AND item_video IS NOT NULL`, [meetingId]);
    return rows.map(r => r.item_video);
}

/** "2:15" or "1:02:15". */
function clock(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}

function drain() { return chain; }

module.exports = {
    ensureColumns, prepare, discard, attach, clear, retry, resumePending,
    segmentsOf, filesOf, filesOfMeeting, clock, drain,
    filePath: recording.filePath, removeFile: recording.removeFile, toVtt: recording.toVtt,
};
