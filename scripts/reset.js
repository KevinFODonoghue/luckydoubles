// Wipes all league data for a fresh start. Run with: npm run reset
// After a reset, the FIRST account to register becomes the league admin.
//
// If DATABASE_URL points at a non-local database, it refuses to run unless
// FORCE_SEED=1 is set (same guard as the seed script).

const { pool, run } = require('../src/db');

async function main() {
  const url = process.env.DATABASE_URL || '';
  if (!/localhost|127\.0\.0\.1/.test(url) && process.env.FORCE_SEED !== '1') {
    console.error(`Refusing to wipe a remote database (${url.replace(/:[^:@/]+@/, ':***@')}).`);
    console.error('If you really mean it, run again with FORCE_SEED=1 set.');
    process.exit(1);
  }

  await run('TRUNCATE scores, teams, signups, password_requests, password_resets, weeks, users RESTART IDENTITY CASCADE');
  console.log('League data wiped — fresh start.');
  console.log('The first account to register becomes the league admin.');
  await pool.end();
}

main().catch((e) => {
  console.error('Reset failed:', e.message);
  process.exit(1);
});
