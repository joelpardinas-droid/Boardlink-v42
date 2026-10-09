// ============================================================
// services/notifyService.js — telling a member their comment is done
// ============================================================
// Used both when the Board Secretary clicks "Done" on a comment and
// when her edit of the document's words changes the very words a
// member commented on (BOARDLINK then marks the comment done itself).
// A failure here never undoes the "Done": only the notice is lost,
// and that is logged.

const Notification = require('../models/Notification');

function itemLabel(c) {
    if (!c.item_title) return 'an agenda item';
    return c.item_order ? `Item ${c.item_order}: ${c.item_title}` : c.item_title;
}

function shorten(text, max = 80) {
    const words = String(text || '').replace(/\s+/g, ' ').trim();
    return words.length > max ? words.slice(0, max - 3) + '...' : words;
}

/**
 * c: { comment_id, author_id | user_id, comment_text, item_id, item_title, item_order }
 * how: 'button' (Secretary clicked Done) or 'reworded' (her edit changed the words)
 */
async function commentDone(meetingId, c, actorId, how = 'button') {
    const authorId = c.author_id || c.user_id;
    if (!authorId || authorId === actorId) return false;
    const said = shorten(c.comment_text);
    const where = itemLabel(c);
    const message = how === 'reworded'
        ? `The Board Secretary revised the words you commented on and marked your comment "${said}" as done on ${where}.`
        : `The Board Secretary marked your comment "${said}" as done on ${where}.`;
    try {
        await Notification.create({
            userId:    authorId,
            kind:      'comment_done',
            message,
            link:      `/meeting/${Number(meetingId)}/item/${Number(c.item_id)}/review#comment-${Number(c.comment_id)}`,
            meetingId: Number(meetingId),
            itemId:    Number(c.item_id),
            commentId: Number(c.comment_id),
        });
        return true;
    } catch (err) {
        console.error('[comment done] could not notify the member:', err.message);
        return false;
    }
}

module.exports = { commentDone };
