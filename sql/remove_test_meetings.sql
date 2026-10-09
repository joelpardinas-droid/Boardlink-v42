-- ============================================================
-- BOARDLINK — remove the meetings made while testing
-- ============================================================
-- KEEPS the sample meeting
--   "1st Regular Meeting of the Board of Trustees, AY 2026-2027"
-- with its agenda items and comments, and removes EVERY OTHER meeting
-- with everything that belongs to it: agenda items and their files'
-- records, comments, AI summaries, briefings, agendas saved in
-- "Meeting Agendas", access requests and meeting notifications.
-- (For BOARDLINK v84 and later.)
--
-- Also KEEPS: user accounts, the Digital Archive's Board Resolutions &
-- Documents (uploaded PDFs, manuals...), and the Google Drive settings.
--
-- How: phpMyAdmin > click "boardlink" on the left > Import > choose
-- this file > Import.   (Do NOT import schema.sql again: that would
-- erase the accounts and Google settings too.)
-- ============================================================

USE boardlink;

-- The meeting to keep (the first one with this title).
SET @keep = COALESCE((SELECT MIN(meeting_id) FROM meetings
                       WHERE title = '1st Regular Meeting of the Board of Trustees, AY 2026-2027'), 0);

-- SAFETY: if that meeting is not found (title changed?), @keep is 0 and
-- every line below does nothing at all.

-- Notifications that point at the other meetings.
DELETE FROM notifications
 WHERE @keep > 0 AND ((meeting_id IS NOT NULL AND meeting_id <> @keep)
    OR (meeting_id IS NULL AND item_id IS NOT NULL
        AND item_id NOT IN (SELECT item_id FROM meeting_agenda_items WHERE meeting_id = @keep)));

-- The other meetings. Their agenda items, comments, briefings,
-- summaries, pages, file versions, archived agendas and access
-- requests are removed together with them.
DELETE FROM meetings WHERE @keep > 0 AND meeting_id <> @keep;

-- New meetings continue numbering right after the one kept.
ALTER TABLE meetings AUTO_INCREMENT = 1;
ALTER TABLE meeting_agenda_items AUTO_INCREMENT = 1;
ALTER TABLE meeting_item_comments AUTO_INCREMENT = 1;

SELECT IF(@keep > 0, 'Done: only the kept meeting is left.',
          'NOTHING WAS DELETED: the meeting to keep was not found.') AS result;
SELECT meeting_id, title, meeting_number, status FROM meetings;
