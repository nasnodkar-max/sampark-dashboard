// Usage: DB_PATH=./data/sampark.db node scripts/seed.js [--count=1000] [--force]
// Appends Margao (Goa) demo citizens + tickets + messages to the database.
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sampark.db');

const { db } = require('../server.js');
const { seedDemoData } = require('../lib/seed');

const countArg = process.argv.find((a) => a.startsWith('--count='));
const count = countArg ? parseInt(countArg.split('=')[1], 10) : 1000;
const force = process.argv.includes('--force');

const existing = db.prepare('SELECT COUNT(*) c FROM citizens').get().c;
if (existing > 20 && !force) {
  console.error(`DB already has ${existing} citizens. Pass --force to seed anyway.`);
  process.exit(1);
}
const out = seedDemoData(db, { count });
console.log('Seeded demo data:', out);
process.exit(0);
