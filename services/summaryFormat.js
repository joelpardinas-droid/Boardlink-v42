// ============================================================
// services/summaryFormat.js — split a stored item summary into
// its parts (SUMMARY / KEY POINTS / ACTION REQUESTED) for display.
// Shared by the meeting page and the document review page.
// ============================================================

function parseItemSummary(text) {
    const out = { summary: '', points: [], action: '' };
    let section = 'summary';
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        let m;
        if ((m = /^SUMMARY:\s*(.*)$/i.exec(line))) {
            section = 'summary';
            if (m[1]) out.summary += (out.summary ? ' ' : '') + m[1];
            continue;
        }
        if (/^KEY POINTS:?\s*$/i.test(line)) { section = 'points'; continue; }
        if ((m = /^ACTION REQUESTED:\s*(.*)$/i.exec(line))) { section = 'action'; out.action = m[1]; continue; }
        if (/^[-•*]\s+/.test(line) || section === 'points') {
            out.points.push(line.replace(/^[-•*]\s+/, ''));
            continue;
        }
        if (section === 'action') out.action += (out.action ? ' ' : '') + line;
        else out.summary += (out.summary ? ' ' : '') + line;
    }
    return out;
}

module.exports = { parseItemSummary };
