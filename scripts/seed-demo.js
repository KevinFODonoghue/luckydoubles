// Fills the league with demo bowlers, a completed week (with results),
// and an open current week. Run with: npm run seed
// Every demo account's password is: demo123
//
// This WIPES all league data first. If DATABASE_URL points at a non-local
// database, it refuses to run unless FORCE_SEED=1 is set.

const bcrypt = require('bcryptjs');
const { pool, q, one, run } = require('../src/db');
const util = require('../src/util');
const { generatePairings } = require('../src/pairing');
const { ensureCurrentWeek } = require('../src/weekview');

function randInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function guardRemote(action) {
  const url = process.env.DATABASE_URL || '';
  if (!/localhost|127\.0\.0\.1/.test(url) && process.env.FORCE_SEED !== '1') {
    console.error(`Refusing to ${action} a remote database (${url.replace(/:[^:@/]+@/, ':***@')}).`);
    console.error('If you really mean it, run again with FORCE_SEED=1 set.');
    process.exit(1);
  }
}

async function main() {
  guardRemote('wipe and seed');

  await run('TRUNCATE scores, teams, signups, password_requests, password_resets, weeks, users RESTART IDENTITY CASCADE');

  const hash = bcrypt.hashSync('demo123', 10);
  const roster = [
    ['League Admin', 'admin@league.test', 152, 1],
    ['Alice Nguyen', 'alice@league.test', 192, 0],
    ['Marcus Webb', 'marcus@league.test', 178, 0],
    ['Priya Shah', 'priya@league.test', 171, 0],
    ['Dave Kowalski', 'dave@league.test', 164, 0],
    ['Jen Park', 'jen@league.test', 158, 0],
    ['Tom Reilly', 'tom@league.test', 139, 0],
    ['Rosa Martinez', 'rosa@league.test', 127, 0],
    ['Chris Boone', 'chris@league.test', 115, 0],
    ['Nina Alvarez', 'nina@league.test', 102, 0],
  ];

  const userIds = {};
  for (let i = 0; i < roster.length; i++) {
    const r = roster[i];
    const row = await one(
      'INSERT INTO users (name, email, password_hash, average, is_admin, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [r[0], r[1], hash, r[2], r[3], Date.now() - 30 * 86400000 + i * 3600000]
    );
    userIds[r[0]] = row.id;
  }

  // ---- Last week: completed, 8 bowlers, full scores ----
  const currentDate = util.upcomingFridayYMD();
  const lastDate = util.addDaysYMD(currentDate, -7);
  const lastDeadline = util.defaultDeadline(lastDate);
  const lastWeek = await one(
    'INSERT INTO weeks (date, deadline, created_at) VALUES ($1, $2, $3) RETURNING id',
    [lastDate, lastDeadline, lastDeadline - 6 * 86400000]
  );

  const lastWeekBowlers = ['Alice Nguyen', 'Marcus Webb', 'Priya Shah', 'Dave Kowalski', 'Jen Park', 'Tom Reilly', 'Rosa Martinez', 'Chris Boone'];
  for (let i = 0; i < lastWeekBowlers.length; i++) {
    await run('INSERT INTO signups (week_id, user_id, created_at, paid) VALUES ($1, $2, $3, $4)',
      [lastWeek.id, userIds[lastWeekBowlers[i]], lastDeadline - 5 * 86400000 + i * 7200000, 1]);
  }

  await generatePairings(lastWeek.id);

  for (const name of lastWeekBowlers) {
    const avg = roster.find((r) => r[0] === name)[2];
    const games = [0, 1, 2].map(() => clamp(avg + randInt(-30, 40), 85, 290));
    await run('INSERT INTO scores (week_id, user_id, game1, game2, game3) VALUES ($1, $2, $3, $4, $5)',
      [lastWeek.id, userIds[name], games[0], games[1], games[2]]);
  }
  await run("UPDATE weeks SET status = 'completed', completed_at = $1 WHERE id = $2",
    [lastDeadline + 4 * 3600000, lastWeek.id]);

  // ---- Current week: open, 9 signups (odd — shows the waitlist rule) ----
  const current = await ensureCurrentWeek();
  const currentBowlers = ['Alice Nguyen', 'Marcus Webb', 'Priya Shah', 'Jen Park', 'Dave Kowalski', 'Tom Reilly', 'Rosa Martinez', 'Chris Boone', 'Nina Alvarez'];
  for (let i = 0; i < currentBowlers.length; i++) {
    await run('INSERT INTO signups (week_id, user_id, created_at, paid) VALUES ($1, $2, $3, $4)',
      [current.id, userIds[currentBowlers[i]], Date.now() - 20 * 3600000 + i * 3600000, i < 5 ? 1 : 0]);
  }

  console.log('Demo league seeded.');
  console.log(`  Completed week: ${lastDate} (results + winners)`);
  console.log(`  Current week:   ${current.date} (9 signed up — odd, so the waitlist rule is visible)`);
  console.log('');
  console.log('  Sign in with any account below — password for all: demo123');
  console.log('    admin@league.test   (League Admin — admin access)');
  for (const r of roster.slice(1)) {
    console.log(`    ${r[1].padEnd(20)}(${r[0]}, avg ${r[2]})`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error('Seed failed:', e.message);
  process.exit(1);
});
