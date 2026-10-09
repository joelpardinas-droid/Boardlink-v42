// Module: User and Access Management — sign-up, forgot password,
// approval and removal of accounts (v56).
//
// The e-mailed codes are random and only their hash is stored, so the
// tests put a code they know into auth_codes directly, the same way
// BOARDLINK stores one.
const { request, BASE, PASSWORD, login, nextIp } = require('./helpers');
const pool = require('../config/db');
const AuthCode = require('../models/AuthCode');

const stamp = Date.now();
const NEW_EMAIL = `ut.signup.${stamp}@gmail.com`;
const NEW_PW = 'Signup2026x';

/** Replaces the code BOARDLINK e-mailed with one the test knows. */
async function knownCode(email, purpose, code = '123456') {
    await pool.query(
        `UPDATE auth_codes SET code_hash = ?, attempts = 0 WHERE email = ? AND purpose = ?`,
        [AuthCode._hash(email, purpose, code), email, purpose]);
    return code;
}

async function userByEmail(email) {
    const [[u]] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    return u || null;
}

afterAll(async () => {
    await pool.query('DELETE FROM auth_codes WHERE email LIKE ?', [`ut.%.${stamp}@gmail.com`]).catch(() => {});
    await pool.query('DELETE FROM notifications WHERE message LIKE ?', [`%${stamp}%`]).catch(() => {});
    await pool.query('DELETE FROM users WHERE email LIKE ?', [`ut.%.${stamp}@gmail.com`]).catch(() => {});
    await pool.end().catch(() => {});
});

describe('Login page', () => {
    test('shows "Forgot password?" and "Create an account"', async () => {
        const res = await request(BASE).get('/');
        expect(res.text).toContain('/forgot-password');
        expect(res.text).toContain('/signup');
    });
});

describe('Sign-up with a Gmail code', () => {
    test('only Gmail addresses can sign up', async () => {
        const res = await request(BASE).post('/signup').set('X-Forwarded-For', nextIp()).type('form')
            .send({ fullName: 'Not Gmail', email: `ut.other.${stamp}@yahoo.com`, requested: 'BOT', password: NEW_PW, confirm: NEW_PW });
        expect(res.statusCode).toBe(400);
        expect(res.text).toContain('Gmail');
    });
    test('a weak password is refused', async () => {
        const res = await request(BASE).post('/signup').set('X-Forwarded-For', nextIp()).type('form')
            .send({ fullName: 'Weak', email: `ut.weak.${stamp}@gmail.com`, requested: 'BOT', password: 'short', confirm: 'short' });
        expect(res.statusCode).toBe(400);
    });
    test('nobody can sign up as System Administrator', async () => {
        const res = await request(BASE).post('/signup').set('X-Forwarded-For', nextIp()).type('form')
            .send({ fullName: 'Sneaky', email: `ut.sneaky.${stamp}@gmail.com`, requested: 'admin', password: NEW_PW, confirm: NEW_PW });
        expect(res.statusCode).toBe(400);
    });
    test('the form sends a code, and a wrong code is refused', async () => {
        const res = await request(BASE).post('/signup').set('X-Forwarded-For', nextIp()).type('form')
            .send({ fullName: `UT Trustee ${stamp}`, email: NEW_EMAIL, requested: 'BOT', password: NEW_PW, confirm: NEW_PW });
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('6-digit code');
        const bad = await request(BASE).post('/signup/verify').set('X-Forwarded-For', nextIp()).type('form')
            .send({ email: NEW_EMAIL, code: '000000' });
        expect(bad.statusCode).toBe(400);
        expect(await userByEmail(NEW_EMAIL)).toBeNull();
    });
    test('the right code creates an account that waits for approval', async () => {
        const code = await knownCode(NEW_EMAIL, 'signup');
        const res = await request(BASE).post('/signup/verify').set('X-Forwarded-For', nextIp()).type('form')
            .send({ email: NEW_EMAIL, code });
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('Waiting for approval');
        const u = await userByEmail(NEW_EMAIL);
        expect(u.account_status).toBe('pending');
        expect(u.is_active).toBe(0);
        expect(u.requested_type).toBe('BOT');
    });
    test('a code works only once', async () => {
        const res = await request(BASE).post('/signup/verify').set('X-Forwarded-For', nextIp()).type('form')
            .send({ email: NEW_EMAIL, code: '123456' });
        expect(res.statusCode).toBe(400);
    });
    test('a pending account cannot sign in yet', async () => {
        const res = await request(BASE).post('/login').set('X-Forwarded-For', nextIp()).type('form')
            .send({ email: NEW_EMAIL, password: NEW_PW });
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('waiting for the System Administrator');
    });
    test('the System Administrator is told about the sign-up', async () => {
        const [rows] = await pool.query(
            `SELECT n.message FROM notifications n JOIN users u ON u.user_id = n.user_id
              WHERE u.role = 'admin' AND n.message LIKE ?`, [`%${NEW_EMAIL}%`]);
        expect(rows.length).toBeGreaterThanOrEqual(1);
    });
});

describe('System Administrator: approving and removing people', () => {
    test('only the System Administrator can approve', async () => {
        const u = await userByEmail(NEW_EMAIL);
        const { agent, ip } = await login('secretary');
        await agent.post(`/users/${u.user_id}/approve`).set('X-Forwarded-For', ip).type('form').send({ accountType: 'BOT' });
        expect((await userByEmail(NEW_EMAIL)).account_status).toBe('pending');
    });
    test('approving lets the person sign in as a Trustee', async () => {
        const u = await userByEmail(NEW_EMAIL);
        const { agent, ip } = await login('admin');
        const list = await agent.get('/users').set('X-Forwarded-For', ip);
        expect(list.text).toContain(NEW_EMAIL);
        const res = await agent.post(`/users/${u.user_id}/approve`).set('X-Forwarded-For', ip).type('form').send({ accountType: 'BOT' });
        expect(res.statusCode).toBe(302);
        const after = await userByEmail(NEW_EMAIL);
        expect(after.account_status).toBe('active');
        expect(after.council_type).toBe('BOT');
        const signin = await request(BASE).post('/login').set('X-Forwarded-For', nextIp()).type('form')
            .send({ email: NEW_EMAIL, password: NEW_PW });
        expect(signin.statusCode).toBe(302);
        expect(signin.headers.location).toBe('/dashboard');
    });
    test('removing a retired Trustee signs them out and stops sign-in', async () => {
        const u = await userByEmail(NEW_EMAIL);
        const member = request.agent(BASE);
        const ip = nextIp();
        await member.post('/login').set('X-Forwarded-For', ip).type('form').send({ email: NEW_EMAIL, password: NEW_PW });
        expect((await member.get('/dashboard').set('X-Forwarded-For', ip)).statusCode).toBe(200);

        const { agent, ip: aip } = await login('admin');
        await agent.post(`/users/${u.user_id}/retire`).set('X-Forwarded-For', aip).type('form')
            .send({ reason: 'Term ended', date: '2026-09-30', note: `test ${stamp}` });
        const after = await userByEmail(NEW_EMAIL);
        expect(after.account_status).toBe('retired');
        expect(after.retired_from).toBe('Trustee');
        expect(after.is_active).toBe(0);

        // Their open session ends within the re-check interval (30 s).
        await pool.query('SELECT 1');
        await new Promise(r => setTimeout(r, 31000));
        const page = await member.get('/dashboard').set('X-Forwarded-For', ip);
        expect(page.statusCode).toBe(302);
        expect(page.headers.location).toContain('notice=removed');

        const signin = await request(BASE).post('/login').set('X-Forwarded-For', nextIp()).type('form')
            .send({ email: NEW_EMAIL, password: NEW_PW });
        expect(signin.statusCode).toBe(200);
        expect(signin.text).toContain('removed from BOARDLINK');
    }, 60000);
    test('a removed person can be brought back', async () => {
        const u = await userByEmail(NEW_EMAIL);
        const { agent, ip } = await login('admin');
        await agent.post(`/users/${u.user_id}/reactivate`).set('X-Forwarded-For', ip).type('form').send({ accountType: 'ACADEMIC' });
        const after = await userByEmail(NEW_EMAIL);
        expect(after.account_status).toBe('active');
        expect(after.council_type).toBe('ACADEMIC');
    });
    test('"Account made by mistake" on an account with records removes it instead of deleting it', async () => {
        const { agent, ip } = await login('admin');
        const email = `mistake.records.${stamp}@gmail.com`;
        const [r] = await pool.query(
            `INSERT INTO users (username, password_hash, role, full_name, email, council_type, is_active, account_status)
             VALUES (?, 'x', 'member', 'Mistake With Records', ?, 'RIC', 1, 'active')`, [`mistake${stamp}`, email]);
        const [d] = await pool.query(
            `INSERT INTO documents (title, doc_type, doc_year, uploaded_by) VALUES ('Record of a mistaken account', 'Other', 2026, ?)`, [r.insertId]);
        try {
            const res = await agent.post(`/users/${r.insertId}/retire`).set('X-Forwarded-For', ip).type('form')
                .send({ reason: 'Account made by mistake' });
            expect(res.headers.location).toContain('done=keptMistake');
            const after = await userByEmail(email);
            expect(after).not.toBeNull();
            expect(after.account_status).toBe('retired');
            expect(after.retired_note).toBe('Account made by mistake');
        } finally {
            await pool.query('DELETE FROM documents WHERE document_id = ?', [d.insertId]);
            await pool.query('DELETE FROM users WHERE user_id = ?', [r.insertId]);
        }
    });
    test('"Account made by mistake" deletes the account completely, and the logs keep its name', async () => {
        const u = await userByEmail(NEW_EMAIL);
        const { agent, ip } = await login('admin');
        const page = await agent.get(`/users/${u.user_id}`).set('X-Forwarded-For', ip);
        expect(page.text).toContain('<option>Account made by mistake</option>');
        expect(page.text).not.toContain('Delete the account completely');
        const res = await agent.post(`/users/${u.user_id}/retire`).set('X-Forwarded-For', ip).type('form')
            .send({ reason: 'Account made by mistake' });
        expect(res.headers.location).toContain('done=deleted');
        expect(await userByEmail(NEW_EMAIL)).toBeNull();
        const [[log]] = await pool.query(
            `SELECT * FROM user_account_logs WHERE user_email = ? AND action = 'deleted_mistake' ORDER BY log_id DESC LIMIT 1`, [NEW_EMAIL]);
        expect(log.user_name).toBeTruthy();
        expect(log.actor_name).toBeTruthy();
        // The old separate delete form is gone.
        const old = await agent.post(`/users/${u.user_id}/delete`).set('X-Forwarded-For', ip).type('form').send({ confirm: NEW_EMAIL });
        expect(old.statusCode).toBe(404);
    });
    test('the administrator cannot remove their own account', async () => {
        const { agent, ip } = await login('admin');
        const [[me]] = await pool.query(`SELECT user_id FROM users WHERE email = 'boardlink.admin.demo@gmail.com'`);
        await agent.post(`/users/${me.user_id}/retire`).set('X-Forwarded-For', ip).type('form').send({ reason: 'Other' });
        const [[after]] = await pool.query('SELECT is_active FROM users WHERE user_id = ?', [me.user_id]);
        expect(after.is_active).toBe(1);
    });
});

describe('Forgot password', () => {
    test('asks for a code without saying whether the address exists', async () => {
        const a = await request(BASE).post('/forgot-password').set('X-Forwarded-For', nextIp()).type('form')
            .send({ email: `ut.nobody.${stamp}@gmail.com` });
        expect(a.statusCode).toBe(200);
        expect(a.text).toContain('If ut.nobody');
    });
    test('the code lets the person choose a new password', async () => {
        const email = 'boardlink.trustee2.demo@gmail.com';
        await request(BASE).post('/forgot-password').set('X-Forwarded-For', nextIp()).type('form').send({ email });
        const code = await knownCode(email, 'reset');
        const NEWPW = `Reset${stamp % 10000}x`;
        const res = await request(BASE).post('/reset-password').set('X-Forwarded-For', nextIp()).type('form')
            .send({ email, code, password: NEWPW, confirm: NEWPW });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/?notice=reset');
        const ok = await request(BASE).post('/login').set('X-Forwarded-For', nextIp()).type('form').send({ email, password: NEWPW });
        expect(ok.statusCode).toBe(302);
        // Put the test password back for the other tests.
        const bcrypt = require('bcryptjs');
        await pool.query('UPDATE users SET password_hash = ? WHERE email = ?', [await bcrypt.hash(PASSWORD, 10), email]);
    });
});

describe('Google Drive Backup belongs to the Board Secretary', () => {
    test('the Board Secretary opens it from the menu', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/settings/drive').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('href="/settings/drive"');
    });
    test('the System Administrator no longer has it', async () => {
        const { agent, ip } = await login('admin');
        const res = await agent.get('/settings/drive').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(302);
        const users = await agent.get('/users').set('X-Forwarded-For', ip);
        expect(users.text).not.toContain('href="/settings/drive"');
    });
    test('a Trustee cannot open it', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/settings/drive').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(302);
    });
});

describe('Choose what to back up (Board Secretary)', () => {
    let hadRefresh = null;
    beforeAll(async () => {
        await require('../services/driveBackup').ensureTables();
        const [[r]] = await pool.query(`SELECT setting_value FROM app_settings WHERE setting_key = 'drive_refresh'`);
        hadRefresh = r ? r.setting_value : null;
        // Pretend a Google account is connected (nothing is sent anywhere in tests).
        await pool.query(`REPLACE INTO app_settings (setting_key, setting_value) VALUES ('drive_refresh', 'test')`);
    });
    afterAll(async () => {
        if (hadRefresh === null) await pool.query(`DELETE FROM app_settings WHERE setting_key = 'drive_refresh'`);
        else await pool.query(`REPLACE INTO app_settings (setting_key, setting_value) VALUES ('drive_refresh', ?)`, [hadRefresh]);
    });

    test('the backup page has the button and no folder picture', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/settings/drive').set('X-Forwarded-For', ip);
        expect(res.text).toContain('href="/settings/drive/choose"');
        expect(res.text).toContain('Choose what to back up');
        expect(res.text).not.toContain('Folders in Google Drive');
    });
    test('the Secretary sees documents and agendas with tick boxes', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.get('/settings/drive/choose').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('Board Resolutions &amp; Documents');
        expect(res.text).toContain('Meeting Agendas');
        expect(res.text).toMatch(/<input type="checkbox" name="doc" value="\d+">/);
        expect(res.text).toContain('Back up selected');
    });
    test('nothing ticked: she is asked to tick something', async () => {
        const { agent, ip } = await login('secretary');
        const res = await agent.post('/settings/drive/backup-selected').set('X-Forwarded-For', ip).type('form').send({ tab: 'agendas' });
        expect(res.headers.location).toBe('/settings/drive/choose?tab=agendas&error=none');
    });
    test('a Trustee cannot open it', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/settings/drive/choose').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).not.toContain('/settings/drive/choose');
    });
});
