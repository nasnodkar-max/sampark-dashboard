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
// contextNote: an optional confirmed detail (e.g. "Location saved: X") that the
// agent should weave naturally into the reply instead of the caller prepending it.
async function generateDraft({ repName, citizenName, category, language, text, kind, contextNote, ticketId, history }) {
  const first = (citizenName || 'Citizen').split(' ')[0];
  const task = kind === 'event'
    ? 'The citizen has invited the MLA to an occasion (birthday, wedding, inauguration, etc.). Thank them warmly for the invitation, acknowledge it, and say the office will confirm attendance.'
    : 'Acknowledge the specific issue; say we have noted it and forwarded it to the concerned department and will update them;';
  const note = contextNote ? ` Also weave in this confirmed detail naturally (do not repeat it verbatim as a separate header): ${contextNote}.` : '';
  const ticketBit = ticketId ? ` The citizen's ticket number is ${ticketId} — if they ask about their ticket number, ticket ID, or status, state it EXACTLY as written (never invent or alter it).` : '';
  const histBit = history && history.length
    ? ` Conversation so far on this ticket (oldest first) — use it for context; never ask the citizen to repeat or re-clarify anything already established here:\n${history.map((m) => `${m.direction === 'in' ? 'Citizen' : 'Office'}: ${String(m.body).slice(0, 220)}`).join('\n')}`
    : '';
  return await chat(
    `You are the official WhatsApp assistant of Indian MLA ${repName}'s office, writing AS the office in first-person plural ("we", "our office"). Rules: warm and respectful; address the citizen as "${first} ji"; reply in the SAME language as the citizen's message${language ? ` (${language})` : ''}; under 60 words; ${task}${note}${ticketBit}${histBit} never invent dates, official names, or promises; never mention you are an AI; sign off exactly "— Team ${repName}". No placeholders, no preamble.`,
    `Citizen message (category: ${category}): """${text}"""`,
    { maxTokens: 260, temperature: 0.7 }
  );
}

// Triage: is the citizen's message a NEW, separate issue (true) or a follow-up
// on their open ticket (false)? Returns null when the AI is unavailable or the
// answer is unclear — the caller falls back to keyword heuristics.
async function isNewIssue({ ticketSummary, recentMessages, text }) {
  try {
    const hist = (recentMessages || [])
      .map((m) => `${m.direction === 'in' ? 'Citizen' : 'Office'}: ${String(m.body).slice(0, 200)}`)
      .join('\n');
    const out = await chat(
      'You triage WhatsApp messages for an Indian MLA constituency office. Reply with exactly one word: YES or NO.',
      `The citizen has an OPEN ticket: ${ticketSummary}.\nRecent conversation on that ticket (oldest first):\n${hist || '(none)'}\n\nTheir NEW message: """${text}"""\n\nIs the new message reporting a NEW, separate issue or problem — a different matter from the open ticket (e.g. they say "another issue", or describe something unrelated to the open ticket and unrelated to any question the office asked)? Reply YES.\nIs it instead a follow-up on the open ticket — answering the office's question, giving details or a reference number, asking about status or their ticket number, describing the same problem again? Reply NO.\nOne word only.`,
      { maxTokens: 10, temperature: 0 }
    );
    if (!out) return null;
    const t = out.trim().toUpperCase();
    if (t.startsWith('YES')) return true;
    if (t.startsWith('NO')) return false;
    return null;
  } catch (e) {
    console.error('AI isNewIssue failed:', e.message);
    return null;
  }
}

// Draft asking a first-time citizen for their name, or null (caller falls back to template).
async function generateNameRequest({ repName, language }) {
  return await chat(
    `You draft short WhatsApp replies for the office of Indian MLA ${repName}. Rules: warm and respectful; under 40 words; reply in ${language ? `the citizen's language (${language})` : "the same language as the citizen's message"}; never assume or invent the citizen's name; sign off exactly "— Team ${repName}". No placeholders, no preamble.`,
    `Write a brief message greeting the citizen and asking them to share their name so the office can assist them better.`,
    { maxTokens: 120, temperature: 0.7 }
  );
}

// Draft re-asking for the citizen's name after they replied with something else
// (e.g. they described their issue instead of giving their name), or null
// (caller falls back to template).
async function generateNameRetry({ repName, theirReply }) {
  return await chat(
    `You draft short WhatsApp replies for the office of Indian MLA ${repName}. Rules: warm and respectful; under 45 words; reply in the SAME language as the citizen's message below; never assume or invent the citizen's name; sign off exactly "— Team ${repName}". No placeholders, no preamble.`,
    `The citizen was asked for their name so the office could log their request, but instead replied: """${theirReply}"""\nWrite a brief message acknowledging what they wrote and gently asking for their name once more.`,
    { maxTokens: 130, temperature: 0.7 }
  );
}

// Draft asking a newly-registered citizen for issue/event details, or null
// (caller falls back to template).
async function generateDetailsQuestion({ repName, citizenName, kind, category, citizenMessage }) {
  const first = (citizenName || 'Citizen').split(' ')[0];
  const what = kind === 'event'
    ? 'the date, time and venue of their event'
    : `the exact location (area or landmark) of their ${category || 'civic'} issue`;
  return await chat(
    `You draft short WhatsApp replies for the office of Indian MLA ${repName}. Rules: warm and respectful; address the citizen as "${first} ji"; under 50 words; reply in the SAME language as the citizen's message below; mention that sharing their home address is optional; sign off exactly "— Team ${repName}". No placeholders, no preamble.`,
    `The citizen just shared their name. Their message: """${citizenMessage || ''}"""\nWrite a brief message thanking them and asking them to share ${what} so the office can act faster.`,
    { maxTokens: 150, temperature: 0.7 }
  );
}

// Draft a ticket-status reply for a citizen who quoted their ticket number.
// Facts are injected; the agent must quote the ticket ID and status exactly.
// Returns the reply string, or null (caller falls back to template).
async function generateStatusReply({ repName, citizenName, ticketId, categoryLabel, statusPlain, latestUpdate, citizenMessage }) {
  const first = (citizenName || 'Citizen').split(' ')[0];
  return await chat(
    `You are the official WhatsApp assistant of Indian MLA ${repName}'s office, writing AS the office in first-person plural ("we", "our office"). Rules: warm and respectful; address the citizen as "${first} ji"; reply in the SAME language as the citizen's message below; under 70 words; quote the ticket ID and the status EXACTLY as given below — never alter them; ${latestUpdate ? 'mention the latest office update briefly in your own words' : 'do not invent any update or promise'}; never mention you are an AI; sign off exactly "— Team ${repName}". No placeholders, no preamble.`,
    `Ticket ID (quote exactly): ${ticketId}\nCategory: ${categoryLabel}\nCurrent status (quote exactly): ${statusPlain}\n${latestUpdate ? `Latest office update: """${latestUpdate}"""\n` : ''}Citizen message: """${citizenMessage}"""`,
    { maxTokens: 220, temperature: 0.5 }
  );
}

// Extract the citizen's name from their reply to the name request. Returns the name or null.
async function extractName(text) {
  const out = await chat(
    "You extract a person's name from a short chat reply. Reply with ONLY the name, no honorifics, or the exact word NONE if no name is present. If the reply is a single common word that is not plausibly a person's name (examples: register, complaint, hello, hi, yes, ok, please, thanks, help, sir), reply NONE. A reply that describes an issue instead of giving a name (e.g. \"water problem near market\") is also NONE.",
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
// event_datetime_text is always an absolute date ("12 Oct 2026, 6 PM") — relative
// words like "tomorrow" are resolved against today so stored dates never go stale.
async function extractDetails(text, kind) {
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const todayStr = `${ist.getUTCDate()} ${mon[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
  const out = await chat(
    'You extract structured details from a short citizen chat reply. Reply with ONLY a JSON object, no other text.',
    `The citizen was asked for ${kind === 'event'
      ? 'the date, time and venue of their event (e.g. birthday, wedding) plus optionally their home address'
      : 'the location/address of their civic issue plus optionally their home address'} and replied: """${text}"""
Today is ${todayStr} (India). Reply format: {"event_datetime_text":"...","venue":"...","issue_address":"...","home_address":"..."}. For event_datetime_text, ALWAYS write an absolute date like "12 Oct 2026, 6 PM" — resolve relative words ("tomorrow", "next Sunday") against today. Use null for anything not mentioned. Keep values short, in the citizen's own words.`,
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
const ASK_SYSTEM = (repName) =>
  `You are Sampark AI, the constituency intelligence assistant to Indian MLA ${repName}. ` +
  `You have query tools to look up citizens, tickets, and WhatsApp chat content — USE THEM whenever a question needs specific names, ticket details, or message content. ` +
  `Answer using ONLY data returned by the tools or the provided summary — never invent numbers, names, tickets, or events. ` +
  `Be concise and specific: cite counts, citizen names, areas, and ticket IDs where relevant. ` +
  `If the data cannot answer the question, say so plainly and suggest what would help. ` +
  `Plain text, short paragraphs or bullets. No greeting. ` +
  `WORKFLOW RULES (follow strictly): ` +
  `1) If the question names or asks about a specific person: call search_citizens, then list_tickets filtered by citizen_name, then get_ticket for the relevant ticket(s). ` +
  `2) If the question asks what someone SAID, what the office REPLIED, or for any conversation/message content: you MUST call get_ticket — it contains the full WhatsApp message thread. NEVER claim message content is unavailable without calling get_ticket first. ` +
  `3) If the question asks for a list (e.g. "open water complaints"): call list_tickets with matching filters and respect the requested status — "open" means status new/open/awaiting_citizen, never resolved. ` +
  `4) Prefer tool results over the summary; the summary is only a starting overview.`;

// Tool-enabled variant of askAI (Anthropic only). toolDefs is an array of
// { name, description, input_schema }; runTool(name, input) executes a tool
// server-side and returns a JSON-serializable result. Runs a short agentic
// loop (max 6 rounds) and returns the final answer text, or null.
async function askAIWithTools({ repName, question, context, history, toolDefs, runTool }) {
  if (PROVIDER !== 'anthropic' || !ANTHROPIC_KEY || !Array.isArray(toolDefs) || !toolDefs.length) return null;
  const hist = (history || []).slice(-8).map((m) => `${m.role === 'user' ? 'Politician' : 'Sampark AI'}: ${m.content}`).join('\n');
  const messages = [{
    role: 'user',
    content: `${hist ? `Recent conversation:\n${hist}\n\n` : ''}Constituency summary (JSON):\n${JSON.stringify(context)}\n\nPolitician's question: """${question}"""`,
  }];
  for (let round = 0; round < 6; round++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    let j;
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
          model: ANTHROPIC_MODEL, max_tokens: 900, temperature: 0.4,
          system: ASK_SYSTEM(repName),
          tools: toolDefs,
          messages,
        }),
      });
      j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `Anthropic HTTP ${r.status}`);
    } catch (e) {
      clearTimeout(timer);
      console.error('askAIWithTools round failed:', e.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
    const blocks = j.content || [];
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: blocks });
    if (!toolUses.length || j.stop_reason !== 'tool_use') {
      return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || null;
    }
    const results = [];
    for (const tu of toolUses) {
      try {
        const out = await runTool(tu.name, tu.input || {});
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 12000) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Tool error: ${e.message}` });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return null;
}
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

// 2027 election intel: deep research on potential candidates for the
// constituency (Goa Assembly elections 2027), with sentiment analysis from
// news and social media. Returns { race_summary, candidates: [...], movements: [...] }
// or null when unavailable. Every claim must be grounded in search results — the
// prompt forces confidence labels and forbids inventing candidates.
// `previous` (optional): { date, estimates: [{name, vote_share}], summary } from
// the last report, so the model can explain day-over-day movements.
async function researchElectionIntel({ constituency, previous } = {}) {
  if (PROVIDER !== 'anthropic' || !ANTHROPIC_KEY) return null;
  const place = constituency || CONSTITUENCY;
  const today = new Date().toISOString().slice(0, 10);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150000);
  const prevBlock = previous && previous.estimates && previous.estimates.length
    ? `PREVIOUS REPORT (${previous.date}): estimated vote shares were ${previous.estimates.map((e) => `${e.name} ${e.vote_share}%`).join('; ')}. Previous summary: "${String(previous.summary || '').slice(0, 300)}"\n` +
      (previous.prevReasons && previous.prevReasons.length
        ? `Movement reasons the previous report already gave — do NOT repeat these, only cite NEW developments: ${previous.prevReasons.map((r) => `"${String(r).slice(0, 140)}"`).join('; ')}\n`
        : '')
    : `This is the first report — there is no previous day to compare against; return "movements": [].\n`;
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
        max_tokens: 7000,
        temperature: 0.3,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
        messages: [{
          role: 'user',
          content:
            `You are an election intelligence analyst. Today is ${today}. The Goa Legislative Assembly elections are due in 2027. Focus ONLY on the ${place} constituency (South Goa, India).\n` +
            `Standing notes: Chirag Datta Naik (businessman, joined INC May 2025) is the probable Congress candidate for ${place} — list HIM as the Congress contender. NEVER list a generic "TBD"/placeholder candidate for any party.\n` +
            `Vijai Sardesai (Goa Forward Party) is the sitting MLA of Fatorda — he does NOT contest ${place} and is not a ${place} contender under any circumstances. NEVER list him as a candidate, and do NOT mention him or discuss any supposed ${place} prospects of his in the race summary either — even if some sources speculate about it, that speculation is incorrect; ignore it completely.\n` +
            `Use web search extensively (news sites AND social media — candidate pages, posts, follower activity, local discussion) to research, for ${place}:\n` +
            `1. Every plausible potential candidate for 2027: sitting MLA, past candidates, party aspirants, and independents. Include party affiliation (or Independent).\n` +
            `2. For each: a brief bio, what they are doing NOW (recent activity, last 90 days), and their likely campaign strategy — assess honestly whether they have real grassroots groundwork or are mostly social-media noise (e.g. baseless allegations with no organizational background).\n` +
            `3. Sentiment analysis per candidate from news tone and social media discussion: score -100 (very negative) to +100 (very positive), a label (Positive/Mixed/Negative), and a one-line summary of WHY. The label MUST match the score's sign (negative score => Negative, near zero => Mixed).\n` +
            `4. Where TWO OR MORE aspirants seek the same party's ticket, estimate each one's percentage likelihood (0-100) of actually getting the party ticket, based on their record, seniority, winnability and recent signals. If only one aspirant, set ticket_likelihood to null. ALSO list, for each candidate, their within-party ticket rivals as "party_contenders": an array of names of people plausibly seeking the SAME party's ticket.\n` +
            `5. Estimate each candidate's likely VOTE SHARE (percentage of total votes cast, 0-100). This is NOT their probability of winning — it is the slice of the vote you expect them to get. Keep the shares realistic: the sum across all candidates should be roughly 85-100 (the rest is undecided/minor candidates).\n` +
            `6. ${prevBlock}TREND MOVEMENTS — explain ONLY what changed in the last 24 hours. Compare today's estimates against the previous report. For EVERY candidate whose estimated vote share you changed by 2+ points in either direction, and for any genuinely new contender, add a "movements" entry: {"name": "<candidate name>", "reasons": ["<specific reason>", ...]}.\n` +
            `STRICT RECENCY RULE: each reason must describe a development from the LAST 48 HOURS — news published, a statement made, or an event occurring within the last 2 days. Begin every reason with its date (e.g. "Oct 2: ..."). NEVER cite stale history as a movement reason: not the 2022 defection, not 2024 Lok Sabha results, not a May 2025 party joining, not appointments from months ago, not events from weeks or months ago ("N days ago" = stale, do not use). That background belongs in bio/track_record, never in why-today-moved.\n` +
            `Change an estimate ONLY when today's research surfaced a genuinely new development. If nothing new happened for a candidate, keep their estimate unchanged and do NOT write a movement entry — a quiet news day with flat numbers is the correct result; never backfill justifications from old news. If a candidate's vote share is unchanged, they get no movement entry, period. If no candidate moved materially, return "movements": [].\n` +
            `For each movement entry, also add "insight": one line on what this development means for the ${place} race, and "recommendation": one practical line for the constituency office watching this race (what to watch, prepare, or respond to — neutral and informational). Keep each under 200 characters.\n` +
            `DATA-CONSISTENCY RULES (violations are the most common error — check every candidate against every rule):\n` +
            `- party_contenders may ONLY name people who belong to the SAME party. Never list a person under a party they are not a member of. Verify each contender's party from your search results before including them.\n` +
            `- An Independent candidate MUST have is_independent=true and party="Independent", and must have NO party_contenders.\n` +
            `- ticket_likelihood is only meaningful when party_contenders is non-empty; a lone aspirant gets null.\n` +
            `- Do not contradict yourself across fields: bio, current_activity, strategy and track_record must agree on the candidate's party, role and record.\n` +
            `Then reply with ONLY a JSON object (no other text):\n` +
            `{"race_summary":"2-3 sentences on the state of the ${place} race","movements":[{"name":"...","reasons":["Oct 2: specific development from the last 48 hours"],"insight":"what it means for the race","recommendation":"practical takeaway for the constituency office"}],"candidates":[{"name":"...","party":"...","is_independent":false,"party_contenders":["..."],"ticket_likelihood":null,"vote_share":32,"sentiment_score":20,"sentiment_label":"Mixed","sentiment_summary":"...","bio":"...","current_activity":"...","strategy":"...","track_record":"...","confidence":"high|medium|low","sources":[{"title":"...","url":"..."}]}]}\n` +
            `Rules: include ONLY people with real evidence of potential candidacy (news, party role, past contests, public announcements) — NEVER invent candidates. Every candidate needs 1-3 source URLs from the search results. confidence=low when evidence is thin. Keep each text field under 400 characters.`,
        }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `Anthropic HTTP ${r.status}`);
    const blocks = j.content || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    if (!obj || !Array.isArray(obj.candidates)) return null;
    const cleanSources = (srcs) => {
      const seen = new Set();
      return (Array.isArray(srcs) ? srcs : []).slice(0, 3)
        .map((s) => ({ title: String(s.title || s.url || '').slice(0, 120), url: String(s.url || '') }))
        .filter((s) => s.url && /^https?:\/\//.test(s.url) && !seen.has(s.url) && seen.add(s.url));
    };
    const clamp = (v, lo, hi) => (v === null || v === undefined || isNaN(+v) ? null : Math.max(lo, Math.min(hi, Math.round(+v))));
    return {
      race_summary: String(obj.race_summary || '').slice(0, 600),
      movements: (Array.isArray(obj.movements) ? obj.movements : []).slice(0, 15).map((m) => ({
        name: String(m.name || '').slice(0, 80),
        reasons: (Array.isArray(m.reasons) ? m.reasons : [])
          .map((r) => String(r || '').replace(/^[\s•\-–—*]+/, '').slice(0, 300)).filter(Boolean).slice(0, 4),
        insight: String(m.insight || '').replace(/^[\s•\-–—*]+/, '').slice(0, 300),
        recommendation: String(m.recommendation || '').replace(/^[\s•\-–—*]+/, '').slice(0, 300),
      })).filter((m) => m.name && (m.reasons.length || m.insight || m.recommendation)),
      candidates: obj.candidates.slice(0, 15).map((c) => ({
        name: String(c.name || 'Unknown').slice(0, 80),
        party: String(c.party || (c.is_independent ? 'Independent' : '')).slice(0, 60),
        is_independent: !!c.is_independent,
        party_contenders: (Array.isArray(c.party_contenders) ? c.party_contenders : [])
          .map((x) => String(x || '').slice(0, 80)).filter(Boolean).slice(0, 6),
        ticket_likelihood: clamp(c.ticket_likelihood, 0, 100),
        vote_share: clamp(c.vote_share, 0, 100),
        sentiment_score: clamp(c.sentiment_score, -100, 100),
        sentiment_label: ['Positive', 'Mixed', 'Negative'].includes(c.sentiment_label) ? c.sentiment_label : 'Mixed',
        sentiment_summary: String(c.sentiment_summary || '').slice(0, 400),
        bio: String(c.bio || '').slice(0, 400),
        current_activity: String(c.current_activity || '').slice(0, 400),
        strategy: String(c.strategy || '').slice(0, 400),
        track_record: String(c.track_record || '').slice(0, 400),
        confidence: ['high', 'medium', 'low'].includes(c.confidence) ? c.confidence : 'low',
        sources: cleanSources(c.sources),
      })).filter((c) => c.name !== 'Unknown'),
    };
  } catch (e) {
    console.error('researchElectionIntel failed:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// LLM-based data-quality eval for Election Intel. A second model pass audits
// the candidate records produced by researchElectionIntel (and any manual
// additions) for factual/consistency errors — wrong party attributions,
// contenders listed under a party they don't belong to, independent/party
// contradictions, impossible numbers, sentiment label/score mismatches, and
// contradictions across the text fields. Returns:
//   { issues: [{candidate, field, severity, problem}],
//     corrections: [{candidate, field, new_value, reason}],
//     score: 0-100 data-quality score }
// Only "high"-severity corrections with clear in-data evidence should be
// applied automatically; everything else is surfaced for review.
async function evaluateIntel(candidates) {
  if (PROVIDER !== 'anthropic' || !ANTHROPIC_KEY) return null;
  const list = (candidates || []).map((c) => ({
    name: c.name,
    party: c.party,
    is_independent: !!c.is_independent,
    party_contenders: c.party_contenders || [],
    ticket_likelihood: c.ticket_likelihood,
    vote_share_mean: c.vote_share_mean,
    win_probability: c.win_probability,
    sentiment_score: c.sentiment_score,
    sentiment_label: c.sentiment_label,
    bio: c.bio,
    current_activity: c.current_activity,
    strategy: c.strategy,
    track_record: c.track_record,
    confidence: c.confidence,
  }));
  if (!list.length) return null;
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
        max_tokens: 4000,
        temperature: 0.1,
        messages: [{
          role: 'user',
          content:
            `You are a data-quality auditor for an election-intelligence database (Goa 2027 assembly race, Margao constituency). ` +
            `Audit these candidate records for ERRORS. Use ONLY the data given — do not invent outside facts; flag what the data itself contradicts.\n` +
            `CANDIDATES:\n${JSON.stringify(list, null, 1)}\n` +
            `Check every record against these rules:\n` +
            `1. PARTY CONSISTENCY: party_contenders must contain ONLY people who belong to the SAME party as the candidate. A contender listed under a party they do not belong to is a HIGH-severity error. Independents must have is_independent=true, party="Independent", and empty party_contenders.\n` +
            `2. TICKET LOGIC: ticket_likelihood must be null when party_contenders is empty (lone aspirant). Values must be 0-100 otherwise.\n` +
            `3. NUMBER SANITY: vote_share_mean 0-100; sentiment_score -100..100; sentiment_label must match the score's sign (score < -15 => Negative, score > 15 => Positive, else Mixed).\n` +
            `4. CROSS-FIELD CONTRADICTIONS: bio, current_activity, strategy, track_record must agree on the candidate's party, role and record (e.g. text calling someone a BJP leader while party says Congress).\n` +
            `5. WIN VS VOTE SANITY: win_probability should be broadly consistent with vote_share_mean — a candidate with the highest vote share should normally have the highest win probability; flag gross inversions.\n` +
            `Reply with ONLY a JSON object:\n` +
            `{"issues":[{"candidate":"exact name","field":"field name","severity":"high|medium|low","problem":"one sentence"}],"corrections":[{"candidate":"exact name","field":"party|is_independent|ticket_likelihood|party_contenders|vote_share_mean|sentiment_label|sentiment_score","new_value":"corrected value (array for party_contenders, boolean for is_independent, number otherwise)","reason":"why this is clearly right from the data"}]}\n` +
            `Rules: propose a correction ONLY when the data itself makes the right value unambiguous (severity high). When uncertain, file it as an issue instead. "candidate" must exactly match a name above. Empty arrays are fine if no problems.`,
        }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `Anthropic HTTP ${r.status}`);
    const blocks = j.content || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    const sev = (s) => ['high', 'medium', 'low'].includes(s) ? s : 'low';
    const issues = (Array.isArray(obj.issues) ? obj.issues : []).slice(0, 30).map((i) => ({
      candidate: String(i.candidate || '').slice(0, 80),
      field: String(i.field || '').slice(0, 40),
      severity: sev(i.severity),
      problem: String(i.problem || '').slice(0, 300),
    })).filter((i) => i.candidate && i.problem);
    const corrections = (Array.isArray(obj.corrections) ? obj.corrections : []).slice(0, 20).map((x) => ({
      candidate: String(x.candidate || '').slice(0, 80),
      field: String(x.field || '').slice(0, 40),
      new_value: x.new_value,
      reason: String(x.reason || '').slice(0, 300),
    })).filter((x) => x.candidate && x.field && x.new_value !== undefined);
    const score = Math.max(0, Math.min(100,
      100 - 15 * issues.filter((i) => i.severity === 'high').length
          - 7 * issues.filter((i) => i.severity === 'medium').length
          - 2 * issues.filter((i) => i.severity === 'low').length));
    return { issues, corrections, score };
  } catch (e) {
    console.error('evaluateIntel failed:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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

// Public API of the AI layer. Every function returns null (or a safe default)
// when no API key is configured so the server degrades to template behavior.
module.exports = { isConfigured, provider: PROVIDER, classifyMessage, generateDraft, generateNameRequest, generateNameRetry, generateDetailsQuestion, generateStatusReply, extractName, extractDetails, isNewIssue, askAI, askAIWithTools, summarizeTopics, generateBrief, gatherWebInsights, researchElectionIntel, evaluateIntel };
