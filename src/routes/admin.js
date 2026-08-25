const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
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

function loadWeek(req, res) {
  const week = wv.getWeek(util.toInt(req.params.id));
  if (!week) {
    util.go(res, '/', { err: 'That week no longer exists.' });
    return null;
  }
  return week;
}

// ---- Week lifecycle ----

router.post('/week/:id/pair', (req, res) => {
  const week = loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  try {
    const result = generatePairings(week.id);
    const wl = result.waitlisted ? ` ${result.waitlisted} is on the waitlist (last to sign up).` : '';
    util.go(res, back, { msg: `Pairings set — ${result.teamCount} teams.${wl}` });
  } catch (e) {
    util.go(res, back, { err: e.message });
  }
});

router.post('/week/:id/reopen', (req, res) => {
  const week = loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status !== 'paired') return util.go(res, back, { err: 'Only a paired week can be reopened.' });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM teams WHERE week_id = ?').run(week.id);
    db.prepare('UPDATE signups SET waitlisted = 0, avg_snapshot = NULL WHERE week_id = ?').run(week.id);
    db.prepare("UPDATE weeks SET status = 'open', paired_at = NULL WHERE id = ?").run(week.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const note = Date.now() >= week.deadline ? ' The deadline has already passed — update it so bowlers can sign up.' : '';
  util.go(res, back, { msg: 'Signups reopened. Pairings cleared.' + note });
});

router.post('/week/:id/finalize', (req, res) => {
  const week = loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status !== 'paired') return util.go(res, back, { err: 'Generate pairings before finalizing.' });
  db.prepare("UPDATE weeks SET status = 'completed', completed_at = ? WHERE id = ?").run(Date.now(), week.id);
  util.go(res, back, { msg: '🏆 Week finalized — results are official!' });
});

router.post('/week/:id/unfinalize', (req, res) => {
  const week = loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status !== 'completed') return util.go(res, back, { err: 'This week is not finalized.' });
  db.prepare("UPDATE weeks SET status = 'paired', completed_at = NULL WHERE id = ?").run(week.id);
  util.go(res, back, { msg: 'Week unlocked — scores can be edited again.' });
});

router.post('/week/:id/deadline', (req, res) => {
  const week = loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status === 'completed') return util.go(res, back, { err: 'This week is finalized.' });
  const ms = util.parseLocalInputValue(req.body.deadline);
  if (!ms) return util.go(res, back, { err: 'Enter a valid date and time.' });
  db.prepare('UPDATE weeks SET deadline = ? WHERE id = ?').run(ms, week.id);
  util.go(res, back, { msg: `Signup deadline updated to ${util.fmtDT(ms)}.` });
});

// ---- Roster management ----

router.post('/week/:id/signups/add', (req, res) => {
  const week = loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status === 'completed') return util.go(res, back, { err: 'This week is finalized.' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(util.toInt(req.body.user_id));
  if (!target) return util.go(res, back, { err: 'Pick a bowler to add.' });
  if (target.average === null || target.average === undefined) {
    return util.go(res, back, { err: `${target.name} has no average yet — set one in Admin → Bowlers first.` });
  }
  try {
    db.prepare('INSERT INTO signups (week_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(week.id, target.id, Date.now());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return util.go(res, back, { err: `${target.name} is already signed up.` });
    throw e;
  }
  const note = week.status === 'paired' ? ' Regenerate pairings to slot them in.' : '';
  util.go(res, back, { msg: `${target.name} added.${note}` });
});

router.post('/signups/:sid/remove', (req, res) => {
  const signup = db.prepare('SELECT * FROM signups WHERE id = ?').get(util.toInt(req.params.sid));
  if (!signup) return util.go(res, '/', { err: 'That signup no longer exists.' });
  const week = wv.getWeek(signup.week_id);
  const back = '/week/' + week.id;
  if (week.status === 'completed') return util.go(res, back, { err: 'This week is finalized.' });
  db.prepare('DELETE FROM signups WHERE id = ?').run(signup.id);
  const note = week.status === 'paired' ? ' Regenerate pairings to rebuild teams.' : '';
  util.go(res, back, { msg: `Removed from this week.${note}` });
});

router.post('/signups/:sid/paid', (req, res) => {
  const signup = db.prepare('SELECT * FROM signups WHERE id = ?').get(util.toInt(req.params.sid));
  if (!signup) return util.go(res, '/', { err: 'That signup no longer exists.' });
  db.prepare('UPDATE signups SET paid = ? WHERE id = ?').run(signup.paid ? 0 : 1, signup.id);
  res.redirect('/week/' + signup.week_id);
});

// ---- Admin panel ----

router.get('/admin', (req, res) => {
  const users = db.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM signups s WHERE s.user_id = u.id) AS signup_count
    FROM users u ORDER BY u.name ASC
  `).all();
  const weeks = db.prepare('SELECT * FROM weeks ORDER BY date DESC').all().map((w) => ({
    ...w,
    bowlerCount: db.prepare('SELECT COUNT(*) AS n FROM signups WHERE week_id = ?').get(w.id).n,
  }));
  res.render('admin', { title: 'Admin', active: 'admin', users, weeks });
});

router.post('/admin/weeks', (req, res) => {
  const dateStr = String(req.body.date || '').trim();
  if (!util.parseYMD(dateStr)) return util.go(res, '/admin', { err: 'Pick a date for the new week.' });
  const deadline = util.parseLocalInputValue(req.body.deadline) || util.defaultDeadline(dateStr);
  try {
    db.prepare('INSERT INTO weeks (date, deadline, created_at) VALUES (?, ?, ?)')
      .run(dateStr, deadline, Date.now());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return util.go(res, '/admin', { err: 'A week already exists on that date.' });
    throw e;
  }
  util.go(res, '/admin', { msg: `Week created for ${util.fmtWeekDate(dateStr)}.` });
});

router.post('/admin/weeks/:id/delete', (req, res) => {
  const week = wv.getWeek(util.toInt(req.params.id));
  if (!week) return util.go(res, '/admin', { err: 'That week no longer exists.' });
  db.prepare('DELETE FROM weeks WHERE id = ?').run(week.id);
  util.go(res, '/admin', { msg: `Deleted the week of ${util.fmtShortDate(week.date)} and all its signups and scores.` });
});

router.post('/admin/users/:id/average', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(util.toInt(req.params.id));
  if (!target) return util.go(res, '/admin', { err: 'Bowler not found.' });
  const average = util.toInt(req.body.average);
  if (!util.validAverage(average)) return util.go(res, '/admin', { err: 'Average must be a whole number between 0 and 300.' });
  db.prepare('UPDATE users SET average = ? WHERE id = ?').run(average, target.id);
  util.go(res, '/admin', { msg: `Average updated for ${target.name}.` });
});

router.post('/admin/users/:id/toggle-admin', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(util.toInt(req.params.id));
  if (!target) return util.go(res, '/admin', { err: 'Bowler not found.' });
  if (target.is_admin) {
    const admins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n;
    if (admins <= 1) return util.go(res, '/admin', { err: 'Cannot remove the last admin.' });
  }
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(target.is_admin ? 0 : 1, target.id);
  util.go(res, '/admin', { msg: `${target.name} is ${target.is_admin ? 'no longer' : 'now'} an admin.` });
});

router.post('/admin/users/:id/reset-password', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(util.toInt(req.params.id));
  if (!target) return util.go(res, '/admin', { err: 'Bowler not found.' });
  const temp = crypto.randomBytes(4).toString('hex');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(temp, 10), target.id);
  util.go(res, '/admin', { msg: `Temporary password for ${target.name}: ${temp} — have them change it in Profile.` });
});

router.post('/admin/users/:id/delete', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(util.toInt(req.params.id));
  if (!target) return util.go(res, '/admin', { err: 'Bowler not found.' });
  if (target.id === req.user.id) return util.go(res, '/admin', { err: 'You cannot delete your own account.' });
  const history = db.prepare('SELECT COUNT(*) AS n FROM signups WHERE user_id = ?').get(target.id).n;
  if (history > 0) return util.go(res, '/admin', { err: `${target.name} has league history and cannot be deleted.` });
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  util.go(res, '/admin', { msg: `${target.name} removed.` });
});

module.exports = router;
