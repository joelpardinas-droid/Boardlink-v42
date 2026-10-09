// ============================================================
// services/access.js — who may see and act on a meeting
// ============================================================
//
// One implementation of the council-scoping rule, shared by the
// meeting pages, the document review page and every comment
// endpoint, so the rule cannot drift between them.

/**
 * The System Administrator and Board Secretary see every meeting.
 * Members see only their own body's meetings: Trustees the Board
 * of Trustees, each council member their own council.
 */
function canSeeMeeting(user, meeting) {
    if (!user || !meeting) return false;
    if (['admin', 'secretary'].includes(user.role)) return true;
    if (user.role === 'member') {
        switch (user.council_type) {
            case 'BOT':      return meeting.meeting_type === 'Board of Trustees';
            case 'ADMIN':    return meeting.meeting_type === 'Administrative Council';
            case 'ACADEMIC': return meeting.meeting_type === 'Academic Council';
            case 'RIC':      return meeting.meeting_type === 'RIC Council';
            default:         return false;
        }
    }
    return false;
}

/** Only members comment; the Secretary and Administrator read. */
function isCommenter(user) {
    return !!user && user.role === 'member';
}

/** The Secretary (and Administrator) manage files and compile. */
function isSecretarial(user) {
    return !!user && ['admin', 'secretary'].includes(user.role);
}

/**
 * Comments are open until the meeting is completed or cancelled.
 * After that the record is frozen: nothing may be added, edited
 * or deleted.
 */
function commentsOpen(meeting) {
    return !!meeting && !['Completed', 'Cancelled'].includes(meeting.status);
}

module.exports = { canSeeMeeting, isCommenter, isSecretarial, commentsOpen };
