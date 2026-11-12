// The records table of the Manhattan Map Quiz (https://nyc-quiz.onrender.com): the first whole round of each mode per device,
// with a name, the share of correct answers and the mean error in km.
// A free Render web service. The rows live in scores.json of a private GitHub repository (env DATA_REPO = owner/name), reached
// over SSH with a deploy key that can write to that one repository only (env DEPLOY_KEY); KNOWN_HOSTS = GitHub's host keys;
// QUIZ_KEY = the app's key, kept inside the sealed app.bin of the quiz.
//   GET  /health                 -> ok (wakes the sleeping service; no key)
//   GET  /top?mode=h0[&id=...]   -> { top: the best 10, me: the row with this id and its rank, total }
//   POST /add {id, mode, name, ok, n, km}  -> the same table, with the new row as «me»
//   POST /del {id}               -> removes a row whose id starts with «selftest» (the deploy check only)
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFile } = require('child_process');

const MODES = ['hoods', 'h0', 'h1', 'streets', 'sights', 'subway'];
const ORIGINS = ['https://nyc-quiz.onrender.com', 'null'];          // the site; «null» = the local file during checks
const ID = /^[a-z0-9]{8,32}$/;
const TMP = os.tmpdir(), DIR = path.join(TMP, 'scores-data'), KEYF = path.join(TMP, 'deploy_key'), KH = path.join(TMP, 'known_hosts');
const GITENV = { ...process.env, GIT_SSH_COMMAND: 'ssh -i ' + KEYF + ' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=' + KH };

let rows = [], state = 'starting', queue = Promise.resolve();
const recent = new Map();                                             // address hash -> times of its rows in the last hour

const run = (args, cwd) => new Promise((res, rej) => execFile('git', args, { cwd, env: GITENV, timeout: 60000 },
  (e, out, err) => e ? rej(new Error(String(err || e.message).split('\n')[0])) : res(out)));

async function init() {
  fs.writeFileSync(KEYF, process.env.DEPLOY_KEY.replace(/\\n/g, '\n').trim() + '\n', { mode: 0o600 });
  fs.writeFileSync(KH, process.env.KNOWN_HOSTS.replace(/\\n/g, '\n').trim() + '\n');
  fs.rmSync(DIR, { recursive: true, force: true });
  await run(['clone', '-q', '--depth', '1', 'git@github.com:' + process.env.DATA_REPO + '.git', DIR], TMP);
  rows = JSON.parse(fs.readFileSync(path.join(DIR, 'scores.json'), 'utf8'));
  state = 'ready';
  console.log('rows loaded:', rows.length);
}

function save(msg) {                                                   // one write at a time; a failed push is retried on top of the remote
  queue = queue.then(async () => {
    fs.writeFileSync(path.join(DIR, 'scores.json'), JSON.stringify(rows, null, 0).replace(/\},\{/g, '},\n{'));
    await run(['add', 'scores.json'], DIR);
    await run(['-c', 'user.name=nyc-quiz', '-c', 'user.email=nyc-quiz@users.noreply.github.com', 'commit', '-q', '-m', msg], DIR);
    try { await run(['push', '-q', 'origin', 'HEAD:main'], DIR); }
    catch (e) { await run(['pull', '-q', '--rebase', 'origin', 'main'], DIR); await run(['push', '-q', 'origin', 'HEAD:main'], DIR); }
  }).catch(e => console.log('save failed:', e.message));
  return queue;
}

const rate = r => r.ok / r.n, err = r => r.km / r.n;
const order = (a, b) => rate(b) - rate(a) || err(a) - err(b) || a.d - b.d;
const pub = r => ({ id: r.id, name: r.name, ok: r.ok, n: r.n, km: r.km, d: r.d });
function table(mode, id) {
  const L = rows.filter(r => r.mode === mode).sort(order), i = id ? L.findIndex(r => r.id === id) : -1;
  return { top: L.slice(0, 10).map(pub), me: i >= 0 ? { ...pub(L[i]), rank: i + 1 } : null, total: L.length };
}

function send(res, status, h, x) {
  res.writeHead(status, { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(x));
}

http.createServer((req, res) => {
  const o = req.headers.origin || '', url = new URL(req.url, 'http://x');
  const h = { 'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0], 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Key', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
  if (url.pathname === '/health') return send(res, state === 'ready' ? 200 : 503, h, { state });
  if (req.headers['x-key'] !== process.env.QUIZ_KEY) return send(res, 403, h, { error: 'key' });
  if (state !== 'ready') return send(res, 503, h, { error: 'starting' });
  if (req.method === 'GET' && url.pathname === '/top') {
    const mode = url.searchParams.get('mode'), id = url.searchParams.get('id');
    if (!MODES.includes(mode)) return send(res, 400, h, { error: 'mode' });
    return send(res, 200, h, table(mode, id && ID.test(id) ? id : null));
  }
  if (req.method !== 'POST' || !['/add', '/del'].includes(url.pathname)) return send(res, 404, h, { error: 'not found' });
  let body = '';
  req.on('data', c => { body += c; if (body.length > 4000) req.destroy(); });
  req.on('end', async () => {
    let b; try { b = JSON.parse(body); } catch (e) { return send(res, 400, h, { error: 'json' }); }
    if (url.pathname === '/del') {
      if (!/^selftest[a-z0-9]{4,24}$/.test(String(b.id))) return send(res, 400, h, { error: 'bad' });
      const n0 = rows.length; rows = rows.filter(r => r.id !== b.id);
      if (rows.length !== n0) await save('remove a test row');
      return send(res, 200, h, { removed: n0 - rows.length });
    }
    const name = String(b.name || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const { ok, n, km } = b;
    if (!MODES.includes(b.mode) || !ID.test(String(b.id)) || !name || !Number.isInteger(ok) || !Number.isInteger(n) || n < 5 || n > 5000
        || ok < 0 || ok > n || typeof km !== 'number' || !(km >= 0) || km > n * 30) return send(res, 400, h, { error: 'bad' });
    if (!rows.some(r => r.id === b.id)) {                              // a resend keeps the first row
      // at most 20 rows an hour from one address (kept as a short salted hash in memory, not the address itself)
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const k = crypto.createHash('sha256').update(ip + process.env.QUIZ_KEY).digest('hex').slice(0, 16), now = Date.now();
      const t = (recent.get(k) || []).filter(x => now - x < 3600e3);
      if (t.length >= 20) return send(res, 429, h, { error: 'later' });
      t.push(now); recent.set(k, t);
      rows.push({ id: b.id, mode: b.mode, name, ok, n, km: Math.round(km * 1000) / 1000, d: now });
      await save('a result in ' + b.mode);
    }
    send(res, 200, h, table(b.mode, b.id));
  });
}).listen(process.env.PORT || 10000, () => console.log('listening'));

init().catch(e => { state = 'failed: ' + e.message.slice(0, 160); console.log('init failed:', e.message); });
