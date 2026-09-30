#!/usr/bin/env node
// Daily refresh of candidates' recent Facebook/Instagram posts.
// Runs on the agent VM (which has the connected CLIs); pushes into the
// Sampark dashboard via the SYNC_TOKEN header. Render cannot run the CLIs.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.env.SAMPARK_BASE || 'https://sampark-dashboard-ujus.onrender.com';
const TOKEN_FILE = path.join(__dirname, '..', '.sync-token');
const SYNC_TOKEN = process.env.SYNC_TOKEN || (fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '');
const IG_ACCOUNT_ID = process.env.IG_ACCOUNT_ID || '17841409761888821';
if (!SYNC_TOKEN) { console.error('SYNC_TOKEN missing (env or .sync-token file)'); process.exit(1); }

function api(method, p, body) {
  const headers = { 'x-sync-token': SYNC_TOKEN };
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => {
      if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}`);
      return r.json();
    });
}
function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) { console.error(`  CLI failed: ${cmd} ${args.join(' ')}: ${String(e.message).slice(0, 120)}`); return null; }
}
const toMs = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

function fetchInstagram(username) {
  const raw = sh('instagram-cli', ['posts', '--account-id', IG_ACCOUNT_ID, '--username', username.replace(/^@/, ''), '--limit', '8']);
  if (!raw) return [];
  let d; try { d = JSON.parse(raw); } catch { return []; }
  return (d.posts || []).filter((p) => (p.username || '').toLowerCase() === username.replace(/^@/, '').toLowerCase())
    .slice(0, 6).map((p) => ({
      post_url: p.url,
      caption: (p.post_caption || '').slice(0, 600),
      posted_at: toMs(p.post_created_at && (p.post_created_at.utc || p.post_created_at.user_local)),
    }));
}
function fbProfileId(handle) {
  const h = String(handle || '').trim();
  const m = h.match(/(\d{5,})/);
  return m ? m[1] : (/^\d+$/.test(h) ? h : null);
}
function fetchFacebook(handle) {
  const pid = fbProfileId(handle);
  if (!pid) { console.error(`  cannot resolve FB profile id from "${handle}"`); return []; }
  const raw = sh('facebook-cli', ['timeline', 'fetch', '--profile-id', pid, '--limit', '8']);
  if (!raw) return [];
  let d; try { d = JSON.parse(raw); } catch { return []; }
  return (d.posts || []).slice(0, 6).map((p) => ({
    post_url: p.url,
    caption: (p.post_caption || '').slice(0, 600),
    posted_at: toMs(p.post_created_at && (p.post_created_at.utc || p.post_created_at.user_local)),
  })).filter((p) => p.post_url);
}

(async () => {
  const intel = await api('GET', '/api/election-intel');
  const cands = (intel.candidates || []).filter((c) => c.facebook_handle || c.instagram_handle);
  console.log(`${cands.length} candidates with social handles`);
  for (const c of cands) {
    console.log(`- ${c.name} (id ${c.id})`);
    if (c.instagram_handle) {
      const posts = fetchInstagram(c.instagram_handle);
      console.log(`  instagram @${c.instagram_handle}: ${posts.length} posts`);
      if (posts.length) await api('POST', `/api/election-intel/candidates/${c.id}/posts`,
        { platform: 'instagram', handle: c.instagram_handle.replace(/^@/, ''), posts });
    }
    if (c.facebook_handle) {
      const posts = fetchFacebook(c.facebook_handle);
      console.log(`  facebook ${c.facebook_handle}: ${posts.length} posts`);
      if (posts.length) await api('POST', `/api/election-intel/candidates/${c.id}/posts`,
        { platform: 'facebook', handle: c.facebook_handle, posts });
    }
  }
  console.log('done');
})().catch((e) => { console.error('refresh failed:', e.message); process.exit(1); });
