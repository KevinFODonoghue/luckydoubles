// Date helpers, form parsing, and flash-message redirects.
// All dates are handled in the server's local timezone (the league's timezone).

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Parse 'YYYY-MM-DD' as a LOCAL date (new Date('YYYY-MM-DD') would parse as UTC).
function parseYMD(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return null;
  return d;
}

function addDaysYMD(dateStr, days) {
  const d = parseYMD(dateStr);
  d.setDate(d.getDate() + days);
  return ymd(d);
}

// The upcoming Friday, counting today if today is Friday.
function upcomingFridayYMD(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  return ymd(d);
}

// Default signup deadline: 6:30 PM on league night.
function defaultDeadline(dateStr) {
  const d = parseYMD(dateStr);
  d.setHours(18, 30, 0, 0);
  return d.getTime();
}

function fmtWeekDate(dateStr) {
  const d = parseYMD(dateStr);
  if (!d) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function fmtShortDate(dateStr) {
  const d = parseYMD(dateStr);
  if (!d) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDT(ms) {
  return new Date(ms).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// For <input type="datetime-local"> values.
function toLocalInputValue(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function parseLocalInputValue(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (isNaN(d.getTime())) return null;
  return d.getTime();
}

function remainingText(deadlineMs, now = Date.now()) {
  let t = deadlineMs - now;
  if (t <= 0) return 'Signups closed';
  const d = Math.floor(t / 86400000);
  const h = Math.floor((t % 86400000) / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  return `${d ? d + 'd ' : ''}${h}h ${m}m`;
}

// '' / undefined -> null; non-numeric -> NaN; otherwise integer.
function toInt(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  if (!/^\d+$/.test(s)) return NaN;
  return parseInt(s, 10);
}

function validAverage(n) {
  return n === null || (Number.isInteger(n) && n >= 0 && n <= 300);
}

function validGame(n) {
  return n === null || (Number.isInteger(n) && n >= 0 && n <= 300);
}

// Redirect with a flash message carried in the query string.
function go(res, path, flash = {}) {
  const u = new URL(path, 'http://local');
  if (flash.msg) u.searchParams.set('msg', flash.msg);
  if (flash.err) u.searchParams.set('err', flash.err);
  res.redirect(u.pathname + u.search);
}

module.exports = {
  ymd, parseYMD, addDaysYMD, upcomingFridayYMD, defaultDeadline,
  fmtWeekDate, fmtShortDate, fmtDT, fmtNum,
  toLocalInputValue, parseLocalInputValue, remainingText,
  toInt, validAverage, validGame, go,
};
