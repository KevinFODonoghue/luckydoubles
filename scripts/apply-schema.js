// Applies the schema (src/schema.js) to the database in DATABASE_URL.
// The app also does this automatically on boot — this script exists for
// applying it explicitly, e.g. before a first deploy. Idempotent.
// Run with: npm run schema

const { pool } = require('../src/db');
const { SCHEMA_SQL } = require('../src/schema');

async function main() {
  await pool.query(SCHEMA_SQL);
  console.log('Schema applied.');
  await pool.end();
}

main().catch((e) => {
  console.error('Schema apply failed:', e.message);
  process.exit(1);
});
