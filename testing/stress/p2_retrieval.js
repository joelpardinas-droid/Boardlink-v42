const autocannon = require('autocannon');
const { BASE, ip, login, summary } = require('./common');
(async () => {
  const cookies = []; for (let i = 0; i < 10; i++) cookies.push(await login());
  let k = 0;
  autocannon({ url: BASE, connections: 100, duration: 30, timeout: 30,
    requests: [{ method: 'GET', setupRequest: (req) => { k++;
      req.path = `/archive/${(k % 10) + 1}`;
      req.headers = { cookie: cookies[k % cookies.length], 'x-forwarded-for': ip() }; return req; } }],
  }, (err, r) => { if (err) throw err; console.log(JSON.stringify(summary('Document Retrieval Load', r), null, 1)); });
})();
