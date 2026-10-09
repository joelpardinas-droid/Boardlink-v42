-- ============================================================
-- BOARDLINK — Seed Data for Title Defense Demo
-- ============================================================
USE boardlink;
-- Read this file as UTF-8, so dashes and accented names are stored correctly.
SET NAMES utf8mb4;

DELETE FROM meeting_item_comments;
DELETE FROM meeting_agenda_items;
DELETE FROM meetings;
DELETE FROM document_ocr_text;
DELETE FROM documents;
DELETE FROM users;

-- Users: the six account types — System Administrator, Board
-- Secretary, Trustees, and members of the Administrative, Academic
-- and RIC Councils. Users sign in with the email
-- column. These are MOCK-UP Gmail addresses standing in for the
-- client's real ones (see config/demoAccounts.js); replace them
-- once the real addresses are known. Passwords are unchanged.
INSERT INTO users (user_id, username, password_hash, role, full_name, email, council_type, is_active, created_at) VALUES
(1, 'admin',          '$2a$12$zt/3nERcGi8ISJiSPhJp0OQpyamhwr65r0.uT1905mmNVTeUqLz4m', 'admin',     'Maria L. Reyes',         'boardlink.admin.demo@gmail.com',         NULL,       1, NOW()),
(2, 'secretary',      '$2a$12$B7BGAfNGp1k8ThqxjNC28.c13lk2TBqZABBpGPDxfW4uD4yulwCuS', 'secretary', 'Juan A. Dela Cruz',      'boardlink.secretary.demo@gmail.com',           NULL,       1, NOW()),
-- Trustees (Board of Trustees)
(5, 'trustee',        '$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Atty. Pedro G. Santos',  'boardlink.trustee1.demo@gmail.com',       'BOT',      1, NOW()),
(6, 'trustee2',       '$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Hon. Ricardo S. Ramos',  'boardlink.trustee2.demo@gmail.com',        'BOT',      1, NOW()),
(7, 'trustee3',       '$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Atty. Patricia E. Lim',  'boardlink.trustee3.demo@gmail.com',          'BOT',      1, NOW()),
-- Administrative Council
(8, 'administrative', '$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Hon. Maria T. Bautista', 'boardlink.admincouncil1.demo@gmail.com',     'ADMIN',    1, NOW()),
(9, 'administrative2','$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Dr. Jocelyn V. Mendoza', 'boardlink.admincouncil2.demo@gmail.com',      'ADMIN',    1, NOW()),
(10,'administrative3','$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Engr. Manuel B. Tan',    'boardlink.admincouncil3.demo@gmail.com',          'ADMIN',    1, NOW()),
-- Academic Council
(11,'academic',       '$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Dr. Sofia M. Aquino',    'boardlink.academic1.demo@gmail.com',       'ACADEMIC', 1, NOW()),
(12,'academic2',      '$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Dean Antonio P. Villanueva','boardlink.academic2.demo@gmail.com','ACADEMIC', 1, NOW()),
(13,'academic3',      '$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Dr. Helena F. Castillo', 'boardlink.academic3.demo@gmail.com',     'ACADEMIC', 1, NOW()),
-- RIC Council
(14,'ric',            '$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Engr. Robert L. Cruz',   'boardlink.ric1.demo@gmail.com',         'RIC',      1, NOW()),
(15,'ric2',           '$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Dr. Elena R. Domingo',   'boardlink.ric2.demo@gmail.com',      'RIC',      1, NOW()),
(16,'ric3',           '$2a$12$xQyUUCZRS3r14.I1VnG.KeqJZcGm3le5ZVq9wKze3ILJcsv3BbdK2', 'member',    'Dr. Ferdinand P. Garcia','boardlink.ric3.demo@gmail.com',       'RIC',      1, NOW());

-- Digital Archive: two Board resolutions. Their PDFs are in
-- sample-archive/ and are copied into uploads/ under these stored names
-- (they are also shipped in uploads/). To empty an existing archive and
-- add these two, run:  node scripts/reset-archive.js --yes
INSERT INTO documents (document_id, title, doc_type, doc_year, category, file_path, uploaded_by, uploaded_at) VALUES
(1, 'Approving the FY 2027 Administrative Budget of the Camarines Sur Polytechnic Colleges',
    'Resolution', 2026, '2026-21', 'a1b2c3d4e5f60718293a4b5c6d7e2621', 2, '2026-05-18 10:00:00'),
(2, 'Approving the Academic Calendar of the Camarines Sur Polytechnic Colleges for Academic Year 2026-2027',
    'Resolution', 2026, '2026-22', 'a1b2c3d4e5f60718293a4b5c6d7e2622', 2, '2026-05-18 10:05:00');

-- Their text, so they can be searched by their words at once.
INSERT INTO document_ocr_text (document_id, ocr_text, ocr_confidence, processed_at) VALUES
(1, 'Republic of the Philippines
 CAMARINES SUR POLYTECHNIC COLLEGES
 Nabua, Camarines Sur
 OFFICE OF THE BOARD SECRETARY

 Excerpt from the Minutes of the 114th Regular Board of Trustees Meeting of the
 Camarines Sur Polytechnic Colleges held on May 15, 2026 at the Board Room,
 CSPC Main Campus, Nabua, Camarines Sur

III. NEW BUSINESS
 A. Matters for Approval
 2. Financial-Fiscal Matters

The Vice President for Administration and Finance presented the proposed FY 2027
Administrative Budget of the College, as reviewed and endorsed by the Administrative
Council on May 6, 2026. After deliberation, the following was adopted:

On motion by Atty. Patricia E. Lim, duly seconded by Hon. Ricardo S. Ramos, the
Board passed:

 Resolution No. 2026-21
 Approving the FY 2027 Administrative Budget of the Camarines Sur
 Polytechnic Colleges in the total amount of Two Hundred Eighty-Four Million
 Six Hundred Thousand Pesos (PHP 284,600,000.00), broken down into
 Personnel Services, Maintenance and Other Operating Expenses, and Capital
 Outlay as endorsed by the Administrative Council, subject to existing budgeting,
 accounting and auditing rules and regulations.

I hereby certify to the correctness of the foregoing excerpt from the Minutes of the 114th
Regular Board of Trustees Meeting of the Camarines Sur Polytechnic Colleges.

JUAN A. DELA CRUZ
Board Secretary V
Date issued: May 18, 2026

Attested:

ATTY. PEDRO G. SANTOS
Presiding Officer

 BOARDLINK test document prepared for system demonstration. Not an official CSPC record.', 100.00, '2026-05-18 10:00:00'),
(2, 'Republic of the Philippines
 CAMARINES SUR POLYTECHNIC COLLEGES
 Nabua, Camarines Sur
 OFFICE OF THE BOARD SECRETARY

 Excerpt from the Minutes of the 114th Regular Board of Trustees Meeting of the
 Camarines Sur Polytechnic Colleges held on May 15, 2026 at the Board Room,
 CSPC Main Campus, Nabua, Camarines Sur

III. NEW BUSINESS
 A. Matters for Approval
 3. Academic Matters

The Vice President for Academic Affairs presented the proposed Academic Calendar for
Academic Year 2026-2027, as reviewed and endorsed by the Academic Council on May
5, 2026. After deliberation, the following was adopted:

On motion by Hon. Ricardo S. Ramos, duly seconded by Atty. Patricia E. Lim, the
Board passed:

 Resolution No. 2026-22
 Approving the Academic Calendar of the Camarines Sur Polytechnic Colleges
 for Academic Year 2026-2027, with the First Semester starting on August 17,
 2026 and the Second Semester starting on January 11, 2027, as endorsed by the
 Academic Council, subject to the conduct of not less than eighteen (18) weeks of
 classes per semester.

I hereby certify to the correctness of the foregoing excerpt from the Minutes of the 114th
Regular Board of Trustees Meeting of the Camarines Sur Polytechnic Colleges.

JUAN A. DELA CRUZ
Board Secretary V
Date issued: May 18, 2026

Attested:

ATTY. PEDRO G. SANTOS
Presiding Officer

 BOARDLINK test document prepared for system demonstration. Not an official CSPC record.', 100.00, '2026-05-18 10:05:00');

-- One meeting: the Board of Trustees meeting used for the demo.
-- Council meetings are created in the system by the Board Secretary.
INSERT INTO meetings (meeting_id, title, meeting_type, meeting_number, meeting_date, meeting_time, venue, mode,
                      called_by_user_id, presided_by_user_id, quorum_required, notes_for_members, comment_deadline,
                      status, created_by, created_at) VALUES
(1, '1st Regular Meeting of the Board of Trustees, AY 2026-2027',
    'Board of Trustees', 'BOT-2026-001', '2026-05-15', '09:00:00',
    'Board Room, CSPC Main Campus, Nabua', 'In-Person',
    2, 5, 7,
    'Items endorsed by the councils on May 5-7 will be taken up for final Board action.',
    '2026-05-10', 'Distributed', 2, '2026-04-28 10:00:00');

-- Its agenda. Item 1 is the review of the previous meeting's minutes,
-- as the Board Secretary enters it. No PDFs are seeded: the Secretary
-- attaches each item's document in the system.
INSERT INTO meeting_agenda_items (item_id, meeting_id, item_order, item_title, item_category) VALUES
(1, 1, 1, 'Approval of the Minutes of the 113th Regular Meeting',                   'Previous Minutes'),
(2, 1, 2, 'Approval of the FY 2027 Administrative Budget',                          'For Approval'),
(3, 1, 3, 'Renewal of the Maintenance Contract for the New Academic Building',      'For Approval'),
(4, 1, 4, 'Approval of the Academic Calendar AY 2026-2027',                         'For Approval'),
(5, 1, 5, 'Revision of the BSIT Curriculum (CMO 25 s. 2015 alignment)',             'For Approval'),
(6, 1, 6, 'Approval of the Internal Research Grant Program 2026-2028',              'For Approval'),
(7, 1, 7, 'MOA with the Provincial Government on Bicol Innovation Hub',             'For Approval'),
(8, 1, 8, 'Adjournment',                                                            'For Information');

-- A few pre-meeting comments from Trustees.
INSERT INTO meeting_item_comments (item_id, user_id, comment_text, commented_at) VALUES
(2, 5, 'I support the budget but request the legal-services line be increased to cover the new ISO recertification work.', '2026-05-09 10:00:00'),
(4, 5, 'No objection. We should align this with the labor calendar of the non-teaching personnel.',                       '2026-05-10 09:15:00'),
(6, 6, 'The grant program guidelines look complete. The PHP 250,000 ceiling per project is reasonable.',                  '2026-05-10 11:00:00');

SELECT 'users' AS table_name, COUNT(*) AS row_count FROM users
UNION SELECT 'meetings',           COUNT(*) FROM meetings
UNION SELECT 'meeting_agenda_items', COUNT(*) FROM meeting_agenda_items
UNION SELECT 'meeting_item_comments', COUNT(*) FROM meeting_item_comments;
