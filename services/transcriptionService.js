// ============================================================
// services/transcriptionService.js — Local Transcription Engine
//
// BOARDLINK | Chapter 3 Sec. 3.6
//   Module 7: AI Meeting Transcription  →  whisper.cpp
// ============================================================
//
// Replaces the earlier OpenAI Whisper API integration with an
// on-premise whisper.cpp binary. Meeting audio is processed
// entirely on the CSPC server — audio files never leave the
// institution's network.
//
// whisper.cpp is a C++ port of OpenAI's Whisper model that runs
// efficiently on CPU-only hardware (no GPU required), which
// matches the hardware specification documented in Chapter 3
// Section 3.5 Table 3.

const { spawn, spawnSync } = require('child_process');
const fs                   = require('fs');
const path                 = require('path');
require('dotenv').config();

const WHISPER_BIN   = process.env.WHISPER_BIN   || 'whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'models/ggml-base.en.bin';
const WHISPER_LANG  = process.env.WHISPER_LANG  || 'en';

/**
 * Some uploaded audio files (MP3, M4A, stereo WAV, 44.1 kHz WAV)
 * are not in whisper.cpp's required input format (16 kHz mono WAV).
 * If ffmpeg is installed, we transparently convert. If it isn't,
 * we throw a clear error explaining what to do.
 */
function preprocessAudio(inputPath) {
    const ext = path.extname(inputPath).toLowerCase();
    // If the file already looks like a WAV, hand it to whisper.cpp directly.
    // whisper.cpp will accept many WAV variants; if it rejects, we'll
    // catch the failure later and the user will see the reason.
    if (ext === '.wav') return inputPath;

    // Otherwise convert with ffmpeg. This also takes the sound out of a
    // VIDEO (MP4, MOV, …): -vn drops the picture, keeping only the audio.
    const wavPath = inputPath + '.16k.wav';
    const result = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', [
        '-y', '-i', inputPath, '-vn',
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        wavPath,
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

    if (result.error) {
        throw new Error(
            `This recording needs to be converted to 16 kHz mono WAV, but ffmpeg is not ` +
            `installed on this server. Install ffmpeg (https://www.gyan.dev/ffmpeg/builds/) ` +
            `and add it to your PATH, or set FFMPEG_BIN in .env.`
        );
    }
    if (result.status !== 0) {
        const why = String(result.stderr || '');
        if (/does not contain any stream|Output file .* does not contain|matches no streams/i.test(why)) {
            throw new Error('This file has no sound to turn into words.');
        }
        throw new Error(`The recording could not be read (ffmpeg: ${why.trim().split('\n').pop() || 'unknown error'}).`);
    }
    return wavPath;
}

/** "00:01:02.500" or "01:02.500" → seconds. */
function toSeconds(stamp) {
    const parts = String(stamp).trim().replace(',', '.').split(':').map(Number);
    return parts.reduce((total, v) => total * 60 + v, 0);
}

/**
 * Reads a WebVTT file (as whisper.cpp writes it with -ovtt) into
 * [{ start, end, text }] with times in seconds.
 */
function parseVtt(vtt) {
    const out = [];
    const blocks = String(vtt).replace(/\r/g, '').split(/\n\s*\n/);
    for (const block of blocks) {
        const lines = block.split('\n').filter(l => l.trim());
        const i = lines.findIndex(l => l.includes('-->'));
        if (i < 0) continue;
        const [from, to] = lines[i].split('-->').map(x => x.trim().split(/\s+/)[0]);
        const text = lines.slice(i + 1).join(' ').replace(/\s+/g, ' ').trim();
        // whisper.cpp marks silence and noise like "[BLANK_AUDIO]" or "(music)".
        if (!text || /^[\[(][^\])]*[\])]$/.test(text)) continue;
        out.push({ start: Math.round(toSeconds(from) * 100) / 100, end: Math.round(toSeconds(to) * 100) / 100, text });
    }
    return out;
}

function checkWhisper() {
    // Sanity-check that the binary and model exist before spawning,
    // so we can give a clear error rather than a confusing exit code.
    if (!fs.existsSync(WHISPER_BIN)) {
        throw new Error(
            `whisper.cpp binary not found at "${WHISPER_BIN}". ` +
            `Check the WHISPER_BIN value in your .env file and confirm the path is correct.`
        );
    }
    if (!fs.existsSync(WHISPER_MODEL)) {
        throw new Error(
            `whisper.cpp model file not found at "${WHISPER_MODEL}". ` +
            `Check the WHISPER_MODEL value in your .env file and confirm the .bin file exists at that path.`
        );
    }
}

/**
 * Transcribes an audio OR video file with the local whisper.cpp binary
 * and returns { text, segments } — segments are the sentences with the
 * time each was said ({ start, end, text }, seconds), which is what
 * lets the words follow along under a playing video.
 *
 * @param {string} mediaPath — absolute path to an audio or video file
 * @param {{ timeoutMs?: number }} [opts]
 */
async function transcribeTimed(mediaPath, { timeoutMs = Number(process.env.WHISPER_TIMEOUT_MS || 2 * 60 * 60 * 1000) } = {}) {
    checkWhisper();
    const wavPath = preprocessAudio(mediaPath);
    const outBase = wavPath + '.out';

    return new Promise((resolve, reject) => {
        const child = spawn(WHISPER_BIN, [
            '-m', WHISPER_MODEL,
            '-f', wavPath,
            '-otxt', '-ovtt',
            '-of', outBase,
            '-l', WHISPER_LANG,
        ]);
        const timer = setTimeout(() => child.kill(), timeoutMs);

        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-10000); });

        child.on('error', (err) => {
            clearTimeout(timer);
            if (wavPath !== mediaPath) fs.unlink(wavPath, () => {});
            reject(new Error(
                `whisper.cpp could not be launched: ${err.code || err.message}. ` +
                `WHISPER_BIN=${WHISPER_BIN}`
            ));
        });

        child.on('close', (code, signal) => {
            clearTimeout(timer);
            // Clean up any temp .wav we created
            if (wavPath !== mediaPath) fs.unlink(wavPath, () => {});
            const cleanup = () => ['.txt', '.vtt'].forEach(e => fs.unlink(outBase + e, () => {}));

            if (signal) {
                cleanup();
                return reject(new Error(`Turning the recording into words took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped.`));
            }
            if (code !== 0) {
                cleanup();
                return reject(new Error(
                    `whisper.cpp exited with code ${code}. ` +
                    `Last stderr: ${stderr.slice(-500).trim() || '(empty)'}`
                ));
            }
            let vtt = '', txt = '';
            try { vtt = fs.readFileSync(outBase + '.vtt', 'utf8'); } catch (_) { /* older whisper.cpp: text only */ }
            try { txt = fs.readFileSync(outBase + '.txt', 'utf8'); } catch (_) { /* ok if vtt exists */ }
            cleanup();
            if (!vtt && !txt) {
                return reject(new Error(`whisper.cpp ran but wrote no output next to ${outBase}.`));
            }
            const segments = parseVtt(vtt);
            const text = (segments.length ? segments.map(s => s.text).join('\n') : txt).trim();
            resolve({ text, segments });
        });
    });
}

/**
 * Transcribes an audio file and returns only the text (the plain
 * transcription page uses this).
 *
 * @param {string} audioPath — absolute path to an audio or video file
 * @returns {Promise<string>} — the transcribed text
 */
async function transcribe(audioPath) {
    return (await transcribeTimed(audioPath)).text;
}

module.exports = { transcribe, transcribeTimed, parseVtt, preprocessAudio };
