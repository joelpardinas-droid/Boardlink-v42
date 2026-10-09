-- ============================================================
-- BOARDLINK — MySQL / MariaDB Schema
-- ============================================================
--
-- 19 tables, the same as the Entity Relationship Diagram (ERD).
-- (Older versions also had RSVP/attendance, meeting minutes, drafted
-- resolutions, a separate meeting recording and an access log. Those
-- features were removed, and so were their tables and columns.)
--
-- How to use (phpMyAdmin): Import this file, then seed_data.sql.
-- BOARDLINK itself also adds anything missing when it starts, and
-- removes the old leftover tables from a database made by an older
-- version (services/dbCleanup.js).

CREATE DATABASE IF NOT EXISTS boardlink
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE boardlink;
SET NAMES utf8mb4;

-- ────────────────────────────────────────────────────────────
-- Re-import safety: drop the meeting tables (children first) and
-- the old leftover tables before creating them again. Accounts and
-- archived documents are kept (CREATE TABLE IF NOT EXISTS).
-- ────────────────────────────────────────────────────────────
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS agenda_access_requests;
DROP TABLE IF EXISTS agenda_archive;
DROP TABLE IF EXISTS agenda_item_file_versions;
DROP TABLE IF EXISTS agenda_item_summaries;
DROP TABLE IF EXISTS agenda_item_pages;
DROP TABLE IF EXISTS meeting_item_comments;
DROP TABLE IF EXISTS meeting_agenda_items;
DROP TABLE IF EXISTS meeting_briefings;
DROP TABLE IF EXISTS meetings;
-- old tables from removed features
DROP TABLE IF EXISTS minutes_reviews;
DROP TABLE IF EXISTS meeting_minutes;
DROP TABLE IF EXISTS meeting_summaries;
DROP TABLE IF EXISTS meeting_transcripts;
DROP TABLE IF EXISTS meeting_attendance;
DROP TABLE IF EXISTS resolutions;
DROP TABLE IF EXISTS access_logs;
DROP TABLE IF EXISTS agenda_comments;
DROP TABLE IF EXISTS agendas;
SET FOREIGN_KEY_CHECKS = 1;

-- 1. users — Accounts: System Administrator, Board Secretary, and members of the Board of Trustees and the three councils.
CREATE TABLE IF NOT EXISTS `users` (
  `user_id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(50) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `role` enum('admin','secretary','member') NOT NULL,
  `full_name` varchar(100) NOT NULL,
  `email` varchar(100) NOT NULL,
  `council_type` enum('BOT','ADMIN','ACADEMIC','RIC') DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `account_status` varchar(20) NOT NULL DEFAULT 'active',
  `requested_type` varchar(20) DEFAULT NULL,
  `retired_at` date DEFAULT NULL,
  `retired_from` varchar(60) DEFAULT NULL,
  `retired_note` varchar(255) DEFAULT NULL,
  `google_sub` varchar(64) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `uniq_users_email` (`email`),
  UNIQUE KEY `uniq_users_google` (`google_sub`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. user_sessions — Signed-in sessions (kept for eight hours, so a restart does not sign users out).
CREATE TABLE IF NOT EXISTS `user_sessions` (
  `session_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `expires` int(11) unsigned NOT NULL,
  `data` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  PRIMARY KEY (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. auth_codes — Six-digit codes e-mailed for sign-up and Forgot password (stored as hashes).
CREATE TABLE IF NOT EXISTS `auth_codes` (
  `code_id` int(11) NOT NULL AUTO_INCREMENT,
  `email` varchar(100) NOT NULL,
  `purpose` varchar(10) NOT NULL,
  `code_hash` char(64) NOT NULL,
  `payload` text DEFAULT NULL,
  `attempts` int(11) NOT NULL DEFAULT 0,
  `expires_at` datetime NOT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`code_id`),
  KEY `idx_auth_codes` (`email`,`purpose`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. app_settings — System-wide settings, such as the encrypted Google Drive backup connection.
CREATE TABLE IF NOT EXISTS `app_settings` (
  `setting_key` varchar(64) NOT NULL,
  `setting_value` text DEFAULT NULL,
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. documents — Digital Archive: Board Resolutions, manuals, policies and memoranda.
CREATE TABLE IF NOT EXISTS `documents` (
  `document_id` int(11) NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `doc_type` varchar(50) NOT NULL,
  `doc_year` int(11) NOT NULL,
  `category` varchar(100) DEFAULT NULL,
  `file_path` varchar(500) DEFAULT NULL,
  `uploaded_by` int(11) DEFAULT NULL,
  `uploaded_at` datetime DEFAULT current_timestamp(),
  `drive_backup_id` varchar(128) DEFAULT NULL,
  `drive_backup_at` datetime DEFAULT NULL,
  `governing_body` varchar(60) DEFAULT NULL,
  PRIMARY KEY (`document_id`),
  KEY `uploaded_by` (`uploaded_by`),
  CONSTRAINT `documents_ibfk_1` FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. document_ocr_text — All the words read from each archived document, for full-text search.
CREATE TABLE IF NOT EXISTS `document_ocr_text` (
  `document_id` int(11) NOT NULL,
  `ocr_text` longtext DEFAULT NULL,
  `ocr_confidence` decimal(5,2) DEFAULT NULL,
  `processed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`document_id`),
  CONSTRAINT `document_ocr_text_ibfk_1` FOREIGN KEY (`document_id`) REFERENCES `documents` (`document_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. meetings — Meetings of the Board of Trustees and the Administrative, Academic and RIC Councils.
CREATE TABLE IF NOT EXISTS `meetings` (
  `meeting_id` int(11) NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `meeting_type` enum('Board of Trustees','Administrative Council','Academic Council','RIC Council') NOT NULL,
  `meeting_number` varchar(50) NOT NULL,
  `meeting_date` date NOT NULL,
  `meeting_time` time NOT NULL,
  `venue` varchar(255) NOT NULL,
  `mode` enum('In-Person','Virtual','Hybrid') DEFAULT 'In-Person',
  `called_by_user_id` int(11) DEFAULT NULL,
  `presided_by_user_id` int(11) DEFAULT NULL,
  `quorum_required` int(11) NOT NULL DEFAULT 7,
  `notes_for_members` text DEFAULT NULL,
  `comment_deadline` date DEFAULT NULL,
  `status` enum('Scheduled','Distributed','In-Session','Completed','Cancelled') DEFAULT 'Scheduled',
  `created_by` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`meeting_id`),
  KEY `called_by_user_id` (`called_by_user_id`),
  KEY `presided_by_user_id` (`presided_by_user_id`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `meetings_ibfk_1` FOREIGN KEY (`called_by_user_id`) REFERENCES `users` (`user_id`),
  CONSTRAINT `meetings_ibfk_2` FOREIGN KEY (`presided_by_user_id`) REFERENCES `users` (`user_id`),
  CONSTRAINT `meetings_ibfk_5` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. meeting_briefings — The latest AI pre-meeting briefing run of each meeting.
CREATE TABLE IF NOT EXISTS `meeting_briefings` (
  `meeting_id` int(11) NOT NULL,
  `briefing_text` longtext DEFAULT NULL,
  `agenda_hash` varchar(64) DEFAULT NULL,
  `generated_at` datetime DEFAULT NULL,
  `generated_by` int(11) DEFAULT NULL,
  PRIMARY KEY (`meeting_id`),
  CONSTRAINT `meeting_briefings_ibfk_1` FOREIGN KEY (`meeting_id`) REFERENCES `meetings` (`meeting_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. meeting_agenda_items — Agenda items of a meeting, each with its PDF/Word file or a video (e.g. the President's Report).
CREATE TABLE IF NOT EXISTS `meeting_agenda_items` (
  `item_id` int(11) NOT NULL AUTO_INCREMENT,
  `meeting_id` int(11) NOT NULL,
  `item_order` int(11) NOT NULL,
  `item_title` varchar(500) NOT NULL,
  `item_category` enum('For Information','For Approval','For Decision','For Discussion','Previous Minutes') NOT NULL,
  `item_pdf` varchar(64) DEFAULT NULL,
  `item_pdf_name` varchar(255) DEFAULT NULL,
  `item_pdf_pages` int(11) DEFAULT NULL,
  `item_pdf_status` enum('processing','ready','failed') DEFAULT NULL,
  `item_pdf_version` int(11) NOT NULL DEFAULT 1,
  `item_docx` varchar(64) DEFAULT NULL,
  `item_video` varchar(80) DEFAULT NULL,
  `item_video_name` varchar(255) DEFAULT NULL,
  `item_video_kind` varchar(10) DEFAULT NULL,
  `item_video_status` varchar(20) DEFAULT NULL,
  `item_video_step` varchar(120) DEFAULT NULL,
  `item_video_error` varchar(600) DEFAULT NULL,
  `item_video_duration` int(11) DEFAULT NULL,
  `item_video_segments` longtext DEFAULT NULL,
  `item_video_text` longtext DEFAULT NULL,
  PRIMARY KEY (`item_id`),
  KEY `meeting_id` (`meeting_id`),
  CONSTRAINT `meeting_agenda_items_ibfk_1` FOREIGN KEY (`meeting_id`) REFERENCES `meetings` (`meeting_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. meeting_item_comments — Comments of members on an agenda item (on selected words, an area, or a moment in a video).
CREATE TABLE IF NOT EXISTS `meeting_item_comments` (
  `comment_id` int(11) NOT NULL AUTO_INCREMENT,
  `item_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `comment_text` text NOT NULL,
  `comment_phase` enum('Pre-Meeting','In-Session') DEFAULT 'Pre-Meeting',
  `page_number` int(11) DEFAULT NULL,
  `line_number` int(11) DEFAULT NULL,
  `status` enum('Open','Addressed') DEFAULT 'Open',
  `addressed_at` datetime DEFAULT NULL,
  `addressed_by` int(11) DEFAULT NULL,
  `anchor_lost` tinyint(1) NOT NULL DEFAULT 0,
  `anchor_stale` tinyint(1) NOT NULL DEFAULT 0,
  `anchor_type` enum('text','area') DEFAULT NULL,
  `anchor_quote` varchar(1000) DEFAULT NULL,
  `anchor_rects` text DEFAULT NULL,
  `commented_at` datetime DEFAULT current_timestamp(),
  `edited_at` datetime DEFAULT NULL,
  `video_time` decimal(10,2) DEFAULT NULL,
  PRIMARY KEY (`comment_id`),
  KEY `item_id` (`item_id`),
  KEY `user_id` (`user_id`),
  KEY `addressed_by` (`addressed_by`),
  CONSTRAINT `meeting_item_comments_ibfk_1` FOREIGN KEY (`item_id`) REFERENCES `meeting_agenda_items` (`item_id`) ON DELETE CASCADE,
  CONSTRAINT `meeting_item_comments_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`),
  CONSTRAINT `meeting_item_comments_ibfk_3` FOREIGN KEY (`addressed_by`) REFERENCES `users` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. agenda_item_pages — The words read on each page of an agenda item's PDF, with their positions.
CREATE TABLE IF NOT EXISTS `agenda_item_pages` (
  `item_id` int(11) NOT NULL,
  `page_no` int(11) NOT NULL,
  `has_text` tinyint(1) NOT NULL DEFAULT 0,
  `ocr_status` enum('not_needed','pending','done','failed') NOT NULL DEFAULT 'not_needed',
  `words` mediumtext DEFAULT NULL,
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`item_id`,`page_no`),
  CONSTRAINT `agenda_item_pages_ibfk_1` FOREIGN KEY (`item_id`) REFERENCES `meeting_agenda_items` (`item_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. agenda_item_summaries — The AI summary of each agenda item.
CREATE TABLE IF NOT EXISTS `agenda_item_summaries` (
  `item_id` int(11) NOT NULL,
  `item_pdf` varchar(64) DEFAULT NULL,
  `item_title` varchar(500) DEFAULT NULL,
  `item_category` varchar(50) DEFAULT NULL,
  `source_hash` varchar(64) DEFAULT NULL,
  `status` enum('done','no_text','no_file','failed') NOT NULL,
  `summary_text` mediumtext DEFAULT NULL,
  `unverified` text DEFAULT NULL,
  `pages_read` int(11) DEFAULT NULL,
  `ocr_pages` int(11) DEFAULT NULL,
  `chars_read` int(11) DEFAULT NULL,
  `model` varchar(100) DEFAULT NULL,
  `error_text` varchar(500) DEFAULT NULL,
  `generated_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`item_id`),
  CONSTRAINT `agenda_item_summaries_ibfk_1` FOREIGN KEY (`item_id`) REFERENCES `meeting_agenda_items` (`item_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. agenda_item_file_versions — Earlier files of an agenda item, kept when the file is replaced or edited.
CREATE TABLE IF NOT EXISTS `agenda_item_file_versions` (
  `version_id` int(11) NOT NULL AUTO_INCREMENT,
  `item_id` int(11) NOT NULL,
  `version` int(11) NOT NULL,
  `item_pdf` varchar(64) NOT NULL,
  `item_pdf_name` varchar(255) DEFAULT NULL,
  `item_docx` varchar(64) DEFAULT NULL,
  `pages` int(11) DEFAULT NULL,
  `note` varchar(255) DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`version_id`),
  UNIQUE KEY `uniq_item_version` (`item_id`,`version`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `agenda_item_file_versions_ibfk_1` FOREIGN KEY (`item_id`) REFERENCES `meeting_agenda_items` (`item_id`) ON DELETE CASCADE,
  CONSTRAINT `agenda_item_file_versions_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14. agenda_archive — Agenda items saved to the Digital Archive when the meeting ends (closed to members).
CREATE TABLE IF NOT EXISTS `agenda_archive` (
  `archive_id` int(11) NOT NULL AUTO_INCREMENT,
  `item_id` int(11) NOT NULL,
  `meeting_id` int(11) NOT NULL,
  `meeting_type` varchar(60) DEFAULT NULL,
  `meeting_number` varchar(60) DEFAULT NULL,
  `meeting_title` varchar(255) DEFAULT NULL,
  `meeting_date` date DEFAULT NULL,
  `item_order` int(11) DEFAULT NULL,
  `item_title` varchar(500) DEFAULT NULL,
  `item_category` varchar(40) DEFAULT NULL,
  `file_kind` varchar(10) DEFAULT NULL,
  `file_name` varchar(255) DEFAULT NULL,
  `content_text` longtext DEFAULT NULL,
  `archived_at` datetime DEFAULT current_timestamp(),
  `drive_backup_id` varchar(128) DEFAULT NULL,
  `drive_backup_at` datetime DEFAULT NULL,
  PRIMARY KEY (`archive_id`),
  UNIQUE KEY `item_id` (`item_id`),
  KEY `idx_aa_meeting` (`meeting_id`),
  CONSTRAINT `agenda_archive_ibfk_1` FOREIGN KEY (`item_id`) REFERENCES `meeting_agenda_items` (`item_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 15. agenda_access_requests — Members' requests to view an archived agenda item, approved or declined by the Office.
CREATE TABLE IF NOT EXISTS `agenda_access_requests` (
  `request_id` int(11) NOT NULL AUTO_INCREMENT,
  `item_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `reason` varchar(500) NOT NULL,
  `status` varchar(10) NOT NULL DEFAULT 'pending',
  `decided_by` int(11) DEFAULT NULL,
  `decided_at` datetime DEFAULT NULL,
  `decision_note` varchar(300) DEFAULT NULL,
  `expires_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`request_id`),
  KEY `idx_aar_item_user` (`item_id`,`user_id`),
  KEY `idx_aar_status` (`status`,`created_at`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `agenda_access_requests_ibfk_1` FOREIGN KEY (`item_id`) REFERENCES `meeting_agenda_items` (`item_id`) ON DELETE CASCADE,
  CONSTRAINT `agenda_access_requests_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 16. notifications — Messages shown to a user (comment done, new sign-up, access request and its decision).
CREATE TABLE IF NOT EXISTS `notifications` (
  `notification_id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `kind` varchar(40) NOT NULL DEFAULT 'comment_done',
  `message` varchar(500) NOT NULL,
  `link` varchar(300) DEFAULT NULL,
  `meeting_id` int(11) DEFAULT NULL,
  `item_id` int(11) DEFAULT NULL,
  `comment_id` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `read_at` datetime DEFAULT NULL,
  PRIMARY KEY (`notification_id`),
  KEY `idx_notif_user` (`user_id`,`read_at`,`created_at`),
  CONSTRAINT `notifications_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 17. document_access_requests — Members' requests to open an archived Board Resolution or document, approved (for one day) or declined by the Board Secretary.
CREATE TABLE IF NOT EXISTS `document_access_requests` (
  `request_id` int(11) NOT NULL AUTO_INCREMENT,
  `document_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `reason` varchar(500) NOT NULL,
  `status` varchar(10) NOT NULL DEFAULT 'pending',
  `decided_by` int(11) DEFAULT NULL,
  `decided_at` datetime DEFAULT NULL,
  `decision_note` varchar(300) DEFAULT NULL,
  `expires_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`request_id`),
  KEY `idx_dar_doc_user` (`document_id`,`user_id`),
  KEY `idx_dar_status` (`status`,`created_at`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `document_access_requests_ibfk_1` FOREIGN KEY (`document_id`) REFERENCES `documents` (`document_id`) ON DELETE CASCADE,
  CONSTRAINT `document_access_requests_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 18. user_account_logs — User Account Logs: sign-ups, approvals, account changes, removals, deletions, sign-ins, failed sign-ins and sign-outs (kept with the name and Gmail as they were).
CREATE TABLE IF NOT EXISTS `user_account_logs` (
  `log_id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) DEFAULT NULL,
  `user_email` varchar(255) DEFAULT NULL,
  `user_name` varchar(150) DEFAULT NULL,
  `actor_id` int(11) DEFAULT NULL,
  `actor_name` varchar(150) DEFAULT NULL,
  `action` varchar(30) NOT NULL,
  `details` varchar(500) DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`log_id`),
  KEY `idx_ual_user` (`user_id`,`created_at`),
  KEY `idx_ual_action` (`action`,`created_at`),
  KEY `idx_ual_time` (`created_at`),
  KEY `actor_id` (`actor_id`),
  CONSTRAINT `user_account_logs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `user_account_logs_ibfk_2` FOREIGN KEY (`actor_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 19. document_attachments — The approved documents of a Board Resolution (a file, pages copied out of the resolution's own PDF, or an agenda item of a past meeting), and the place in the resolution they are attached to (page, selected words, boxes).
CREATE TABLE IF NOT EXISTS `document_attachments` (
  `attachment_id` int(11) NOT NULL AUTO_INCREMENT,
  `resolution_id` int(11) NOT NULL,
  `document_id` int(11) DEFAULT NULL,
  `source` varchar(10) NOT NULL DEFAULT 'file',
  `anchor_page` int(11) DEFAULT NULL,
  `anchor_text` varchar(500) DEFAULT NULL,
  `anchor_rects` text DEFAULT NULL,
  `page_from` int(11) DEFAULT NULL,
  `page_to` int(11) DEFAULT NULL,
  `agenda_item_id` int(11) DEFAULT NULL,
  `attached_by` int(11) DEFAULT NULL,
  `attached_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`attachment_id`),
  UNIQUE KEY `uq_da_pair` (`resolution_id`,`document_id`),
  UNIQUE KEY `uq_da_agenda` (`resolution_id`,`agenda_item_id`),
  KEY `idx_da_document` (`document_id`),
  KEY `attached_by` (`attached_by`),
  KEY `agenda_item_id` (`agenda_item_id`),
  CONSTRAINT `document_attachments_ibfk_1` FOREIGN KEY (`resolution_id`) REFERENCES `documents` (`document_id`) ON DELETE CASCADE,
  CONSTRAINT `document_attachments_ibfk_2` FOREIGN KEY (`document_id`) REFERENCES `documents` (`document_id`) ON DELETE CASCADE,
  CONSTRAINT `document_attachments_ibfk_3` FOREIGN KEY (`attached_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL,
  CONSTRAINT `document_attachments_ibfk_4` FOREIGN KEY (`agenda_item_id`) REFERENCES `agenda_archive` (`item_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

