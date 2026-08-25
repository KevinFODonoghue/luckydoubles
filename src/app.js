// League nights are US Eastern; pin the timezone so date math and display are
// right even when the host runs in UTC (e.g. Vercel). Must run before any Date use.
process.env.TZ = process.env.TZ || 'America/New_York';

const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const { one, sessionSecret } = require('./db');
const util = require('./util');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(cookieSession({
  name: 'luckydoubles',
  keys: [sessionSecret()],
  maxAge: 1000 * 60 * 60 * 24 * 90,
  sameSite: 'lax',
  httpOnly: true,
  // In production the app sits behind an HTTPS proxy (Vercel/Caddy/etc.)
  secure: process.env.NODE_ENV === 'production',
}));

// Unauthenticated health check; pings the database so uptime monitors and the
// daily cron keep the whole stack (including a sleeping DB) verified warm.
app.get('/healthz', async (req, res) => {
  await one('SELECT 1 AS ok');
  res.type('text').send('ok');
});

// Load the signed-in user and set template defaults.
app.use(async (req, res, next) => {
  req.user = null;
  if (req.session && req.session.userId) {
    req.user = await one('SELECT * FROM users WHERE id = $1', [req.session.userId]) || null;
    if (!req.user) req.session = null;
  }
  res.locals.user = req.user;
  res.locals.title = 'Lucky Doubles';
  res.locals.active = '';
  res.locals.msg = typeof req.query.msg === 'string' ? req.query.msg : null;
  res.locals.err = typeof req.query.err === 'string' ? req.query.err : null;
  res.locals.h = util;
  next();
});

app.use(require('./routes/auth'));

// Everything below requires a signed-in user.
app.use((req, res, next) => {
  if (!req.user) return res.redirect('/login');
  next();
});

app.use(require('./routes/main'));
app.use(require('./routes/actions'));
app.use(require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', code: 404, message: 'That page does not exist.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  // TEMPORARY pre-launch diagnostics: expose error detail behind a token.
  const message = req.query.debug === 'ld-debug-7431'
    ? `[${err.code || 'no-code'}] ${err.message}`
    : 'Something went wrong. Try again.';
  res.status(500).render('error', { title: 'Error', code: 500, message });
});

module.exports = app;
