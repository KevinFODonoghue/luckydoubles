const express = require('express');
const { db } = require('../db');
const util = require('../util');
const wv = require('../weekview');

const router = express.Router();

function loadWeek(req, res) {
  const week = wv.getWeek(util.toInt(req.params.id));
  if (!week) {
    util.go(res, '/', { err: 'That week no longer exists.' });
    return null;
  }
  return week;
}

router.post('/week/:id/optin', (req, res) => {
  const week = loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status !== 'open' || Date.now() >= week.deadline) {
    return util.go(res, back, { err: 'Signups are closed for this week.' });
  }
  // The sign-up card lets a bowler enter their average inline the first time.
  if (req.body.average !== undefined && String(req.body.average).trim() !== '') {
    const average = util.toInt(req.body.average);
    if (!util.validAverage(average) || average === null) {
      return util.go(res, back, { err: 'Average must be a whole number between 0 and 300.' });
    }
    db.prepare('UPDATE users SET average = ? WHERE id = ?').run(average, req.user.id);
    req.user.average = average;
  }
  if (req.user.average === null || req.user.average === undefined) {
    return util.go(res, back, { err: 'Enter your average to sign up — teams are drawn from it.' });
  }
  try {
    db.prepare('INSERT INTO signups (week_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(week.id, req.user.id, Date.now());
  } catch (e) {
    if (!String(e.message).includes('UNIQUE')) throw e;
  }
  util.go(res, back, { msg: `You're in for ${util.fmtWeekDate(week.date)}! 🎳` });
});

router.post('/week/:id/optout', (req, res) => {
  const week = loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  if (week.status !== 'open' || Date.now() >= week.deadline) {
    return util.go(res, back, { err: 'Signups are closed — ask the league admin to make changes.' });
  }
  db.prepare('DELETE FROM signups WHERE week_id = ? AND user_id = ?').run(week.id, req.user.id);
  util.go(res, back, { msg: "You've opted out for this week." });
});

router.post('/week/:id/scores/:userId', (req, res) => {
  const week = loadWeek(req, res);
  if (!week) return;
  const back = '/week/' + week.id;
  const targetId = util.toInt(req.params.userId);

  if (!wv.canEditScores(week, req.user, targetId)) {
    return util.go(res, back, { err: 'You can only enter your own scores while the week is in play.' });
  }
  const onTeam = db.prepare(
    'SELECT 1 FROM teams WHERE week_id = ? AND (bowler1_id = ? OR bowler2_id = ?)'
  ).get(week.id, targetId, targetId);
  if (!onTeam) {
    return util.go(res, back, { err: 'That bowler is not on a team this week.' });
  }

  const games = [req.body.game1, req.body.game2, req.body.game3].map(util.toInt);
  if (!games.every(util.validGame)) {
    return util.go(res, back, { err: 'Each game must be a whole number between 0 and 300.' });
  }

  db.prepare(`
    INSERT INTO scores (week_id, user_id, game1, game2, game3) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (week_id, user_id) DO UPDATE SET
      game1 = excluded.game1, game2 = excluded.game2, game3 = excluded.game3
  `).run(week.id, targetId, games[0], games[1], games[2]);

  util.go(res, back, { msg: 'Scores saved.' });
});

module.exports = router;
