// Date helpers, form parsing, and flash-message redirects.
//
// Every league date and time is computed in the LEAGUE timezone explicitly —
// never in whatever timezone the host process happens to run in. Serverless
// hosts (Vercel) run in UTC, so anything that leaned on the process timezone
// stored the signup deadline hours away from the intended league time. Only
// LEAGUE_TZ decides league time; deadlines are stored as epoch milliseconds.

const DEFAULT_TZ = 'America/New_York';

function validTZ(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const LEAGUE_TZ = (() => {
  const wanted = process.env.LEAGUE_TZ;
  if (!wanted) return DEFAULT_TZ;
  if (validTZ(wanted)) return wanted;
  console.error(`LEAGUE_TZ="${wanted}" is not a known timezone — falling back to ${DEFAULT_TZ}.`);
  return DEFAULT_TZ;
})();

// Signup deadline on league night: 6:40 PM league time.
const DEADLINE_HOUR = 18;
const DEADLINE_MINUTE = 40;

function pad2(n) {
  return String(n).padStart(2, '0');
}

const PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: LEAGUE_TZ,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// The wall-clock parts an instant reads as in the league timezone.
function tzParts(ms) {
  const out = {};
  for (const p of PARTS_FMT.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0; // some ICU builds report midnight as hour 24
  return out;
}

// Offset of the league timezone at a given instant, in ms (league local - UTC).
function tzOffset(ms) {
  const p = tzParts(ms);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

// Epoch ms for a wall-clock league-timezone time. Two passes so the offset is
// taken at the resulting instant, which matters on DST changeover weekends.
function zonedToEpoch(y, m, d, hh = 0, mm = 0) {
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  return naive - tzOffset(naive - tzOffset(naive));
}

function fmtYMD({ y, m, d }) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// Parse 'YYYY-MM-DD' into calendar parts (no timezone applied yet).
function parseYMD(s) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

// Midday on a league date — a safe instant to format or shift a calendar date
// from, since it is never near a DST boundary.
function noonOf(dateStr) {
  const parts = parseYMD(dateStr);
  return parts ? zonedToEpoch(parts.y, parts.m, parts.d, 12, 0) : null;
}

function addDaysYMD(dateStr, days) {
  const parts = parseYMD(dateStr);
  if (!parts) return dateStr;
  const shifted = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + days));
  return fmtYMD({ y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() });
}

// Today's calendar date in the league timezone.
function todayYMD(now = Date.now()) {
  const p = tzParts(now);
  return fmtYMD({ y: p.year, m: p.month, d: p.day });
}

// The upcoming Friday in league time, counting today if today is Friday.
function upcomingFridayYMD(now = Date.now()) {
  const today = todayYMD(now);
  const parts = parseYMD(today);
  const dow = new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
  return addDaysYMD(today, (5 - dow + 7) % 7);
}

// Default signup deadline for a league night: 6:40 PM league time.
function defaultDeadline(dateStr) {
  const parts = parseYMD(dateStr);
  if (!parts) return null;
  return zonedToEpoch(parts.y, parts.m, parts.d, DEADLINE_HOUR, DEADLINE_MINUTE);
}

function fmtWeekDate(dateStr) {
  const ms = noonOf(dateStr);
  if (ms === null) return dateStr;
  return new Date(ms).toLocaleDateString('en-US', {
    timeZone: LEAGUE_TZ, weekday: 'long', month: 'long', day: 'numeric',
  });
}

function fmtShortDate(dateStr) {
  const ms = noonOf(dateStr);
  if (ms === null) return dateStr;
  return new Date(ms).toLocaleDateString('en-US', {
    timeZone: LEAGUE_TZ, month: 'short', day: 'numeric', year: 'numeric',
  });
}

// Times always carry their timezone, so "6:40" is never ambiguous to a bowler
// reading the page from another state.
function fmtDT(ms) {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: LEAGUE_TZ,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: LEAGUE_TZ, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// Short name for the league timezone right now, e.g. "EDT" — for labelling
// times so nobody has to guess which 6:40 is meant.
function tzLabel(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: LEAGUE_TZ, timeZoneName: 'short' })
    .formatToParts(new Date(ms));
  const found = parts.find((p) => p.type === 'timeZoneName');
  return found ? found.value : LEAGUE_TZ;
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// For <input type="datetime-local"> values — league wall-clock, both ways, so
// an admin typing 6:40 PM gets 6:40 PM at the lanes.
function toLocalInputValue(ms) {
  const p = tzParts(ms);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

function parseLocalInputValue(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  return zonedToEpoch(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
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

// Repeated form fields (a checkbox paired with a hidden fallback) arrive as an
// array; the last one wins, which is the control the bowler actually touched.
function lastValue(v) {
  return Array.isArray(v) ? v[v.length - 1] : v;
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
  res.redirect(u.pathname + u.search + (flash.hash || ''));
}

module.exports = {
  LEAGUE_TZ, DEADLINE_HOUR, DEADLINE_MINUTE,
  parseYMD, addDaysYMD, todayYMD, upcomingFridayYMD, defaultDeadline, zonedToEpoch,
  fmtWeekDate, fmtShortDate, fmtDT, fmtTime, fmtNum, tzLabel,
  toLocalInputValue, parseLocalInputValue, remainingText,
  toInt, lastValue, validAverage, validGame, go,
};
