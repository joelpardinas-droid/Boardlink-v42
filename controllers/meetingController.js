// ============================================================
// controllers/meetingController.js
//
// Modules 5–8 unified at the controller layer. The Meeting record
// is the workflow spine and ties together:
//   • Module 5  agenda creation
//   • Module 6  pre-meeting briefing and item comments
//   • Module 7  transcription + basic summary
//   • Module 8  formal summary
//
// Out of scope (per client): drafting the minutes and consolidating
// comments are done by the Office of the Board Secretary outside
// BOARDLINK (Google Drive / Word). The review of the previous
// meeting's minutes is simply the first agenda item, which the
// Secretary adds like any other. Every agenda item can carry a
// Google Drive link to its PDF or Word file; members open the file
// there and post their comments on the item here.
//
// The 3 councils (Administrative, Academic, RIC) hold their own
// meetings. Items they approve go on to the Board of Trustees; the
// Secretary enters those on the BOT agenda like any other item.
// ============================================================

const fs                   = require('fs');
const path                 = require('path');
const Meeting              = require('../models/Meeting');
const notify = require('../services/notifyService');
const User                 = require('../models/User');
const transcriptionService = require('../services/transcriptionService');
const governance    = require('../config/governance');
const llmService           = require('../services/llmService');
const itemPdf = require('../services/itemPdfService');
const itemVideo = require('../services/itemVideoService');
const agendaArchive = require('../services/agendaArchive');
const briefingService = require('../services/briefingService');

// ── Visibility-by-council ─────────────────────────────────────
// Each council member sees only their own council's meetings and
// Trustees only Board of Trustees meetings. The rule lives in
// services/access.js so every endpoint applies the same one.
const { canSeeMeeting, commentsOpen } = require('../services/access');

// Filter a list of meetings to only those the user can see.
function filterMeetingsByCouncil(meetings, user) {
    if (!Array.isArray(meetings)) return [];
    return meetings.filter(m => canSeeMeeting(user, m));
}

// ── Mockup data for demo without DB ──────────────────────────
// When MySQL is unavailable, we still want every screen to render
// with believable content so the system can be demoed. The data
// below mirrors what's in seed_data.sql.

const MOCK_MEETINGS = [
    // One meeting, matching sql/seed_data.sql: the Board of Trustees.
    // Council meetings are created in the system by the Secretary.
    { meeting_id:1, title:'1st Regular Meeting of the Board of Trustees, AY 2026-2027',
      meeting_type:'Board of Trustees', meeting_number:'BOT-2026-001',
      meeting_date:'2026-05-15', meeting_time:'09:00:00',
      venue:'Board Room, CSPC Main Campus, Nabua', mode:'In-Person',
      called_by_name:'Juan A. Dela Cruz', presided_by_name:'Atty. Pedro G. Santos',
      quorum_required:7, status:'Distributed', comment_deadline:'2026-05-10',
      notes_for_members:'Items approved by the 3 councils on May 5–7 will be taken up for final BOT action.',
      transcript_text:null, summary_text:null },
];


const MOCK_AGENDA_ITEMS = {
    1: [ // The Board of Trustees agenda
        { item_id:400, item_order:1, item_title:'Approval of the Minutes of Meeting BOT-2026-113',
          item_category:'Previous Minutes', sponsor_name:'Juan A. Dela Cruz',
          item_pdf:'__sample:minutes', item_pdf_name:'BOT-2026-113 Minutes (sample).pdf',
          item_pdf_pages:2, item_pdf_status:'ready' },
        { item_id:401, item_order:2, item_title:'Call to Order and Roll Call',
          item_category:'For Information', sponsor_name:'Juan A. Dela Cruz' },
        { item_id:402, item_order:3, item_title:'Approval of the FY 2027 Administrative Budget',
          item_category:'For Approval', sponsor_name:'Hon. Maria T. Bautista',
          item_pdf:'__sample:budget', item_pdf_name:'FY 2027 Budget Board Paper (sample).pdf',
          item_pdf_pages:2, item_pdf_status:'ready' },
        { item_id:403, item_order:4, item_title:'Renewal of the Maintenance Contract for the New Academic Building',
          item_category:'For Approval', sponsor_name:'Hon. Maria T. Bautista' },
        { item_id:404, item_order:5, item_title:'Approval of the Academic Calendar AY 2026-2027',
          item_category:'For Approval', sponsor_name:'Dr. Sofia M. Aquino' },
        { item_id:405, item_order:6, item_title:'Revision of the BSIT Curriculum (CMO 25 s. 2015 alignment)',
          item_category:'For Approval', sponsor_name:'Dr. Sofia M. Aquino' },
        { item_id:406, item_order:7, item_title:'Approval of the Internal Research Grant Program 2026-2028',
          item_category:'For Approval', sponsor_name:'Engr. Robert L. Cruz' },
        { item_id:407, item_order:8, item_title:'MOA with the Provincial Government on Bicol Innovation Hub',
          item_category:'For Approval', sponsor_name:'Engr. Robert L. Cruz' },
        { item_id:408, item_order:9, item_title:'Adjournment',
          item_category:'For Information', sponsor_name:'Juan A. Dela Cruz' },
    ],
};


const MOCK_COMMENTS = {
    1: [
        // ── Comments on the Previous Minutes item ──
        // Trustees point at the exact words (or an area) in the
        // minutes PDF. Positions are page fractions matching the
        // bundled sample file samples/sample-previous-minutes.pdf.
        { comment_id:9001, item_id:400, user_id:905, full_name:'Atty. Pedro G. Santos',
          role:'member', council_type:'BOT', comment_phase:'Pre-Meeting',
          comment_text:'I made the motion and Trustee Ramos seconded it. Please swap the two names.',
          page_number:1, status:'Open', anchor_type:'text',
          anchor_quote:'On motion of Trustee Ramos, seconded by Trustee Santos',
          anchor_rects:'[[0.1176,0.2667,0.4165,0.0146]]',
          commented_at:'2026-05-10 09:00:00' },
        { comment_id:9002, item_id:400, user_id:909, full_name:'Hon. Ricardo S. Ramos',
          role:'member', council_type:'BOT', comment_phase:'Pre-Meeting',
          comment_text:'The special meeting was held on March 13, not March 31.',
          page_number:1, status:'Addressed', anchor_type:'text',
          anchor_quote:'on March 31, 2026',
          anchor_rects:'[[0.1176,0.3588,0.1257,0.0146]]',
          commented_at:'2026-05-10 10:15:00', addressed_at:'2026-05-11 16:30:00' },
        { comment_id:9003, item_id:400, user_id:909, full_name:'Hon. Ricardo S. Ramos',
          role:'member', council_type:'BOT', comment_phase:'Pre-Meeting',
          comment_text:'Please state that the report is expected at the next regular meeting, as Trustee Lim requested.',
          page_number:2, status:'Open', anchor_type:'area',
          anchor_rects:'[[0.11,0.132,0.58,0.042]]',
          commented_at:'2026-05-11 08:45:00' },
        // ── Comments on the budget board paper ──
        { comment_id:9101, item_id:402, user_id:905, full_name:'Atty. Pedro G. Santos',  role:'member', council_type:'BOT', comment_phase:'Pre-Meeting',
          comment_text:'I support the budget but request the legal-services line be increased to cover the new ISO recertification work.',
          page_number:1, anchor_type:'text',
          anchor_quote:'The MOOE line includes PHP 1,200,000 for legal services',
          anchor_rects:'[[0.1176,0.4169,0.4244,0.0146]]',
          commented_at:'2026-05-09 10:00:00' },
        { comment_id:9102, item_id:404, user_id:910, full_name:'Atty. Patricia E. Lim',    role:'member', council_type:'BOT', comment_phase:'Pre-Meeting',
          comment_text:'The Academic Council endorsed this calendar on May 6. Implementation should start with the orientation week of August 11.',
          commented_at:'2026-05-09 14:30:00' },
        { comment_id:9103, item_id:404, user_id:905, full_name:'Atty. Pedro G. Santos',  role:'member', council_type:'BOT', comment_phase:'Pre-Meeting',
          comment_text:'No objection. We should align this with the labor calendar of the non-teaching personnel.',
          commented_at:'2026-05-10 09:15:00' },
        { comment_id:9104, item_id:406, user_id:909, full_name:'Hon. Ricardo S. Ramos',   role:'member', council_type:'BOT', comment_phase:'Pre-Meeting',
          comment_text:'The grant program guidelines have been finalized. Funding ceiling is set at PHP 250,000 per project.',
          commented_at:'2026-05-10 11:00:00' },
        { comment_id:9105, item_id:402, user_id:909, full_name:'Hon. Ricardo S. Ramos', role:'member', council_type:'BOT', comment_phase:'Pre-Meeting',
          comment_text:'I recommend approval. The totals in this summary match the DBM ceiling.',
          page_number:1, anchor_type:'area', anchor_rects:'[[0.11,0.281,0.6,0.078]]',
          commented_at:'2026-05-10 13:30:00' },
        // ── In-Session comments posted live during the face-to-face meeting ──
        // Captured by trustees while the discussion is happening (or
        // typed by the Secretary on their behalf). These feed directly
        // into the minutes draft.
        { comment_id:9201, item_id:402, user_id:905, full_name:'Atty. Pedro G. Santos', role:'member', council_type:'BOT', comment_phase:'In-Session',
          comment_text:'On page 2, item 9 — moved to amend the legal-services budget from PHP 1.2M to PHP 1.4M to cover the ISO recertification work as discussed.',
          commented_at:'2026-05-15 10:14:00' },
        { comment_id:9202, item_id:402, user_id:909, full_name:'Hon. Ricardo S. Ramos', role:'member', council_type:'BOT', comment_phase:'In-Session',
          comment_text:'Seconded the motion to amend.',
          commented_at:'2026-05-15 10:15:00' },
        { comment_id:9203, item_id:404, user_id:910, full_name:'Atty. Patricia E. Lim', role:'member', council_type:'BOT', comment_phase:'In-Session',
          comment_text:'Motion to approve the Academic Calendar AY 2026-2027 as endorsed by the Academic Council.',
          commented_at:'2026-05-15 10:42:00' },
        { comment_id:9204, item_id:406, user_id:909, full_name:'Hon. Ricardo S. Ramos', role:'member', council_type:'BOT', comment_phase:'In-Session',
          comment_text:'Suggest tabling item 4 (Research Grant Program) pending the finalised CHED guidance memo expected next week. Will return at the June meeting.',
          commented_at:'2026-05-15 11:05:00' },
        // ── Secretary's own in-session notes (captured live as the
        // discussion happened), for reference when the minutes are
        // written outside BOARDLINK.
        { comment_id:9301, item_id:402, user_id:2, full_name:'Juan A. Dela Cruz', role:'secretary', council_type:null, comment_phase:'In-Session',
          comment_text:'Moved by Trustee Santos, seconded by Trustee Ramos. Amendment to increase the legal-services line to PHP 1.4M carried. Resolution to be drafted for adoption.',
          commented_at:'2026-05-15 10:16:00' },
        { comment_id:9302, item_id:404, user_id:2, full_name:'Juan A. Dela Cruz', role:'secretary', council_type:null, comment_phase:'In-Session',
          comment_text:'Approved unanimously upon motion of Trustee Lim, seconded by Trustee Santos.',
          commented_at:'2026-05-15 10:44:00' },
        { comment_id:9303, item_id:406, user_id:2, full_name:'Juan A. Dela Cruz', role:'secretary', council_type:null, comment_phase:'In-Session',
          comment_text:'Tabled upon motion of Trustee Ramos. To be brought back at the June regular meeting pending CHED guidance.',
          commented_at:'2026-05-15 11:08:00' },
    ],
};


function findMockMeeting(id) {
    const idn = parseInt(id, 10);
    return MOCK_MEETINGS.find(m => m.meeting_id === idn) || null;
}
// ── List + view ───────────────────────────────────────────────
exports.list = async (req, res) => {
    let meetings = [];
    try {
        meetings = await Meeting.findAll();
    } catch (_err) {
        // Fall back to mockup data so the demo always shows something
        meetings = MOCK_MEETINGS;
    }
    if (!meetings || meetings.length === 0) meetings = MOCK_MEETINGS;

    // Restrict to meetings the current user is allowed to see.
    // Council members only see their own council; Trustees only
    // see Board of Trustees meetings.
    const visible = filterMeetingsByCouncil(meetings, req.session.user);

    // Sort buttons: the Board of Trustees, the Board of Councils (the three
    // councils together), or one council.
    const GROUPS = {
        bot:      ['Board of Trustees'],
        councils: ['Academic Council', 'Administrative Council', 'RIC Council'],
        academic: ['Academic Council'],
        admin:    ['Administrative Council'],
        ric:      ['RIC Council'],
    };
    // Members see only their own body's meetings, so the buttons are not theirs.
    const body = GROUPS[req.query.body] && req.session.user?.role !== 'member' ? req.query.body : '';
    const counts = { all: visible.length };
    for (const [k, types] of Object.entries(GROUPS)) counts[k] = visible.filter(m => types.includes(m.meeting_type)).length;
    const shown = body ? visible.filter(m => GROUPS[body].includes(m.meeting_type)) : visible;

    res.render('meeting', {
        active: 'meeting',
        meetings: shown,
        bodyFilter: body,
        bodyCounts: counts,
        userRole:        req.session.user?.role,
        userCouncilType: req.session.user?.council_type,
        deletedNumber:   typeof req.query.deleted === 'string' ? req.query.deleted.slice(0, 50) : null,
    });
};

exports.view = async (req, res) => {
    const id = req.params.id;
    let meeting        = null;
    let agendaItems    = [];
    let comments       = [];

    try {
        meeting        = await Meeting.findById(id);
        // An item whose file is not on this computer shows no document.
        agendaItems    = require('../services/missingFiles').checkAll(await Meeting.getAgendaItems(id));
        comments       = await Meeting.getCommentsForMeeting(id);
    } catch (err) {
        console.error('[meeting view] DB error — falling back to mockup:', err.message);
    }

    // Mockup fallback when DB is empty
    const fromDb = !!meeting;
    if (!meeting) {
        meeting = findMockMeeting(id);
        if (meeting) {
            agendaItems    = MOCK_AGENDA_ITEMS[parseInt(id, 10)] || [];
            comments       = MOCK_COMMENTS[parseInt(id, 10)]     || [];
        }
    }

    // Council scoping — silently send unauthorised members back
    // to their meeting list. Members of one council must not be
    // able to reach another council's meeting by typing the URL.
    if (meeting && !canSeeMeeting(req.session.user, meeting)) {
        return res.redirect('/meeting');
    }
    // The pre-meeting briefing: one summary per agenda item, written
    // from each item's PDF, plus the progress of a briefing that is
    // still being prepared.
    let briefingData = null;
    if (meeting) {
        try {
            briefingData = await briefingService.viewData(id, agendaItems, { mock: !fromDb });
        } catch (err) {
            console.warn('[meeting view] briefing unavailable:', err.message);
        }
    }

    res.render('meeting-view', {
        active: 'meeting',
        id,
        meeting,
        agendaItems,
        comments,
        fileError: ['pdf', 'size', 'closed', 'convert', 'ffmpeg'].includes(req.query.file_error) ? req.query.file_error : null,
        savedNotice: req.query.saved === '1',
        briefingNotice: ['none', 'cancelled', 'notstopped'].includes(req.query.briefing) ? req.query.briefing : null,
        archivedCount: /^\d+$/.test(String(req.query.archived || '')) ? Number(req.query.archived) : null,
        editLocked:  req.query.edit_error === 'locked',
        // v99: why a comment from this page was not saved (it used to be dropped silently)
        commentError: COMMENT_ERRORS[req.query.comment_error] || null,
        userId:   req.session.user?.id,
        userRole: req.session.user?.role,
        briefingData,
    });
};

// ── Module 5+6: Create new meeting (the form spine) ───────────
// ── Pre-meeting comment deadline ─────────────────────────────
const DEADLINE_LEAD_DAYS = 5;
const isYmd = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && !isNaN(new Date(`${v}T00:00:00Z`));
const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
function todayManila() {
    // en-CA formats as YYYY-MM-DD.
    return new Date().toLocaleDateString('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Manila' });
}
/**
 * The deadline to store: the Secretary's date when she gave one
 * (moved back to the meeting date if it falls after it), otherwise
 * 5 days before the meeting — but not earlier than today when the
 * meeting is sooner than that.
 */
function commentDeadlineFor(meetingDate, given) {
    if (!isYmd(meetingDate)) return isYmd(given) ? given : null;
    if (isYmd(given)) return given > meetingDate ? meetingDate : given;
    const auto  = addDays(meetingDate, -DEADLINE_LEAD_DAYS);
    const today = todayManila();
    return (auto < today && meetingDate >= today) ? today : auto;
}
exports._commentDeadlineFor = commentDeadlineFor;

exports.showCreate = async (req, res) => {
    let users = [];
        try { users = await User.findAll(); }
    catch (_err) { /* mockup */ }
    res.render('meeting-create', {
        governingBodies: governance.asList(),
        active: 'meeting',
        users,
    });
};

exports.processCreate = async (req, res) => {
    const b = req.body;
    let meetingId;

    // Files arrive from multer.any(): one optional PDF per agenda row,
    // named `item_pdf__<row key>`. Each row sends its key in
    // `item_key`, so a file is matched to its row even when other
    // rows have none.
    const files = Array.isArray(req.files) ? req.files : [];
    const madePdfs = [];                         // PDFs made from attached Word files
    const madeVideos = [];                       // videos already moved into uploads/recordings
    const discardAll = () => {
        files.forEach(f => fs.unlink(f.path, () => {}));
        madePdfs.forEach(n => itemPdf.removeStored(n));
        madeVideos.forEach(v => itemVideo.discard(v));
    };

    // Agenda item rows arrive as parallel arrays, one entry per row.
    const asList = v => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
    const titles       = asList(b.item_title);
    const categories   = asList(b.item_category);
    const keys         = asList(b.item_key);

    const fileByKey = new Map();
    for (const f of files) {
        const m = /^item_pdf__([A-Za-z0-9]{1,16})$/.exec(f.fieldname);
        if (m) fileByKey.set(m[1], f);
    }
    // Every attached item file must be a PDF or a Word (.docx) file; a
    // Word file is kept for editing and a PDF is made from it. Checked
    // before anything is saved, so a bad file never leaves a half-made meeting.
    const prepared = new Map();
    for (const [key, f] of fileByKey) {
        const up = await itemPdf.acceptUpload(f);
        if (up.ok && up.docx) madePdfs.push(up.stored);
        if (up.ok && up.video) madeVideos.push(up);
        if (!up.ok) {
            discardAll();
            const row = keys.indexOf(key);
            const label = row >= 0 && titles[row] ? `"${String(titles[row]).trim()}"` : 'an agenda item';
            return res.status(400).render('meeting-create', {
                governingBodies: governance.asList(),
                active: 'meeting',
                users:  await User.findAll().catch(() => []),
                error:  up.message && up.reason !== 'type'
                    ? `Could not create the meeting: ${up.message}`
                    : `Could not create the meeting: the file attached to ${label} is not a PDF, Word (.docx) or video file.`,
            });
        }
        prepared.set(key, up);
    }
    // Pre-meeting comment deadline: the form fills in 5 days before the
    // meeting and the Secretary may change it. If it arrives empty,
    // apply the same rule here; it may never fall after the meeting.
    const deadline = commentDeadlineFor(b.meeting_date, b.comment_deadline);

    const pdfForRow = i => (keys[i] ? prepared.get(String(keys[i])) || null : null);

    try {
        // 1) Create the meeting record
        meetingId = await Meeting.create({
            title:               b.title,
            meeting_type:        b.meeting_type,
            meeting_number:      b.meeting_number,
            meeting_date:        b.meeting_date,
            meeting_time:        b.meeting_time,
            venue:               b.venue,
            mode:                b.mode,
            called_by_user_id:   b.called_by_user_id || null,
            presided_by_user_id: b.presided_by_user_id || null,
            // Fall back to the body's own quorum rather than a fixed
            // number: the four bodies differ (7 of 11 for the Board,
            // 37 of 72 for the Academic Council), so one default
            // cannot be right for all of them.
            quorum_required:     parseInt(b.quorum_required, 10)
                                 || governance.quorumFor(b.meeting_type)
                                 || 7,
            notes_for_members:   b.notes_for_members || null,
            comment_deadline:    deadline,
            created_by:          req.session.user?.id || null,
        });

        let order = 0;

        // 2) Add the agenda items in the order entered. The review of
        // the previous meeting's minutes is simply the first item,
        // entered by the Secretary with the "Previous Minutes"
        // category so members can cite page and line numbers.
        for (let i = 0; i < titles.length; i++) {
            if (!titles[i] || !titles[i].trim()) continue;
            order++;
            const pdf  = pdfForRow(i);
            const newItemId = await Meeting.addAgendaItem(
                meetingId, order,
                titles[i].trim(),
                categories[i] || 'For Information',
                pdf && !pdf.video ? pdf : null,
            );
            if (pdf) {
                pdf.used = true;
                // A video (e.g. the President's Report) is the item's paper.
                if (pdf.video) await itemVideo.attach(newItemId, pdf);
                else itemPdf.processInBackground(newItemId, pdf.stored);
            }
        }
        // A file attached to a row that had no title is not kept.
        for (let i = 0; i < keys.length; i++) {
            const pdf = pdfForRow(i);
            if (pdf && !pdf.used && !(titles[i] && String(titles[i]).trim())) itemPdf.discardUpload(pdf);
        }

        return res.redirect(`/meeting/${meetingId}`);
    } catch (err) {
        console.error('[meeting create] error:', err.message);
        if (!meetingId) discardAll();
        return res.render('meeting-create', {
            governingBodies: governance.asList(),
            active: 'meeting',
            users:  await User.findAll().catch(() => []),
            error:  'Could not create the meeting: ' + err.message,
        });
    }
};

// ── Edit a meeting (Board Secretary) ──────────────────────────
// The Create Meeting form is reused with the meeting's current
// values. Agenda items can be renamed, re-categorised, reordered,
// removed (with their comments), added, or given a new PDF.
// The governing body can change only while nobody has commented,
// since comments belong to the members of the original body.
const EDIT_LOCKED = ['Completed', 'Cancelled'];
const COUNCIL_FOR = {
    'Board of Trustees': 'BOT', 'Administrative Council': 'ADMIN',
    'Academic Council': 'ACADEMIC', 'RIC Council': 'RIC',
};
const ITEM_CATEGORIES = ['Previous Minutes', 'For Information', 'For Approval', 'For Decision', 'For Discussion'];

async function loadEditable(req, res) {
    let meeting = null;
    try { meeting = await Meeting.findById(req.params.id); }
    catch (_) {
        res.status(503).render('404', { active: '' });
        return null;
    }
    if (!meeting) { res.redirect('/meeting'); return null; }
    return meeting;
}

async function renderEdit(res, meeting, extra = {}) {
    const [items, users, counts] = await Promise.all([
        Meeting.getAgendaItems(meeting.meeting_id).then(require('../services/missingFiles').checkAll),
        User.findAll().catch(() => []),
        Meeting.countCommentsByItem(meeting.meeting_id),
    ]);
    const totalComments = [...counts.values()].reduce((a, b) => a + b, 0);
    res.render('meeting-create', {
        active: 'meeting',
        governingBodies: governance.asList(),
        users,
        editing: {
            meeting,
            items: items.map(i => ({ ...i, commentCount: counts.get(i.item_id) || 0 })),
            typeLocked: totalComments > 0 || meeting.status === 'In-Session',
        },
        ...extra,
    });
}

exports.showEdit = async (req, res) => {
    const meeting = await loadEditable(req, res);
    if (!meeting) return;
    if (EDIT_LOCKED.includes(meeting.status)) {
        return res.redirect(`/meeting/${meeting.meeting_id}?edit_error=locked`);
    }
    const fileErrors = {
        size: 'Nothing was saved: one of the files is larger than the upload limit.',
        count: 'Nothing was saved: too many files were attached at once.',
    };
    await renderEdit(res, meeting, { error: fileErrors[req.query.file_error] || null });
};

exports.processEdit = async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    const madePdfs = [];                         // PDFs made from attached Word files
    const madeVideos = [];                       // videos already moved into uploads/recordings
    const discardAll = () => {
        files.forEach(f => fs.unlink(f.path, () => {}));
        madePdfs.forEach(n => itemPdf.removeStored(n));
        madeVideos.forEach(v => itemVideo.discard(v));
    };
    const meeting = await loadEditable(req, res);
    if (!meeting) return discardAll();
    const id = meeting.meeting_id;
    if (EDIT_LOCKED.includes(meeting.status)) {
        discardAll();
        return res.redirect(`/meeting/${id}?edit_error=locked`);
    }
    const b = req.body;
    const fail = async (message) => {
        discardAll();
        return renderEdit(res.status(400), meeting, { error: message });
    };

    const asList = v => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
    const ids        = asList(b.item_id);
    const keys       = asList(b.item_key);
    const titles     = asList(b.item_title);
    const categories = asList(b.item_category);

    const fileByKey = new Map();
    for (const f of files) {
        const m = /^item_pdf__([A-Za-z0-9]{1,16})$/.exec(f.fieldname);
        if (m) fileByKey.set(m[1], f);
    }
    const prepared = new Map();
    for (const [key, f] of fileByKey) {
        const up = await itemPdf.acceptUpload(f);
        if (up.ok && up.docx) madePdfs.push(up.stored);
        if (up.ok && up.video) madeVideos.push(up);
        if (!up.ok) {
            const row = keys.indexOf(key);
            const label = row >= 0 && titles[row] ? `"${String(titles[row]).trim()}"` : 'an agenda item';
            return fail(up.message && up.reason !== 'type'
                ? `Nothing was saved: ${up.message}`
                : `Nothing was saved: the file attached to ${label} is not a PDF, Word (.docx) or video file.`);
        }
        prepared.set(key, up);
    }

    // Required meeting fields.
    for (const [k, label] of [['title', 'title'], ['meeting_number', 'meeting number'],
                              ['meeting_date', 'date'], ['meeting_time', 'time'], ['venue', 'venue']]) {
        if (!String(b[k] || '').trim()) return fail(`Nothing was saved: the meeting ${label} is required.`);
    }

    const current = await Meeting.getAgendaItems(id);
    const byId = new Map(current.map(i => [String(i.item_id), i]));
    const counts = await Meeting.countCommentsByItem(id);
    const totalComments = [...counts.values()].reduce((a, c) => a + c, 0);

    // Governing body: unchanged unless nobody has commented yet.
    let meetingType = meeting.meeting_type;
    if (b.meeting_type && b.meeting_type !== meeting.meeting_type) {
        if (!COUNCIL_FOR[b.meeting_type]) return fail('Nothing was saved: unknown meeting type.');
        if (totalComments > 0 || meeting.status === 'In-Session') {
            return fail('Nothing was saved: the governing body cannot change after members have commented or the meeting has started.');
        }
        meetingType = b.meeting_type;
    }

    const updates = [], inserts = [], replaced = [];
    const kept = new Set();
    let order = 0;
    for (let i = 0; i < titles.length; i++) {
        const title = String(titles[i] || '').trim();
        const itemId = String(ids[i] || '').trim();
        const category = ITEM_CATEGORIES.includes(categories[i]) ? categories[i] : 'For Information';
        const f = keys[i] ? fileByKey.get(String(keys[i])) : null;
        const pdf = f ? prepared.get(String(keys[i])) : null;
        if (itemId) {
            const existing = byId.get(itemId);
            if (!existing) return fail('Nothing was saved: an agenda item does not belong to this meeting.');
            if (!title) return fail(`Nothing was saved: agenda item "${existing.item_title}" needs a title.`);
            kept.add(itemId);
            order++;
            updates.push({ itemId: existing.item_id, order, title: title.slice(0, 500), category });
            if (pdf) replaced.push({ itemId: existing.item_id, old: existing.item_pdf, pdf });
        } else if (title) {
            order++;
            inserts.push({ order, title: title.slice(0, 500), category,
                           pdf: pdf && !pdf.video ? pdf : null, video: pdf && pdf.video ? pdf : null });
        } else if (f) {
            itemPdf.discardUpload(pdf);            // file on an empty new row
        }
    }
    if (!order) return fail('Nothing was saved: a meeting needs at least one agenda item.');
    const deletes = current.filter(i => !kept.has(String(i.item_id)));

    const fields = {
        title: String(b.title).trim(),
        meeting_type: meetingType,
        meeting_number: String(b.meeting_number).trim(),
        meeting_date: b.meeting_date,
        meeting_time: b.meeting_time,
        venue: String(b.venue).trim(),
        mode: ['In-Person', 'Virtual', 'Hybrid'].includes(b.mode) ? b.mode : 'In-Person',
        called_by_user_id: b.called_by_user_id || null,
        presided_by_user_id: b.presided_by_user_id || null,
        quorum_required: parseInt(b.quorum_required, 10) || governance.quorumFor(meetingType) || 7,
        notes_for_members: b.notes_for_members || null,
        comment_deadline: commentDeadlineFor(b.meeting_date, b.comment_deadline),
    };

    // Gathered before the rows go: every version of a removed item's
    // document is deleted from disk afterwards.
    const filesOfRemoved = await Meeting.getItemFileNames(deletes.map(d => d.item_id)).catch(() => []);
    const videosOfRemoved = await itemVideo.filesOf(deletes.map(d => d.item_id)).catch(() => []);

    let newIds;
    try {
        newIds = await Meeting.applyEdit(id, {
            fields, updates, inserts,
            deletes: deletes.map(d => d.item_id),
        });
    } catch (err) {
        console.error('[meeting edit] failed:', err.message);
        return fail('Nothing was saved: the changes could not be stored. Please try again.');
    }

    // Files: new documents are read in the background; files no longer
    // used are removed from disk.
    for (const r of replaced) {
        try {
            if (r.pdf.video) {
                await itemVideo.attach(r.itemId, r.pdf);
            } else {
                // The old file stays on disk as an earlier version.
                await Meeting.setItemPdf(r.itemId, r.pdf.stored, r.pdf.name, req.session.user.id, r.pdf.docx);
                await itemVideo.clear(r.itemId);
                itemPdf.processInBackground(r.itemId, r.pdf.stored);
            }
        } catch (err) {
            console.error('[meeting edit] file replace failed:', err.message);
            itemPdf.discardUpload(r.pdf);
        }
    }
    for (let k = 0; k < inserts.length; k++) {
        const it = inserts[k];
        if (it.pdf) itemPdf.processInBackground(newIds[k], it.pdf.stored);
        if (it.video) await itemVideo.attach(newIds[k], it.video).catch(err => {
            console.error('[meeting edit] video attach failed:', err.message);
            itemVideo.discard(it.video);
        });
    }
    // Removed items take every version of their document with them.
    filesOfRemoved.forEach(f => itemPdf.removeStored(f));
    videosOfRemoved.forEach(f => itemVideo.removeFile(f));

    console.log(`[meeting edit] meeting ${id}: ${updates.length} kept, ${inserts.length} added, ` +
                `${deletes.length} removed, ${replaced.length} file(s) replaced` + (meetingType !== meeting.meeting_type ? `, now ${meetingType}` : ''));
    res.redirect(`/meeting/${id}?saved=1`);
};

// ── Delete a meeting (Board Secretary) ────────────────────────
exports.showDelete = async (req, res) => {
    const meeting = await loadEditable(req, res);
    if (!meeting) return;
    const footprint = await Meeting.getMeetingFootprint(meeting.meeting_id);
    res.render('meeting-delete', { active: 'meeting', meeting, footprint, error: null });
};

exports.processDelete = async (req, res) => {
    const meeting = await loadEditable(req, res);
    if (!meeting) return;
    const id = meeting.meeting_id;
    const typed = String((req.body && req.body.confirm_number) || '').trim().toLowerCase();
    if (typed !== String(meeting.meeting_number).trim().toLowerCase()) {
        const footprint = await Meeting.getMeetingFootprint(id);
        return res.status(400).render('meeting-delete', {
            active: 'meeting', meeting, footprint,
            error: 'The meeting number you typed does not match. Nothing was deleted.',
        });
    }
    if (meeting.status === 'Completed') {
        const footprint = await Meeting.getMeetingFootprint(id);
        return res.status(409).render('meeting-delete', {
            active: 'meeting', meeting, footprint,
            error: 'This meeting is completed and its agendas are kept in the Digital Archive, so it cannot be deleted.',
        });
    }
    if (briefingService.isActive(id)) {
        const footprint = await Meeting.getMeetingFootprint(id);
        return res.status(409).render('meeting-delete', {
            active: 'meeting', meeting, footprint,
            error: 'A briefing is being prepared for this meeting. Try again when it has finished.',
        });
    }
    try {
        const videos = await itemVideo.filesOfMeeting(id).catch(() => []);
        const removed = await Meeting.deleteMeeting(id);
        if (removed) {
            removed.itemFiles.forEach(f => itemPdf.removeStored(f));
            videos.forEach(f => itemVideo.removeFile(f));
        }
        console.log(`[meeting delete] meeting ${id} (${meeting.meeting_number}) deleted by user ${req.session.user.id}`);
        res.redirect(`/meeting?deleted=${encodeURIComponent(meeting.meeting_number)}`);
    } catch (err) {
        const footprint = await Meeting.getMeetingFootprint(id).catch(() => null);
        res.status(500).render('meeting-delete', {
            active: 'meeting', meeting, footprint,
            error: 'The meeting could not be deleted. Please try again.',
        });
    }
};

// v99: a comment that could not be saved is no longer dropped silently;
// the meeting page says why.
const COMMENT_ERRORS = {
    empty:  'Write a comment first.',
    long:   'Your comment was not saved: comments are limited to 4,000 characters. Please shorten it and post again.',
    closed: 'Your comment was not saved: this meeting is completed, so comments are closed.',
    failed: 'Your comment could not be saved. Please try again.',
    edit_empty: 'A comment cannot be empty. Use Delete to remove it.',
    edit_long:  'Your change was not saved: comments are limited to 4,000 characters.',
    edit_done:  'The Secretary has already marked this comment done, so it can no longer be changed.',
    edit_failed:   'Your change could not be saved. Please try again.',
    delete_failed: 'The comment could not be deleted. Please try again.',
};
exports.COMMENT_ERRORS = COMMENT_ERRORS;
const backWith = (meetingId, code, itemId) => `/meeting/${parseInt(meetingId, 10)}?comment_error=${code}${itemId ? `#item-${parseInt(itemId, 10)}` : ''}`;

exports.processItemComment = async (req, res) => {
    const meetingId  = req.params.id;
    const itemId     = req.body.item_id;
    const commentTxt = (req.body.comment_text || '').trim();
    if (!itemId) return res.redirect(`/meeting/${meetingId}`);
    if (!commentTxt) return res.redirect(backWith(meetingId, 'empty', itemId));
    if (commentTxt.length > 4000) return res.redirect(backWith(meetingId, 'long', itemId));

    // Pre-meeting comments are member input. Only Trustees, Council
    // Members may post. The Administrator and Board Secretary can
    // read every comment and compile
    // them into a PDF, but they don't author their own. Reject the
    // POST silently and redirect.
    const role = req.session.user?.role;
    if (role !== 'member') {
        return res.redirect(`/meeting/${meetingId}`);
    }

    // Council scope: a member cannot comment on another council's
    // meeting. The item must also belong to THIS meeting — otherwise a
    // member could post onto another body's item by sending its id
    // with their own meeting's URL — and the meeting must still be
    // accepting comments.
    let mtg = null;
    let item = null;
    try {
        mtg  = await Meeting.findById(meetingId);
        item = await Meeting.getItem(itemId);
    } catch (_err) { /* mockup */ }
    if (!mtg) mtg = findMockMeeting(meetingId);
    if (!mtg || !canSeeMeeting(req.session.user, mtg)) {
        return res.redirect('/meeting');
    }
    if (item && String(item.meeting_id) !== String(mtg.meeting_id)) {
        return res.redirect(`/meeting/${meetingId}`);
    }
    if (!commentsOpen(mtg)) {
        return res.redirect(backWith(meetingId, 'closed', itemId));
    }
    // Optional page/line — only meaningful for Previous Minutes
    // agenda items. Coerce to integer or NULL.
    const pageNum = req.body.page_number ? parseInt(req.body.page_number, 10) : null;
    const lineNum = req.body.line_number ? parseInt(req.body.line_number, 10) : null;
    const pageNumber = Number.isFinite(pageNum) && pageNum > 0 ? pageNum : null;
    const lineNumber = Number.isFinite(lineNum) && lineNum > 0 ? lineNum : null;

    // Phase tag — defaults to Pre-Meeting, but the live composer
    // sends "In-Session" while the meeting is actually in progress.
    // We trust the client tag only if it matches a valid phase and
    // the meeting status confirms it (you can't post In-Session on
    // a meeting that isn't actually In-Session).
    let phase = 'Pre-Meeting';
    if (req.body.comment_phase === 'In-Session' && mtg && mtg.status === 'In-Session') {
        phase = 'In-Session';
    }

    try {
        if (!item) throw new Error('agenda item not found');
        await Meeting.addItemComment(itemId, req.session.user.id, commentTxt, { pageNumber, lineNumber, phase });
    } catch (err) {
        console.error('[comment] error:', err.message);
        return res.redirect(backWith(meetingId, 'failed', itemId));
    }
    res.redirect(`/meeting/${meetingId}#item-${itemId}`);
};

// ── Meeting lifecycle: Start / End ─────────────────────────────
// The Secretary clicks "▶ Start Meeting" to flip the status from
// Distributed → In-Session, which activates the in-session comment
// composer. "■ End Meeting" flips In-Session → Completed and
// closes the in-session phase. Secretary/admin only.
exports.processStartMeeting = async (req, res) => {
    const meetingId = req.params.id;
    try {
        if (typeof Meeting.setStatus === 'function') {
            await Meeting.setStatus(meetingId, 'In-Session');
        }
    } catch (err) {
        console.error('[start meeting] error:', err.message);
    }
    res.redirect(`/meeting/${meetingId}`);
};

exports.processEndMeeting = async (req, res) => {
    const meetingId = req.params.id;
    try {
        if (typeof Meeting.setStatus === 'function') {
            await Meeting.setStatus(meetingId, 'Completed');
        }
        // Every agenda item goes to the Digital Archive (Meeting Agendas),
        // closed to members unless the Office approves a request.
        const n = await agendaArchive.archiveMeeting(meetingId);
        return res.redirect(`/meeting/${meetingId}?archived=${n}`);
    } catch (err) {
        console.error('[end meeting] error:', err.message);
    }
    res.redirect(`/meeting/${meetingId}`);
};

// ── Mark a minutes-correction comment as Addressed ─────────────
// Secretary-only. The route is also restricted to admin/secretary
// via requireRole, but we re-check here as a server-side safety net.
exports.processMarkAddressed = async (req, res) => {
    const meetingId = req.params.id;
    const commentId = req.params.commentId;
    try {
        const done = await Meeting.markCommentAddressed(commentId, req.session.user.id, meetingId);
        // Tell the member who wrote the comment that it has been done.
        if (done) await notify.commentDone(meetingId, done, req.session.user.id, 'button');
    } catch (err) {
        console.error('[mark addressed] error:', err.message);
    }
    // From an item's own page (e.g. a video), go back there.
    const back = String((req.body && req.body.back) || '');
    if (/^\/meeting\/\d+\/item\/\d+\/review$/.test(back) && back.startsWith(`/meeting/${parseInt(meetingId, 10)}/`)) {
        return res.redirect(`${back}#comment-${commentId}`);
    }
    res.redirect(`/meeting/${meetingId}#comment-${commentId}`);
};

// ── Module 6: AI-generated Pre-Meeting Briefing ──────────────
// Starts the briefing in the background. Every agenda item is
// summarised from the full text of its PDF (services/briefingService).
// Anyone who can see the meeting may start it; items that have not
// changed are not summarised again. Only the Secretary may ask for
// everything to be redone.
async function loadForBriefing(req) {
    const id = req.params.id;
    try {
        const meeting = await Meeting.findById(id);
        if (meeting) return { meeting, items: require('../services/missingFiles').checkAll(await Meeting.getAgendaItems(id)), mock: false };
    } catch (_) { /* no database */ }
    const meeting = findMockMeeting(id);
    return meeting ? { meeting, items: MOCK_AGENDA_ITEMS[parseInt(id, 10)] || [], mock: true } : null;
}

exports.generateBriefing = async (req, res) => {
    const id = req.params.id;
    const wantsJson = /json/.test(req.get('accept') || '');
    const ctx = await loadForBriefing(req);
    if (!ctx) return wantsJson ? res.status(404).json({ ok: false }) : res.redirect('/meeting');
    if (!canSeeMeeting(req.session.user, ctx.meeting)) {
        return wantsJson ? res.status(403).json({ ok: false }) : res.redirect('/meeting');
    }
    // After the meeting the agendas are closed: only the Office summarises them.
    if (ctx.meeting.status === 'Completed' && !['admin', 'secretary'].includes(req.session.user.role)) {
        return wantsJson ? res.status(403).json({ ok: false }) : res.redirect(`/meeting/${id}`);
    }

    // What to summarise:
    //   only=<id>          one item, written afresh (per-item button)
    //   item_ids=<id>...   the ticked items, written afresh
    //   (neither)          every item; unchanged ones are skipped
    const body = req.body || {};
    const asList = v => (Array.isArray(v) ? v : (v === undefined || v === '' ? [] : [v]));
    const withFile = new Map(ctx.items.filter(i => i.item_pdf || i.item_video).map(i => [String(i.item_id), i]));
    let picked = null;
    if (body.only !== undefined && body.only !== '') picked = [String(body.only)];
    else if (body.mode === 'selected') picked = asList(body.item_ids).map(String);

    // Where to go afterwards: the meeting page, or the item's document.
    const backTo = (body.return === 'review' && picked && picked.length === 1 && withFile.has(picked[0]))
        ? `/meeting/${id}/item/${picked[0]}/review#summary`
        : `/meeting/${id}#briefing`;

    let items, forceIds = [];
    if (picked) {
        items = [...new Set(picked)].map(k => withFile.get(k)).filter(Boolean);
        if (!items.length) {
            if (wantsJson) return res.status(400).json({ ok: false, error: 'Choose at least one agenda item that has a document.' });
            return res.redirect(`/meeting/${id}?briefing=none#briefing`);
        }
        forceIds = items.map(i => i.item_id);
    } else {
        items = ctx.items;
    }

    const job = briefingService.start({
        meetingId: id, items, userId: req.session.user.id, forceIds, mock: ctx.mock,
    });
    if (wantsJson) return res.json({ ok: true, job });
    res.redirect(backTo);
};

/** Cancel button while summarising. */
exports.cancelBriefing = async (req, res) => {
    const id = req.params.id;
    const wantsJson = /json/.test(req.get('accept') || '');
    const ctx = await loadForBriefing(req);
    if (!ctx || !canSeeMeeting(req.session.user, ctx.meeting)) {
        return wantsJson ? res.status(404).json({ ok: false }) : res.redirect('/meeting');
    }
    const user = req.session.user;
    // The Secretary may stop any briefing; a member only one they started.
    const mayStop = ['admin', 'secretary'].includes(user.role) ||
        String(briefingService.startedBy(id) || '') === String(user.id);
    const stopped = mayStop && briefingService.cancel(id);
    if (wantsJson) return res.json({ ok: !!stopped });
    const back = String((req.body && req.body.return) || '');
    if (/^\d+$/.test(back)) return res.redirect(`/meeting/${id}/item/${back}/review#summary`);
    res.redirect(`/meeting/${id}?briefing=${stopped ? 'cancelled' : 'notstopped'}#briefing`);
};

exports.briefingStatus = async (req, res) => {
    const ctx = await loadForBriefing(req);
    if (!ctx || !canSeeMeeting(req.session.user, ctx.meeting)) {
        return res.status(404).json({ ok: false });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, job: briefingService.status(req.params.id) });
};

// ── Module 7: Transcription (whisper.cpp) ────────────────────
exports.showTranscription = (req, res) => {
    res.render('transcription', {
        active:             'meeting',
        result:             null,
        meetingTitle:       null,
        fallbackReason:     null,
        quickSummary:       null,
        quickSummaryReason: null,
    });
};

exports.processTranscription = async (req, res) => {
    const { meetingTitle } = req.body;
    let result;
    let fallbackReason = null;

    try {
        if (req.file) {
            console.log(`[transcription] Processing audio: ${req.file.path}`);
            console.log(`[transcription] Original filename: ${req.file.originalname}`);
            console.log(`[transcription] MIME: ${req.file.mimetype}, size: ${req.file.size} bytes`);
            result = await transcriptionService.transcribe(req.file.path);
            console.log(`[transcription] SUCCESS — produced ${result.length} chars`);
        } else {
            throw new Error('no audio file uploaded');
        }
    } catch (err) {
        // No made-up sample transcript: a Board record must never show
        // words nobody said. The real reason is shown instead.
        console.error('[transcription] FAILED:', err.message);
        fallbackReason = err.message;
        result = 'failed';
    } finally {
        if (req.file) require('fs').unlink(req.file.path, () => {});
    }

    res.render('transcription', {
        active:             'meeting', result, meetingTitle, fallbackReason,
        quickSummary:        null,
        quickSummaryReason:  null,
    });
};

// ── Module 7: Basic post-transcription summary ───────────────
exports.processQuickSummary = async (req, res) => {
    const { meetingTitle, transcriptText } = req.body;
    let result        = transcriptText || '';
    let quickSummary  = null;
    let quickSummaryReason = null;

    try {
        if (!transcriptText || transcriptText.trim().length === 0) {
            throw new Error('no transcript provided');
        }
        console.log(`[quick-summary] Generating — input ${transcriptText.length} chars`);
        quickSummary = await llmService.quickSummary(transcriptText);
        console.log(`[quick-summary] SUCCESS — produced ${quickSummary.length} chars`);
    } catch (err) {
        console.error('[quick-summary] FAILED — falling back');
        console.error('[quick-summary] Reason:', err.message);
        quickSummaryReason = err.message;
        quickSummary =
            `• The Board Secretary called the meeting to order and established that a quorum was present.\n` +
            `• Dr. Reyes moved to approve the minutes of the previous meeting.\n` +
            `• The minutes were approved unanimously.\n` +
            `• Engr. Cruz raised a concern regarding infrastructure budget allocation.\n` +
            `• The Board agreed to direct the Finance Office to revise the budget proposal.\n` +
            `• The meeting was adjourned with no other matters raised.`;
    }

    res.render('transcription', {
        active: 'meeting', result, meetingTitle,
        fallbackReason: null,
        quickSummary, quickSummaryReason,
    });
};

// ── Module 8: Formal structured summary ──────────────────────
exports.showSummary = (req, res) => {
    res.render('summary', { active: 'meeting', result: null, fallbackReason: null });
};

exports.processSummary = async (req, res) => {
    const { meetingRef, transcriptText } = req.body;
    let result;
    let fallbackReason = null;

    try {
        if (transcriptText) {
            console.log(`[summary] Generating for "${meetingRef}" — ${transcriptText.length} chars`);
            result = await llmService.summarize(transcriptText);
            console.log(`[summary] SUCCESS — ${result.length} chars`);
        } else {
            throw new Error('no transcript provided');
        }
    } catch (err) {
        console.error('[summary] FAILED — falling back');
        console.error('[summary] Reason:', err.message);
        fallbackReason = err.message;
        result =
            `MEETING SUMMARY — ${meetingRef || 'Untitled'}\n\n` +
            `KEY DECISIONS:\n` +
            `• Academic Calendar AY 2026–2027 unanimously approved.\n` +
            `• Infrastructure budget approved with amendments.\n\n` +
            `ACTION ITEMS:\n` +
            `• Board Secretary to distribute approved calendar to all departments.\n` +
            `• Finance Office to revise budget per board recommendations.\n\n` +
            `NEXT MEETING: To be announced.`;
    }
    res.render('summary', { active: 'meeting', result, fallbackReason });
};

// Demo data, shared with the document review controller.
exports._mock = { findMockMeeting, MOCK_AGENDA_ITEMS, MOCK_COMMENTS };
