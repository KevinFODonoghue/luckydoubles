// Fills the league with demo bowlers, a completed week (with results),
// and an open current week. Run with: npm run seed
// Every demo account's password is: demo123

const bcrypt = require('bcryptjs');
const { db } = require('../src/db');
const util = require('../src/util');
const { generatePairings } = require('../src/pairing');
const { ensureCurrentWeek } = require('../src/weekview');

function randInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Wipe everything (order matters for foreign keys).
for (const t of ['scores', 'teams', 'signups', 'weeks', 'users']) {
  db.exec(`DELETE FROM ${t}`);
}
try { db.exec("DELETE FROM sqlite_sequence"); } catch {}

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
const insUser = db.prepare(
  'INSERT INTO users (name, email, password_hash, average, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
roster.forEach((r, i) => {
  const res = insUser.run(r[0], r[1], hash, r[2], r[3], Date.now() - 30 * 86400000 + i * 3600000);
  userIds[r[0]] = Number(res.lastInsertRowid);
});

const insSignup = db.prepare('INSERT INTO signups (week_id, user_id, created_at, paid) VALUES (?, ?, ?, ?)');
const insScore = db.prepare('INSERT INTO scores (week_id, user_id, game1, game2, game3) VALUES (?, ?, ?, ?, ?)');

// ---- Last week: completed, 8 bowlers, full scores ----
const currentDate = util.upcomingFridayYMD();
const lastDate = util.addDaysYMD(currentDate, -7);
const lastDeadline = util.defaultDeadline(lastDate);
const lastRes = db.prepare('INSERT INTO weeks (date, deadline, created_at) VALUES (?, ?, ?)')
  .run(lastDate, lastDeadline, lastDeadline - 6 * 86400000);
const lastWeekId = Number(lastRes.lastInsertRowid);

const lastWeekBowlers = ['Alice Nguyen', 'Marcus Webb', 'Priya Shah', 'Dave Kowalski', 'Jen Park', 'Tom Reilly', 'Rosa Martinez', 'Chris Boone'];
lastWeekBowlers.forEach((name, i) => {
  insSignup.run(lastWeekId, userIds[name], lastDeadline - 5 * 86400000 + i * 7200000, 1);
});

generatePairings(lastWeekId);

for (const name of lastWeekBowlers) {
  const avg = roster.find((r) => r[0] === name)[2];
  const games = [0, 1, 2].map(() => clamp(avg + randInt(-30, 40), 85, 290));
  insScore.run(lastWeekId, userIds[name], games[0], games[1], games[2]);
}
db.prepare("UPDATE weeks SET status = 'completed', completed_at = ? WHERE id = ?")
  .run(lastDeadline + 4 * 3600000, lastWeekId);

// ---- Current week: open, 9 signups (odd — shows the waitlist rule) ----
const current = ensureCurrentWeek();
const currentBowlers = ['Alice Nguyen', 'Marcus Webb', 'Priya Shah', 'Jen Park', 'Dave Kowalski', 'Tom Reilly', 'Rosa Martinez', 'Chris Boone', 'Nina Alvarez'];
currentBowlers.forEach((name, i) => {
  insSignup.run(current.id, userIds[name], Date.now() - 20 * 3600000 + i * 3600000, i < 5 ? 1 : 0);
});

console.log('Demo league seeded.');
console.log(`  Completed week: ${lastDate} (results + winners)`);
console.log(`  Current week:   ${current.date} (9 signed up — odd, so the waitlist rule is visible)`);
console.log('');
console.log('  Sign in with any account below — password for all: demo123');
console.log('    admin@league.test   (League Admin — admin access)');
for (const r of roster.slice(1)) {
  console.log(`    ${r[1].padEnd(20)}(${r[0]}, avg ${r[2]})`);
}
