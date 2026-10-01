// lib/seed.js — generates realistic demo data for Sampark, set in Margao, Goa.
// Exports seedDemoData(db, { count }) which appends citizens + tickets + messages
// to an existing (migrated) database. Used by scripts/seed.js and /api/admin/seed.

const FIRST_M = ['Agnelo', 'Antonio', 'Caetano', 'Domnic', 'Francis', 'Joaquim', 'Joseph', 'Menino', 'Pascoal', 'Rosario', 'Sebastiao', 'Baptist', 'Arjun', 'Deepak', 'Mahesh', 'Nilesh', 'Prakash', 'Rajesh', 'Sandesh', 'Satish', 'Suresh', 'Uday', 'Vijay', 'Vishnu', 'Tulsidas', 'Dattaprasad'];
const FIRST_F = ['Maria', 'Fatima', 'Conceicao', 'Esperanca', 'Filomena', 'Graca', 'Lourdes', 'Milagrina', 'Perpetua', 'Rosaria', 'Succorina', 'Anita', 'Deepa', 'Lakshmi', 'Meena', 'Priya', 'Seema', 'Shanti', 'Sunita', 'Varsha', 'Divya', 'Rashmi'];
const LAST = ['Fernandes', 'D\u2019Souza', 'Pereira', 'Rodrigues', 'Dias', 'Vaz', 'Costa', 'Lobo', 'D\u2019Costa', 'D\u2019Mello', 'Barretto', 'Colaco', 'Mascarenhas', 'Sequeira', 'Tavares', 'Naik', 'Kamat', 'Dessai', 'Prabhu', 'Pai', 'Shenoy', 'Bhat', 'Kholkar', 'Faldessai', 'Sawant', 'Shirodkar', 'Velip', 'Gaonkar', 'Harmalkar', 'Kakodkar'];
const AREAS = ['Fatorda', 'Navelim', 'Aquem', 'Gogol', 'Comba', 'Davorlim', 'Benaulim', 'Colva', 'Varca', 'Cavelossim', 'Malbhat', 'Khareband', 'Madel', 'Ambaji', 'Dicarpale', 'Margao City', 'Monte Hill', 'Aquem-Baixo', 'Old Market', 'Rumdamol'];
const LANDMARKS = ['Rosary Church', 'Holy Spirit Church', 'KTC bus stand', 'Gogol housing board', 'Fatorda stadium road', 'Colva beach road', 'Navelim church', 'Davorlim industrial estate', 'Benaulim beach', 'Comba chapel', 'Madhuban complex', 'Malbhat chapel'];

const ISSUES = {
  water: [
    'No water supply in {area} for 3 days now, please help',
    'Water pipeline burst near {landmark}, {area}',
    'Dirty muddy water coming from taps in {area} since yesterday',
    'Low pressure water supply in {area}, top floors get nothing',
  ],
  road: [
    'Big potholes on the road near {landmark}, {area} — accidents happening',
    'Road digging work left incomplete in {area}, dust everywhere',
    'No footpath near {landmark}, {area}, school children walk on road',
  ],
  sanitation: [
    'Garbage not collected in {area} for a week, foul smell',
    'Overflowing dustbins near {landmark}, {area}',
    'Sonsoddo garbage dump smoke reaching {area} houses',
  ],
  streetlight: [
    'Streetlights not working on {landmark} road, {area}',
    'Dark stretch near {area}, safety concern for women at night',
  ],
  drainage: [
    'Blocked drain near {landmark}, {area}, mosquitoes everywhere',
    'Sewage overflowing on the lane in {area}',
    'Monsoon flooding in {area} every year, drains need desilting',
  ],
  pension: [
    'My widow pension stopped 4 months ago, please help restart',
    'Old age pension application pending for 8 months',
    'DSS pension not received, {area} office not responding',
  ],
  ration: [
    'Ration card name correction pending at {area} office',
    'New ration card application for my family, need guidance',
    'Ration shop in {area} gives less grain than quota',
  ],
  education: [
    'School admission help needed for my daughter in {area}',
    'Scholarship form rejected, need help reapplying',
    'No school bus facility for {area} children',
  ],
  other: [
    'Need help with caste certificate from {area} mamlatdar office',
    'Request for meeting with MLA sir regarding {area} gymkhana',
    'Stray dog menace near {landmark}, {area}',
    'Noise from bars near {landmark} till late night',
  ],
};
const EVENTS = [
  'You are cordially invited to my daughter\u2019s birthday on {date} at {venue}, {area}',
  'Wedding invitation \u2014 my son\u2019s wedding on {date} at {venue}, {area}. Please grace the occasion',
  'Feast mass at {venue} on {date}, request your presence for the celebration',
  'Shop inauguration on {date} at {area}, please come and bless us',
  'We are celebrating our 25th wedding anniversary on {date} at {venue}, {area}. Do join us',
];
const VENUES = ['Rosary Hall, Fatorda', 'Holy Spirit Church Hall', 'Gogol Community Hall', 'Benaulim Panchayat Hall', 'Navelim Church Hall', 'Our Lady of Merces Chapel Hall', 'Fatorda Stadium Annexe'];
const OFFICE_REPLIES = {
  water: 'your water supply complaint has been registered and shared with the PWD water division. We will update you on the tanker/pipeline schedule shortly.',
  road: 'your road complaint has been noted and sent to the PWD liaison for inspection. We will share the repair timeline soon.',
  sanitation: 'your garbage complaint has been noted and sent to the Margao Municipal Council conservancy team.',
  streetlight: 'your streetlight complaint has been forwarded to the municipal electrical department.',
  drainage: 'your drainage complaint has been forwarded for desilting/cleaning. We will confirm once it is done.',
  pension: 'your pension matter has been taken up. Our office will check the status with the social welfare department.',
  ration: 'your ration card request has been received. Our office will guide you on the application.',
  education: 'your school request has been received. Our office will guide you on the process.',
  other: 'your message has been registered and our office will respond shortly.',
  event: 'thank you for the invitation! Our office has noted it and we will confirm attendance shortly.',
};
const FOLLOWUPS = [
  'Any update on this? It has been a few days.',
  'What is the status of my complaint?',
  'Please look into this urgently, the problem is getting worse.',
  'Thank you for taking this up.',
];
const CLOSURES = [
  'This has been resolved now. Thank you for your help! 🙏',
  'Work completed in our area. Grateful for the quick action.',
];

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const DAY = 864e5;

function fill(tpl, area) {
  return tpl.replace('{area}', area).replace('{landmark}', pick(LANDMARKS));
}

function seedDemoData(db, { count = 1000 } = {}) {
  const repName = process.env.REP_NAME || 'Arjun Deshpande';
  const sign = `— Team ${repName}`;
  const now = Date.now();
  const usedPhones = new Set(db.prepare('SELECT wa_id FROM citizens').all().map((r) => r.wa_id));
  const newPhone = () => {
    let p;
    do { p = '91' + String(6000000000 + rnd(3999999999)); } while (usedPhones.has(p));
    usedPhones.add(p);
    return p;
  };

  const insCitizen = db.prepare(
    "INSERT INTO citizens (wa_id, name, phone, address, onboarding_step, source, created_at, updated_at) VALUES (?,?,?,?,?, 'dummy', ?,?)");
  const insTicket = db.prepare(
    `INSERT INTO tickets (id, wa_id, citizen_name, category, priority, sensitive, kind, issue_address, event_datetime, venue, status, awaiting_name, pending_draft, draft_source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insMsg = db.prepare(
    'INSERT INTO messages (ticket_id, direction, body, wa_message_id, auto, created_at) VALUES (?,?,?,?,?,?)');
  const nextId = (() => {
    let n = parseInt((db.prepare("SELECT v FROM meta WHERE k='next_seq'").get() || { v: '1' }).v, 10);
    return () => 'SKT-' + String(n++).padStart(4, '0');
  })();

  let citizens = 0, tickets = 0, messages = 0;
  db.exec('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      const isEvent = Math.random() < 0.15;
      const category = isEvent ? 'other' : pick(Object.keys(ISSUES));
      const area = pick(AREAS);
      const waId = newPhone();
      const name = `${pick(Math.random() < 0.5 ? FIRST_M : FIRST_F)} ${pick(LAST)}`;
      const created = now - Math.floor(Math.pow(Math.random(), 1.4) * 120 * DAY);
      const address = Math.random() < 0.45 ? `H.No. ${1 + rnd(900)}, Near ${pick(LANDMARKS)}, ${area}, Margao, Goa 403601` : null;
      insCitizen.run(waId, name, waId, address, 'done', created, created);
      citizens++;

      const r = Math.random();
      const status = r < 0.62 ? 'resolved' : r < 0.80 ? 'in_progress' : r < 0.94 ? 'new' : 'awaiting_citizen';
      const id = nextId();
      let body, issueAddress = null, eventDatetime = null, venue = null;
      if (isEvent) {
        const d = new Date(now + (2 + rnd(40)) * DAY);
        const dateStr = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        venue = pick(VENUES);
        body = fill(pick(EVENTS), area).replace('{date}', dateStr).replace('{venue}', venue);
        eventDatetime = `${dateStr}, ${pick(['10 AM', '11 AM', '4 PM', '6 PM', '7 PM'])}`;
      } else {
        body = fill(pick(ISSUES[category]), area);
        issueAddress = Math.random() < 0.7 ? `${area}, near ${pick(LANDMARKS)}` : area;
      }
      const priority = /accident|burst|overflow|flooding/i.test(body) ? 'High' : 'Medium';
      const sensitive = Math.random() < 0.03 ? 1 : 0;
      const updated = status === 'resolved' ? created + rnd(10) * DAY : now - rnd(7) * DAY;
      insTicket.run(id, waId, name, category, priority, sensitive, isEvent ? 'event' : 'issue',
        issueAddress, eventDatetime, venue, status, 0, null, null, created, Math.min(updated, now));
      tickets++;

      // Thread: citizen opener + office reply; follow-ups for in_progress; closure for resolved.
      let t = created + rnd(3600e3);
      insMsg.run(id, 'in', body, `seed-${id}-1`, 0, Math.min(t, now)); messages++;
      const first = name.split(' ')[0];
      t += (1 + rnd(20)) * 3600e3;
      const reply = `Namaste ${first} ji, ${OFFICE_REPLIES[isEvent ? 'event' : category]} ${sign}`;
      insMsg.run(id, 'out', reply, `seed-${id}-2`, 0, Math.min(t, now)); messages++;
      if (status === 'in_progress' && Math.random() < 0.7) {
        t += (1 + rnd(48)) * 3600e3;
        insMsg.run(id, 'in', pick(FOLLOWUPS), `seed-${id}-3`, 0, Math.min(t, now)); messages++;
        t += (1 + rnd(20)) * 3600e3;
        insMsg.run(id, 'out', `Namaste ${first} ji, we are following up with the concerned department on this and will update you shortly. ${sign}`, `seed-${id}-4`, 0, Math.min(t, now)); messages++;
      }
      if (status === 'resolved') {
        t += (2 + rnd(72)) * 3600e3;
        insMsg.run(id, 'out', `Namaste ${first} ji, our office confirms this matter has been resolved. Please reach out anytime. ${sign}`, `seed-${id}-9`, 0, Math.min(t, now)); messages++;
        if (Math.random() < 0.4) {
          t += (1 + rnd(24)) * 3600e3;
          insMsg.run(id, 'in', pick(CLOSURES), `seed-${id}-10`, 0, Math.min(t, now)); messages++;
        }
      }
      if (sensitive) {
        db.prepare('UPDATE tickets SET pending_draft=?, draft_source=? WHERE id=?')
          .run(`Namaste ${first} ji, we have received your message and our office is looking into it carefully. ${sign}`, 'template', id);
      }
    }
    const maxN = db.prepare("SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) m FROM tickets").get().m || 0;
    db.prepare("UPDATE meta SET v=? WHERE k='next_seq'").run(String(maxN + 1));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { citizens, tickets, messages };
}

module.exports = { seedDemoData };
