const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one, run } = require('../db');
const util = require('../util');
const wv = require('../weekview');
const { seasonStats } = require('../stats');

const router = express.Router();

router.get('/', async (req, res) => {
  const week = await wv.ensureCurrentWeek();
  const qi = req.url.indexOf('?');
  res.redirect('/week/' + week.id + (qi === -1 ? '' : req.url.slice(qi)));
});

router.get('/week/:id', async (req, res, next) => {
  const week = await wv.getWeek(util.toInt(req.params.id));
  if (!week) return next();
  const current = await wv.ensureCurrentWeek();
  const vm = await wv.buildWeekView(week, req.user);
  res.render('week', {
    title: util.fmtWeekDate(week.date),
    active: week.id === current.id ? 'week' : 'weeks',
    vm,
    week,
    isCurrent: week.id === current.id,
  });
});

router.get('/weeks', async (req, res) => {
  const current = await wv.ensureCurrentWeek();
  const weekRows = await q('SELECT * FROM weeks ORDER BY date DESC');
  const weeks = await Promise.all(weekRows.map(async (w) => ({
    ...w,
    bowlerCount: (await one('SELECT COUNT(*) AS n FROM signups WHERE week_id = $1', [w.id])).n,
    winners: await wv.winnersFor(w),
    isCurrent: w.id === current.id,
  })));
  res.render('weeks', { title: 'History', active: 'weeks', weeks });
});

router.get('/stats', async (req, res) => {
  const { rows, completedWeeks } = await seasonStats();
  res.render('stats', { title: 'Season stats', active: 'stats', rows, completedWeeks });
});

router.get('/profile', (req, res) => {
  res.render('profile', { title: 'Profile', active: 'profile' });
});

router.post('/profile/details', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const average = util.toInt(req.body.average);
  if (!name || name.length > 60) return util.go(res, '/profile', { err: 'Please enter your name (up to 60 characters).' });
  if (!util.validAverage(average)) return util.go(res, '/profile', { err: 'Average must be a whole number between 0 and 300.' });
  const hadAverage = req.user.average !== null && req.user.average !== undefined;
  await run('UPDATE users SET name = $1, average = $2 WHERE id = $3', [name, average, req.user.id]);

  // First time setting an average: point them back at the open signup if there is one.
  if (!hadAverage && average !== null) {
    const current = await wv.ensureCurrentWeek();
    const signedUp = await one('SELECT 1 AS x FROM signups WHERE week_id = $1 AND user_id = $2', [current.id, req.user.id]);
    if (current.status === 'open' && Date.now() < current.deadline && !signedUp) {
      return util.go(res, '/', { msg: 'Average saved — you can sign up for Friday now.' });
    }
  }
  util.go(res, '/profile', { msg: 'Profile saved.' });
});

router.post('/profile/password', async (req, res) => {
  const current = String(req.body.current || '');
  const fresh = String(req.body.password || '');
  if (!bcrypt.compareSync(current, req.user.password_hash)) {
    return util.go(res, '/profile', { err: 'Current password is incorrect.' });
  }
  if (fresh.length < 6) return util.go(res, '/profile', { err: 'New password must be at least 6 characters.' });
  await run('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(fresh, 10), req.user.id]);
  util.go(res, '/profile', { msg: 'Password updated.' });
});

module.exports = router;
