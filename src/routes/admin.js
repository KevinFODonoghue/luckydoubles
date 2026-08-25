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

router.post('/signups/:sid/paid', async (req, res) => {
  const signup = await one('SELECT * FROM signups WHERE id = $1', [util.toInt(req.params.sid)]);
  if (!signup) return util.go(res, '/', { err: 'That signup no longer exists.' });
  await run('UPDATE signups SET paid = $1 WHERE id = $2', [signup.paid ? 0 : 1, signup.id]);
  res.redirect('/week/' + signup.week_id);
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
  res.render('admin', { title: 'Admin', active: 'admin', users, weeks });
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

router.post('/admin/users/:id/reset-password', async (req, res) => {
  const target = await one('SELECT * FROM users WHERE id = $1', [util.toInt(req.params.id)]);
  if (!target) return util.go(res, '/admin', { err: 'Bowler not found.' });
  const temp = crypto.randomBytes(4).toString('hex');
  await run('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(temp, 10), target.id]);
  util.go(res, '/admin', { msg: `Temporary password for ${target.name}: ${temp} — have them change it in Profile.` });
});

// Danger zone: wipe every table for a fresh season / go-live. Requires the
// admin to type RESET in the confirmation box. After the wipe, the first
// account to register becomes the new league admin.
router.post('/admin/danger/reset', async (req, res) => {
  if (String(req.body.confirm || '').trim().toUpperCase() !== 'RESET') {
    return util.go(res, '/admin', { err: 'Type RESET in the confirmation box to wipe the league.' });
  }
  await run('TRUNCATE scores, teams, signups, weeks, users RESTART IDENTITY CASCADE');
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
