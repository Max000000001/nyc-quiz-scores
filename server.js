// The records table of the Manhattan Map Quiz (https://nyc-quiz.onrender.com): the first whole round of each mode per device,
// with a name, the share of correct answers and the mean error in km. Also the answer counts of all devices per object, for the
// «Самые сложные» quiz (the hardest objects first).
// A free Render web service. The rows live in scores.json, the counts in stats.json of a private GitHub repository (env DATA_REPO = owner/name), reached
// over SSH with a deploy key that can write to that one repository only (env DEPLOY_KEY); KNOWN_HOSTS = GitHub's host keys;
// QUIZ_KEY = the app's key, kept inside the sealed app.bin of the quiz.
//   GET  /health                 -> ok (wakes the sleeping service; no key)
//   GET  /top?mode=h0[&id=...][&limit=200]  -> { top: the best 10 (limit: 1..200, the records screen of the app asks 200), me: the row with this id and its rank, total }
//   POST /add {id, mode, name, ok, n, km}  -> the same table, with the new row as «me»
//   POST /del {id}               -> removes a row whose id starts with «selftest» (the deploy check only)
//   POST /stats [{cat, key, n, miss, km}, ...]  -> { added }: the answers of one device in one batch (an object once per batch: n <= 50 answers,
//                                   miss of them wrong, km = the distances of the misses added up; <= 300 objects; the whole batch or nothing)
//   GET  /hard?cat=hood          -> { cat, items: { key: [answers, misses, km], ... } }: the totals of all devices (cat: hood | street | sight | station)
// The totals sit in memory and are written to stats.json at most once a minute, and on SIGTERM. No address is stored: the hourly limits
// keep only a short salted hash of it in memory (as for /add), the counts carry no device id.
// env DRY_STATS=1: no GitHub at all; scores.json and stats.json live in a local folder (env DRY_DIR), for tests.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFile } = require('child_process');

const MODES = ['hoods', 'h0', 'h1', 'streets', 'sights', 'subway'];
const CATS = ['hood', 'street', 'sight', 'station'];                 // what an object is (hoods, h0 and h1 all ask about «hood»)
const DRY = process.env.DRY_STATS === '1';
const ORIGINS = ['https://nyc-quiz.onrender.com', 'null'];          // the site; «null» = the local file during checks
if (DRY) ORIGINS.push('http://127.0.0.1:8765', 'http://localhost:8765');   // the local test page
const ID = /^[a-z0-9]{8,32}$/;
const KEY = /^[^\u0000-\u001f\u007f]{1,80}$/;                          // an object's key in the counts
const MAXKEYS = 5000, FLUSH = +process.env.STATS_FLUSH_MS || 60000;     // per type (the quiz has 84 / 951 / 1807 / 121 objects); the write interval
const TMP = os.tmpdir(), DIR = DRY ? process.env.DRY_DIR || path.join(TMP, 'scores-data-dry') : path.join(TMP, 'scores-data'),
  KEYF = path.join(TMP, 'deploy_key'), KH = path.join(TMP, 'known_hosts');
const GITENV = { ...process.env, GIT_SSH_COMMAND: 'ssh -i ' + KEYF + ' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=' + KH };

let rows = [], state = 'starting', queue = Promise.resolve();
const newStats = () => Object.fromEntries(CATS.map(c => [c, Object.create(null)]));   // no prototype: a key may be «__proto__»
let stats = newStats(), statsDirty = false, statsTimer = null;        // cat -> key -> [answers, misses, km] of all devices
const recent = new Map(), recentStats = new Map();                     // address hash -> times of its rows / batches in the last hour

const run = (args, cwd) => new Promise((res, rej) => execFile('git', args, { cwd, env: GITENV, timeout: 60000 },
  (e, out, err) => e ? rej(new Error(String(err || e.message).split('\n')[0])) : res(out)));

function loadStats() {                                                 // stats.json: cat -> key -> [answers, misses, km]; none yet = no answers yet
  const out = newStats(); let j = {};
  try { j = JSON.parse(fs.readFileSync(path.join(DIR, 'stats.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.log('stats.json unreadable, starting empty:', e.message); }
  for (const c of CATS) for (const [k, v] of Object.entries(j && j[c] || {}))
    if (KEY.test(k) && Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && x >= 0)) out[c][k] = v;
  return out;
}

async function init() {
  if (DRY) fs.mkdirSync(DIR, { recursive: true });
  else {
    fs.writeFileSync(KEYF, process.env.DEPLOY_KEY.replace(/\\n/g, '\n').trim() + '\n', { mode: 0o600 });
    fs.writeFileSync(KH, process.env.KNOWN_HOSTS.replace(/\\n/g, '\n').trim() + '\n');
    fs.rmSync(DIR, { recursive: true, force: true });
    await run(['clone', '-q', '--depth', '1', 'git@github.com:' + process.env.DATA_REPO + '.git', DIR], TMP);
  }
  rows = DRY && !fs.existsSync(path.join(DIR, 'scores.json')) ? [] : JSON.parse(fs.readFileSync(path.join(DIR, 'scores.json'), 'utf8'));
  stats = loadStats();
  state = 'ready';
  console.log('rows loaded:', rows.length, '| objects counted:', CATS.map(c => c + ' ' + Object.keys(stats[c]).length).join(', '));
}

function write(file, text, msg) {                                      // one write at a time (one queue for both files); a failed push is retried on top of the remote
  queue = queue.then(async () => {
    fs.writeFileSync(path.join(DIR, file), text());
    if (DRY) return true;
    await run(['add', file], DIR);
    if ((await run(['status', '--porcelain', '--', file], DIR)).trim())       // nothing new to commit = an earlier push failed: only push again
      await run(['-c', 'user.name=nyc-quiz', '-c', 'user.email=nyc-quiz@users.noreply.github.com', 'commit', '-q', '-m', msg], DIR);
    try { await run(['push', '-q', 'origin', 'HEAD:main'], DIR); }
    catch (e) { await run(['pull', '-q', '--rebase', 'origin', 'main'], DIR); await run(['push', '-q', 'origin', 'HEAD:main'], DIR); }
    return true;
  }).catch(e => { console.log('save failed:', e.message); return false; });
  return queue;
}
const save = msg => write('scores.json', () => JSON.stringify(rows, null, 0).replace(/\},\{/g, '},\n{'), msg);

// the answer counts of all devices (the «Самые сложные» quiz ranks the objects by them)
function checkStats(b) {                                               // one batch of one device: every object once, all or nothing
  if (!Array.isArray(b) || !b.length || b.length > 300) return false;
  const seen = new Set();
  for (const x of b) {
    if (!x || !CATS.includes(x.cat) || typeof x.key !== 'string' || !KEY.test(x.key) || seen.has(x.cat + '|' + x.key)) return false;
    seen.add(x.cat + '|' + x.key);
    if (!Number.isInteger(x.n) || x.n < 1 || x.n > 50 || !Number.isInteger(x.miss) || x.miss < 0 || x.miss > x.n
        || typeof x.km !== 'number' || !(x.km >= 0) || x.km > x.miss * 50) return false;
  }
  return true;
}
function addStats(b) {                                                 // false: it would make more than MAXKEYS objects of a type
  for (const c of CATS) {
    const fresh = b.filter(x => x.cat === c && !(x.key in stats[c])).length;
    if (fresh && Object.keys(stats[c]).length + fresh > MAXKEYS) return false;
  }
  for (const x of b) {
    const a = stats[x.cat][x.key] || (stats[x.cat][x.key] = [0, 0, 0]);
    a[0] += x.n; a[1] += x.miss; a[2] = Math.round((a[2] + x.km) * 1000) / 1000;
  }
  return true;
}
const statsText = () => '{\n' + CATS.map(c => JSON.stringify(c) + ': {\n' +                      // one object a line, so the commits stay small
  Object.entries(stats[c]).map(([k, v]) => JSON.stringify(k) + ': ' + JSON.stringify(v)).join(',\n') + '\n}').join(',\n') + '\n}\n';
function markStats() { statsDirty = true; if (!statsTimer) statsTimer = setTimeout(flushStats, FLUSH); }
function flushStats() {                                                // one commit for all the answers of the last minute
  clearTimeout(statsTimer); statsTimer = null;
  if (!statsDirty) return queue;
  statsDirty = false;
  return write('stats.json', statsText, 'answer counts').then(ok => { if (!ok) markStats(); });   // not written: try again in a minute
}
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, async () => {   // Render stops the service on every deploy: the last minute is written first
  setTimeout(() => process.exit(0), 20000).unref();
  await flushStats(); await queue;
  process.exit(0);
});

function limited(map, req, max) {                                      // at most max calls an hour from one address (kept as a short salted hash in memory, not the address itself)
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = crypto.createHash('sha256').update(ip + process.env.QUIZ_KEY).digest('hex').slice(0, 16), now = Date.now();
  if (map.size > 5000) for (const [a, t] of map) if (!t.length || now - t[t.length - 1] >= 3600e3) map.delete(a);
  const t = (map.get(k) || []).filter(x => now - x < 3600e3);
  if (t.length >= max) return true;
  t.push(now); map.set(k, t);
  return false;
}

const rate = r => r.ok / r.n, err = r => r.km / r.n;
const order = (a, b) => rate(b) - rate(a) || err(a) - err(b) || a.d - b.d;
const pub = r => ({ id: r.id, name: r.name, ok: r.ok, n: r.n, km: r.km, d: r.d });
function table(mode, id, lim) {
  const L = rows.filter(r => r.mode === mode).sort(order), i = id ? L.findIndex(r => r.id === id) : -1;
  return { top: L.slice(0, lim || 10).map(pub), me: i >= 0 ? { ...pub(L[i]), rank: i + 1 } : null, total: L.length };
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
    const lim = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 10));   // the app's records screen asks for 200; older app versions send none (10)
    return send(res, 200, h, table(mode, id && ID.test(id) ? id : null, lim));
  }
  if (req.method === 'GET' && url.pathname === '/hard') {
    const cat = url.searchParams.get('cat');
    if (!CATS.includes(cat)) return send(res, 400, h, { error: 'cat' });
    return send(res, 200, h, { cat, items: stats[cat] });
  }
  if (req.method !== 'POST' || !['/add', '/del', '/stats'].includes(url.pathname)) return send(res, 404, h, { error: 'not found' });
  let body = '';
  req.on('data', c => { body += c; if (body.length > (url.pathname === '/stats' ? 60000 : 4000)) req.destroy(); });
  req.on('end', async () => {
    let b; try { b = JSON.parse(body); } catch (e) { b = null; }
    if (!b || typeof b !== 'object') return send(res, 400, h, { error: 'json' });   // not JSON, or «null» / a number: nothing below may meet it
    if (url.pathname === '/stats') {
      if (!checkStats(b)) return send(res, 400, h, { error: 'bad' });
      if (limited(recentStats, req, 600)) return send(res, 429, h, { error: 'later' });   // a device sends a batch every 10 answers
      if (!addStats(b)) return send(res, 400, h, { error: 'full' });
      markStats();
      return send(res, 200, h, { added: b.length });
    }
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
      if (limited(recent, req, 20)) return send(res, 429, h, { error: 'later' });   // at most 20 rows an hour from one address
      rows.push({ id: b.id, mode: b.mode, name, ok, n, km: Math.round(km * 1000) / 1000, d: Date.now() });
      await save('a result in ' + b.mode);
    }
    send(res, 200, h, table(b.mode, b.id));
  });
}).listen(process.env.PORT || 10000, () => console.log('listening'));

init().catch(e => { state = 'failed: ' + e.message.slice(0, 160); console.log('init failed:', e.message); });
