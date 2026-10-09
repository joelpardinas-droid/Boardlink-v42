// ============================================================
// services/recordingService.js — video and audio helpers
// ============================================================
//
// Used by agenda items that are a video or audio recording (for
// example the CSPC President's Report, see itemVideoService.js):
//   • probe()          — length, and whether there is picture and sound;
//   • makePlayable()   — an MP4/M4A copy when a browser cannot play the
//                        file as it is (e.g. an iPhone .MOV in HEVC);
//   • toVtt()          — the spoken words as subtitles for the player.
// The files are kept in UPLOAD_DIR/recordings/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DIR = path.join(require('../config/paths').UPLOAD_DIR, 'recordings');
const FFMPEG = () => process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE_BIN || 'ffprobe';
try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) { /* made when the first video is saved */ }

// ── looking at the file ──────────────────────────────────────

/** Duration, and whether there is a picture / sound, using ffprobe. */
function probe(file) {
    const r = spawnSync(FFPROBE(), ['-v', 'error', '-show_entries',
        'format=format_name,duration:stream=codec_type,codec_name', '-of', 'json', file],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.error) return { ok: false, missing: true };
    if (r.status !== 0) return { ok: false };
    try {
        const j = JSON.parse(r.stdout);
        const streams = j.streams || [];
        const video = streams.find(s => s.codec_type === 'video' && !/^(mjpeg|png|bmp)$/.test(s.codec_name || ''));
        const audio = streams.find(s => s.codec_type === 'audio');
        return {
            ok: true,
            format: String((j.format && j.format.format_name) || ''),
            duration: Number((j.format && j.format.duration) || 0),
            video: video ? video.codec_name : null,
            audio: audio ? audio.codec_name : null,
        };
    } catch (_) { return { ok: false }; }
}

/** Whether Chrome, Edge, Firefox and Safari can all play it as it is. */
function browserPlayable(p) {
    if (p.video) {
        return /mp4|mov/.test(p.format) && p.video === 'h264' && (!p.audio || p.audio === 'aac' || p.audio === 'mp3');
    }
    return /^(mp3|aac|opus|vorbis|pcm_s16le|flac)$/.test(p.audio || '') && !/^(amr|asf|ogg)$/.test(p.format);
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args);
        let err = '';
        child.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-8000); });
        child.on('error', e => reject(e));
        child.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `exit ${code}`)));
    });
}

/** An MP4 (H.264 + AAC, at most 720p) or M4A copy that every browser plays. */
async function makePlayable(src, kind) {
    const out = path.join(DIR, crypto.randomBytes(16).toString('hex') + (kind === 'video' ? '.mp4' : '.m4a'));
    const args = kind === 'video'
        ? ['-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
           '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
           '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]
        : ['-y', '-i', src, '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
    await run(FFMPEG(), args);
    return out;
}

function filePath(stored) {
    if (!stored || !/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/.test(stored)) return null;
    const full = path.join(DIR, stored);
    return fs.existsSync(full) ? full : null;
}

function removeFile(stored) {
    const full = filePath(stored);
    if (full) fs.unlink(full, () => {});
}

/** The words as WebVTT subtitles for the <track> of the video. */
function toVtt(segments) {
    const ts = s => {
        const ms = Math.max(0, Math.round(s * 1000));
        const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
    };
    const list = segments || [];
    return 'WEBVTT\n\n' + list.map((s, i) => {
        // A subtitle ends just before the next one starts; otherwise, at
        // the exact moment they meet, the video shows both at once.
        const next = list[i + 1];
        const end = next ? Math.min(s.end, next.start - 0.001) : s.end;
        return `${i + 1}\n${ts(s.start)} --> ${ts(Math.max(s.start, end))}\n${String(s.text).replace(/-->/g, '→')}\n`;
    }).join('\n');
}

module.exports = { filePath, removeFile, toVtt, probe, browserPlayable, makePlayable, DIR };
