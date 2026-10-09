// Module: User & Access Management — User Account Logs (v86)
const { request, BASE, login, nextIp, ACCOUNTS } = require('./helpers');
const pool = require('../config/db');
afterAll(() => pool.end());

const last = async (action, email) => {
    const [[r]] = await pool.query(
        `SELECT * FROM user_account_logs WHERE action = ? AND user_email = ? ORDER BY log_id DESC LIMIT 1`, [action, email]);
    return r || null;
};

describe('User Management page', () => {
    test('the RBAC Permission Matrix is gone and the logs are linked', async () => {
        const { agent, ip } = await login('admin');
        const res = await agent.get('/users').set('X-Forwarded-For', ip);
        expect(res.text).not.toContain('RBAC Permission Matrix');
        expect(res.text).toContain('href="/users/logs"');
    });
});

describe('What is logged', () => {
    test('a sign-in, with the IP address', async () => {
        const ip = nextIp();
        const agent = request.agent(BASE);
        await agent.post('/login').set('X-Forwarded-For', ip).type('form').send({ email: ACCOUNTS.trustee, password: 'Test@2026!' });
        const r = await last('signed_in', ACCOUNTS.trustee);
        expect(r.ip_address).toContain(ip);
        expect(r.user_id).toBeTruthy();
        await agent.get('/logout').set('X-Forwarded-For', ip);
        expect(await last('signed_out', ACCOUNTS.trustee)).not.toBeNull();
    });
    test('a wrong password and an unknown Gmail address', async () => {
        await request(BASE).post('/login').set('X-Forwarded-For', nextIp()).type('form').send({ email: ACCOUNTS.academic, password: 'wrong-password' });
        expect((await last('sign_in_failed', ACCOUNTS.academic)).details).toBe('Wrong password');
        const nobody = `nobody.${Date.now()}@gmail.com`;
        await request(BASE).post('/login').set('X-Forwarded-For', nextIp()).type('form').send({ email: nobody, password: 'whatever1' });
        const r = await last('sign_in_failed', nobody);
        expect(r.user_id).toBeNull();
        expect(r.details).toBe('No account with this Gmail address');
    });
    test('a new session id is given at sign-in', async () => {
        const ip = nextIp();
        const agent = request.agent(BASE);
        const first = await agent.get('/').set('X-Forwarded-For', ip);
        const before = (first.headers['set-cookie'] || []).join(';');
        const signin = await agent.post('/login').set('X-Forwarded-For', ip).type('form').send({ email: ACCOUNTS.trustee, password: 'Test@2026!' });
        const after = (signin.headers['set-cookie'] || []).join(';');
        expect(after).toMatch(/boardlink|sid|connect/i);
        if (before) expect(after).not.toBe(before);
    });
});

describe('User Account Logs page', () => {
    test('only the System Administrator can open it', async () => {
        const { agent, ip } = await login('secretary');
        expect((await agent.get('/users/logs').set('X-Forwarded-For', ip)).statusCode).toBe(302);
    });
    test('lists the logs and filters by what happened and by name', async () => {
        const { agent, ip } = await login('admin');
        const all = await agent.get('/users/logs').set('X-Forwarded-For', ip);
        expect(all.statusCode).toBe(200);
        expect(all.text).toContain('Signed in');
        const failed = await agent.get('/users/logs').query({ action: 'sign_in_failed', q: ACCOUNTS.academic }).set('X-Forwarded-For', ip);
        expect(failed.text).toContain('Wrong password');
        expect(failed.text).not.toContain('With Gmail address and password');
    });
    test('an account page shows its own history', async () => {
        const { agent, ip } = await login('admin');
        const [[t]] = await pool.query('SELECT user_id FROM users WHERE email = ?', [ACCOUNTS.trustee]);
        const res = await agent.get(`/users/${t.user_id}`).set('X-Forwarded-For', ip);
        expect(res.text).toContain('Account history');
        expect(res.text).toContain('Signed in');
    });
});
