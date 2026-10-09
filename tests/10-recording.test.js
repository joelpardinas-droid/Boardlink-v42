// Module: AI Meeting Transcription — a VIDEO as an agenda item (e.g. the
// CSPC President's Report), with subtitles and comments at a moment in it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { login } = require('./helpers');
const { parseVtt } = require('../services/transcriptionService');
const recordings = require('../services/recordingService');
const pool = require('../config/db');

describe('Reading whisper.cpp timed output (WebVTT)', () => {
    const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:04.200\n Good morning, members of the Board.\n\n' +
                '00:00:04.200 --> 00:00:05.000\n [BLANK_AUDIO]\n\n' +
                '00:01:05.500 --> 00:01:09.000\n I fully support this budget.\n';
    test('keeps each sentence with the time it was said', () => {
        expect(parseVtt(vtt)).toEqual([
            { start: 0, end: 4.2, text: 'Good morning, members of the Board.' },
            { start: 65.5, end: 69, text: 'I fully support this budget.' },
        ]);
    });
    test('leaves out silence markers such as [BLANK_AUDIO]', () => {
        expect(parseVtt(vtt).some(s => /BLANK/.test(s.text))).toBe(false);
    });
});

describe('Subtitles for the video player', () => {
    test('a subtitle ends before the next begins, so two never show at once', () => {
        const out = recordings.toVtt([
            { start: 0, end: 3, text: 'One.' }, { start: 3, end: 6, text: 'Two.' },
        ]);
        expect(out).toContain('00:00:00.000 --> 00:00:02.999');
        expect(out).toContain('00:00:03.000 --> 00:00:06.000');
    });
});

describe('Which files the browser can play as they are', () => {
    test('an H.264 MP4 is kept; an iPhone HEVC .MOV is converted', () => {
        expect(recordings.browserPlayable({ format: 'mov,mp4,m4a', video: 'h264', audio: 'aac' })).toBe(true);
        expect(recordings.browserPlayable({ format: 'mov,mp4,m4a', video: 'hevc', audio: 'aac' })).toBe(false);
    });
});

// ── A video attached to an agenda item, end to end ──────────
describe("The President's Report as a video agenda item", () => {
    let clip, meetingId, videoItemId, pdfItemId, commentId;
    const number = `TEST-VID-${Date.now()}`;

    beforeAll(async () => {
        // A 12-second video with sound, made with ffmpeg.
        clip = path.join(os.tmpdir(), `president-report-${process.pid}.mp4`);
        const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '12',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
        if (r.status !== 0) throw new Error('ffmpeg is needed for this test');

        const { agent, ip } = await login('secretary');
        const [[sec]] = await pool.query(`SELECT user_id FROM users WHERE email = 'boardlink.secretary.demo@gmail.com'`);
        const res = await agent.post('/meeting/create').set('X-Forwarded-For', ip)
            .field('title', 'Video agenda test').field('meeting_type', 'Board of Trustees')
            .field('meeting_number', number).field('meeting_date', '2030-01-15').field('meeting_time', '09:00')
            .field('venue', 'Board Room').field('mode', 'In-Person')
            .field('called_by_user_id', String(sec.user_id)).field('presided_by_user_id', String(sec.user_id))
            .field('quorum_required', '7')
            .field('item_title', "President's Report").field('item_category', 'For Information').field('item_key', 'r1')
            .field('item_title', 'Other paper').field('item_category', 'For Information').field('item_key', 'r2')
            .attach('item_pdf__r1', clip, "President's Report.mp4");
        expect(res.statusCode).toBe(302);
        meetingId = Number((/\/meeting\/(\d+)/.exec(res.headers.location) || [])[1]);
        expect(meetingId).toBeGreaterThan(0);
        const [items] = await pool.query(`SELECT * FROM meeting_agenda_items WHERE meeting_id = ? ORDER BY item_order`, [meetingId]);
        videoItemId = items[0].item_id;
        pdfItemId = items[1].item_id;

        // Wait for the subtitles to be written (whisper.cpp in the background).
        for (let k = 0; k < 120; k++) {
            const [[row]] = await pool.query(`SELECT item_video_status FROM meeting_agenda_items WHERE item_id = ?`, [videoItemId]);
            if (row.item_video_status !== 'processing') break;
            await new Promise(r => setTimeout(r, 1000));
        }
    }, 180000);

    afterAll(async () => {
        if (clip) fs.unlink(clip, () => {});
        if (meetingId) {
            const { agent, ip } = await login('secretary');
            await agent.post(`/meeting/${meetingId}/delete`).set('X-Forwarded-For', ip)
                .type('form').send({ confirm_number: number });
        }
    });

    test('the video becomes the item\'s paper, and its subtitles are written', async () => {
        const [[row]] = await pool.query(`SELECT * FROM meeting_agenda_items WHERE item_id = ?`, [videoItemId]);
        expect(row.item_video).toMatch(/^[a-f0-9]{32}\.mp4$/);
        expect(row.item_video_name).toBe("President's Report.mp4");
        expect(row.item_pdf).toBeNull();
        expect(row.item_video_status).toBe('done');
        expect(JSON.parse(row.item_video_segments).length).toBeGreaterThan(0);
    });

    test('a Trustee sees "Watch & comment" on the meeting page', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get(`/meeting/${meetingId}`).set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('Watch &amp; comment');
        expect(res.text).toContain("President&#39;s Report.mp4");
    });

    test('the item page plays the video with subtitles on it', async () => {
        const { agent, ip } = await login('trustee');
        const page = await agent.get(`/meeting/${meetingId}/item/${videoItemId}/review`).set('X-Forwarded-For', ip);
        expect(page.statusCode).toBe(200);
        expect(page.text).toMatch(/<video id="ivMedia"/);
        expect(page.text).toMatch(/<track kind="captions"[^>]*default/);
        expect(page.text).not.toContain('Edit the words');
        const vtt = await agent.get(`/meeting/${meetingId}/item/${videoItemId}/video/captions.vtt`).set('X-Forwarded-For', ip);
        expect(vtt.text.startsWith('WEBVTT')).toBe(true);
        const media = await agent.get(`/meeting/${meetingId}/item/${videoItemId}/video`)
            .set('X-Forwarded-For', ip).set('Range', 'bytes=0-99');
        expect(media.statusCode).toBe(206);
    });

    test('a Trustee comments at a moment in the video ("at 0:07")', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.post(`/meeting/${meetingId}/item/${videoItemId}/video/comment`).set('X-Forwarded-For', ip)
            .type('form').send({ text: 'Please clarify the budget figure here.', use_time: '1', video_time: '7.4' });
        expect(res.statusCode).toBe(302);
        commentId = Number((/#comment-(\d+)/.exec(res.headers.location) || [])[1]);
        const [[c]] = await pool.query(`SELECT video_time FROM meeting_item_comments WHERE comment_id = ?`, [commentId]);
        expect(Number(c.video_time)).toBeCloseTo(7.4);
        const page = await agent.get(`/meeting/${meetingId}/item/${videoItemId}/review`).set('X-Forwarded-For', ip);
        expect(page.text).toContain('at 0:07');
        const meeting = await agent.get(`/meeting/${meetingId}`).set('X-Forwarded-For', ip);
        expect(meeting.text).toContain('Show in video');
    });

    test('the Secretary presses Done there and stays on the video page', async () => {
        const { agent, ip } = await login('secretary');
        const back = `/meeting/${meetingId}/item/${videoItemId}/review`;
        const res = await agent.post(`/meeting/${meetingId}/comment/${commentId}/addressed`).set('X-Forwarded-For', ip)
            .type('form').send({ back });
        expect(res.headers.location).toBe(`${back}#comment-${commentId}`);
        const [[c]] = await pool.query(`SELECT status FROM meeting_item_comments WHERE comment_id = ?`, [commentId]);
        expect(c.status).toBe('Addressed');
    });

    test('the compiled comments list it by its time in the video', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get(`/meeting/${meetingId}/comments/compiled.docx`).set('X-Forwarded-For', ip)
            .buffer(true).parse((r, cb) => { const d = []; r.on('data', x => d.push(x)); r.on('end', () => cb(null, Buffer.concat(d))); });
        expect(res.statusCode).toBe(200);
        const out = path.join(os.tmpdir(), `compiled-${process.pid}.docx`);
        fs.writeFileSync(out, res.body);
        const xml = spawnSync('unzip', ['-p', out, 'word/document.xml'], { encoding: 'utf8' }).stdout;
        fs.unlink(out, () => {});
        expect(xml).toContain('At 0:07 in the video');
        expect(xml).toContain("Video: President");
    });

    test('an Academic Council member cannot open a Board of Trustees video', async () => {
        const { agent, ip } = await login('academic');
        const res = await agent.get(`/meeting/${meetingId}/item/${videoItemId}/video`).set('X-Forwarded-For', ip);
        expect([302, 403, 404]).toContain(res.statusCode);
        expect(res.statusCode).not.toBe(200);
    });

    test('a Trustee cannot attach files to an agenda item', async () => {
        const { agent, ip } = await login('trustee');
        await agent.post(`/meeting/${meetingId}/item/${pdfItemId}/file`).set('X-Forwarded-For', ip)
            .attach('item_pdf', clip, 'clip.mp4');
        const [[row]] = await pool.query(`SELECT item_video FROM meeting_agenda_items WHERE item_id = ?`, [pdfItemId]);
        expect(row.item_video).toBeNull();
    });

    test('Edit meeting: a new agenda item can get a video too', async () => {
        const { agent, ip } = await login('secretary');
        const [[sec]] = await pool.query(`SELECT user_id FROM users WHERE email = 'boardlink.secretary.demo@gmail.com'`);
        const res = await agent.post(`/meeting/${meetingId}/edit`).set('X-Forwarded-For', ip)
            .field('title', 'Video agenda test').field('meeting_type', 'Board of Trustees')
            .field('meeting_number', number).field('meeting_date', '2030-01-15').field('meeting_time', '09:00')
            .field('venue', 'Board Room').field('mode', 'In-Person')
            .field('called_by_user_id', String(sec.user_id)).field('presided_by_user_id', String(sec.user_id))
            .field('quorum_required', '7')
            .field('item_id', String(videoItemId)).field('item_title', "President's Report").field('item_category', 'For Information').field('item_key', `e${videoItemId}`)
            .field('item_id', String(pdfItemId)).field('item_title', 'Other paper').field('item_category', 'For Information').field('item_key', `e${pdfItemId}`)
            .field('item_id', '').field('item_title', 'VP message').field('item_category', 'For Information').field('item_key', 'r3')
            .attach('item_pdf__r3', clip, 'VP message.mp4');
        expect(res.headers.location).toContain('saved=1');
        const [[row]] = await pool.query(
            `SELECT item_video, item_video_name FROM meeting_agenda_items WHERE meeting_id = ? AND item_title = 'VP message'`, [meetingId]);
        expect(row.item_video).toMatch(/\.mp4$/);
        expect(row.item_video_name).toBe('VP message.mp4');
    });

    test('attaching a PDF in place of the video replaces it', async () => {
        const { agent, ip } = await login('secretary');
        const [[before]] = await pool.query(`SELECT item_video FROM meeting_agenda_items WHERE item_id = ?`, [videoItemId]);
        await agent.post(`/meeting/${meetingId}/item/${videoItemId}/file`).set('X-Forwarded-For', ip)
            .attach('item_pdf', path.join(__dirname, '..', 'samples', 'sample-budget-proposal.pdf'), 'report.pdf');
        const [[row]] = await pool.query(`SELECT item_pdf, item_video FROM meeting_agenda_items WHERE item_id = ?`, [videoItemId]);
        expect(row.item_pdf).toMatch(/^[a-f0-9]{32}$/);
        expect(row.item_video).toBeNull();
        expect(fs.existsSync(path.join(recordings.DIR, before.item_video))).toBe(false);
    });

    test('a file that is neither a paper nor a video is refused', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post(`/meeting/${meetingId}/item/${pdfItemId}/file`).set('X-Forwarded-For', ip)
            .attach('item_pdf', Buffer.from('just some text, not a video'), 'notes.txt');
        expect(res.headers.location).toContain('file_error=pdf');
    });
});

describe('The separate meeting-recording box is gone', () => {
    test('the meeting page has no Post-Meeting Records section', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/meeting/1').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
        expect(res.text).not.toContain('Post-Meeting Records');
        expect(res.text).not.toContain('id="phase-5"');
    });
    test('an archived scan no longer shows "Text read from the document"', async () => {
        const { agent, ip } = await login('secretary');
        const [[doc]] = await pool.query(`SELECT document_id FROM documents WHERE file_path IS NOT NULL LIMIT 1`);
        if (!doc) return;
        const res = await agent.get(`/archive/${doc.document_id}`).set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
        expect(res.text).not.toContain('Text read from the document');
    });
    test('Post-Meeting Records no longer offers a recording upload', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/meeting/1').set('X-Forwarded-For', ip);
        expect(res.text).not.toContain('Add the recording of this meeting');
        expect(res.text).not.toMatch(/Meeting recording/i);
        const up = await agent.post('/meeting/1/recording').set('X-Forwarded-For', ip)
            .attach('recording', Buffer.from('x'), 'clip.mp4');
        expect(up.statusCode).toBe(404);
    });
});

describe('AI Briefing: a dropdown on each item, and Cancel', () => {
    test('each agenda item in the briefing has a dropdown for its summary', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/meeting/1').set('X-Forwarded-For', ip);
        expect(res.text).toMatch(/class="bf-toggle" aria-expanded="false"/);
        expect(res.text).toMatch(/class="bf-item-body"[^>]*hidden/);
        expect(res.text).toContain('Show all summaries');
    });
    test('Cancel when nothing is being summarised changes nothing', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post('/meeting/1/briefing/cancel').set('X-Forwarded-For', ip).type('form').send({});
        expect(res.headers.location).toContain('briefing=notstopped');
    });
    test('a Trustee cannot cancel a meeting they cannot see', async () => {
        const { agent, ip } = await login('academic');
        const res = await agent.post('/meeting/1/briefing/cancel').set('X-Forwarded-For', ip)
            .set('Accept', 'application/json').send({});
        expect(res.statusCode).toBe(404);
    });
});

describe('Attendance is no longer tracked in BOARDLINK', () => {
    test('the meeting page has no RSVP or attendance list', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/meeting/1').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
        expect(res.text).not.toMatch(/Your RSVP|Will Attend|Attendance/);
    });
    test('the meeting page still shows the quorum needed', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/meeting/1').set('X-Forwarded-For', ip);
        expect(res.text).toMatch(/Quorum needed: \d+/);
    });
    test('the New Meeting form has a Quorum needed box', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/meeting/create').set('X-Forwarded-For', ip);
        expect(res.text).toContain('Quorum needed');
        expect(res.text).toMatch(/type="number" name="quorum_required"/);
    });
});

afterAll(async () => { await pool.end().catch(() => {}); });
