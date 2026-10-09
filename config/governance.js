// ============================================================
// config/governance.js — CSPC governing bodies
// ============================================================
//
// Membership counts and quorum thresholds for the four bodies the
// Office of the Board Secretary serves. Figures confirmed with the
// Board Secretary (September 2026).
//
// Quorum is NOT derived by formula. Three of the four bodies happen
// to sit at simple majority (half the membership plus one), but the
// Board of Trustees requires 7 of 11, which is more than a simple
// majority of 6. Because the rule is not uniform, each threshold is
// recorded as given rather than computed — a formula would quietly
// produce the wrong number for the Board.

const BODIES = {
    'Board of Trustees': {
        key:        'BOT',
        members:    11,
        quorum:     7,          // note: more than simple majority (6)
        shortName:  'Board of Trustees',
    },
    'Academic Council': {
        key:        'ACADEMIC',
        members:    72,
        quorum:     37,         // simple majority
        shortName:  'Academic Council',
    },
    'Administrative Council': {
        key:        'ADMIN',
        members:    20,
        quorum:     11,         // simple majority
        shortName:  'Administrative Council',
    },
    'RIC Council': {
        key:        'RIC',
        members:    20,
        quorum:     11,         // simple majority
        shortName:  'RIC Council',
    },
};

/** Quorum for a meeting type, or null when the type is unknown. */
function quorumFor(meetingType) {
    const body = BODIES[meetingType];
    return body ? body.quorum : null;
}

/** Total membership for a meeting type, or null. */
function membershipFor(meetingType) {
    const body = BODIES[meetingType];
    return body ? body.members : null;
}

/** Plain list for rendering dropdowns and client-side defaults. */
function asList() {
    return Object.entries(BODIES).map(([name, b]) => ({
        name, key: b.key, members: b.members, quorum: b.quorum,
    }));
}

module.exports = { BODIES, quorumFor, membershipFor, asList };
