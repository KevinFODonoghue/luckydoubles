const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const { db, sessionSecret } = require('./src/db');
const util = require('./src/util');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(cookieSession({
  name: 'luckydoubles',
  keys: [process.env.SESSION_SECRET || sessionSecret()],
  maxAge: 1000 * 60 * 60 * 24 * 90,
  sameSite: 'lax',
  httpOnly: true,
}));

// Load the signed-in user and set template defaults.
app.use((req, res, next) => {
  req.user = null;
  if (req.session && req.session.userId) {
    req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || null;
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

app.use(require('./src/routes/auth'));

// Everything below requires a signed-in user.
app.use((req, res, next) => {
  if (!req.user) return res.redirect('/login');
  next();
});

app.use(require('./src/routes/main'));
app.use(require('./src/routes/actions'));
app.use(require('./src/routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', code: 404, message: 'That page does not exist.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Error', code: 500, message: 'Something went wrong. Try again.' });
});

app.listen(PORT, () => {
  console.log(`🎳 Lucky Doubles running at http://localhost:${PORT}`);
});
