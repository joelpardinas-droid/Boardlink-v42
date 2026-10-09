# BOARDLINK

**An Integrated Digital Archiving and Board Governance Platform for the Office
of the Board Secretary of Camarines Sur Polytechnic Colleges**

Capstone research project, BSIT 4, College of Computer Studies, CSPC (2026).
Team: **CORE SOLUTIONS** — Baal · Gastilo · Pardinas · Radasa.
Adviser: Maricris L. Ramizares, MIT.

---

## Technology Stack

| Layer                | Technology                   | Version      |
|----------------------|------------------------------|--------------|
| Runtime              | Node.js                      | 22.x LTS     |
| Web framework        | Express.js                   | 4.x          |
| View engine          | EJS                          | 3.x          |
| Database             | MySQL                        | 8.0          |
| DB driver            | mysql2                       | 3.x          |
| Auth hashing         | bcryptjs                     | 2.x          |
| Session              | express-session              | 1.x          |
| File uploads         | multer                       | 2.x          |
| OCR                  | Tesseract.js                 | 5.x          |
| Transcription        | **whisper.cpp** (local)      | 1.x          |
| LLM (summary + briefing) | **Ollama + Llama 3.1 8B** (local) | 0.3.x / 8B |
| Document search      | Meilisearch (local)          | 1.x          |
| Front-end            | Bootstrap                    | 5.3          |

All AI components run **on-premise** within the CSPC environment — no meeting
audio, board resolution, or search query is transmitted to any third-party
cloud service. This is a hard design commitment documented in Chapter 3
Section 3.4.

The full stack specification is documented in Chapter 3 Section 3.4 Table 2
and Section 3.6 Table 5 of the capstone manuscript.

---

## Project Structure (MVC)

    boardlink/
    ├── config/         — DB, session, Meilisearch clients
    ├── middleware/     — auth (RBAC) + logger
    ├── models/         — M in MVC — DB queries (mysql2)
    ├── controllers/    — C in MVC — business logic
    ├── routes/         — thin URL-to-controller wiring
    ├── services/       — Tesseract, Whisper, Meilisearch integrations
    ├── views/          — V in MVC — EJS templates
    ├── public/         — static CSS / images
    ├── uploads/        — multer destination (runtime)
    ├── sql/            — database schema DDL
    └── server.js       — application entry point

---

## 8 Modules → Code Map

| # | Module                               | Controller                      | Route      |
|---|--------------------------------------|----------------------------------|------------|
| 1 | User & Access Management             | `userController.js`              | `/users`   |
| 2 | Digital Archiving                    | `archiveController.js`           | `/archive` |
| 2.3 | Pre-Meeting Review, **AI Briefing**, and Comment | `meetingController.js` (generateBriefing) + `briefingService.js` | `/meeting/:id/briefing` |
| 2.4 | OCR-based Document Processing and **Metadata Autofill** | `archiveController.js` (processAutofill) + `tesseractService.extractMetadata` | `/archive/autofill` |
| 3 | OCR Processing                       | `ocrController.js` (processOcr)  | `/ocr`     |
| 4 | AI-powered Document Search           | `ocrController.js` (search)      | `/ocr/search` |
| 5 | Agenda Management                    | `agendaController.js`            | `/agenda`  |
| 6 | Pre-Meeting Review & Comment         | `agendaController.js` (addComment) | `/agenda/:id/comment` |
| 7 | AI Meeting Transcription (whisper.cpp) | `meetingController.js` + `transcriptionService.js` | `/meeting/transcription` |
| 8 | AI-generated Meeting Summary (Ollama) | `meetingController.js` + `llmService.js` | `/meeting/summary` |

---

## Roles (RBAC)

Six account types (defined once in `config/roles.js`):

1. **System Administrator** — `role = admin`
2. **Board Secretary** — `role = secretary`
3. **Trustee** — `role = member`, `council_type = BOT`
4. **Administrative Council** — `role = member`, `council_type = ADMIN`
5. **Academic Council** — `role = member`, `council_type = ACADEMIC`
6. **RIC Council** — `role = member`, `council_type = RIC`

Each member type sees only its own body's meetings.

Role enforcement lives in `middleware/auth.js` and is applied per-route.

## Signing in

Users sign in with their **Gmail address** and BOARDLINK password
(`users.email`, unique). Until the client's real addresses are known,
the seed data uses mock-up addresses such as
`boardlink.secretary.demo@gmail.com`; the full list is in
`config/demoAccounts.js` and is shown on the login page when
`NODE_ENV` is not `production`. Replace them with the real Gmail
addresses before going live.

---

## Agenda Item Documents and Comments

Each agenda item can carry a PDF, attached by the Board Secretary on
**Create Meeting** (or later, from the meeting page). Files are stored on
the BOARDLINK server in `uploads/`; nothing is sent to an outside service.

* **Reading and commenting** — `Open & comment` on an agenda item opens
  `/meeting/:id/item/:itemId/review`. Trustees and council members select
  words and click **Comment**, or use **Mark an area** to box a table,
  figure or signature. Comments are saved with the page, the selected
  words and their position (as page fractions), so highlights line up at
  any zoom level. The viewer is PDF.js, served from `node_modules` at
  `/vendor/pdfjs`, so it works without internet access.
* **Scanned pages** — pages with no text are read with OCR in the
  background (a few seconds per page) by `services/itemPdfService.js`;
  their words become selectable when done. Any page can take an area
  comment immediately. Unfinished work resumes after a restart.
* **Adjusting a marked area** — a box can be moved or resized before the
  comment is posted, and afterwards by its author (*Edit area*), by
  dragging it, dragging a corner, or with the arrow keys. A highlight on
  words keeps its place, since it belongs to the words selected.
* **Editing** — members can edit or delete only their own comments, and
  only while the meeting is not completed and the Secretary has not yet
  marked the comment *Addressed*.
* **Editing the pages** — the Secretary can reorder, turn and remove an
  item's pages, and add pages from another PDF, from *Edit pages* on the
  document (`services/pdfEditService.js`). The words on a page are never
  rewritten. Comments move with their pages, highlights turn with a
  turned page, and a comment whose page was removed is kept against the
  item. The previous file is kept as an earlier version
  (`agenda_item_file_versions`), and the text of unchanged pages —
  including OCR of scans — is carried over instead of being read again.
* **Editing the words** — when the wording itself is wrong (a figure, a
  name, a sentence), the Secretary uses *Edit the words* on the document
  (`services/wordEditService.js`). Two ways, both ending in a new PDF
  version of the item's document:
  - **on the page** (the usual way) — BOARDLINK turns the PDF into a Word
    file behind the scenes and shows its paragraphs for editing, with the
    members' comments listed beside them and each one pointing at the
    paragraph its words are in. The corrected words are written back into
    that same Word file by `scripts/docx_blocks.py`, so **only the
    paragraphs actually edited are rewritten** and the rest of the
    document keeps its layout exactly. A paragraph may hold several
    visual lines (pdf2docx often puts them in one paragraph, separated by
    line breaks); those breaks and tabs survive the round trip, or lines
    of the document would silently vanish.
  - **in Microsoft Word** — for a heavy rewrite (adding paragraphs,
    changing formatting): the Word file is downloaded, edited in Word,
    and sent back.
  No comment is ever deleted. Because
  BOARDLINK saved the exact words each comment was made on, it looks for
  those words in the new document and moves the highlight to where they
  now are (`services/reanchorService.js`):
  - found → the comment moves to its new page and place;
  - only partly found, or a marked *area* (which has no words to look
    for) → it keeps its place and is marked *check this still marks the
    right place* (`anchor_stale`); its author answers that by moving it;
  - not found at all → the words are gone, so the comment is kept
    against the item with its old words still shown (`anchor_lost`).
  This needs `pdf2docx` and LibreOffice on the server (see
  `deploy/DEPLOYMENT.md`); until they are installed the page says so and
  nothing else is affected. A scanned document has no words to edit and
  is refused with that reason.
* **Compiling** — the Secretary downloads every comment as one Word or PDF
  document from the meeting page (*Comments & Attendance → Compile
  comments*), ordered by agenda item, page and highlighted passage
  (`services/compileService.js`). A comment whose words were changed says
  so, and one whose position should be checked is labelled.
* **Access** — every request checks that the agenda item belongs to the
  meeting in the URL and that the user may see that meeting
  (`services/access.js`).

Demo mode (no database) uses the two sample PDFs in `samples/`.

### AI pre-meeting briefing

**Summarise all items** on a meeting page summarises every agenda item
from the full text of its PDF (`services/briefingService.js`):

* Text pages are read with PDF.js; scanned pages use the OCR words saved
  at upload. The briefing waits for any scanned pages still being read.
* A document is sent to the local model (Ollama, `OLLAMA_NUM_CTX` =
  8192 tokens) in one piece when it fits, otherwise in parts of about
  12,000 characters whose facts are then combined, so no page is left out.
* Each summary has *SUMMARY*, *KEY POINTS* and *ACTION REQUESTED*.
  Every figure in it is checked against the document; the model is asked
  once more if one is not found, and any figure still unmatched is shown
  to readers as a caution.
* It runs in the background with a progress bar. Unchanged items are
  not summarised again; the Secretary can **Redo all**. If the model is
  unavailable, earlier summaries are kept.
* Expect roughly one to a few minutes per item on the documented i5 /
  8 GB hardware.

### Editing and deleting meetings

The Board Secretary can **Edit** a meeting (details, deadline, agenda
items, their order and PDFs) until it is completed, and **Delete** one
after typing its meeting number. The governing body can only change
while nobody has commented. A meeting with adopted resolutions cannot
be deleted.

---

## Local Setup

    # 1. Install Node dependencies
    npm install

    # 2. Configure environment
    cp .env.example .env
    #    then edit .env and fill in your local values

    # 3. Create the database (see sql/schema.sql), then load demo data
    mysql -u root -p < sql/schema.sql
    mysql -u root -p < sql/seed_data.sql
    #    Re-running schema.sql recreates the meeting tables (meetings,
    #    agenda items, comments, item pages), so existing meetings are lost.

    # 4. Install the local AI engines
    #    (a) whisper.cpp — for Module 7 transcription
    #        Build instructions: https://github.com/ggerganov/whisper.cpp
    #        After building, set WHISPER_BIN in .env to the binary path
    #        and download a model file (e.g. ggml-base.en.bin)
    #    (b) Ollama — for Module 8 summary and Module 2.3 briefing
    #        curl -fsSL https://ollama.com/install.sh | sh
    #        ollama pull llama3.1:8b
    #    (c) Meilisearch — for Module 4 document search
    #        Run via Docker or download from meilisearch.com

    # 5. Run the application
    npm run dev

    # The server listens on http://127.0.0.1:3000

> **Note:** The application boots gracefully even when the AI engines are not
> yet installed. Each controller falls back to canned mockup responses, which
> is useful during early development before the production server has been
> set up. The fallbacks are clearly visible as such; once the engines are
> wired up, real AI output replaces the mock data automatically.

---

## Notes on the Current State

This repository is the **structural baseline** of BOARDLINK. The MVC folders,
the database models, the service wrappers, and the RBAC middleware are all
in place and wired into the route layer. External integrations (Tesseract,
Whisper, Meilisearch) will behave as no-ops until their respective
credentials and running instances are configured through `.env`. During
early development, every controller gracefully falls back to the mock
responses used in the original UI prototype, which allows the views to
continue rendering end-to-end before the database is populated.

Feature implementation is tracked against the eight modules listed above,
one Agile sprint at a time, as described in Chapter 3 Section 3.2.1.
