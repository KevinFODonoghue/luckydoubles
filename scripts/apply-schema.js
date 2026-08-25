// Applies scripts/schema.sql to the database in DATABASE_URL.
// Idempotent — safe to run more than once. Run with: npm run schema

const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema applied.');
  await pool.end();
}

main().catch((e) => {
  console.error('Schema apply failed:', e.message);
  process.exit(1);
});
