// Shared helpers for the BOARDLINK Jest suite.
// The tests talk to a running BOARDLINK server (npm start) backed by
// MySQL 8.0 and Meilisearch, so every request goes through the real
// routes, middleware, controllers and database.
const request = require('supertest');
const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const PASSWORD = process.env.TEST_PASSWORD || 'Test@2026!';
const ACCOUNTS = {
    admin:     'boardlink.admin.demo@gmail.com',
    secretary: 'boardlink.secretary.demo@gmail.com',
    trustee:   'boardlink.trustee1.demo@gmail.com',
    trustee2:  'boardlink.trustee2.demo@gmail.com',
    academic:  'boardlink.academic1.demo@gmail.com',
};
let ipSeq = 10;
// Each test signs in from its own address, as separate users would,
// so the per-network sign-in limiter does not interfere.
function nextIp() { ipSeq += 1; return `10.20.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`; }
async function login(who) {
    const agent = request.agent(BASE);
    const ip = nextIp();
    const res = await agent.post('/login').set('X-Forwarded-For', ip)
        .type('form').send({ email: ACCOUNTS[who], password: PASSWORD });
    if (res.status !== 302) throw new Error(`login as ${who} failed: ${res.status}`);
    return { agent, ip };
}
module.exports = { request, BASE, PASSWORD, ACCOUNTS, login, nextIp };
