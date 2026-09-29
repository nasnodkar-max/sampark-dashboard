// Local test: web-insight migration + /api/insights shape + refresh endpoints.
// Boots the real server against a temp DB with a legacy-schema insights table.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sampark-test-'));
const DB = path.join(tmp, 'test.db');
const PORT = 18473;
const PW = 'testpw123';

// 1) Build a LEGACY database: insights table without source/urls columns.
{
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE insights (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, rank INTEGER NOT NULL, topic TEXT NOT NULL, summary TEXT, ticket_count INTEGER DEFAULT 0, trend TEXT DEFAULT 'stable', suggested_action TEXT, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE citizens (wa_id TEXT PRIMARY KEY, name TEXT, phone TEXT, address TEXT, onboarding_step TEXT DEFAULT 'name', created_at INTEGER, updated_at INTEGER)`);
  db.exec(`CREATE TABLE tickets (id TEXT PRIMARY KEY, wa_id TEXT, citizen_name TEXT, phone TEXT, category TEXT, priority TEXT, status TEXT, kind TEXT DEFAULT 'issue', issue_address TEXT, event_datetime TEXT, venue TEXT, last_message TEXT, created_at INTEGER, updated_at INTEGER)`);
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT, direction TEXT, body TEXT, created_at INTEGER)`);
  db.exec(`CREATE TABLE approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT, draft TEXT, kind TEXT DEFAULT 'reply', status TEXT DEFAULT 'pending', created_at INTEGER)`);
  db.exec(`CREATE TABLE ai_chats (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, created_at INTEGER)`);
  const now = Date.now();
  const t = db.prepare(`INSERT INTO tickets (id, wa_id, citizen_name, phone, category, priority, status, kind, last_message, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const cats = ['water', 'road', 'water', 'streetlight', 'drainage'];
  cats.forEach((c, i) => t.run(`SKT-T${i}`, `wa${i}`, `Citizen ${i}`, `+91${i}`, c, 'Medium', 'new', 'issue', 'test message', now - i * 36e5, now - i * 36e5));
  db.close();
}

const srv = spawn('node', ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, DB_PATH: DB, PORT: String(PORT), DASHBOARD_PASSWORD: PW, LLM_PROVIDER: 'anthropic' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '', err = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => { err += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';

async function api(p, opts = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  const setc = r.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

(async () => {
  const results = [];
  const check = (name, ok, extra = '') => { results.push([ok ? 'PASS' : 'FAIL', name, extra]); };

  await sleep(2500);

  // 2) Migration: legacy table should now have source/urls columns.
  {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB);
    const cols = db.prepare('PRAGMA table_info(insights)').all().map((c) => c.name);
    db.close();
    check('migration adds source column', cols.includes('source'), cols.join(','));
    check('migration adds urls column', cols.includes('urls'));
  }

  // 3) Login (form POST /login, 302 + cookie on success).
  {
    const r = await fetch(`http://127.0.0.1:${PORT}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent(PW),
    });
    const setc = r.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    check('login works', r.status === 302 && !!cookie, `status=${r.status}`);
  }

  // 4) Force refresh insights (no Anthropic key -> template issues, empty web).
  {
    const { status, j } = await api('/api/admin/refresh-insights', { method: 'POST', body: '{}' });
    check('refresh-insights 200', status === 200, JSON.stringify(j).slice(0, 160));
    check('refresh returns issues+web', j.issues && j.web, JSON.stringify(j).slice(0, 160));
    check('issues generated from tickets', j.issues.count > 0, `count=${j.issues && j.issues.count}`);
    check('web empty without API key', j.web.empty === true || j.web.count === 0, JSON.stringify(j.web));
  }

  // 5) GET /api/insights shape.
  {
    const { status, j } = await api('/api/insights');
    check('GET insights 200', status === 200);
    check('shape has issues array', Array.isArray(j.issues), `keys=${Object.keys(j).join(',')}`);
    check('shape has web array', Array.isArray(j.web));
    check('no legacy insights key', !('insights' in j));
    check('issues rows have source=issues', j.issues.length > 0 && j.issues.every((r) => r.source === 'issues'));
    check('day set', !!j.day, `day=${j.day}`);
  }

  // 6) Cached refresh does not duplicate.
  {
    const { j } = await api('/api/admin/refresh-insights', { method: 'POST', body: '{}' });
    check('second refresh cached', j.issues.cached === true && j.web.cached !== undefined || j.web.empty === true, JSON.stringify(j).slice(0, 120));
  }

  console.log('\n==== results ====');
  let fails = 0;
  for (const [s, n, e] of results) { console.log(`${s}  ${n}${e ? '  — ' + e : ''}`); if (s === 'FAIL') fails++; }
  console.log(`==== ${results.length - fails}/${results.length} passed ====`);
  srv.kill();
  setTimeout(() => process.exit(fails ? 1 : 0), 500);
})().catch((e) => { console.error('TEST ERROR', e); srv.kill(); process.exit(1); });
