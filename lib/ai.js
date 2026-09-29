// lib/ai.js — LLM layer for Sampark: message classification, reply drafting,
// morning-brief generation. Supports Anthropic and OpenAI via plain fetch.
// Every function returns null when no API key is configured, so the server
// transparently falls back to its built-in template behavior.

const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CONSTITUENCY = process.env.CONSTITUENCY || 'Margao';

function isConfigured() {
  return (PROVIDER === 'anthropic' && !!ANTHROPIC_KEY) || (PROVIDER === 'openai' && !!OPENAI_KEY);
}

async function chat(system, user, { maxTokens = 600, temperature = 0.5 } = {}) {
  if (!isConfigured()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    if (PROVIDER === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OPENAI_MODEL, max_tokens: maxTokens, temperature,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `OpenAI HTTP ${r.status}`);
      return j.choices?.[0]?.message?.content?.trim() || null;
    }
    // anthropic (default)
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL, max_tokens: maxTokens, temperature, system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `Anthropic HTTP ${r.status}`);
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || null;
  } finally {
    clearTimeout(timer);
  }
}

const CATEGORIES = ['streetlight', 'water', 'road', 'ration', 'drainage', 'sanitation', 'pension', 'education', 'other'];

// Returns { category, priority, language, sensitive, sensitivity_reason, kind } or null (caller falls back to keywords).
async function classifyMessage(text) {
  const out = await chat(
    'You classify citizen complaints for an Indian MLA office. Reply with ONLY a JSON object, no other text.',
    `Classify this citizen message. Categories: ${CATEGORIES.join(', ')}.
Priority: High only for emergencies (accident, fire, hospital, safety risk, no water for days); Medium for normal complaints; Low for feedback or thanks.
Kind: "event" if the message is an invitation or announcement about an upcoming occasion (birthday, wedding, inauguration, puja, feast, function, ceremony); otherwise "issue".
Also detect the message language (e.g. English, Hindi, Hinglish, Marathi, Konkani).
Also judge SENSITIVITY. sensitive=true if the message involves ANY of: corruption or bribery allegations; legal matters (police, FIR, courts, lawyers, disputes); communal, religious or caste conflict; medical emergencies or health advice; accusations against a named person or official; media or press inquiries; money, donations, or financial transactions; threats, violence, or safety risks; requests to share someone's private personal data. Otherwise sensitive=false.
Message: """${text}"""
Reply format: {"category":"...","priority":"High|Medium|Low","language":"...","sensitive":true|false,"sensitivity_reason":"...","kind":"issue|event"}`,
    { maxTokens: 220, temperature: 0.2 }
  );
  if (!out) return null;
  try {
    const j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    if (!CATEGORIES.includes(j.category)) j.category = 'other';
    if (!['High', 'Medium', 'Low'].includes(j.priority)) j.priority = 'Medium';
    if (!['issue', 'event'].includes(j.kind)) j.kind = 'issue';
    j.sensitive = j.sensitive !== false; // fail closed: uncertain -> sensitive -> needs approval
    return j;
  } catch {
    return null;
  }
}

// Returns a draft reply string, or null (caller falls back to template draft).
// The agent writes AS the MLA's office (first-person plural "we") — the citizen
// experiences it as an official office reply, not a bot announcement.
async function generateDraft({ repName, citizenName, category, language, text, kind }) {
  const first = (citizenName || 'Citizen').split(' ')[0];
  const task = kind === 'event'
    ? 'The citizen has invited the MLA to an occasion (birthday, wedding, inauguration, etc.). Thank them warmly for the invitation, acknowledge it, and say the office will confirm attendance.'
    : 'Acknowledge the specific issue; say we have noted it and forwarded it to the concerned department and will update them;';
  return await chat(
    `You are the official WhatsApp assistant of Indian MLA ${repName}'s office, writing AS the office in first-person plural ("we", "our office"). Rules: warm and respectful; address the citizen as "${first} ji"; reply in the SAME language as the citizen's message${language ? ` (${language})` : ''}; under 60 words; ${task} never invent dates, official names, or promises; never mention you are an AI; sign off exactly "— Team ${repName}". No placeholders, no preamble.`,
    `Citizen message (category: ${category}): """${text}"""`,
    { maxTokens: 220, temperature: 0.7 }
  );
}

// Draft asking a first-time citizen for their name, or null (caller falls back to template).
async function generateNameRequest({ repName, language }) {
  return await chat(
    `You draft short WhatsApp replies for the office of Indian MLA ${repName}. Rules: warm and respectful; under 40 words; reply in ${language ? `the citizen's language (${language})` : "the same language as the citizen's message"}; never assume or invent the citizen's name; sign off exactly "— Team ${repName}". No placeholders, no preamble.`,
    `Write a brief message greeting the citizen and asking them to share their name so the office can assist them better.`,
    { maxTokens: 120, temperature: 0.7 }
  );
}

// Extract the citizen's name from their reply to the name request. Returns the name or null.
async function extractName(text) {
  const out = await chat(
    "You extract a person's name from a short chat reply. Reply with ONLY the name, no honorifics, or the exact word NONE if no name is present.",
    `The citizen was asked for their name and replied: """${text}"""\nReply with ONLY their name, or NONE.`,
    { maxTokens: 40, temperature: 0.1 }
  );
  if (!out) return null;
  const t = out.trim();
  if (/^none\b/i.test(t)) return null;
  const clean = t.replace(/[^\p{L}\p{M} .'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean || null;
}

// Returns a plain-text bullet brief, or null (caller falls back to computed brief).
async function generateBrief({ repName, input }) {
  return await chat(
    `You write a 2-minute morning brief for Indian MLA ${repName} from their constituency WhatsApp inbox snapshot. Output 4-6 short bullet lines, plain text, each starting with "- ". Cover: new complaints, any emerging cluster, drafts awaiting approval, tickets awaiting citizen reply. Be specific with numbers. No greeting, no sign-off.`,
    `Inbox snapshot: ${JSON.stringify(input)}`,
    { maxTokens: 320, temperature: 0.5 }
  );
}

// Extract structured details from a citizen's reply to the details question.
// Returns { event_datetime_text, venue, issue_address, home_address } (missing keys = null), or null on failure.
async function extractDetails(text, kind) {
  const out = await chat(
    'You extract structured details from a short citizen chat reply. Reply with ONLY a JSON object, no other text.',
    `The citizen was asked for ${kind === 'event'
      ? 'the date, time and venue of their event (e.g. birthday, wedding) plus optionally their home address'
      : 'the location/address of their civic issue plus optionally their home address'} and replied: """${text}"""
Reply format: {"event_datetime_text":"...","venue":"...","issue_address":"...","home_address":"..."}. Use null for anything not mentioned. Keep values short, in the citizen's own words.`,
    { maxTokens: 200, temperature: 0.2 }
  );
  if (!out) return null;
  try {
    const j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    return {
      event_datetime_text: j.event_datetime_text || null,
      venue: j.venue || null,
      issue_address: j.issue_address || null,
      home_address: j.home_address || null,
    };
  } catch {
    return null;
  }
}

// The politician's AI assistant: answers questions about the constituency using live data.
// context is a plain object with counts, top topics, insights, upcoming events, recent tickets.
// Returns the answer string, or null (caller shows a graceful fallback).
async function askAI({ repName, question, context, history }) {
  const hist = (history || []).slice(-8).map((m) => `${m.role === 'user' ? 'Politician' : 'Sampark AI'}: ${m.content}`).join('\n');
  return await chat(
    `You are Sampark AI, the constituency intelligence assistant to Indian MLA ${repName}. Answer the politician's question using ONLY the constituency data provided below — never invent numbers, names, or events. Be concise and specific: cite counts, areas, and ticket IDs where relevant. If the data cannot answer the question, say so plainly and suggest what would help. Plain text, short paragraphs or bullets. No greeting.`,
    `${hist ? `Recent conversation:\n${hist}\n\n` : ''}Constituency data (JSON):\n${JSON.stringify(context)}\n\nPolitician's question: """${question}"""`,
    { maxTokens: 500, temperature: 0.4 }
  );
}

// Turn 30-day ticket aggregates into the daily top-10 topics list.
// stats: [{ category, total, open, trend }] where trend is rising|stable|falling.
// Returns [{ topic, summary, ticket_count, trend, suggested_action }] or null.
async function summarizeTopics(stats) {
  const out = await chat(
    'You are a constituency analyst for an Indian MLA. Reply with ONLY a JSON array, no other text.',
    `From these 30-day civic-issue statistics, produce the TOP 10 topics by total tickets. For each: a short topic label, a one-line summary naming the worst-affected areas if known, the ticket count, the trend (use the given trend), and one concrete suggested action the MLA's office can take this week.\nStatistics: ${JSON.stringify(stats)}\nReply format: [{"topic":"...","summary":"...","ticket_count":12,"trend":"rising","suggested_action":"..."}]`,
    { maxTokens: 1200, temperature: 0.4 }
  );
  if (!out) return null;
  try {
    const j = JSON.parse(out.match(/\[[\s\S]*\]/)[0]);
    return Array.isArray(j) ? j.slice(0, 10) : null;
  } catch {
    return null;
  }
}

module.exports = { isConfigured, provider: PROVIDER, classifyMessage, generateDraft, generateNameRequest, extractName, extractDetails, askAI, summarizeTopics, generateBrief, gatherWebInsights };

// Web insights: ask Claude (with Anthropic's server-side web search) for recent
// news and developments relevant to the constituency. Returns
// [{ topic, summary, trend, suggested_action, sources: [{title, url}] }]
// or null when unavailable (caller degrades gracefully).
async function gatherWebInsights({ repName, constituency } = {}) {
  if (PROVIDER !== 'anthropic' || !ANTHROPIC_KEY) return null;
  const place = constituency || CONSTITUENCY;
  const today = new Date().toISOString().slice(0, 10);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2500,
        temperature: 0.4,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        messages: [{
          role: 'user',
          content:
            `You are a constituency intelligence analyst for ${repName || 'the MLA'} of ${place}, Goa, India. Today is ${today}.\n` +
            `Use web search to find the most important RECENT (last 30 days) news, government announcements, civic developments, and local issues concerning ${place} and South Goa that an MLA should know about — for example infrastructure projects, water/power/road news, municipal corporation decisions, public grievances reported in the press, and notable upcoming local events.\n` +
            `Then reply with ONLY a JSON array (no other text) of up to 8 items:\n` +
            `[{"topic":"...","summary":"one line on why it matters for the constituency","trend":"rising|stable|falling","suggested_action":"one concrete action the MLA office can take","sources":[{"title":"...","url":"..."}]}]\n` +
            `Rules: every item must be grounded in the search results; give 1-3 source URLs per item; skip anything you cannot source; if nothing relevant is found, reply with [].`,
        }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `Anthropic HTTP ${r.status}`);
    const blocks = j.content || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    // Fallback sources straight from the search result blocks.
    const toolUrls = [];
    for (const b of blocks) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const s of b.content) {
          if (s && s.type === 'web_search_result' && s.url) {
            toolUrls.push({ title: String(s.title || s.url).slice(0, 120), url: String(s.url) });
          }
        }
      }
    }
    if (!text) return null;
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return null;
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return null;
    return arr.slice(0, 8).map((t) => {
      const seen = new Set();
      const sources = (Array.isArray(t.sources) ? t.sources : [])
        .slice(0, 3)
        .map((s) => ({ title: String(s.title || s.url || '').slice(0, 120), url: String(s.url || '') }))
        .filter((s) => s.url && /^https?:\/\//.test(s.url) && !seen.has(s.url) && seen.add(s.url))
        .concat(toolUrls.filter((s) => !seen.has(s.url) && seen.add(s.url)).slice(0, 3)).slice(0, 3);
      return {
        topic: String(t.topic || 'Topic').slice(0, 120),
        summary: String(t.summary || '').slice(0, 500),
        trend: ['rising', 'stable', 'falling'].includes(t.trend) ? t.trend : 'stable',
        suggested_action: String(t.suggested_action || '').slice(0, 300),
        sources,
      };
    });
  } catch (e) {
    console.error('gatherWebInsights failed:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
