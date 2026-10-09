// Module: User and Access Management
const bcrypt = require('bcryptjs');
const { request, BASE, PASSWORD, ACCOUNTS, login, nextIp } = require('./helpers');
const roles = require('../config/roles');

describe('authController.processLogin', () => {
    test('valid credentials redirect to the dashboard', async () => {
        const res = await request(BASE).post('/login').set('X-Forwarded-For', nextIp())
            .type('form').send({ email: ACCOUNTS.secretary, password: PASSWORD });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/dashboard');
    });
    test('System Administrator is sent to User Management', async () => {
        const res = await request(BASE).post('/login').set('X-Forwarded-For', nextIp())
            .type('form').send({ email: ACCOUNTS.admin, password: PASSWORD });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/users');
    });
    test('invalid password shows an error message', async () => {
        const res = await request(BASE).post('/login').set('X-Forwarded-For', nextIp())
            .type('form').send({ email: ACCOUNTS.secretary, password: 'wrong' });
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('Invalid Gmail address or password.');
    });
    test('an address that is not a Gmail-style email is rejected', async () => {
        const res = await request(BASE).post('/login').set('X-Forwarded-For', nextIp())
            .type('form').send({ email: 'secretary', password: PASSWORD });
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('Enter your full Gmail address');
    });
});

describe('RBAC (middleware/auth.js)', () => {
    test('a visitor who is not signed in is sent to the login page', async () => {
        const res = await request(BASE).get('/meeting');
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/');
    });
    test('a Trustee cannot open User Management', async () => {
        const { agent, ip } = await login('trustee');
        const res = await agent.get('/users').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/dashboard');
    });
    test('the System Administrator can open User Management', async () => {
        const { agent, ip } = await login('admin');
        const res = await agent.get('/users').set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(200);
    });
});

describe('config/roles.js', () => {
    test('there are exactly six account types', () => {
        expect(roles.ACCOUNT_TYPES).toHaveLength(6);
    });
    test('a council member is labelled by council', () => {
        expect(roles.roleLabel({ role: 'member', council_type: 'RIC' })).toBe('RIC Council');
    });
    test('an unknown account type is refused', () => {
        expect(roles.fromAccountType('PRESIDENT')).toBeNull();
    });
});

describe('bcrypt password hashing', () => {
    test('the same password gives two different hashes that both verify', async () => {
        const a = await bcrypt.hash('Test@2026!', 12);
        const b = await bcrypt.hash('Test@2026!', 12);
        expect(a).not.toBe(b);
        expect(await bcrypt.compare('Test@2026!', a)).toBe(true);
        expect(await bcrypt.compare('wrong', b)).toBe(false);
    });
});

describe('System Administrator is limited to user accounts', () => {
    test.each(['/archive', '/meeting', '/meeting/1', '/ocr'])('typing %s sends the Administrator back to User Management', async (url) => {
        const { agent, ip } = await login('admin');
        const res = await agent.get(url).set('X-Forwarded-For', ip);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/users');
    });
});
