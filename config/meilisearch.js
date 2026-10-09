// ============================================================
// config/meilisearch.js — Meilisearch Client
// BOARDLINK | Chapter 3 Sec. 3.6 — Full-text AI document search
// ============================================================
//
// Meilisearch runs as an external service and is accessed through
// its official Node.js client. In BOARDLINK, every document that
// passes OCR processing is indexed into the "documents" index so
// that the AI-powered Document Search module (Module 4) can return
// ranked results in milliseconds.

const { MeiliSearch } = require('meilisearch');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });  // works from any folder

const client = new MeiliSearch({
    host:   process.env.MEILI_HOST    || 'http://localhost:7700',
    apiKey: process.env.MEILI_API_KEY || '',
});

// Index reference used across the search module.
const documentsIndex = client.index('documents');

module.exports = { client, documentsIndex };
