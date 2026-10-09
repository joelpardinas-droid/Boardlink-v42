const autocannon = require('autocannon');
const { BASE, PASSWORD, EMAILS, ip, summary } = require('./common');
let k = 0;
autocannon({ url: BASE, connections: 100, amount: 1000, timeout: 120,
  requests: [{ method: 'POST', path: '/login', setupRequest: (req) => {
    k++;
    req.headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip() };
    req.body = new URLSearchParams({ email: EMAILS[k % EMAILS.length], password: PASSWORD }).toString();
    return req; } }],
}, (err, r) => { if (err) throw err;
  // A successful sign-in answers 302 (redirect to the dashboard).
  const ok = (r.statusCodeStats['302'] || {}).count || 0;
  const s = summary('Concurrent Login Load', r, { successful302: ok });
  s.errorRatePct = +(((r.requests.total - ok) / r.requests.total) * 100).toFixed(2);
  console.log(JSON.stringify(s, null, 1)); });
