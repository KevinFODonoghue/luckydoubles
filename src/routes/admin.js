const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { q, one, run, tx, isUniqueViolation } = require('../db');
const util = require('../util');
const wv = require('../weekview');
const { generatePairings } = require('../pairing');

const router = express.Router();

router.use((req, res, next) => {
  if (!req.user || !req.user.is_admin) {
    return util.go(res, '/', { err: 'Admin access required.' });
  }
  next();
});

async function loadWeek(req, res) {
  const week = await wv.getWeek(util.toInt(req.params.id));
  if (!week) {
    util.go(res, '/', { err: 'That week no longer exists.' });
    return null;
  }
  return week;
}

// ---- Week lifecycle ----

router.post('/week/:id/pair', async (req, res) => {
  const week = await loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  try {
    const result = await generatePairings(week.id);
    const wl = result.waitlisted ? ` ${result.waitlisted} is on the waitlist (last to sign up).` : '';
    util.go(res, back, { msg: `Pairings set — ${result.teamCount} teams.${wl}` });
  } catch (e) {
    util.go(res, back, { err: e.message });
  }
});

router.post('/week/:id/reopen', async (req, res) => {
  const week = await loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status !== 'paired') return util.go(res, back, { err: 'Only a paired week can be reopened.' });
  await tx(async (c) => {
    await c.query('DELETE FROM teams WHERE week_id = $1', [week.id]);
    await c.query('UPDATE signups SET waitlisted = 0, avg_snapshot = NULL WHERE week_id = $1', [week.id]);
    await c.query("UPDATE weeks SET status = 'open', paired_at = NULL WHERE id = $1", [week.id]);
  });
  const note = Date.now() >= week.deadline ? ' The deadline has already passed — update it so bowlers can sign up.' : '';
  util.go(res, back, { msg: 'Signups reopened. Pairings cleared.' + note });
});

router.post('/week/:id/finalize', async (req, res) => {
  const week = await loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status !== 'paired') return util.go(res, back, { err: 'Generate pairings before finalizing.' });
  await run("UPDATE weeks SET status = 'completed', completed_at = $1 WHERE id = $2", [Date.now(), week.id]);
  util.go(res, back, { msg: '🏆 Week finalized — results are official!' });
});

router.post('/week/:id/unfinalize', async (req, res) => {
  const week = await loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status !== 'completed') return util.go(res, back, { err: 'This week is not finalized.' });
  await run("UPDATE weeks SET status = 'paired', completed_at = NULL WHERE id = $1", [week.id]);
  util.go(res, back, { msg: 'Week unlocked — scores can be edited again.' });
});

router.post('/week/:id/deadline', async (req, res) => {
  const week = await loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status === 'completed') return util.go(res, back, { err: 'This week is finalized.' });
  const ms = util.parseLocalInputValue(req.body.deadline);
  if (!ms) return util.go(res, back, { err: 'Enter a valid date and time.' });
  await run('UPDATE weeks SET deadline = $1 WHERE id = $2', [ms, week.id]);
  util.go(res, back, { msg: `Signup deadline updated to ${util.fmtDT(ms)}.` });
});

// ---- Roster management ----

router.post('/week/:id/signups/add', async (req, res) => {
  const week = await loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status === 'completed') return util.go(res, back, { err: 'This week is finalized.' });
  const target = await one('SELECT * FROM users WHERE id = $1', [util.toInt(req.body.user_id)]);
  if (!target) return util.go(res, back, { err: 'Pick a bowler to add.' });
  if (target.average === null || target.average === undefined) {
    return util.go(res, back, { err: `${target.name} has no average yet — set one in Admin → Bowlers first.` });
  }
  try {
    await run('INSERT INTO signups (week_id, user_id, created_at) VALUES ($1, $2, $3)',
      [week.id, target.id, Date.now()]);
  } catch (e) {
    if (isUniqueViolation(e)) return util.go(res, back, { err: `${target.name} is already signed up.` });
    throw e;
  }
  const note = week.status === 'paired' ? ' Regenerate pairings to slot them in.' : '';
  util.go(res, back, { msg: `${target.name} added.${note}` });
});

router.post('/signups/:sid/remove', async (req, res) => {
  const signup = await one('SELECT * FROM signups WHERE id = $1', [util.toInt(req.params.sid)]);
  if (!signup) return util.go(res, '/', { err: 'That signup no longer exists.' });
  const week = await wv.getWeek(signup.week_id);
  const back = '/week/' + week.id;
  if (week.status === 'completed') return util.go(res, back, { err: 'This week is finalized.' });
  await run('DELETE FROM signups WHERE id = $1', [signup.id]);
  const note = week.status === 'paired' ? ' Regenerate pairings to rebuild teams.' : '';
  util.go(res, back, { msg: `Removed from this week.${note}` });
});

// The check-in list posts the box's state explicitly (a hidden 0 paired with
// the checkbox's 1), so ticking twice can't land back where it started.
router.post('/signups/:sid/paid', async (req, res) => {
  const signup = await one('SELECT * FROM signups WHERE id = $1', [util.toInt(req.params.sid)]);
  if (!signup) return util.go(res, '/', { err: 'That signup no longer exists.' });
  const wanted = util.lastValue(req.body.paid);
  const paid = wanted === undefined ? (signup.paid ? 0 : 1) : (String(wanted) === '1' ? 1 : 0);
  await run('UPDATE signups SET paid = $1 WHERE id = $2', [paid, signup.id]);
  res.redirect('/week/' + signup.week_id + '#checkin');
});

// Enter every bowler's three games in one pass — how the admin closes out the
// night when people have already left or are handing over scraps of paper.
router.post('/week/:id/scores-all', async (req, res) => {
  const week = await loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status === 'open') return util.go(res, back, { err: 'Generate pairings before entering scores.' });

  const teams = await q('SELECT bowler1_id, bowler2_id FROM teams WHERE week_id = $1 ORDER BY team_number ASC', [week.id]);
  const bowlerIds = teams.flatMap((t) => [t.bowler1_id, t.bowler2_id]);
  if (!bowlerIds.length) return util.go(res, back, { err: 'No teams to score yet.' });

  const entries = [];
  for (const userId of bowlerIds) {
    const games = [1, 2, 3].map((n) => util.toInt(req.body[`g${n}_${userId}`]));
    if (!games.every(util.validGame)) {
      return util.go(res, back, { err: 'Each game must be a whole number between 0 and 300.' });
    }
    entries.push({ userId, games });
  }

  await tx(async (c) => {
    for (const { userId, games } of entries) {
      await c.query(`
        INSERT INTO scores (week_id, user_id, game1, game2, game3) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (week_id, user_id) DO UPDATE SET
          game1 = EXCLUDED.game1, game2 = EXCLUDED.game2, game3 = EXCLUDED.game3
      `, [week.id, userId, games[0], games[1], games[2]]);
    }
  });

  util.go(res, back, { msg: `Scores saved for all ${bowlerIds.length} bowlers.`, hash: '#scores' });
});

// ---- Admin panel ----

router.get('/admin', async (req, res) => {
  const users = await q(`
    SELECT u.*, (SELECT COUNT(*) FROM signups s WHERE s.user_id = u.id) AS signup_count
    FROM users u ORDER BY u.name ASC
  `);
  const weekRows = await q('SELECT * FROM weeks ORDER BY date DESC');
  const weeks = await Promise.all(weekRows.map(async (w) => ({
    ...w,
    bowlerCount: (await one('SELECT COUNT(*) AS n FROM signups WHERE week_id = $1', [w.id])).n,
  })));
  res.render('admin', { title: 'Admin', active: 'admin', users, weeks, lockouts: await openLockouts() });
});

router.post('/admin/weeks', async (req, res) => {
  const dateStr = String(req.body.date || '').trim();
  if (!util.parseYMD(dateStr)) return util.go(res, '/admin', { err: 'Pick a date for the new week.' });
  const deadline = util.parseLocalInputValue(req.body.deadline) || util.defaultDeadline(dateStr);
  try {
    await run('INSERT INTO weeks (date, deadline, created_at) VALUES ($1, $2, $3)',
      [dateStr, deadline, Date.now()]);
  } catch (e) {
    if (isUniqueViolation(e)) return util.go(res, '/admin', { err: 'A week already exists on that date.' });
    throw e;
  }
  util.go(res, '/admin', { msg: `Week created for ${util.fmtWeekDate(dateStr)}.` });
});

router.post('/admin/weeks/:id/delete', async (req, res) => {
  const week = await wv.getWeek(util.toInt(req.params.id));
  if (!week) return util.go(res, '/admin', { err: 'That week no longer exists.' });
  await run('DELETE FROM weeks WHERE id = $1', [week.id]);
  util.go(res, '/admin', { msg: `Deleted the week of ${util.fmtShortDate(week.date)} and all its signups and scores.` });
});

router.post('/admin/users/:id/average', async (req, res) => {
  const target = await one('SELECT * FROM users WHERE id = $1', [util.toInt(req.params.id)]);
  if (!target) return util.go(res, '/admin', { err: 'Bowler not found.' });
  const average = util.toInt(req.body.average);
  if (!util.validAverage(average)) return util.go(res, '/admin', { err: 'Average must be a whole number between 0 and 300.' });
  await run('UPDATE users SET average = $1 WHERE id = $2', [average, target.id]);
  util.go(res, '/admin', { msg: `Average updated for ${target.name}.` });
});

router.post('/admin/users/:id/toggle-admin', async (req, res) => {
  const target = await one('SELECT * FROM users WHERE id = $1', [util.toInt(req.params.id)]);
  if (!target) return util.go(res, '/admin', { err: 'Bowler not found.' });
  if (target.is_admin) {
    const admins = (await one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')).n;
    if (admins <= 1) return util.go(res, '/admin', { err: 'Cannot remove the last admin.' });
  }
  await run('UPDATE users SET is_admin = $1 WHERE id = $2', [target.is_admin ? 0 : 1, target.id]);
  util.go(res, '/admin', { msg: `${target.name} is ${target.is_admin ? 'no longer' : 'now'} an admin.` });
});

// ---- Locked-out bowlers ----

async function openLockouts() {
  return q(`
    SELECT r.id, r.created_at, u.id AS user_id, u.name, u.email
    FROM password_requests r JOIN users u ON u.id = r.user_id
    WHERE r.handled_at IS NULL
    ORDER BY r.created_at ASC
  `);
}

// Give the bowler a fresh temporary password to sign in with, and close out any
// help request they raised. They change it themselves under Profile afterwards.
async function resetPasswordFor(target, adminId) {
  const temp = crypto.randomBytes(4).toString('hex');
  await run('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(temp, 10), target.id]);
  await run(
    'UPDATE password_requests SET handled_at = $1, handled_by = $2 WHERE user_id = $3 AND handled_at IS NULL',
    [Date.now(), adminId, target.id]
  );
  return temp;
}

router.post('/admin/users/:id/reset-password', async (req, res) => {
  const target = await one('SELECT * FROM users WHERE id = $1', [util.toInt(req.params.id)]);
  if (!target) return util.go(res, '/admin', { err: 'Bowler not found.' });
  const temp = await resetPasswordFor(target, req.user.id);
  util.go(res, '/admin', { msg: `Temporary password for ${target.name}: ${temp} — send it over, and have them change it in Profile.` });
});

router.post('/admin/lockouts/:id/reset', async (req, res) => {
  const request = await one('SELECT * FROM password_requests WHERE id = $1', [util.toInt(req.params.id)]);
  if (!request) return util.go(res, '/admin', { err: 'That request no longer exists.' });
  const target = await one('SELECT * FROM users WHERE id = $1', [request.user_id]);
  if (!target) return util.go(res, '/admin', { err: 'Bowler not found.' });
  const temp = await resetPasswordFor(target, req.user.id);
  util.go(res, '/admin', { msg: `Temporary password for ${target.name}: ${temp} — send it over, and have them change it in Profile.` });
});

router.post('/admin/lockouts/:id/dismiss', async (req, res) => {
  const request = await one('SELECT * FROM password_requests WHERE id = $1', [util.toInt(req.params.id)]);
  if (!request) return util.go(res, '/admin', { err: 'That request no longer exists.' });
  await run('UPDATE password_requests SET handled_at = $1, handled_by = $2 WHERE id = $3',
    [Date.now(), req.user.id, request.id]);
  util.go(res, '/admin', { msg: 'Request cleared — no password was changed.' });
});

// Danger zone: wipe every table for a fresh season / go-live. Requires the
// admin to type RESET in the confirmation box. After the wipe, the first
// account to register becomes the new league admin.
router.post('/admin/danger/reset', async (req, res) => {
  if (String(req.body.confirm || '').trim().toUpperCase() !== 'RESET') {
    return util.go(res, '/admin', { err: 'Type RESET in the confirmation box to wipe the league.' });
  }
  await run('TRUNCATE scores, teams, signups, password_requests, weeks, users RESTART IDENTITY CASCADE');
  req.session = null;
  res.redirect('/register?msg=' + encodeURIComponent('League wiped clean. The first account to register becomes the new admin.'));
});

router.post('/admin/users/:id/delete', async (req, res) => {
  const target = await one('SELECT * FROM users WHERE id = $1', [util.toInt(req.params.id)]);
  if (!target) return util.go(res, '/admin', { err: 'Bowler not found.' });
  if (target.id === req.user.id) return util.go(res, '/admin', { err: 'You cannot delete your own account.' });
  const history = (await one('SELECT COUNT(*) AS n FROM signups WHERE user_id = $1', [target.id])).n;
  if (history > 0) return util.go(res, '/admin', { err: `${target.name} has league history and cannot be deleted.` });
  await run('DELETE FROM users WHERE id = $1', [target.id]);
  util.go(res, '/admin', { msg: `${target.name} removed.` });
});

module.exports = router;
