// Sampark real dashboard — Meta WhatsApp Cloud API webhook + politician dashboard API.
// Text + image messages (citizens share issue photos; the office shares completed-work photos).
// Voice intake excluded by product scope.
// Env: PORT, WEBHOOK_VERIFY_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
//      WHATSAPP_APP_SECRET (optional, enables webhook signature check), REP_NAME.

require('dotenv').config(); // loads .env into process.env (must run before lib/ai)
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const ai = require('./lib/ai');

// AI brief cache — the dashboard polls every 5s; never burn an LLM call per poll.
const BRIEF_TTL_MS = 15 * 60 * 1000;
let briefCache = { text: null, at: 0 };
function markBriefDirty() { briefCache.at = 0; }

// ---------- tiny .env loader (no dependency) ----------
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
})();

const PORT = parseInt(process.env.PORT || '3000', 10);
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || '';
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const REP_NAME = process.env.REP_NAME || 'Arjun Deshpande';
const CONSTITUENCY = process.env.CONSTITUENCY || 'Margao';
const CONFIGURED = Boolean(WA_TOKEN && PHONE_NUMBER_ID);

// ---------- dashboard password gate (politician portal) ----------
// Set DASHBOARD_PASSWORD in the environment. No password configured -> locked for everyone (fail closed).
// The Meta webhook (/webhook) and Render health check (/api/health) stay public; everything else needs the cookie.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const AUTH_SALT = crypto.randomBytes(16).toString('hex'); // per-boot: restarts require re-login
const AUTH_COOKIE = 'sp_auth';
function authToken() {
  return crypto.createHash('sha256').update(AUTH_SALT + '\n' + DASHBOARD_PASSWORD).digest('hex');
}
function getCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function isAuthed(req) {
  if (!DASHBOARD_PASSWORD) return false;
  const tok = getCookie(req, AUTH_COOKIE);
  if (!tok) return false;
  const a = Buffer.from(tok), b = Buffer.from(authToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login required' });
  return res.redirect('/login');
}

// ---------- storage (SQLite, zero extra deps via node:sqlite) ----------
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sampark.db');
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (e) { /* exists */ }
const db = new DatabaseSync(DB_PATH);
// ---------- media storage (issue photos, completed-work photos) ----------
// Lives next to the DB so it survives on the persistent disk in production.
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(path.dirname(DB_PATH), 'media');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) { /* exists */ }
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
// Sanitize a media filename: basename only, strict charset, must exist under MEDIA_DIR.
function mediaFilePath(name) {
  const base = path.basename(String(name || ''));
  if (!base || !/^[\w.\-]{1,120}$/.test(base)) return null;
  const full = path.join(MEDIA_DIR, base);
  if (path.dirname(full) !== MEDIA_DIR) return null;
  return full;
}
db.exec(`
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  wa_id TEXT NOT NULL,
  citizen_name TEXT,
  category TEXT DEFAULT 'other',
  priority TEXT DEFAULT 'Medium',
  status TEXT DEFAULT 'new',
  pending_draft TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_wa ON tickets(wa_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  wa_message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);
if (!db.prepare("SELECT v FROM meta WHERE k='next_seq'").get()) {
  db.prepare("INSERT INTO meta (k,v) VALUES ('next_seq','1')").run();
}
// lightweight migration: track whether a draft came from the AI or the template fallback
try { db.exec("ALTER TABLE tickets ADD COLUMN draft_source TEXT DEFAULT 'template'"); } catch (e) { /* already there */ }
// lightweight migration: onboarding flag — 1 while we're still waiting for the citizen's name
try { db.exec("ALTER TABLE tickets ADD COLUMN awaiting_name INTEGER DEFAULT 0"); } catch (e) { /* already there */ }
// lightweight migration: sensitivity gate — 1 = needs human approval, 0 = safe to auto-reply (fail closed)
try { db.exec("ALTER TABLE tickets ADD COLUMN sensitive INTEGER DEFAULT 1"); } catch (e) { /* already there */ }
// lightweight migration: mark outbound messages the office auto-sent (vs human-approved)
try { db.exec("ALTER TABLE messages ADD COLUMN auto INTEGER DEFAULT 0"); } catch (e) { /* already there */ }
// one-time repair (2026-09-29): the demo seed wrongly flagged synthetic messages as
// office auto-sends (they never went through WhatsApp) and stamped some with future
// timestamps, burying real auto-sends in the review log. Synthetic rows carry
// wa_message_id LIKE 'seed-%'. Safe to re-run: matches nothing once repaired.
try {
  const nowMs = Date.now();
  db.prepare("UPDATE messages SET auto=0 WHERE auto=1 AND wa_message_id LIKE 'seed-%'").run();
  db.prepare("UPDATE messages SET created_at=? WHERE created_at>?").run(nowMs, nowMs);
} catch (e) { console.error('auto-sent repair migration failed:', e.message); }
// Politician-posted updates on a ticket; citizens are notified via WhatsApp.
db.exec(`
CREATE TABLE IF NOT EXISTS ticket_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  body TEXT NOT NULL,
  notified INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_updates_ticket ON ticket_updates(ticket_id);
`);
// ---------- Sampark AI assistant: citizens registry, events, insights ----------
// Citizens registry: everyone who ever messaged, with onboarding progress.
db.exec(`
CREATE TABLE IF NOT EXISTS citizens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT UNIQUE NOT NULL,
  name TEXT,
  phone TEXT,
  address TEXT,
  onboarding_step TEXT DEFAULT 'name',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_citizens_wa ON citizens(wa_id);
`);
// Tickets: kind (issue vs event), location of the issue, event date/time + venue.
try { db.exec("ALTER TABLE tickets ADD COLUMN kind TEXT DEFAULT 'issue'"); } catch (e) { /* already there */ }
try { db.exec("ALTER TABLE tickets ADD COLUMN issue_address TEXT"); } catch (e) { /* already there */ }
try { db.exec("ALTER TABLE tickets ADD COLUMN event_datetime TEXT"); } catch (e) { /* already there */ }
try { db.exec("ALTER TABLE tickets ADD COLUMN venue TEXT"); } catch (e) { /* already there */ }
// Message media: photos shared by citizens (issue photos) or the office (completed work).
try { db.exec("ALTER TABLE messages ADD COLUMN media_type TEXT"); } catch (e) { /* already there */ }
try { db.exec("ALTER TABLE messages ADD COLUMN media_path TEXT"); } catch (e) { /* already there */ }
// Daily AI insights: top-10 constituency topics refreshed every day.
// source = 'issues' (from ticket data) or 'web' (from web research); urls holds
// JSON [{title,url}] for web insights.
db.exec(`
CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'issues',
  rank INTEGER NOT NULL,
  topic TEXT NOT NULL,
  summary TEXT,
  ticket_count INTEGER DEFAULT 0,
  trend TEXT DEFAULT 'stable',
  suggested_action TEXT,
  urls TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insights_day ON insights(day);
`);
try { db.exec("ALTER TABLE insights ADD COLUMN source TEXT DEFAULT 'issues'"); } catch (e) { /* already there */ }
try { db.exec("ALTER TABLE insights ADD COLUMN urls TEXT"); } catch (e) { /* already there */ }
// Politician's chat history with the Sampark AI assistant.
db.exec(`
CREATE TABLE IF NOT EXISTS ai_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
try { db.exec('ALTER TABLE ai_chats ADD COLUMN conversation_id INTEGER'); } catch (e) { /* already there */ }
db.exec(`
CREATE TABLE IF NOT EXISTS ai_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);
// One-time: group pre-conversation chat history into a single archived conversation.
try {
  const orphans = db.prepare('SELECT COUNT(*) c FROM ai_chats WHERE conversation_id IS NULL').get().c;
  if (orphans > 0) {
    const now = Date.now();
    const r = db.prepare('INSERT INTO ai_conversations (title, created_at, updated_at) VALUES (?,?,?)').run('Earlier conversations', now, now);
    db.prepare('UPDATE ai_chats SET conversation_id=? WHERE conversation_id IS NULL').run(Number(r.lastInsertRowid));
  }
} catch (e) { console.error('ai_chats conversation migration failed:', e.message); }
// 2027 election intel: potential candidates for the constituency, researched
// daily by the AI. Manual=1 rows were added by the politician and are never
// removed by the research runs.
db.exec(`
CREATE TABLE IF NOT EXISTS election_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  party TEXT,
  is_independent INTEGER DEFAULT 0,
  ticket_likelihood INTEGER,
  win_likelihood INTEGER,
  sentiment_score INTEGER,
  sentiment_label TEXT,
  sentiment_summary TEXT,
  bio TEXT,
  current_activity TEXT,
  strategy TEXT,
  track_record TEXT,
  sources TEXT,
  confidence TEXT,
  manual INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_name ON election_candidates(lower(name));
CREATE TABLE IF NOT EXISTS candidate_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  sentiment_score INTEGER,
  win_likelihood INTEGER,
  ticket_likelihood INTEGER,
  UNIQUE(candidate_id, day)
);
CREATE TABLE IF NOT EXISTS intel_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  candidate_count INTEGER,
  note TEXT
);
`);
// Backfill the citizens registry from tickets that predate it.
try {
  const rows = db.prepare("SELECT wa_id, citizen_name, awaiting_name, created_at FROM tickets ORDER BY created_at ASC").all();
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.wa_id)) seen.set(r.wa_id, { name: null, awaiting: 0, created: r.created_at });
    const s = seen.get(r.wa_id);
    if (r.citizen_name) s.name = r.citizen_name;
    if (r.awaiting_name) s.awaiting = 1;
  }
  const ins = db.prepare("INSERT OR IGNORE INTO citizens (wa_id, name, address, onboarding_step, created_at, updated_at) VALUES (?,?,?,?,?,?)");
  for (const [waId, s] of seen) {
    ins.run(waId, s.name || null, null, (s.name && !s.awaiting) ? 'done' : 'name', s.created, Date.now());
  }
} catch (e) { console.error('citizen backfill failed:', e.message); }
function nextTicketId() {
  const row = db.prepare("SELECT v FROM meta WHERE k='next_seq'").get();
  let n = parseInt(row.v, 10) || 1;
  // Defensive: never reuse a number even if the counter ever drifts behind the
  // tickets table (e.g. across restores/seeds) — every issue gets a unique number.
  const maxRow = db.prepare("SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) m FROM tickets WHERE id LIKE 'SKT-%'").get();
  if (maxRow && maxRow.m >= n) n = maxRow.m + 1;
  db.prepare("UPDATE meta SET v=? WHERE k='next_seq'").run(String(n + 1));
  return 'SKT-' + String(n).padStart(4, '0');
}

// ---------- classification + draft generation ----------
function detectCategory(text) {
  const t = text.toLowerCase();
  if (/street\s?light|lamp|streetlight/.test(t)) return 'streetlight';
  if (/water|paani|pani|tanker|pipe/.test(t)) return 'water';
  if (/pothole|road|gaddha|footpath/.test(t)) return 'road';
  if (/ration|anna yojana|ration card/.test(t)) return 'ration';
  if (/drain|naali|sewage|gutter/.test(t)) return 'drainage';
  if (/garbage|kachra|waste|safai|dustbin/.test(t)) return 'sanitation';
  if (/pension/.test(t)) return 'pension';
  if (/school|admission|teacher/.test(t)) return 'education';
  return 'other';
}
function detectPriority(text) {
  return /urgent|emergency|accident|fire|hospital|immediately/i.test(text) ? 'High' : 'Medium';
}
// Event vs issue: invitations (birthday, wedding, inauguration, puja...) become events with a date/venue.
const EVENT_RE = /birthday|bday|wedding|shaadi|marriage|invit|nimantran|inaugurat|udghatan|\bpuja\b|pooja|anniversary|griha pravesh|house ?warming|\bfunction\b|ceremony|bhandara|jagran|kirtan|reception/i;
function detectKind(text) { return EVENT_RE.test(String(text || '')) ? 'event' : 'issue'; }
// Keyword fallback for sensitivity (used when the LLM classifier is unavailable).
// Anything matching needs human approval; everything else may auto-reply as the office.
// Fail closed: when in doubt, the caller treats the message as sensitive.
const SENSITIVE_RE = /rishwat|ghus|ghoos|bhrasht|corrupt|bribe|scam|ghotala|extort|hafta|police|thana|\bfir\b|court|adalat|lawyer|vakil|mukadma|jail|arrest|giraftar|chori|theft|riot|danga|communal|murder|qatl|rape|assault|marpeet|\bbeat\b|threat|dhamki|attack|hamla|stab|chaku|emergency|accident|\bfire\b|hospital|ambulance|donation|chanda|\bmoney\b|paisa|payment|\bupi\b|aadhaar|aadhar|\bpress\b|journalist|patrakar|\bmedia\b|reporter/i;
function detectSensitive(text) {
  return SENSITIVE_RE.test(String(text || ''));
}
// Auto-reply master switch. Dashboard toggle (meta.auto_reply) wins; env SAMPARK_AUTO_REPLY=off forces off. Default on.
function autoReplyOn() {
  const row = db.prepare("SELECT v FROM meta WHERE k='auto_reply'").get();
  if (row) return row.v === '1';
  return process.env.SAMPARK_AUTO_REPLY !== 'off';
}
// Try to send a reply immediately as the office. Returns true on success, false on
// any failure (caller must then queue the text as a pending draft for approval).
async function tryAutoSend(ticket, text, newStatus) {
  try {
    const wa = await sendWhatsApp(ticket.wa_id, text);
    db.prepare('INSERT INTO messages (ticket_id, direction, body, wa_message_id, auto, created_at) VALUES (?,?,?,?,1,?)')
      .run(ticket.id, 'out', text, wa.messages?.[0]?.id || null, Date.now());
    db.prepare('UPDATE tickets SET pending_draft=NULL, draft_source=NULL, status=?, updated_at=? WHERE id=?')
      .run(newStatus, Date.now(), ticket.id);
    console.log(`[${new Date().toISOString()}] AUTO-SENT ${ticket.id}: ${text.slice(0, 70)}`);
    return true;
  } catch (e) {
    console.error('auto-send failed, queuing for approval:', e.message);
    return false;
  }
}
// Template for the onboarding ask: a first-time citizen is asked for their name.
function nameRequestDraft() {
  return `Namaste 🙏 Thanks for reaching out to Sampark. Could you please share your name so our office can assist you better? — Team ${REP_NAME}`;
}
// Words that are never a person's name on their own — the template fallback
// must reject replies made only of these (e.g. a citizen typing "register"
// when asked for their name).
const NAME_STOPWORDS = new Set(
  ('register registration complaint complain request issue problem help ' +
   'hello hi hey namaste namaskar greetings good morning evening afternoon ' +
   'yes no ok okay please thanks thank thankyou sir madam ji ' +
   'water road streetlight light drainage garbage sanitation pension ration ' +
   'school hospital event wedding birthday invitation function ' +
   'my i me we you your the a an to for of').split(' ')
);
// Template-mode name capture: accept short, name-shaped replies only.
function fallbackName(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length <= 2 || t.length > 40) return null;
  if (t.split(' ').length > 3) return null;
  if (!/^[\p{L}\p{M} .'-]+$/u.test(t)) return null;
  if (/[?!.]/.test(t)) return null; // looks like a sentence, not a name
  const words = t.toLowerCase().split(/[\s.'-]+/).filter(Boolean);
  if (!words.length || words.every((w) => NAME_STOPWORDS.has(w))) return null;
  return t;
}
// TODO(product): replace template drafts with the LLM drafting service.
function generateDraft(ticket, text) {
  const first = (ticket.citizen_name || 'Citizen').split(' ')[0];
  const sign = `— Team ${REP_NAME}`;
  if (ticket.kind === 'event') {
    return `Thank you for the invitation, ${first} ji! 🙏 Our office has noted it and we will confirm attendance shortly. ${sign}`;
  }
  const T = {
    streetlight: `Namaste ${first} ji, your complaint about the streetlight issue has been noted and forwarded to the municipal engineer. We will update you within 48 hours. ${sign}`,
    water: `Namaste ${first} ji, your water supply complaint has been registered and shared with the ward water engineer. We will update you on the tanker/pipeline schedule shortly. ${sign}`,
    road: `Namaste ${first} ji, your road/pothole complaint has been noted and sent to the PWD liaison for inspection. We will share the repair timeline soon. ${sign}`,
    ration: `Namaste ${first} ji, we have received your ration-card related request. Our office will check your eligibility and guide you on the application. ${sign}`,
    drainage: `Namaste ${first} ji, your drainage complaint has been forwarded to the sanitation department for cleaning. We will confirm once it is done. ${sign}`,
    sanitation: `Namaste ${first} ji, your garbage/sanitation complaint has been noted and sent to the conservancy team. We will follow up after clearance. ${sign}`,
    pension: `Namaste ${first} ji, your pension matter has been taken up. Our office will check the status with the concerned department and update you. ${sign}`,
    education: `Namaste ${first} ji, your school/admission request has been received. Our office will guide you on the process and revert shortly. ${sign}`,
    other: `Namaste ${first} ji, thank you for writing to us. Your message has been registered and our office will respond shortly. ${sign}`,
  };
  return T[ticket.category] || T.other;
}

// Ticket reference line: every new ticket's citizen gets their number up front
// so they can quote it anytime to check the status.
function ticketRefLine(ticketId) {
  return `\n\n📋 Your ticket number is ${ticketId} — message it here anytime to check the status.`;
}
// Human-friendly category label shared by details questions and status replies.
function categoryLabel(category) {
  const labels = { streetlight: 'streetlight', water: 'water supply', road: 'road', ration: 'ration card', drainage: 'drainage', sanitation: 'garbage/sanitation', pension: 'pension', education: 'school/admission' };
  return labels[category] || 'issue';
}
// Plain-language status for citizens.
function statusPlainText(status) {
  return { new: 'received and logged', in_progress: 'being worked on', awaiting_citizen: 'waiting for your reply', resolved: 'resolved' }[status] || status;
}
// Template fallback for a ticket-status reply (Claude drafts it when available).
function statusReplyTemplate(ticket, latestUpdate) {
  const first = (ticket.citizen_name || 'Citizen').split(' ')[0];
  const cat = categoryLabel(ticket.category);
  let s = `Namaste ${first} ji, ticket ${ticket.id} (${cat === 'issue' ? 'general' : cat}) is ${statusPlainText(ticket.status)}.`;
  if (latestUpdate) s += ` Latest update from our office: ${latestUpdate}`;
  return s + ` — Team ${REP_NAME}`;
}
// Extract a quoted ticket ID ("SKT-0042") from a citizen's message, if any.
function extractTicketRef(text) {
  const m = String(text || '').match(/\bSKT-\d{4,}\b/i);
  return m ? m[0].toUpperCase() : null;
}
// Keyword fallback for new-issue triage when the AI is unavailable: explicit
// "another issue" style markers mean a new ticket; everything else stays a
// follow-up on the open ticket.
function looksLikeNewIssue(text) {
  const t = String(text || '');
  return /\b(another|new|different|second|one more)\s+(issue|problem|complaint|matter|request)\b/i.test(t)
      || (/^\s*also\b/i.test(t) && t.length > 25);
}
// Words that carry no meaning beyond "what's my ticket status?" — used to tell
// a pure status check ("status of SKT-0042 please") apart from a follow-up that
// quotes the ticket and adds new information.
const STATUS_CHECK_WORDS = new Set('status check please pls track tracking update my ticket number no of for the a hi hello sir madam ji'.split(' '));
function isStatusCheckOnly(text) {
  const rest = String(text || '')
    .replace(/\bSKT-\d{4,}\b/gi, ' ')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w && !STATUS_CHECK_WORDS.has(w));
  return rest.length === 0;
}
// Details question for a newly registered citizen: issue location, or event
// date/time + venue. Home address is always optional. Sent automatically.
function detailsQuestionDraft(citizenName, kind, category) {
  const first = (citizenName || 'Citizen').split(' ')[0];
  const sign = `— Team ${REP_NAME}`;
  if (kind === 'event') {
    return `Thanks ${first} ji! 🙏 When is the celebration and where should we come? Please share the date, time and venue. (You can also share your home address for our records — optional.) ${sign}`;
  }
  const label = categoryLabel(category);
  return `Thanks ${first} ji! To help our office act faster, please share the exact location of this ${label} issue (area/landmark). (You can also share your home address for our records — optional.) ${sign}`;
}
// Capture structured details from the citizen's reply to the details question.
// Always advances onboarding to 'done'. Falls back to the citizen's own words
// when the LLM extractor is unavailable.
async function captureDetails(citizen, ticket, text) {
  const now = Date.now();
  let d = null;
  try { d = await ai.extractDetails(text, ticket.kind); } catch (e) { console.error('AI details extract failed:', e.message); }
  const raw = String(text || '').trim().slice(0, 200);
  const out = {
    issue_address: d?.issue_address || null,
    event_datetime: d?.event_datetime_text || null,
    venue: d?.venue || null,
    home_address: d?.home_address || null,
  };
  if (!d) {
    // No LLM: keep the citizen's words where the politician can use them,
    // plus light heuristics for the optional home address and the venue.
    let locText = raw;
    const addr = String(text || '').match(/(?:home address|my address|residing at|stay at)(?: is)?\s*:?\s*(.+)/i);
    if (addr) {
      out.home_address = addr[1].trim().slice(0, 200);
      locText = raw.replace(addr[0], '').replace(/\s+/g, ' ').trim().replace(/^[.,;:\s]+|[.,;:\s]+$/g, '');
    }
    if (ticket.kind === 'event') {
      const m = locText.match(/^(.+?)\s+at\s+(.+)$/i);
      if (m) { out.event_datetime = m[1].trim(); out.venue = m[2].trim(); }
      else out.event_datetime = locText || null;
    } else {
      out.issue_address = locText || null;
    }
  }
  db.prepare('UPDATE tickets SET issue_address=?, event_datetime=?, venue=?, updated_at=? WHERE id=?')
    .run(out.issue_address, out.event_datetime, out.venue, now, ticket.id);
  if (out.home_address) db.prepare('UPDATE citizens SET address=? WHERE id=?').run(out.home_address, citizen.id);
  db.prepare("UPDATE citizens SET onboarding_step='done', updated_at=? WHERE id=?").run(now, citizen.id);
  citizen.onboarding_step = 'done';
  return out;
}
// Short confirmation line echoing captured details, prepended to the issue/event reply.
function detailsConfirmPrefix(citizenName, ticket, details) {
  const first = (citizenName || 'Citizen').split(' ')[0];
  if (ticket.kind === 'event') {
    const bits = [details.event_datetime, details.venue].filter(Boolean).join(' at ');
    return bits ? `Thank you for the invitation, ${first} ji! 🙏 We've noted: ${bits}.` : null;
  }
  return details.issue_address ? `Noted, ${first} ji! Location saved: ${details.issue_address}. ✅` : null;
}

// ---------- incoming message handling ----------
function findOpenTicket(waId) {
  return db.prepare("SELECT * FROM tickets WHERE wa_id=? AND status != 'resolved' ORDER BY updated_at DESC LIMIT 1").get(waId);
}
// A citizen quoted their ticket number: answer with the ticket's status.
// The reply is drafted by Claude (template fallback), logged on the ticket,
// and sent directly — a status lookup is never left unanswered.
async function replyTicketStatus({ ticket, waId, text, waMessageId, ts, now, mediaType, mediaPath }) {
  const upd = db.prepare('SELECT body FROM ticket_updates WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticket.id);
  let msg = statusReplyTemplate(ticket, upd?.body || null);
  let src = 'template';
  try {
    const aiMsg = await ai.generateStatusReply({
      repName: REP_NAME,
      citizenName: ticket.citizen_name,
      ticketId: ticket.id,
      categoryLabel: categoryLabel(ticket.category),
      statusPlain: statusPlainText(ticket.status),
      latestUpdate: upd?.body || null,
      citizenMessage: text,
    });
    if (aiMsg) { msg = aiMsg; src = 'ai'; }
  } catch (e) { console.error('AI status reply failed, using template:', e.message); }
  db.prepare('INSERT INTO messages (ticket_id, direction, body, wa_message_id, media_type, media_path, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(ticket.id, 'in', text, waMessageId || null, mediaType || null, mediaPath || null, ts || now);
  let sent = false;
  try {
    const wa = await sendWhatsApp(waId, msg);
    db.prepare('INSERT INTO messages (ticket_id, direction, body, wa_message_id, created_at) VALUES (?,?,?,?,?)')
      .run(ticket.id, 'out', msg, wa.messages?.[0]?.id || null, Date.now());
    sent = true;
  } catch (e) { console.error('status reply send failed:', e.message); }
  if (!sent) {
    // WhatsApp unreachable: queue for the politician instead of going silent.
    db.prepare('UPDATE tickets SET pending_draft=?, draft_source=?, updated_at=? WHERE id=?').run(msg, src, Date.now(), ticket.id);
    ticket.pending_draft = msg; ticket.draft_source = src;
  }
  console.log(`[${new Date().toISOString()}] IN ${ticket.id} (${ticket.citizen_name}): status check -> ${sent ? 'sent' : 'queued'}`);
  return { ticket, isNew: false };
}
// A citizen quoted a ticket number that isn't theirs (or doesn't exist).
// Answered plainly, naming their actual open ticket when they have one.
// No ticket is created — a bare number is not a new issue.
async function replyTicketNotFound({ waId, refId, openTicket }) {
  let msg;
  if (openTicket) {
    msg = `Namaste 🙏 I couldn't find ticket ${refId} on this number. Your open ticket is ${openTicket.id} (${categoryLabel(openTicket.category)}) — it is ${statusPlainText(openTicket.status)}. — Team ${REP_NAME}`;
  } else {
    msg = `Namaste 🙏 I couldn't find ticket ${refId} on this number. Please check the number and try again, or describe your issue and we'll register it. — Team ${REP_NAME}`;
  }
  try { await sendWhatsApp(waId, msg); }
  catch (e) { console.error('ticket-not-found reply send failed:', e.message); }
}

// Open a brand-new ticket for the citizen's message and send/queue the first
// reply. Used both for first contact AND when a known citizen reports a new,
// separate issue while another ticket is still open — every issue gets its own
// ticket number and its own row in the database.
async function openNewTicket({ waId, citizen, name, text, ts, now, contextNote }) {
  const id = nextTicketId();
  let category = detectCategory(text);
  let priority = detectPriority(text);
  let language = null;
  let kind = detectKind(text);
  let sensitive = true; // fail closed: uncertain -> needs human approval
  try {
    const cls = await ai.classifyMessage(text); // null when no API key -> keyword fallback stands
    if (cls) {
      category = cls.category || category;
      priority = cls.priority || priority;
      language = cls.language || null;
      kind = cls.kind || kind;
      sensitive = cls.sensitive !== false;
    } else {
      sensitive = detectSensitive(text);
    }
  } catch (e) { console.error('AI classify failed, using keywords:', e.message); sensitive = detectSensitive(text); }
  // New citizen (no name on record)? Ask for it — don't ask returning citizens again.
  const isNewCitizen = !citizen.name || citizen.onboarding_step === 'name';
  const awaitingName = isNewCitizen ? 1 : 0;
  db.prepare(`INSERT INTO tickets (id, wa_id, citizen_name, category, priority, sensitive, kind, status, awaiting_name, pending_draft, draft_source, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?, 'new', ?, NULL, NULL, ?, ?)`)
    .run(id, waId, citizen.name || name || null, category, priority, sensitive ? 1 : 0, kind, awaitingName, ts || now, now);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
  const autoOn = autoReplyOn();
  if (awaitingName) {
    // First contact: the name request goes out AUTOMATICALLY as the office — no approval needed.
    let askText = nameRequestDraft();
    let src = 'template';
    try {
      const aiAsk = await ai.generateNameRequest({ repName: REP_NAME, language });
      if (aiAsk) { askText = aiAsk; src = 'ai'; }
    } catch (e) { console.error('AI name-request failed, using template:', e.message); }
    askText += ticketRefLine(id); // every citizen gets their ticket number up front
    const sent = autoOn && await tryAutoSend(ticket, askText, 'new');
    if (!sent) {
      db.prepare('UPDATE tickets SET pending_draft=?, draft_source=?, updated_at=? WHERE id=?').run(askText, src, Date.now(), id);
      ticket.pending_draft = askText; ticket.draft_source = src;
    }
  } else {
    // Known citizen: sensitive topics need approval; routine ones auto-reply as the office.
    let draftText = generateDraft(ticket, text); // template fallback
    let src = 'template';
    try {
      const aiDraft = await ai.generateDraft({ repName: REP_NAME, citizenName: ticket.citizen_name, category, language, text, kind, ticketId: id, contextNote });
      if (aiDraft) { draftText = aiDraft; src = 'ai'; }
    } catch (e) { console.error('AI draft failed, using template:', e.message); }
    draftText += ticketRefLine(id); // every citizen gets their ticket number up front
    const sent = !sensitive && autoOn && await tryAutoSend(ticket, draftText, 'in_progress');
    if (sent) {
      ticket.status = 'in_progress';
    } else {
      db.prepare('UPDATE tickets SET pending_draft=?, draft_source=?, updated_at=? WHERE id=?').run(draftText, src, Date.now(), id);
      ticket.pending_draft = draftText; ticket.draft_source = src;
    }
  }
  return { ticket, isNew: true };
}
async function handleIncoming({ waId, name, text, waMessageId, ts, mediaType, mediaPath }) {
  const now = Date.now();
  // A photo with no caption still needs classifiable text; the photo itself is stored on the message row.
  if (mediaPath && !text) text = '[photo shared]';
  let ticket = findOpenTicket(waId);
  // Ticket-number status check: a citizen quoting "SKT-0042" gets that
  // ticket's status — but only ever from the sender's OWN ticket.
  const refId = extractTicketRef(text);
  if (refId) {
    const refTicket = db.prepare('SELECT * FROM tickets WHERE id=? AND wa_id=?').get(refId, waId);
    if (refTicket) {
      if (isStatusCheckOnly(text) || refTicket.status === 'resolved') {
        return await replyTicketStatus({ ticket: refTicket, waId, text, waMessageId, ts, now, mediaType, mediaPath });
      }
      ticket = refTicket; // follow-up quoting the ticket: route it to that ticket
    } else if (isStatusCheckOnly(text)) {
      await replyTicketNotFound({ waId, refId, openTicket: ticket });
      return { ticket, isNew: false };
    }
    // Unknown number + other content: fall through to the normal flow.
  }
  let isNew = false;
  // Citizens registry: every wa_id gets a row; first-time citizens onboard (name -> details).
  let citizen = db.prepare('SELECT * FROM citizens WHERE wa_id=?').get(waId);
  if (!citizen) {
    db.prepare("INSERT INTO citizens (wa_id, name, phone, address, onboarding_step, created_at, updated_at) VALUES (?,?,?,?, 'name', ?, ?)")
      .run(waId, name || null, null, null, ts || now, now);
    citizen = db.prepare('SELECT * FROM citizens WHERE wa_id=?').get(waId);
  }
  if (!ticket) {
    const opened = await openNewTicket({ waId, citizen, name, text, ts, now });
    ticket = opened.ticket;
    isNew = true;
  } else if (ticket.awaiting_name) {
    // Citizen answered the name request — try to capture their name.
    let captured = null;
    try { captured = await ai.extractName(text); } catch (e) { console.error('AI name extract failed:', e.message); }
    if (!captured) captured = fallbackName(text);
    const status = ticket.status === 'awaiting_citizen' ? 'in_progress' : ticket.status;
    if (captured) {
      // Name captured: register the citizen and ask for the details we need —
      // issue location, or event date/time + venue (home address optional). Automatic.
      ticket.citizen_name = captured;
      ticket.awaiting_name = 0;
      db.prepare("UPDATE citizens SET name=?, onboarding_step='details', updated_at=? WHERE wa_id=?").run(captured, now, waId);
      citizen.name = captured; citizen.onboarding_step = 'details';
      // Claude drafts the details question; template is the fallback, never the default.
      let q = detailsQuestionDraft(captured, ticket.kind, ticket.category);
      let qSrc = 'template';
      try {
        const aiQ = await ai.generateDetailsQuestion({ repName: REP_NAME, citizenName: captured, kind: ticket.kind, category: ticket.category, citizenMessage: text });
        if (aiQ) { q = aiQ; qSrc = 'ai'; }
      } catch (e) { console.error('AI details-question failed, using template:', e.message); }
      q += ticketRefLine(ticket.id); // citizen gets their ticket number with the first substantive reply
      const sent = autoReplyOn() && await tryAutoSend(ticket, q, status);
      db.prepare('UPDATE tickets SET citizen_name=?, awaiting_name=0, pending_draft=?, draft_source=?, status=?, updated_at=? WHERE id=?')
        .run(captured, sent ? null : q, sent ? null : qSrc, status, now, ticket.id);
      ticket.pending_draft = sent ? null : q;
      ticket.draft_source = sent ? null : qSrc;
      ticket.status = status;
    } else {
      // Not a name. Ask at most twice, then stop and treat it as a normal ticket.
      const inCount = db.prepare("SELECT COUNT(*) c FROM messages WHERE ticket_id=? AND direction='in'").get(ticket.id).c;
      if (inCount >= 2) {
        ticket.awaiting_name = 0;
        let draftText = generateDraft(ticket, text);
        let src = 'template';
        try {
          const aiDraft = await ai.generateDraft({ repName: REP_NAME, citizenName: ticket.citizen_name, category: ticket.category, language: null, text, ticketId: ticket.id });
          if (aiDraft) { draftText = aiDraft; src = 'ai'; }
        } catch (e) { console.error('AI draft failed, using template:', e.message); }
        draftText += ticketRefLine(ticket.id); // citizen gets their ticket number with the first substantive reply
        const sent = !ticket.sensitive && autoReplyOn() && await tryAutoSend(ticket, draftText, status);
        db.prepare('UPDATE tickets SET awaiting_name=0, pending_draft=?, draft_source=?, status=?, updated_at=? WHERE id=?')
          .run(sent ? null : draftText, sent ? null : src, status, now, ticket.id);
        ticket.pending_draft = sent ? null : draftText;
        ticket.draft_source = sent ? null : src;
        ticket.status = status;
      } else {
        // Not a name on the first retry: never stay silent — acknowledge and ask for the name again (automatic).
        // Claude drafts it; template is the fallback, never the default.
        let ack = "Thanks for writing in! Could you please share your name so our office can log your request properly?";
        let ackSrc = 'template';
        try {
          const aiAck = await ai.generateNameRetry({ repName: REP_NAME, theirReply: text });
          if (aiAck) { ack = aiAck; ackSrc = 'ai'; }
        } catch (e) { console.error('AI name-retry failed, using template:', e.message); }
        const sent = autoReplyOn() && await tryAutoSend(ticket, ack, status);
        db.prepare('UPDATE tickets SET pending_draft=?, draft_source=?, updated_at=?, status=? WHERE id=?')
          .run(sent ? null : ack, sent ? null : ackSrc, now, status, ticket.id);
        ticket.pending_draft = sent ? null : ack;
        ticket.draft_source = sent ? null : ackSrc;
        ticket.status = status;
      }
    }
  } else if (citizen.onboarding_step === 'details') {
    // Citizen answered the details question — capture location/date/venue,
    // finish onboarding, and reply to their original issue/event.
    const status = ticket.status === 'awaiting_citizen' ? 'in_progress' : ticket.status;
    const details = await captureDetails(citizen, ticket, text);
    ticket.issue_address = details.issue_address;
    ticket.event_datetime = details.event_datetime;
    ticket.venue = details.venue;
    // Confirmed detail for Claude to weave into its reply; the template prefix
    // below is only used when Claude is unavailable.
    const noteBits = [];
    if (ticket.kind === 'event') {
      const when = [details.event_datetime, details.venue].filter(Boolean).join(' at ');
      if (when) noteBits.push(`event noted: ${when}`);
    } else if (details.issue_address) {
      noteBits.push(`issue location saved: ${details.issue_address}`);
    }
    const contextNote = noteBits.join('; ') || null;
    let draftText = null;
    let src = 'template';
    try {
      const aiDraft = await ai.generateDraft({ repName: REP_NAME, citizenName: ticket.citizen_name, category: ticket.category, language: null, text, kind: ticket.kind, contextNote, ticketId: ticket.id });
      if (aiDraft) { draftText = aiDraft; src = 'ai'; }
    } catch (e) { console.error('AI draft failed, using template:', e.message); }
    if (!draftText) {
      const prefix = detailsConfirmPrefix(ticket.citizen_name, ticket, details);
      draftText = (prefix ? prefix + '\n\n' : '') + generateDraft(ticket, text);
    }
    const sent = !ticket.sensitive && autoReplyOn() && await tryAutoSend(ticket, draftText, status);
    db.prepare('UPDATE tickets SET pending_draft=?, draft_source=?, status=?, updated_at=? WHERE id=?')
      .run(sent ? null : draftText, sent ? null : src, status, now, ticket.id);
    ticket.pending_draft = sent ? null : draftText;
    ticket.draft_source = sent ? null : src;
    ticket.status = status;
  } else {
    // Existing open ticket. First decide: is this a NEW, separate issue (it gets
    // its own ticket number and database row) or a follow-up on the open ticket?
    // Ticket-number questions are always follow-ups — never split those.
    const asksTicketNumber = /ticket\s*(number|id|no\.?|#)/i.test(text);
    let newIssue = false;
    if (!asksTicketNumber) {
      const firstIn = db.prepare("SELECT body FROM messages WHERE ticket_id=? AND direction='in' ORDER BY created_at ASC LIMIT 1").get(ticket.id);
      const recent = db.prepare("SELECT direction, body FROM messages WHERE ticket_id=? ORDER BY created_at DESC LIMIT 6").all(ticket.id).reverse();
      const summary = `${ticket.id} [${ticket.category || 'general'}]: ${firstIn ? String(firstIn.body).slice(0, 200) : '(no description yet)'}`;
      try {
        const verdict = await ai.isNewIssue({ ticketSummary: summary, recentMessages: recent, text });
        newIssue = verdict === null ? looksLikeNewIssue(text) : verdict; // null -> AI unavailable, use keyword fallback
      } catch (e) { console.error('new-issue triage failed:', e.message); newIssue = looksLikeNewIssue(text); }
    }
    if (newIssue) {
      // New issue -> brand-new ticket with its own number. The citizen keeps
      // their identity; only the issue is split into its own database row.
      console.log(`[${new Date().toISOString()}] NEW-ISSUE split from ${ticket.id}: opening separate ticket`);
      const opened = await openNewTicket({
        waId, citizen, name, text, ts, now,
        contextNote: 'The citizen already has another open ticket — treat this message as a brand-new, separate request with its own ticket number.',
      });
      ticket = opened.ticket;
      isNew = true;
    } else {
    // Follow-up message on the existing ticket (e.g. a question about their issue):
    // classify it, then auto-reply as the office for routine topics or queue for
    // approval when sensitive — never leave the citizen hanging.
    const status = ticket.status === 'awaiting_citizen' ? 'in_progress' : ticket.status;
    let category = ticket.category;
    let sensitive = ticket.sensitive === 1;
    let language = null;
    try {
      const cls = await ai.classifyMessage(text);
      if (cls) {
        category = cls.category || category;
        if (cls.sensitive === true) sensitive = true;
        language = cls.language || null;
      } else if (detectSensitive(text)) {
        sensitive = true;
      }
    } catch (e) { console.error('AI classify failed, using keywords:', e.message); if (detectSensitive(text)) sensitive = true; }
    // Conversation history so the reply keeps context (e.g. the office asked for
    // a reference number and the citizen just sent it).
    const history = db.prepare("SELECT direction, body FROM messages WHERE ticket_id=? ORDER BY created_at DESC LIMIT 6").all(ticket.id).reverse();
    let draftText = generateDraft({ ...ticket, category }, text);
    let src = 'template';
    try {
      const aiDraft = await ai.generateDraft({ repName: REP_NAME, citizenName: ticket.citizen_name, category, language, text, kind: ticket.kind, ticketId: ticket.id, history });
      if (aiDraft) { draftText = aiDraft; src = 'ai'; }
    } catch (e) { console.error('AI draft failed, using template:', e.message); }
    // Citizen asking about their ticket number on an existing ticket: guarantee the
    // exact number is in the reply even if the draft didn't state it.
    if (asksTicketNumber) draftText += ticketRefLine(ticket.id);
    const sent = !sensitive && autoReplyOn() && await tryAutoSend(ticket, draftText, status);
    db.prepare('UPDATE tickets SET pending_draft=?, draft_source=?, category=?, sensitive=?, updated_at=?, status=? WHERE id=?')
      .run(sent ? null : draftText, sent ? null : src, category, sensitive ? 1 : 0, now, status, ticket.id);
    ticket.pending_draft = sent ? null : draftText;
    ticket.draft_source = sent ? null : src;
    ticket.category = category;
    ticket.sensitive = sensitive ? 1 : 0;
    ticket.status = status;
    }
  }
  db.prepare('INSERT INTO messages (ticket_id, direction, body, wa_message_id, media_type, media_path, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(ticket.id, 'in', text, waMessageId || null, mediaType || null, mediaPath || null, ts || now);
  markBriefDirty(); // new inbound message -> AI brief will regenerate (at most every 15 min)
  console.log(`[${new Date().toISOString()}] IN ${ticket.id} (${ticket.citizen_name}): ${text.slice(0, 80)}`);
  return { ticket, isNew };
}

// ---------- WhatsApp Cloud API send ----------
async function sendWhatsApp(to, body) {
  if (!CONFIGURED) throw new Error('WhatsApp API not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
  const r = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body } }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `WhatsApp send failed (HTTP ${r.status})`);
  return data;
}

// Download an inbound WhatsApp media object by its media ID into MEDIA_DIR.
// Returns { filename, contentType }. Only images are accepted.
async function downloadWhatsAppMedia(mediaId) {
  if (!CONFIGURED) throw new Error('WhatsApp API not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
  const metaR = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });
  const meta = await metaR.json().catch(() => ({}));
  if (!metaR.ok || !meta?.url) throw new Error(meta?.error?.message || 'media URL lookup failed');
  const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
  if (!r.ok) throw new Error(`media download failed (HTTP ${r.status})`);
  const ct = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ct.startsWith('image/')) throw new Error(`unsupported media type: ${ct || 'unknown'}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > MAX_MEDIA_BYTES) throw new Error('image empty or too large (max 8 MB)');
  const ext = (ct.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, filename), buf);
  console.log(`[${new Date().toISOString()}] media saved: ${filename} (${buf.length} bytes, ${ct})`);
  return { filename, contentType: ct };
}

// Upload a local image from MEDIA_DIR to WhatsApp, then send it as an image
// message with an optional caption. Returns the Graph API response.
async function sendWhatsAppImage(to, filename, caption) {
  if (!CONFIGURED) throw new Error('WhatsApp API not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
  const full = mediaFilePath(filename);
  if (!full || !fs.existsSync(full)) throw new Error('image not found');
  const buf = fs.readFileSync(full);
  if (!buf.length || buf.length > MAX_MEDIA_BYTES) throw new Error('image empty or too large (max 8 MB)');
  const ext = path.extname(full).slice(1).toLowerCase() || 'jpg';
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg';
  // 1) upload the media to get a media object ID
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buf], { type: mime }), path.basename(full));
  const up = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
    body: form,
  });
  const upj = await up.json().catch(() => ({}));
  if (!up.ok || !upj.id) throw new Error(upj?.error?.message || 'WhatsApp media upload failed');
  // 2) send the image message referencing the uploaded media
  const r = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'image',
      image: { id: upj.id, caption: String(caption || '').slice(0, 1024) || undefined },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `WhatsApp send failed (HTTP ${r.status})`);
  return data;
}

// ---------- app ----------
// Public first: Meta webhook (must stay open), Render health check, login/logout.
const app = express();

// Meta webhook verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Meta webhook receiver (POST) — keep raw body for signature check.
// Responds 200 immediately, then processes messages (LLM calls can take seconds).
app.post('/webhook', express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }), (req, res) => {
  const incoming = [];
  try {
    if (APP_SECRET) {
      const sig = req.headers['x-hub-signature-256'] || '';
      const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(401);
    }
    const body = req.body || {};
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          const contacts = value.contacts || [];
          for (const msg of value.messages || []) {
            const c = contacts.find((x) => x.wa_id === msg.from);
            const base = {
              waId: msg.from,
              name: c?.profile?.name || 'Citizen',
              waMessageId: msg.id,
              ts: msg.timestamp ? parseInt(msg.timestamp, 10) * 1000 : Date.now(),
            };
            if (msg.type === 'text' && msg.text?.body) {
              incoming.push({ ...base, text: msg.text.body });
            } else if (msg.type === 'image' && msg.image?.id) {
              // Photo of an issue (or anything else) — caption may be empty.
              incoming.push({ ...base, text: msg.image.caption || '', mediaId: msg.image.id, mediaType: 'image' });
            }
            // other message types (audio, video, documents, stickers, reactions) are ignored
          }
        }
      }
    }
  } catch (e) {
    console.error('webhook error:', e.message);
  }
  res.sendStatus(200); // always 200 fast so Meta doesn't retry-storm
  (async () => {
    for (const m of incoming) {
      try {
        if (m.mediaId) {
          try {
            const dl = await downloadWhatsAppMedia(m.mediaId);
            m.mediaPath = dl.filename;
          } catch (e) {
            console.error('inbound image download failed:', e.message);
            // keep the caption/text; the ticket still gets created without the photo
          }
        }
        await handleIncoming(m);
      } catch (e) { console.error('handleIncoming error:', e.message); }
    }
  })();
});

// ---------- dashboard API ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, configured: CONFIGURED, rep: REP_NAME, now: Date.now(), auto_reply: autoReplyOn(), ai: { configured: ai.isConfigured(), provider: ai.provider } });
});

// Politician-portal login (public). Sets an httpOnly auth cookie on success.
app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const pw = String(req.body.password || '');
  if (DASHBOARD_PASSWORD && pw === DASHBOARD_PASSWORD) {
    res.cookie(AUTH_COOKIE, authToken(), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 * 1000 });
    return res.redirect('/');
  }
  return res.redirect('/login?e=1');
});
app.get('/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.redirect('/login');
});

// Everything below requires the dashboard password (static UI + API).
app.use(requireAuth);

// Serve stored issue / completed-work photos (authenticated; no path traversal).
app.get('/media/:file', (req, res) => {
  const full = mediaFilePath(req.params.file);
  if (!full || !fs.existsSync(full)) return res.sendStatus(404);
  const ext = path.extname(full).toLowerCase();
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
  res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(full).pipe(res);
});

// Upload a photo from the politician's device (completed-work photos, etc.).
// Client sends raw image bytes with Content-Type: image/* (no multipart dep needed).
app.post('/api/upload', express.raw({ type: 'image/*', limit: '8mb' }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'no image data' });
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[ct] || 'jpg';
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  try {
    fs.writeFileSync(path.join(MEDIA_DIR, filename), req.body);
  } catch (e) {
    return res.status(500).json({ error: 'could not save image' });
  }
  res.json({ ok: true, file: filename });
});
app.use(express.static(path.join(__dirname, 'public')));

function ticketSummary(t) {
  const last = db.prepare('SELECT body, direction, media_path, created_at FROM messages WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(t.id);
  const unread = db.prepare("SELECT COUNT(*) c FROM messages WHERE ticket_id=? AND direction='in'").get(t.id).c;
  let preview = last?.body || '';
  if (last?.media_path && (!preview || preview === '[photo shared]')) preview = '📷 Photo';
  else if (last?.media_path && preview) preview = '📷 ' + preview;
  return { ...t, last_message: preview, last_dir: last?.direction || null, last_at: last?.created_at || t.updated_at, inbound_count: unread };
}
app.get('/api/tickets', (req, res) => {
  const { status, kind } = req.query;
  let sql = 'SELECT * FROM tickets';
  const conds = [], args = [];
  if (status) { conds.push('status=?'); args.push(status); }
  if (kind) { conds.push('kind=?'); args.push(kind); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY updated_at DESC';
  const rows = db.prepare(sql).all(...args);
  res.json(rows.map(ticketSummary));
});

// Citizens registry: everyone who ever messaged, with their ticket counts.
app.get('/api/citizens', (req, res) => {
  const { q } = req.query;
  const sel = `c.*, (SELECT COUNT(*) FROM tickets t WHERE t.wa_id=c.wa_id) AS tickets,
               (SELECT COUNT(*) FROM tickets t WHERE t.wa_id=c.wa_id AND t.status != 'resolved') AS open_tickets`;
  const rows = q
    ? db.prepare(`SELECT ${sel} FROM citizens c WHERE c.name LIKE ? OR c.wa_id LIKE ? OR c.address LIKE ? ORDER BY c.updated_at DESC LIMIT 100`).all(`%${q}%`, `%${q}%`, `%${q}%`)
    : db.prepare(`SELECT ${sel} FROM citizens c ORDER BY c.updated_at DESC LIMIT 100`).all();
  res.json(rows);
});

// Events: invitations/occasions citizens invited the MLA to.
app.get('/api/events', (req, res) => {
  const rows = db.prepare("SELECT * FROM tickets WHERE kind='event' ORDER BY updated_at DESC LIMIT 100").all();
  res.json(rows.map(ticketSummary));
});

// ---------- Sampark AI assistant: daily insights + politician chat ----------
// Aggregate 30-day stats and ask Claude for the top-10 topics with actions.
// Source 'issues': grounded in the constituency's own ticket data.
async function refreshIssueInsights(force = false) {
  const today = new Date().toISOString().slice(0, 10);
  if (!force && db.prepare("SELECT COUNT(*) c FROM insights WHERE day=? AND source='issues'").get(today).c) {
    return { ok: true, cached: true, day: today };
  }
  const month = Date.now() - 30 * 864e5, prev = Date.now() - 60 * 864e5;
  const stats = db.prepare(`
    SELECT category,
           SUM(CASE WHEN created_at>? THEN 1 ELSE 0 END) AS total,
           SUM(CASE WHEN created_at>? AND status != 'resolved' THEN 1 ELSE 0 END) AS open
    FROM tickets GROUP BY category`).all(month, month);
  const prevRows = db.prepare('SELECT category, COUNT(*) c FROM tickets WHERE created_at>? AND created_at<=? GROUP BY category').all(prev, month);
  const prevMap = Object.fromEntries(prevRows.map((r) => [r.category, r.c]));
  const enriched = stats
    .filter((s) => s.total > 0)
    .map((s) => {
      const p = prevMap[s.category] || 0;
      return { category: s.category, total: s.total, open: s.open,
               trend: s.total > p * 1.2 ? 'rising' : (s.total < p * 0.8 ? 'falling' : 'stable') };
    })
    .sort((a, b) => b.total - a.total);
  let topics = null, viaAI = false;
  try { topics = await ai.summarizeTopics(enriched); viaAI = !!topics; } catch (e) { console.error('insights AI failed:', e.message); }
  if (!topics) {
    const labels = { streetlight: 'Streetlights', water: 'Water supply', road: 'Roads & potholes', ration: 'Ration cards', drainage: 'Drainage', sanitation: 'Garbage & sanitation', pension: 'Pensions', education: 'Schools & admissions', other: 'Other requests' };
    topics = enriched.slice(0, 10).map((e) => ({
      topic: labels[e.category] || e.category,
      summary: `${e.total} tickets in the last 30 days (${e.open} still open).`,
      ticket_count: e.total, trend: e.trend,
      suggested_action: 'Review the open tickets with the ward team this week.',
    }));
  }
  db.prepare("DELETE FROM insights WHERE day=? AND source='issues'").run(today);
  const ins = db.prepare("INSERT INTO insights (day, source, rank, topic, summary, ticket_count, trend, suggested_action, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  topics.slice(0, 10).forEach((t, i) => ins.run(today, 'issues', i + 1, t.topic || 'Topic', t.summary || '', t.ticket_count || 0, t.trend || 'stable', t.suggested_action || '', Date.now()));
  return { ok: true, day: today, count: Math.min(topics.length, 10), ai: viaAI };
}

// Source 'web': Claude researches recent Margao/Goa news via web search and
// turns it into actionable constituency insights with source links.
async function refreshWebInsights(force = false) {
  const today = new Date().toISOString().slice(0, 10);
  if (!force && db.prepare("SELECT COUNT(*) c FROM insights WHERE day=? AND source='web'").get(today).c) {
    return { ok: true, cached: true, day: today };
  }
  let items = null;
  try { items = await ai.gatherWebInsights({ repName: REP_NAME }); } catch (e) { console.error('web insights AI failed:', e.message); }
  if (!items || !items.length) return { ok: true, day: today, count: 0, ai: false, empty: true };
  db.prepare("DELETE FROM insights WHERE day=? AND source='web'").run(today);
  const ins = db.prepare("INSERT INTO insights (day, source, rank, topic, summary, ticket_count, trend, suggested_action, urls, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  items.forEach((t, i) => ins.run(today, 'web', i + 1, t.topic, t.summary, 0, t.trend, t.suggested_action, JSON.stringify(t.sources || []), Date.now()));
  return { ok: true, day: today, count: items.length, ai: true };
}

// Refresh both insight sources; runs daily at 06:00 and lazily on GET /api/insights.
async function refreshInsights(force = false) {
  const [issues, web] = await Promise.all([refreshIssueInsights(force), refreshWebInsights(force)]);
  markBriefDirty();
  const today = new Date().toISOString().slice(0, 10);
  return { ok: true, day: today, issues, web };
}

// Latest insights, split by source; cold start waits for the first build,
// later refreshes happen in background.
app.get('/api/insights', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  let day = db.prepare('SELECT MAX(day) d FROM insights').get().d;
  let refreshing = false;
  if (!day) {
    await refreshInsights().catch((e) => console.error('insights refresh failed:', e.message));
    day = db.prepare('SELECT MAX(day) d FROM insights').get().d;
  } else if (day !== today) {
    refreshing = true;
    refreshInsights().catch((e) => console.error('background insights refresh failed:', e.message));
  }
  const bySource = (source) => day ? db.prepare('SELECT * FROM insights WHERE day=? AND source=? ORDER BY rank').all(day, source) : [];
  res.json({ day, refreshing, issues: bySource('issues'), web: bySource('web') });
});

app.post('/api/admin/refresh-insights', express.json(), async (_req, res) => {
  try { res.json(await refreshInsights(true)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 2027 election intel ----------
// Daily deep research on potential candidates for the constituency, with
// sentiment analysis from news + social media. Research merges into
// election_candidates (upsert by name, never auto-deletes); daily snapshots
// feed the trend charts. Runs even when the AI is down — it just keeps the
// last good data and logs a failed run.
const ELECTION_YEAR = 2027;

function upsertIntelSnapshot(candidateId, day, c) {
  const ex = db.prepare('SELECT id FROM candidate_snapshots WHERE candidate_id=? AND day=?').get(candidateId, day);
  if (ex) db.prepare('UPDATE candidate_snapshots SET sentiment_score=?, win_likelihood=?, ticket_likelihood=? WHERE id=?')
    .run(c.sentiment_score, c.win_likelihood, c.ticket_likelihood, ex.id);
  else db.prepare('INSERT INTO candidate_snapshots (candidate_id, day, sentiment_score, win_likelihood, ticket_likelihood) VALUES (?,?,?,?,?)')
    .run(candidateId, day, c.sentiment_score, c.win_likelihood, c.ticket_likelihood);
}

async function refreshElectionIntel() {
  console.log('[intel] starting election research…');
  const intel = await ai.researchElectionIntel({ constituency: CONSTITUENCY });
  const now = Date.now();
  if (!intel || !intel.candidates.length) {
    db.prepare('INSERT INTO intel_runs (ran_at, status, candidate_count, note) VALUES (?,?,?,?)')
      .run(now, 'failed', 0, 'research returned nothing (AI unavailable?) — previous data kept');
    console.error('[intel] research failed or empty — keeping previous data');
    return { ok: false, error: 'research unavailable' };
  }
  const day = new Date().toISOString().slice(0, 10);
  let merged = 0;
  for (const c of intel.candidates) {
    const srcJson = JSON.stringify(c.sources || []);
    const existing = db.prepare('SELECT id FROM election_candidates WHERE lower(name)=lower(?)').get(c.name);
    if (existing) {
      db.prepare(`UPDATE election_candidates SET party=?, is_independent=?, ticket_likelihood=?, win_likelihood=?,
        sentiment_score=?, sentiment_label=?, sentiment_summary=?, bio=?, current_activity=?, strategy=?,
        track_record=?, sources=?, confidence=?, updated_at=? WHERE id=?`)
        .run(c.party || null, c.is_independent ? 1 : 0, c.ticket_likelihood, c.win_likelihood,
          c.sentiment_score, c.sentiment_label, c.sentiment_summary, c.bio, c.current_activity, c.strategy,
          c.track_record, srcJson, c.confidence, now, existing.id);
      upsertIntelSnapshot(existing.id, day, c);
    } else {
      const r = db.prepare(`INSERT INTO election_candidates
        (name, party, is_independent, ticket_likelihood, win_likelihood, sentiment_score, sentiment_label,
         sentiment_summary, bio, current_activity, strategy, track_record, sources, confidence, manual, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`)
        .run(c.name, c.party || null, c.is_independent ? 1 : 0, c.ticket_likelihood, c.win_likelihood,
          c.sentiment_score, c.sentiment_label, c.sentiment_summary, c.bio, c.current_activity, c.strategy,
          c.track_record, srcJson, c.confidence, now);
      upsertIntelSnapshot(Number(r.lastInsertRowid), day, c);
    }
    merged++;
  }
  db.prepare('INSERT INTO intel_runs (ran_at, status, candidate_count, note) VALUES (?,?,?,?)')
    .run(now, 'ok', merged, intel.race_summary || '');
  console.log(`[intel] research complete: ${merged} candidates`);
  return { ok: true, candidates: merged };
}

app.get('/api/election-intel', (req, res) => {
  const candidates = db.prepare(`SELECT * FROM election_candidates ORDER BY COALESCE(win_likelihood, -1) DESC, name`).all()
    .map((c) => { try { c.sources = JSON.parse(c.sources || '[]'); } catch { c.sources = []; } return c; });
  let snapshots = [];
  if (candidates.length) {
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const ids = candidates.map((c) => c.id);
    snapshots = db.prepare(`SELECT candidate_id, day, sentiment_score, win_likelihood, ticket_likelihood
      FROM candidate_snapshots WHERE candidate_id IN (${ids.map(() => '?').join(',')}) AND day >= ? ORDER BY day`)
      .all(...ids, since);
  }
  const lastRun = db.prepare("SELECT * FROM intel_runs WHERE status='ok' ORDER BY ran_at DESC LIMIT 1").get() || null;
  const lastFail = db.prepare("SELECT * FROM intel_runs WHERE status='failed' ORDER BY ran_at DESC LIMIT 1").get() || null;
  res.json({
    candidates, snapshots,
    last_run: lastRun, last_failed: lastFail && (!lastRun || lastFail.ran_at > lastRun.ran_at) ? lastFail : null,
    race_summary: (lastRun && lastRun.note) || null,
    election_year: ELECTION_YEAR, constituency: CONSTITUENCY,
  });
});

// Manual refresh — starts the research in the background; the tab polls.
app.post('/api/election-intel/refresh', express.json(), (_req, res) => {
  refreshElectionIntel().catch((e) => console.error('manual intel refresh failed:', e.message));
  res.json({ ok: true, started: true });
});

// Politician-added candidate: kept forever, never removed by research runs.
// Accepts the full field set so researched candidates can be plugged in with
// their analysis; anything omitted stays null.
app.post('/api/election-intel/candidates', express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
  const pct = (v) => (v === null || v === undefined || v === '' || isNaN(+v) ? null : Math.max(0, Math.min(100, Math.round(+v))));
  const snt = (v) => (v === null || v === undefined || v === '' || isNaN(+v) ? null : Math.max(-100, Math.min(100, Math.round(+v))));
  const str = (v, n) => String(v || '').slice(0, n) || null;
  try {
    const r = db.prepare(`INSERT INTO election_candidates
      (name, party, is_independent, ticket_likelihood, win_likelihood, sentiment_score, sentiment_label,
       sentiment_summary, bio, current_activity, strategy, track_record, sources, confidence, manual, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
      .run(String(b.name).trim().slice(0, 80), str(b.party, 60),
        /independent/i.test(String(b.party || '')) ? 1 : 0,
        pct(b.ticket_likelihood), pct(b.win_likelihood), snt(b.sentiment_score),
        ['Positive', 'Mixed', 'Negative'].includes(b.sentiment_label) ? b.sentiment_label : null,
        str(b.sentiment_summary, 400), str(b.bio, 400), str(b.current_activity, 400),
        str(b.strategy, 400), str(b.track_record, 400),
        JSON.stringify((Array.isArray(b.sources) ? b.sources : []).slice(0, 3)
          .map((s) => ({ title: String(s.title || s.url || '').slice(0, 120), url: String(s.url || '') }))
          .filter((s) => /^https?:\/\//.test(s.url))),
        ['high', 'medium', 'low'].includes(b.confidence) ? b.confidence : 'low',
        Date.now());
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (e) {
    res.status(400).json({ error: 'that candidate is already on the list' });
  }
});

app.delete('/api/election-intel/candidates/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  db.prepare('DELETE FROM candidate_snapshots WHERE candidate_id=?').run(id);
  const r = db.prepare('DELETE FROM election_candidates WHERE id=?').run(id);
  res.json({ ok: true, deleted: r.changes });
});

// Context bundle the AI assistant reasons over.
function buildAssistantContext() {
  const month = Date.now() - 30 * 864e5;
  return {
    representative: REP_NAME,
    citizens: db.prepare('SELECT COUNT(*) c FROM citizens').get().c,
    tickets_by_status: db.prepare('SELECT status, COUNT(*) c FROM tickets GROUP BY status').all(),
    tickets_by_kind: db.prepare('SELECT kind, COUNT(*) c FROM tickets GROUP BY kind').all(),
    top_categories_30d: db.prepare('SELECT category, COUNT(*) c FROM tickets WHERE created_at>? GROUP BY category ORDER BY c DESC LIMIT 12').all(month),
    latest_insights: db.prepare("SELECT rank, topic, summary, ticket_count, trend, suggested_action FROM insights WHERE source='issues' AND day=(SELECT MAX(day) FROM insights WHERE source='issues') ORDER BY rank").all(),
    upcoming_events: db.prepare("SELECT id, citizen_name, event_datetime, venue, status FROM tickets WHERE kind='event' AND status != 'resolved' ORDER BY updated_at DESC LIMIT 8").all(),
    open_high_priority: db.prepare("SELECT id, citizen_name, category, kind, status FROM tickets WHERE priority='High' AND status != 'resolved' ORDER BY updated_at DESC LIMIT 5").all(),
  };
}

// Query tools the Sampark AI assistant can call to reach every citizen,
// ticket, and chat message in the database. All inputs are sanitized and
// every query is parameterized; result sizes are capped.
const ASSISTANT_TOOL_DEFS = [
  {
    name: 'search_citizens',
    description: 'Find citizens by name (partial match). Returns id, name, phone, address, onboarding step.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full or partial citizen name, e.g. "Jai Shankar"' },
        limit: { type: 'integer', description: 'Max results (default 10, max 50)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_tickets',
    description: 'List tickets filtered by category, kind, status, priority, or citizen name. Newest first.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'One of: streetlight, water, road, ration, drainage, sanitation, pension, education, other' },
        kind: { type: 'string', description: 'issue or event' },
        status: { type: 'string', description: 'new, open, awaiting_citizen, resolved, etc.' },
        priority: { type: 'string', description: 'High, Medium, Low' },
        citizen_name: { type: 'string', description: 'Partial citizen name match' },
        limit: { type: 'integer', description: 'Max results (default 20, max 50)' },
      },
    },
  },
  {
    name: 'get_ticket',
    description: 'Full detail of one ticket: fields plus its complete WhatsApp message thread (oldest first). Messages with has_image=true include a photo (issue photo from the citizen or completed-work photo from the office).',
    input_schema: {
      type: 'object',
      properties: { ticket_id: { type: 'string', description: 'Ticket ID, e.g. SKT-1001' } },
      required: ['ticket_id'],
    },
  },
  {
    name: 'search_messages',
    description: 'Full-text search across all citizen and office WhatsApp messages. Returns matching messages with ticket ID and citizen name.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Word or phrase to search for' },
        limit: { type: 'integer', description: 'Max results (default 20, max 50)' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_stats',
    description: 'Constituency-wide aggregates: citizen count, tickets by status/kind, top categories (30d), latest issue insights, upcoming events, open high-priority tickets.',
    input_schema: { type: 'object', properties: {} },
  },
];

function capLimit(v, def = 20, max = 50) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : def;
}
const shortBody = (b, n = 400) => String(b || '').slice(0, n);

async function runAssistantTool(name, input = {}) {
  switch (name) {
    case 'search_citizens': {
      const rows = db.prepare(
        'SELECT id, name, phone, address, onboarding_step FROM citizens WHERE name LIKE ? ORDER BY name LIMIT ?'
      ).all(`%${String(input.name || '').slice(0, 60)}%`, capLimit(input.limit, 10));
      return { count: rows.length, citizens: rows };
    }
    case 'list_tickets': {
      const where = [];
      const params = [];
      const CATS = ['streetlight', 'water', 'road', 'ration', 'drainage', 'sanitation', 'pension', 'education', 'other'];
      if (input.category && CATS.includes(input.category)) { where.push('category=?'); params.push(input.category); }
      if (input.kind && ['issue', 'event'].includes(input.kind)) { where.push('kind=?'); params.push(input.kind); }
      if (input.status && /^[a-z_]+$/.test(input.status)) { where.push('status=?'); params.push(input.status); }
      if (input.priority && ['High', 'Medium', 'Low'].includes(input.priority)) { where.push('priority=?'); params.push(input.priority); }
      if (input.citizen_name) { where.push('citizen_name LIKE ?'); params.push(`%${String(input.citizen_name).slice(0, 60)}%`); }
      const q = `SELECT id, citizen_name, category, kind, priority, status, issue_address, venue, event_datetime, created_at FROM tickets` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ` ORDER BY created_at DESC LIMIT ?`;
      params.push(capLimit(input.limit));
      const rows = db.prepare(q).all(...params);
      return { count: rows.length, tickets: rows };
    }
    case 'get_ticket': {
      const t = db.prepare(
        'SELECT id, citizen_name, category, kind, priority, status, issue_address, venue, event_datetime, pending_draft, created_at, updated_at FROM tickets WHERE id=?'
      ).get(String(input.ticket_id || '').slice(0, 20));
      if (!t) return { error: 'ticket not found' };
      t.messages = db.prepare(
        "SELECT direction, substr(body,1,400) AS body, media_type, created_at FROM messages WHERE ticket_id=? ORDER BY created_at ASC LIMIT 60"
      ).all(t.id).map((m) => ({ ...m, has_image: !!m.media_type }));
      return t;
    }
    case 'search_messages': {
      const kw = `%${String(input.keyword || '').slice(0, 60)}%`;
      const rows = db.prepare(
        `SELECT m.ticket_id, t.citizen_name, m.direction, substr(m.body,1,300) AS snippet, m.created_at
         FROM messages m LEFT JOIN tickets t ON t.id=m.ticket_id
         WHERE m.body LIKE ? ORDER BY m.created_at DESC LIMIT ?`
      ).all(kw, capLimit(input.limit));
      return { count: rows.length, messages: rows };
    }
    case 'get_stats':
      return buildAssistantContext();
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// Politician chats with the Sampark AI assistant about constituency insights.
// Conversations persist across logins; the dashboard starts a fresh one on each login.
function getConversation(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return null;
  return db.prepare('SELECT * FROM ai_conversations WHERE id=?').get(n) || null;
}
function createConversation(title) {
  const now = Date.now();
  const r = db.prepare('INSERT INTO ai_conversations (title, created_at, updated_at) VALUES (?,?,?)')
    .run(String(title || 'New conversation').slice(0, 80), now, now);
  return db.prepare('SELECT * FROM ai_conversations WHERE id=?').get(Number(r.lastInsertRowid));
}
app.post('/api/ask', express.json(), async (req, res) => {
  const question = String(req.body.question || '').trim().slice(0, 1000);
  if (!question) return res.status(400).json({ error: 'empty question' });
  let conv = getConversation(req.body.conversation_id);
  if (!conv) conv = createConversation(question.slice(0, 60));
  const now = Date.now();
  const history = db.prepare('SELECT role, content FROM ai_chats WHERE conversation_id=? ORDER BY id DESC LIMIT 8').all(conv.id).reverse();
  db.prepare('INSERT INTO ai_chats (role, content, created_at, conversation_id) VALUES (?,?,?,?)').run('user', question, now, conv.id);
  // Title from the first question if still untitled.
  if (!conv.title || conv.title === 'New conversation') {
    const t = question.slice(0, 60);
    db.prepare('UPDATE ai_conversations SET title=? WHERE id=?').run(t, conv.id);
    conv.title = t;
  }
  let answer = null;
  // Tool-enabled assistant first: it can query every citizen, ticket, and message.
  try { answer = await ai.askAIWithTools({ repName: REP_NAME, question, context: buildAssistantContext(), history, toolDefs: ASSISTANT_TOOL_DEFS, runTool: runAssistantTool }); }
  catch (e) { console.error('askAIWithTools failed:', e.message); }
  // Fallback: summary-only context (e.g. OpenAI provider or tool loop failure).
  if (!answer) {
    try { answer = await ai.askAI({ repName: REP_NAME, question, context: buildAssistantContext(), history }); }
    catch (e) { console.error('askAI failed:', e.message); }
  }
  if (!answer) answer = 'Sampark AI is unavailable right now (no AI key configured on the server). Your question has been saved — please try again once the AI key is set.';
  db.prepare('INSERT INTO ai_chats (role, content, created_at, conversation_id) VALUES (?,?,?,?)').run('assistant', answer, Date.now(), conv.id);
  db.prepare('UPDATE ai_conversations SET updated_at=? WHERE id=?').run(Date.now(), conv.id);
  res.json({ ok: true, answer, conversation_id: conv.id, title: conv.title });
});

// List past conversations (newest first) with message counts.
app.get('/api/ask/conversations', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM ai_chats m WHERE m.conversation_id=c.id) AS messages
    FROM ai_conversations c ORDER BY c.updated_at DESC LIMIT 100`).all();
  res.json(rows);
});

// Messages of one conversation (oldest first) — reopen and reengage.
app.get('/api/ask/conversations/:id/messages', (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  const msgs = db.prepare('SELECT role, content, created_at FROM ai_chats WHERE conversation_id=? ORDER BY id ASC LIMIT 200').all(conv.id);
  res.json({ ...conv, messages: msgs });
});

// Delete a conversation and all its messages.
app.delete('/api/ask/conversations/:id', (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM ai_chats WHERE conversation_id=?').run(conv.id);
  db.prepare('DELETE FROM ai_conversations WHERE id=?').run(conv.id);
  res.json({ ok: true });
});

app.get('/api/ask/history', (_req, res) => {
  res.json(db.prepare('SELECT role, content, created_at FROM ai_chats ORDER BY id ASC LIMIT 100').all());
});

// Seed demo data (1000 chats). Guarded: refuses when citizens already exist unless forced.
app.post('/api/admin/seed', express.json(), (req, res) => {
  try {
    const existing = db.prepare('SELECT COUNT(*) c FROM citizens').get().c;
    if (existing > 20 && !req.body.force) {
      return res.status(409).json({ error: `already has ${existing} citizens — pass {force:true} to seed anyway` });
    }
    const seed = require('./lib/seed');
    const out = seed.seedDemoData(db, { count: 1000 });
    markBriefDirty();
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('seed failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tickets/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const msgs = db.prepare('SELECT * FROM messages WHERE ticket_id=? ORDER BY id ASC').all(t.id);
  const updates = db.prepare('SELECT * FROM ticket_updates WHERE ticket_id=? ORDER BY id ASC').all(t.id);
  res.json({ ...t, messages: msgs, updates });
});

// Save / override the AI draft
app.post('/api/tickets/:id/draft', express.json(), (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE tickets SET pending_draft=?, updated_at=? WHERE id=?').run(req.body.text || '', Date.now(), t.id);
  res.json({ ok: true });
});

// Approve & send the pending draft (or supplied text) via WhatsApp
app.post('/api/tickets/:id/approve', express.json(), async (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const text = (req.body.text || t.pending_draft || '').trim();
  if (!text) return res.status(400).json({ error: 'empty draft' });
  try {
    const wa = await sendWhatsApp(t.wa_id, text);
    db.prepare('INSERT INTO messages (ticket_id, direction, body, wa_message_id, created_at) VALUES (?,?,?,?,?)')
      .run(t.id, 'out', text, wa.messages?.[0]?.id || null, Date.now());
    db.prepare("UPDATE tickets SET pending_draft=NULL, status='in_progress', updated_at=? WHERE id=?").run(Date.now(), t.id);
    res.json({ ok: true, wa });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Send a photo (e.g. completed work) with an optional caption via WhatsApp.
// Body: { file: "<name from /api/upload>", caption: "..." }
app.post('/api/tickets/:id/send-image', express.json(), async (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const file = String(req.body.file || '');
  const caption = String(req.body.caption || '').slice(0, 1024);
  if (!file) return res.status(400).json({ error: 'no image' });
  try {
    const wa = await sendWhatsAppImage(t.wa_id, file, caption);
    db.prepare('INSERT INTO messages (ticket_id, direction, body, wa_message_id, media_type, media_path, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(t.id, 'out', caption, wa.messages?.[0]?.id || null, 'image', path.basename(file), Date.now());
    db.prepare("UPDATE tickets SET status='in_progress', updated_at=? WHERE id=?").run(Date.now(), t.id);
    res.json({ ok: true, wa });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Send a freeform office reply (human-written, still goes through WhatsApp)
app.post('/api/tickets/:id/reply', express.json(), async (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty message' });
  try {
    const wa = await sendWhatsApp(t.wa_id, text);
    db.prepare('INSERT INTO messages (ticket_id, direction, body, wa_message_id, created_at) VALUES (?,?,?,?,?)')
      .run(t.id, 'out', text, wa.messages?.[0]?.id || null, Date.now());
    db.prepare("UPDATE tickets SET status='in_progress', updated_at=? WHERE id=?").run(Date.now(), t.id);
    res.json({ ok: true, wa });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/tickets/:id/status', express.json(), (req, res) => {
  const { status } = req.body;
  if (!['new', 'in_progress', 'awaiting_citizen', 'resolved'].includes(status)) return res.status(400).json({ error: 'bad status' });
  db.prepare('UPDATE tickets SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), req.params.id);
  res.json({ ok: true });
});

// Politician posts an update on a ticket. It is recorded and the citizen is
// notified via WhatsApp right away. If the send fails, the update is kept
// (notified=0) so the politician can retry from the dashboard.
app.post('/api/tickets/:id/updates', express.json(), async (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const body = String(req.body.body || '').trim().slice(0, 1000);
  if (!body) return res.status(400).json({ error: 'empty update' });
  const now = Date.now();
  const info = db.prepare('INSERT INTO ticket_updates (ticket_id, body, notified, created_at) VALUES (?,?,0,?)').run(t.id, body, now);
  const uid = info.lastInsertRowid;
  const msg = `📋 Update on your ticket ${t.id}:\n\n${body}\n\n— Team ${REP_NAME}`;
  let notified = false;
  try {
    const wa = await sendWhatsApp(t.wa_id, msg);
    db.prepare('INSERT INTO messages (ticket_id, direction, body, wa_message_id, created_at) VALUES (?,?,?,?,?)')
      .run(t.id, 'out', msg, wa.messages?.[0]?.id || null, now);
    db.prepare('UPDATE ticket_updates SET notified=1 WHERE id=?').run(uid);
    notified = true;
  } catch (e) { console.error('update notify failed:', e.message); }
  if (t.status !== 'resolved') db.prepare("UPDATE tickets SET status='in_progress', updated_at=? WHERE id=?").run(now, t.id);
  res.json({ ok: true, id: uid, notified });
});

// Retry notifying the citizen about an update whose WhatsApp send failed.
app.post('/api/tickets/:id/updates/:uid/notify', express.json(), async (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  const u = db.prepare('SELECT * FROM ticket_updates WHERE id=? AND ticket_id=?').get(req.params.uid, req.params.id);
  if (!t || !u) return res.status(404).json({ error: 'not found' });
  const msg = `📋 Update on your ticket ${t.id}:\n\n${u.body}\n\n— Team ${REP_NAME}`;
  try {
    const wa = await sendWhatsApp(t.wa_id, msg);
    db.prepare('INSERT INTO messages (ticket_id, direction, body, wa_message_id, created_at) VALUES (?,?,?,?,?)')
      .run(t.id, 'out', msg, wa.messages?.[0]?.id || null, Date.now());
    db.prepare('UPDATE ticket_updates SET notified=1 WHERE id=?').run(u.id);
    res.json({ ok: true, notified: true });
  } catch (e) {
    res.status(502).json({ error: e.message, notified: false });
  }
});

// Auto-reply master switch (dashboard toggle). Persists in meta; default on.
app.post('/api/settings/auto-reply', express.json(), (req, res) => {
  const v = req.body.enabled ? '1' : '0';
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('auto_reply', v);
  res.json({ ok: true, auto_reply: v === '1' });
});

// Recently auto-sent office replies, for politician review.
app.get('/api/auto-sent', (req, res) => {
  const rows = db.prepare(`
    SELECT m.ticket_id, m.body, m.created_at, t.citizen_name, t.category, t.sensitive
    FROM messages m JOIN tickets t ON t.id = m.ticket_id
    WHERE m.direction='out' AND m.auto=1
    ORDER BY m.created_at DESC LIMIT 20`).all();
  res.json(rows);
});

app.get('/api/stats', (_req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM tickets').get().c;
  const active = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status != 'resolved'").get().c;
  const fresh = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status='new'").get().c;
  const resolved = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status='resolved'").get().c;
  const drafts = db.prepare('SELECT COUNT(*) c FROM tickets WHERE pending_draft IS NOT NULL').get().c;
  const citizens = db.prepare('SELECT COUNT(*) c FROM citizens').get().c;
  // avg first response: ticket created -> first outbound message
  const pairs = db.prepare(`
    SELECT t.created_at tc, MIN(m.created_at) mr FROM tickets t
    JOIN messages m ON m.ticket_id=t.id AND m.direction='out'
    GROUP BY t.id`).all();
  const avgResp = pairs.length
    ? Math.round(pairs.reduce((a, p) => a + (p.mr - p.tc), 0) / pairs.length / 1000)
    : null;
  const week = Date.now() - 7 * 864e5;
  const mix = db.prepare('SELECT category, COUNT(*) c FROM tickets WHERE created_at>? GROUP BY category ORDER BY c DESC').all(week);
  const autoSent24h = db.prepare("SELECT COUNT(*) c FROM messages WHERE direction='out' AND auto=1 AND created_at>?").get(Date.now() - 864e5).c;
  res.json({ total, active, new: fresh, resolved, pending_drafts: drafts, citizens, avg_first_response_sec: avgResp, issue_mix_7d: mix, auto_sent_24h: autoSent24h });
});

app.get('/api/brief', async (_req, res) => {
  const day = Date.now() - 864e5;
  const newToday = db.prepare('SELECT COUNT(*) c FROM tickets WHERE created_at>?').get(day).c;
  const drafts = db.prepare("SELECT id, citizen_name, category FROM tickets WHERE pending_draft IS NOT NULL ORDER BY updated_at DESC LIMIT 5").all();
  const awaiting = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status='awaiting_citizen'").get().c;
  const autoSent = db.prepare("SELECT COUNT(*) c FROM messages WHERE direction='out' AND auto=1 AND created_at>?").get(day).c;
  const week = Date.now() - 7 * 864e5;
  const prev = Date.now() - 14 * 864e5;
  const top = db.prepare('SELECT category, COUNT(*) c FROM tickets WHERE created_at>? GROUP BY category ORDER BY c DESC LIMIT 1').get(week);
  let spike = null;
  if (top) {
    const before = db.prepare('SELECT COUNT(*) c FROM tickets WHERE category=? AND created_at>? AND created_at<=?').get(top.category, prev, week).c;
    if (top.c >= 3 && top.c > before * 1.5) spike = { category: top.category, this_week: top.c, prev_week: before };
  }
  let aiBrief = briefCache.text;
  if (ai.isConfigured() && Date.now() - briefCache.at > BRIEF_TTL_MS) {
    try {
      const fresh = await ai.generateBrief({ repName: REP_NAME, input: {
        new_today: newToday,
        awaiting_citizen: awaiting,
        auto_sent_24h: autoSent,
        spike,
        pending_drafts: drafts.map((d) => ({ id: d.id, citizen: d.citizen_name, category: d.category })),
      }});
      if (fresh) { briefCache = { text: fresh, at: Date.now() }; aiBrief = fresh; }
    } catch (e) { console.error('brief AI error:', e.message); }
  }
  res.json({ new_today: newToday, pending_drafts: drafts, awaiting_citizen: awaiting, auto_sent_24h: autoSent, spike, ai_brief: aiBrief, ai_configured: ai.isConfigured() });
});

// Local test simulator: injects a message exactly as if it came from WhatsApp (no Meta needed)
app.post('/api/test/simulate', express.json(), async (req, res) => {
  const { from, name, text, media } = req.body; // media: optional uploaded filename to simulate an inbound photo
  if (!from || !text) return res.status(400).json({ error: 'from and text required' });
  let mediaPath = null;
  if (media) {
    const full = mediaFilePath(String(media));
    if (!full || !fs.existsSync(full)) return res.status(400).json({ error: 'media file not found — upload it first' });
    mediaPath = path.basename(full);
  }
  try {
    const r = await handleIncoming({ waId: String(from), name: name || 'Test Citizen', text, waMessageId: 'test-' + Date.now(), ts: Date.now(), mediaType: mediaPath ? 'image' : null, mediaPath });
    res.json({ ok: true, ticket_id: r.ticket ? r.ticket.id : null, is_new: r.isNew, draft_source: r.ticket ? r.ticket.draft_source : null });
  } catch (e) {
    console.error('simulate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Sampark dashboard on http://localhost:${PORT}`);
  console.log(CONFIGURED ? 'WhatsApp API: CONNECTED' : 'WhatsApp API: NOT CONFIGURED — set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID (see README)');
  if (!VERIFY_TOKEN) console.log('Warning: WEBHOOK_VERIFY_TOKEN not set — webhook verification will reject everything.');
});

// Daily insights refresh: run once a day at 06:00 local so the top-10 is fresh
// every morning; GET /api/insights also refreshes lazily when stale.
function scheduleDailyInsights() {
  const run = () => refreshInsights().catch((e) => console.error('daily insights refresh failed:', e.message));
  const now = new Date();
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => { run(); setInterval(run, 24 * 3600e3); }, next - now);
  console.log(`Daily insights refresh scheduled for ${next.toLocaleString()}`);
}
scheduleDailyInsights();

// Daily election intel: deep candidate research once a day at 07:00 local
// (after the 06:00 insights run). Also kicks off in the background shortly
// after startup when the last successful run is older than 24h.
let intelRunning = false;
function scheduleDailyElectionIntel() {
  const run = () => {
    if (intelRunning) return;
    intelRunning = true;
    refreshElectionIntel()
      .catch((e) => console.error('daily intel refresh failed:', e.message))
      .finally(() => { intelRunning = false; });
  };
  const now = new Date();
  const next = new Date(now);
  next.setHours(7, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => { run(); setInterval(run, 24 * 3600e3); }, next - now);
  console.log(`Daily election intel scheduled for ${next.toLocaleString()}`);
  try {
    const lastOk = db.prepare("SELECT MAX(ran_at) m FROM intel_runs WHERE status='ok'").get().m;
    if (!lastOk || Date.now() - lastOk > 24 * 3600e3) {
      setTimeout(run, 60e3);
      console.log('Election intel stale or empty — first research run starts in 60s');
    }
  } catch (e) { console.error('intel cold-start check failed:', e.message); }
}
scheduleDailyElectionIntel();

module.exports = { db, handleIncoming };
