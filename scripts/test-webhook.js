// Simulates Meta's webhook calls against a locally running server.
// Usage: node scripts/test-webhook.js
const BASE = process.env.BASE || 'http://localhost:3000';
const VERIFY = process.env.WEBHOOK_VERIFY_TOKEN || 'change-me-to-a-random-string';

async function main() {
  // 1. Webhook verification (what Meta sends when you click "Verify and save")
  const v = await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=test-challenge-123`);
  const vt = await v.text();
  console.log('verify ->', v.status, JSON.stringify(vt), vt === 'test-challenge-123' ? 'OK' : 'FAIL');

  // 2. Incoming text message (shape taken from Meta's docs)
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '12345',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550001111', phone_number_id: '999' },
          contacts: [{ profile: { name: 'Priya Nair' }, wa_id: '919876543210' }],
          messages: [{
            from: '919876543210', id: 'wamid.test1', timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text', text: { body: 'Streetlight near Old Market bus stop has not worked for a week' },
          }],
        },
      }],
    }],
  };
  const r = await fetch(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  console.log('incoming ->', r.status, r.status === 200 ? 'OK' : 'FAIL');

  // 3. Ticket created?
  const tickets = await (await fetch(`${BASE}/api/tickets`)).json();
  const t = tickets[0];
  console.log('tickets ->', tickets.length, t ? `${t.id} ${t.citizen_name} [${t.category}/${t.priority}/${t.status}]` : '');
  console.log('draft ->', t && t.pending_draft ? 'generated OK' : 'MISSING');
  if (t) console.log('draft text:', t.pending_draft);

  // 4. Dashboard APIs
  console.log('stats ->', JSON.stringify(await (await fetch(`${BASE}/api/stats`)).json()));
  console.log('brief ->', JSON.stringify(await (await fetch(`${BASE}/api/brief`)).json()));
  console.log('health ->', JSON.stringify(await (await fetch(`${BASE}/api/health`)).json()));
}
main().catch((e) => { console.error(e); process.exit(1); });
