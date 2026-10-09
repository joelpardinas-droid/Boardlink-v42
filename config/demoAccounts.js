// ============================================================
// config/demoAccounts.js — mock-up Gmail sign-in accounts
//
// BOARDLINK signs users in with their Gmail address. The client's
// real addresses are not known yet, so these placeholder Gmail
// accounts stand in for one person per account type. They match
// the rows in sql/seed_data.sql (same names, same addresses).
//
// These are placeholders only: BOARDLINK never sends mail to them,
// and signing in checks the password stored in BOARDLINK, not a
// Google password. When the real addresses arrive, update each
// user's email in the database and delete or empty this list.
//
// DEMO_ACCOUNTS is also the no-database fallback: if MySQL is not
// reachable, these addresses can still sign in so every screen can
// be demonstrated. That fallback is disabled in production.
// ============================================================

const DEMO_ACCOUNTS = [
    { email: 'boardlink.admin.demo@gmail.com',         id: 901, fullName: 'Maria L. Reyes',         role: 'admin',     council_type: null,       label: 'System Administrator' },
    { email: 'boardlink.secretary.demo@gmail.com',     id: 902, fullName: 'Juan A. Dela Cruz',      role: 'secretary', council_type: null,       label: 'Board Secretary' },
    { email: 'boardlink.trustee1.demo@gmail.com',      id: 905, fullName: 'Atty. Pedro G. Santos',  role: 'member',    council_type: 'BOT',      label: 'Trustee' },
    { email: 'boardlink.admincouncil1.demo@gmail.com', id: 906, fullName: 'Hon. Maria T. Bautista', role: 'member',    council_type: 'ADMIN',    label: 'Administrative Council' },
    { email: 'boardlink.academic1.demo@gmail.com',     id: 907, fullName: 'Dr. Sofia M. Aquino',    role: 'member',    council_type: 'ACADEMIC', label: 'Academic Council' },
    { email: 'boardlink.ric1.demo@gmail.com',          id: 908, fullName: 'Engr. Robert L. Cruz',   role: 'member',    council_type: 'RIC',      label: 'RIC Council' },
];

// Shown on the login page and usable as the no-database fallback
// everywhere except production.
const demoEnabled = () => process.env.NODE_ENV !== 'production';

function findDemoAccount(email) {
    if (!demoEnabled()) return null;
    const key = String(email || '').trim().toLowerCase();
    return DEMO_ACCOUNTS.find(a => a.email === key) || null;
}

module.exports = { DEMO_ACCOUNTS, demoEnabled, findDemoAccount };
