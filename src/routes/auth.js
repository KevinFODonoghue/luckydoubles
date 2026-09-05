const express = require('express');
const bcrypt = require('bcryptjs');
const { one, run, isUniqueViolation } = require('../db');
const util = require('../util');

const router = express.Router();

// Simple in-memory login throttle: 10 failed tries per email+IP per 10 minutes.
// (Per serverless instance on Vercel — still blunts bulk guessing.)
const failedLogins = new Map();
const THROTTLE_WINDOW = 10 * 60 * 1000;
const THROTTLE_MAX = 10;

function throttleKey(req, email) {
  return `${req.ip || ''}|${email.toLowerCase()}`;
}

function isThrottled(key) {
  const entry = failedLogins.get(key);
  if (!entry || Date.now() - entry.first > THROTTLE_WINDOW) return false;
  return entry.count >= THROTTLE_MAX;
}

function recordFailure(key) {
  if (failedLogins.size > 5000) failedLogins.clear();
  const entry = failedLogins.get(key);
  if (!entry || Date.now() - entry.first > THROTTLE_WINDOW) {
    failedLogins.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count++;
  }
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', active: '' });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const key = throttleKey(req, email);
  if (isThrottled(key)) {
    return util.go(res, '/login', { err: 'Too many attempts — wait a few minutes and try again.' });
  }
  const user = await one('SELECT * FROM users WHERE email = $1', [email]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordFailure(key);
    return util.go(res, '/login', { err: "Wrong email or password. Locked out? Use “Forgot password?” below." });
  }
  failedLogins.delete(key);
  req.session.userId = user.id;
  util.go(res, '/', { msg: `Welcome back, ${user.name}!` });
});

// ---- Locked out ----
//
// The league has no mail server, so a reset link can't be emailed. Instead a
// bowler raises a request here, it shows up on the admin's Admin page, and the
// admin hands back a temporary password the same way they'd text anything else.

router.get('/forgot', (req, res) => {
  if (req.user) return res.redirect('/profile');
  res.render('forgot', { title: 'Locked out', active: '' });
});

router.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return util.go(res, '/forgot', { err: 'Please enter the email address you registered with.' });
  }
  const user = await one('SELECT id FROM users WHERE email = $1', [email]);
  if (user) {
    try {
      await run('INSERT INTO password_requests (user_id, created_at) VALUES ($1, $2)', [user.id, Date.now()]);
    } catch (e) {
      // A second ask while the first is still open is not an error.
      if (!isUniqueViolation(e)) throw e;
    }
  }
  // Same answer either way, so this page can't be used to fish for addresses.
  util.go(res, '/login', {
    msg: 'Request sent. If that email is registered, your league admin will get you a temporary password — then change it under Profile.',
  });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: 'Create account', active: '' });
});

router.post('/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const average = util.toInt(req.body.average);

  if (!name || name.length > 60) return util.go(res, '/register', { err: 'Please enter your name (up to 60 characters).' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return util.go(res, '/register', { err: 'Please enter a valid email address.' });
  if (password.length < 6) return util.go(res, '/register', { err: 'Password must be at least 6 characters.' });
  if (!util.validAverage(average)) return util.go(res, '/register', { err: 'Average must be a whole number between 0 and 300.' });

  const isFirst = (await one('SELECT COUNT(*) AS n FROM users')).n === 0;
  let userId;
  try {
    const inserted = await one(
      'INSERT INTO users (name, email, password_hash, average, is_admin, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [name, email, bcrypt.hashSync(password, 10), average, isFirst ? 1 : 0, Date.now()]
    );
    userId = inserted.id;
  } catch (e) {
    if (isUniqueViolation(e)) {
      return util.go(res, '/register', {
        err: "That email already has an account. Sign in with it — or use “Forgot password?” if you can't get in.",
      });
    }
    throw e;
  }

  req.session.userId = userId;
  const note = isFirst ? ' You created the first account, so you have admin access.' : '';
  util.go(res, '/', { msg: `Welcome, ${name}!${note}` });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login?msg=' + encodeURIComponent('Signed out.'));
});

module.exports = router;
