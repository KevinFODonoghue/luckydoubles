const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { one, run, tx, isUniqueViolation } = require('../db');
const util = require('../util');
const mail = require('../mail');

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

// ---- Password reset ----
//
// Standard emailed single-use link. Only the SHA-256 of the token ever reaches
// the database, and the link expires. If email isn't configured or the send
// fails, the request falls back to the admin queue, so a locked-out bowler is
// never left with nothing — same for someone whose address no longer works.

const RESET_TTL_MS = 60 * 60 * 1000;
const RESET_TTL_MINUTES = RESET_TTL_MS / 60000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

router.get('/forgot', (req, res) => {
  if (req.user) return res.redirect('/profile');
  res.render('forgot', { title: 'Reset password', active: '', mailOn: mail.isConfigured() });
});

router.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return util.go(res, '/forgot', { err: 'Please enter the email address you registered with.' });
  }
  // Throttled on the address so this can't be used to bomb someone's inbox.
  const key = throttleKey(req, email);
  if (isThrottled(key)) {
    return util.go(res, '/forgot', { err: 'Too many attempts — wait a few minutes and try again.' });
  }
  recordFailure(key);

  const user = await one('SELECT * FROM users WHERE email = $1', [email]);
  if (user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    // Any earlier link stops working the moment a new one is asked for.
    await run('UPDATE password_resets SET used_at = $1 WHERE user_id = $2 AND used_at IS NULL', [now, user.id]);
    await run(
      'INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4)',
      [user.id, hashToken(token), now + RESET_TTL_MS, now]
    );

    const link = `${mail.appOrigin(req)}/reset/${token}`;
    const sent = await mail.send({
      to: user.email,
      toName: user.name,
      ...mail.resetEmail({ name: user.name, link, minutes: RESET_TTL_MINUTES }),
    });

    if (!sent.ok) {
      console.error(`Password reset email to ${user.email} failed: ${sent.reason}`);
      // Nobody is stranded: put it in front of the admin instead.
      try {
        await run('INSERT INTO password_requests (user_id, created_at) VALUES ($1, $2)', [user.id, now]);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e; // asking twice while one is open is fine
      }
    }
  }

  // Same answer whether or not the address is registered, so this page can't be
  // used to find out who is in the league.
  util.go(res, '/login', {
    msg: `If that email is registered, a reset link is on its way — it expires in ${RESET_TTL_MINUTES} minutes. Nothing arrives? Your league admin can still reset it for you.`,
  });
});

// Resolve a token, rejecting anything unknown, already used, or expired.
async function liveReset(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const row = await one(`
    SELECT r.*, u.name, u.email
    FROM password_resets r JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = $1
  `, [hashToken(token)]);
  if (!row || row.used_at !== null || Date.now() >= row.expires_at) return null;
  return row;
}

router.get('/reset/:token', async (req, res) => {
  const reset = await liveReset(req.params.token);
  if (!reset) {
    return util.go(res, '/forgot', { err: 'That reset link has expired or already been used — ask for a new one.' });
  }
  res.render('reset', { title: 'Choose a new password', active: '', token: req.params.token, name: reset.name });
});

router.post('/reset/:token', async (req, res) => {
  const reset = await liveReset(req.params.token);
  if (!reset) {
    return util.go(res, '/forgot', { err: 'That reset link has expired or already been used — ask for a new one.' });
  }
  const password = String(req.body.password || '');
  const back = '/reset/' + req.params.token;
  if (password.length < 6) {
    return util.go(res, back, { err: 'New password must be at least 6 characters.' });
  }
  if (password !== String(req.body.confirm || '')) {
    return util.go(res, back, { err: 'Those two passwords do not match.' });
  }

  const now = Date.now();
  await tx(async (c) => {
    await c.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(password, 10), reset.user_id]);
    // Burn every outstanding link for this bowler, not just the one just used.
    await c.query('UPDATE password_resets SET used_at = $1 WHERE user_id = $2 AND used_at IS NULL', [now, reset.user_id]);
    // Anyone waiting on the admin for this account no longer is.
    await c.query('UPDATE password_requests SET handled_at = $1 WHERE user_id = $2 AND handled_at IS NULL', [now, reset.user_id]);
  });

  // They proved they hold the mailbox, so sign them straight in.
  req.session.userId = reset.user_id;
  failedLogins.delete(throttleKey(req, reset.email));
  util.go(res, '/', { msg: `Password updated — you're signed in, ${reset.name}.` });
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
