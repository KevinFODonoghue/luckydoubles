const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const util = require('../util');
const wv = require('../weekview');
const { seasonStats } = require('../stats');

const router = express.Router();

router.get('/', (req, res) => {
  const week = wv.ensureCurrentWeek();
  const qi = req.url.indexOf('?');
  res.redirect('/week/' + week.id + (qi === -1 ? '' : req.url.slice(qi)));
});

router.get('/week/:id', (req, res, next) => {
  const week = wv.getWeek(util.toInt(req.params.id));
  if (!week) return next();
  const current = wv.ensureCurrentWeek();
  const vm = wv.buildWeekView(week, req.user);
  res.render('week', {
    title: util.fmtWeekDate(week.date),
    active: week.id === current.id ? 'week' : 'weeks',
    vm,
    week,
    isCurrent: week.id === current.id,
  });
});

router.get('/weeks', (req, res) => {
  const current = wv.ensureCurrentWeek();
  const weeks = db.prepare('SELECT * FROM weeks ORDER BY date DESC').all().map((w) => ({
    ...w,
    bowlerCount: db.prepare('SELECT COUNT(*) AS n FROM signups WHERE week_id = ?').get(w.id).n,
    winners: wv.winnersFor(w),
    isCurrent: w.id === current.id,
  }));
  res.render('weeks', { title: 'History', active: 'weeks', weeks });
});

router.get('/stats', (req, res) => {
  const { rows, completedWeeks } = seasonStats();
  res.render('stats', { title: 'Season stats', active: 'stats', rows, completedWeeks });
});

router.get('/profile', (req, res) => {
  res.render('profile', { title: 'Profile', active: 'profile' });
});

router.post('/profile/details', (req, res) => {
  const name = String(req.body.name || '').trim();
  const average = util.toInt(req.body.average);
  if (!name || name.length > 60) return util.go(res, '/profile', { err: 'Please enter your name (up to 60 characters).' });
  if (!util.validAverage(average)) return util.go(res, '/profile', { err: 'Average must be a whole number between 0 and 300.' });
  const hadAverage = req.user.average !== null && req.user.average !== undefined;
  db.prepare('UPDATE users SET name = ?, average = ? WHERE id = ?').run(name, average, req.user.id);

  // First time setting an average: point them back at the open signup if there is one.
  if (!hadAverage && average !== null) {
    const current = wv.ensureCurrentWeek();
    const signedUp = db.prepare('SELECT 1 FROM signups WHERE week_id = ? AND user_id = ?').get(current.id, req.user.id);
    if (current.status === 'open' && Date.now() < current.deadline && !signedUp) {
      return util.go(res, '/', { msg: 'Average saved — you can sign up for Friday now.' });
    }
  }
  util.go(res, '/profile', { msg: 'Profile saved.' });
});

router.post('/profile/password', (req, res) => {
  const current = String(req.body.current || '');
  const fresh = String(req.body.password || '');
  if (!bcrypt.compareSync(current, req.user.password_hash)) {
    return util.go(res, '/profile', { err: 'Current password is incorrect.' });
  }
  if (fresh.length < 6) return util.go(res, '/profile', { err: 'New password must be at least 6 characters.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(fresh, 10), req.user.id);
  util.go(res, '/profile', { msg: 'Password updated.' });
});

module.exports = router;
