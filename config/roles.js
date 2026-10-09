// ============================================================
// config/roles.js — the six BOARDLINK account types
// ============================================================
//
// Per the client, BOARDLINK has exactly six kinds of account:
//
//   System Administrator      role = 'admin'
//   Board Secretary           role = 'secretary'
//   Trustee                   role = 'member', council_type = 'BOT'
//   Administrative Council    role = 'member', council_type = 'ADMIN'
//   Academic Council          role = 'member', council_type = 'ACADEMIC'
//   RIC Council               role = 'member', council_type = 'RIC'
//
// The four member types share role 'member' in the database and are
// told apart by council_type, which is also what scopes each member
// to their own body's meetings. This file is the one place that maps
// between the two, so forms and labels cannot drift apart.

const ACCOUNT_TYPES = [
    { key: 'admin',     role: 'admin',     council_type: null,       label: 'System Administrator',   short: 'Admin' },
    { key: 'secretary', role: 'secretary', council_type: null,       label: 'Board Secretary',        short: 'Secretary' },
    { key: 'BOT',       role: 'member',    council_type: 'BOT',      label: 'Trustee',                short: 'Trustee' },
    { key: 'ADMIN',     role: 'member',    council_type: 'ADMIN',    label: 'Administrative Council', short: 'Admin Council' },
    { key: 'ACADEMIC',  role: 'member',    council_type: 'ACADEMIC', label: 'Academic Council',       short: 'Academic Council' },
    { key: 'RIC',       role: 'member',    council_type: 'RIC',      label: 'RIC Council',            short: 'RIC Council' },
];

const ROLES = ['admin', 'secretary', 'member'];

/** The account type for a user record, or null if it is not valid. */
function accountTypeOf(user) {
    if (!user) return null;
    return ACCOUNT_TYPES.find(t =>
        t.role === user.role && (t.council_type || null) === (user.council_type || null)
    ) || null;
}

/** Display label for a user, e.g. "Trustee". */
function roleLabel(user, { short = false } = {}) {
    const t = accountTypeOf(user);
    if (t) return short ? t.short : t.label;
    return user && user.role ? String(user.role) : '—';
}

/** { role, council_type } for a submitted account-type key, or null. */
function fromAccountType(key) {
    const t = ACCOUNT_TYPES.find(x => x.key === key);
    return t ? { role: t.role, council_type: t.council_type } : null;
}

module.exports = { ACCOUNT_TYPES, ROLES, accountTypeOf, roleLabel, fromAccountType };
