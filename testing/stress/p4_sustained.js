const autocannon = require('autocannon');
const { BASE, EMAILS, ip, login, summary } = require('./common');
const MIN = Number(process.env.MINUTES || 30);
(async () => {
  // Signed-in users of different account types browsing at once.
  const sec = [], bot = [];
  for (let i = 0; i < 5; i++) sec.push(await login(EMAILS[1]));
  for (let i = 0; i < 5; i++) bot.push(await login(EMAILS[2 + (i % 3)]));
  const paths = [
    ['/dashboard', bot], ['/meeting', bot], ['/meeting/1', bot], ['/archive', bot],
    ['/archive?q=curriculum', sec], ['/archive/6', sec], ['/meeting/1', sec], ['/dashboard', sec],
  ];
  let k = 0;
  autocannon({ url: BASE, connections: 50, duration: MIN * 60, timeout: 30,
    requests: [{ method: 'GET', setupRequest: (req) => { k++;
      const [p, pool] = paths[k % paths.length];
      req.path = p; req.headers = { cookie: pool[k % pool.length], 'x-forwarded-for': ip() }; return req; } }],
  }, (err, r) => { if (err) throw err; console.log(JSON.stringify(summary('Sustained Traffic', r), null, 1)); });
})();
