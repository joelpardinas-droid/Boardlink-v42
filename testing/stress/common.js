const BASE = 'http://127.0.0.1:3000';
const PASSWORD = 'Test@2026!';
const EMAILS = ['admin','secretary','trustee1','trustee2','trustee3','admincouncil1','admincouncil2','admincouncil3',
  'academic1','academic2','academic3','ric1','ric2','ric3'].map(k => `boardlink.${k}.demo@gmail.com`);
let n = 0;
// Every simulated user comes from its own address, as real users on
// separate devices would (the server trusts one proxy hop, as behind Caddy).
const ip = () => { n++; return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`; };
async function login(email = EMAILS[1]) {
  const r = await fetch(BASE + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip() },
    body: new URLSearchParams({ email, password: PASSWORD }) });
  const c = r.headers.get('set-cookie'); if (r.status !== 302 || !c) throw new Error('login failed ' + r.status);
  return c.split(';')[0];
}
function summary(name, r, extra = {}) {
  const total = r.requests.total, non2xx = r.non2xx || 0, errs = r.errors + r.timeouts;
  return { name, durationSec: r.duration, connections: r.connections, requests: total,
    avgLatencyMs: r.latency.average, p50: r.latency.p50, p90: r.latency.p90, p99: r.latency.p99, maxMs: r.latency.max,
    throughputReqPerSec: +(total / r.duration).toFixed(2), non2xx, socketErrors: errs,
    errorRatePct: +(((non2xx + errs) / Math.max(total, 1)) * 100).toFixed(2), statusCodes: r.statusCodeStats, ...extra };
}
module.exports = { BASE, PASSWORD, EMAILS, ip, login, summary };
