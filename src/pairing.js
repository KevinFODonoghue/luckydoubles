const { db } = require('./db');

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function signupsInOrder(weekId) {
  return db.prepare(`
    SELECT s.id AS signup_id, s.user_id, s.created_at, u.name, u.average
    FROM signups s JOIN users u ON u.id = s.user_id
    WHERE s.week_id = ?
    ORDER BY s.created_at ASC, s.id ASC
  `).all(weekId);
}

// Lucky-draw doubles pairing:
//  - If the count is odd, the LAST bowler to sign up goes to the waitlist.
//  - Remaining bowlers are sorted by average and split into a high half and a low half.
//  - The high half is randomly matched against the low half, so every team is
//    one higher-average bowler + one lower-average bowler, but WHO you draw is random.
function generatePairings(weekId) {
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week) throw new Error('Week not found.');
  if (week.status === 'completed') throw new Error('This week is already finalized.');

  const rows = signupsInOrder(weekId);
  if (rows.length < 2) throw new Error('Need at least 2 bowlers signed up to make pairs.');

  const missing = rows.filter((r) => r.average === null || r.average === undefined);
  if (missing.length) {
    throw new Error(`No average on file for: ${missing.map((m) => m.name).join(', ')}. Set it before pairing.`);
  }

  let waitlisted = null;
  const active = rows.slice();
  if (active.length % 2 === 1) waitlisted = active.pop();

  const sorted = active.slice().sort((a, b) => (b.average - a.average) || (a.created_at - b.created_at));
  const half = sorted.length / 2;
  const top = sorted.slice(0, half);
  const bottom = shuffle(sorted.slice(half));
  const teams = shuffle(top.map((t, i) => ({ high: t, low: bottom[i] })));

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM teams WHERE week_id = ?').run(weekId);
    db.prepare('UPDATE signups SET waitlisted = 0, avg_snapshot = NULL WHERE week_id = ?').run(weekId);

    const snap = db.prepare('UPDATE signups SET avg_snapshot = ? WHERE id = ?');
    for (const r of active) snap.run(r.average, r.signup_id);
    if (waitlisted) db.prepare('UPDATE signups SET waitlisted = 1 WHERE id = ?').run(waitlisted.signup_id);

    const ins = db.prepare('INSERT INTO teams (week_id, team_number, bowler1_id, bowler2_id) VALUES (?, ?, ?, ?)');
    teams.forEach((t, i) => ins.run(weekId, i + 1, t.high.user_id, t.low.user_id));

    db.prepare("UPDATE weeks SET status = 'paired', paired_at = ? WHERE id = ?").run(Date.now(), weekId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { teamCount: teams.length, waitlisted: waitlisted ? waitlisted.name : null };
}

module.exports = { generatePairings };
