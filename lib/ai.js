// lib/ai.js — LLM layer for Sampark: message classification, reply drafting,
// morning-brief generation. Supports Anthropic and OpenAI via plain fetch.
// Every function returns null when no API key is configured, so the server
// transparently falls back to its built-in template behavior.

const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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

// Returns { category, priority, language } or null (caller falls back to keywords).
async function classifyMessage(text) {
  const out = await chat(
    'You classify citizen complaints for an Indian MLA office. Reply with ONLY a JSON object, no other text.',
    `Classify this citizen message. Categories: ${CATEGORIES.join(', ')}.
Priority: High only for emergencies (accident, fire, hospital, safety risk, no water for days); Medium for normal complaints; Low for feedback or thanks.
Also detect the message language (e.g. English, Hindi, Hinglish, Marathi).
Message: """${text}"""
Reply format: {"category":"...","priority":"High|Medium|Low","language":"..."}`,
    { maxTokens: 150, temperature: 0.2 }
  );
  if (!out) return null;
  try {
    const j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    if (!CATEGORIES.includes(j.category)) j.category = 'other';
    if (!['High', 'Medium', 'Low'].includes(j.priority)) j.priority = 'Medium';
    return j;
  } catch {
    return null;
  }
}

// Returns a draft reply string, or null (caller falls back to template draft).
async function generateDraft({ repName, citizenName, category, language, text }) {
  const first = (citizenName || 'Citizen').split(' ')[0];
  return await chat(
    `You draft short WhatsApp replies for the office of Indian MLA ${repName}. Rules: warm and respectful; address the citizen as "${first} ji"; reply in the SAME language as the citizen's message${language ? ` (${language})` : ''}; under 60 words; acknowledge the specific issue; say it has been forwarded to the concerned department and the office will update them; never invent dates, official names, or promises; sign off exactly "— Team ${repName}". No placeholders, no preamble.`,
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

module.exports = { isConfigured, provider: PROVIDER, classifyMessage, generateDraft, generateNameRequest, extractName, generateBrief };
