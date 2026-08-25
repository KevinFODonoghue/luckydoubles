const { db } = require('./db');
const util = require('./util');

function getWeek(id) {
  return db.prepare('SELECT * FROM weeks WHERE id = ?').get(id);
}

// Make sure a week exists for the upcoming Friday (today counts if it's Friday).
function ensureCurrentWeek() {
  const dateStr = util.upcomingFridayYMD();
  let week = db.prepare('SELECT * FROM weeks WHERE date = ?').get(dateStr);
  if (!week) {
    const res = db.prepare('INSERT INTO weeks (date, deadline, created_at) VALUES (?, ?, ?)')
      .run(dateStr, util.defaultDeadline(dateStr), Date.now());
    week = getWeek(Number(res.lastInsertRowid));
  }
  return week;
}

function signupsFor(weekId) {
  return db.prepare(`
    SELECT s.id, s.user_id, s.created_at, s.paid, s.waitlisted, s.avg_snapshot, u.name, u.average
    FROM signups s JOIN users u ON u.id = s.user_id
    WHERE s.week_id = ?
    ORDER BY s.created_at ASC, s.id ASC
  `).all(weekId);
}

function scoresMap(weekId) {
  const map = {};
  for (const r of db.prepare('SELECT * FROM scores WHERE week_id = ?').all(weekId)) {
    map[r.user_id] = r;
  }
  return map;
}

function teamsFor(weekId) {
  return db.prepare(`
    SELECT t.id, t.team_number, t.bowler1_id, t.bowler2_id,
           u1.name AS b1_name, u1.average AS b1_avg,
           u2.name AS b2_name, u2.average AS b2_avg
    FROM teams t
    JOIN users u1 ON u1.id = t.bowler1_id
    JOIN users u2 ON u2.id = t.bowler2_id
    WHERE t.week_id = ?
    ORDER BY t.team_number ASC
  `).all(weekId);
}

function canEditScores(week, viewer, targetUserId) {
  if (!viewer) return false;
  if (viewer.is_admin) return week.status !== 'open';
  return week.status === 'paired' && viewer.id === targetUserId;
}

// Build everything the week page needs.
function buildWeekView(week, viewer) {
  const now = Date.now();
  const signups = signupsFor(week.id);
  const signupOpen = week.status === 'open' && now < week.deadline;
  const viewerSignup = viewer ? signups.find((s) => s.user_id === viewer.id) || null : null;
  const oddOut = signups.length % 2 === 1 ? signups[signups.length - 1] : null;

  const snapFor = (userId, fallback) => {
    const s = signups.find((x) => x.user_id === userId);
    return s && s.avg_snapshot !== null && s.avg_snapshot !== undefined ? s.avg_snapshot : fallback;
  };

  let standings = [];
  let highlights = null;
  let waitlist = [];
  let allScored = true;

  if (week.status !== 'open') {
    const smap = scoresMap(week.id);
    const gamesOf = (row) => (row ? [row.game1, row.game2, row.game3] : [null, null, null]);

    const teams = teamsFor(week.id).map((t) => {
      const bowlers = [
        { user_id: t.bowler1_id, name: t.b1_name, avg: snapFor(t.bowler1_id, t.b1_avg), games: gamesOf(smap[t.bowler1_id]) },
        { user_id: t.bowler2_id, name: t.b2_name, avg: snapFor(t.bowler2_id, t.b2_avg), games: gamesOf(smap[t.bowler2_id]) },
      ].map((b) => ({
        ...b,
        series: b.games.reduce((sum, g) => sum + (g || 0), 0),
        hasAny: b.games.some((g) => g !== null && g !== undefined),
        canEdit: canEditScores(week, viewer, b.user_id),
      }));
      const gamesEntered = bowlers.reduce(
        (n, b) => n + b.games.filter((g) => g !== null && g !== undefined).length, 0);
      return {
        id: t.id,
        number: t.team_number,
        bowlers,
        combinedAvg: (bowlers[0].avg || 0) + (bowlers[1].avg || 0),
        total: bowlers[0].series + bowlers[1].series,
        gamesEntered,
        complete: gamesEntered === 6,
      };
    });

    allScored = teams.length > 0 && teams.every((t) => t.complete);

    standings = teams.slice().sort((a, b) => (b.total - a.total) || (a.number - b.number));
    let lastTotal = null;
    let lastRank = 0;
    standings.forEach((t, i) => {
      t.rank = t.total === lastTotal ? lastRank : i + 1;
      lastTotal = t.total;
      lastRank = t.rank;
    });

    waitlist = signups.filter((s) => s.waitlisted);

    const gameEntries = [];
    const seriesEntries = [];
    for (const t of teams) {
      for (const b of t.bowlers) {
        for (const g of b.games) {
          if (g !== null && g !== undefined) gameEntries.push({ name: b.name, pins: g });
        }
        if (b.hasAny) seriesEntries.push({ name: b.name, pins: b.series });
      }
    }
    if (gameEntries.length) {
      highlights = {
        highGame: gameEntries.reduce((m, e) => (e.pins > m.pins ? e : m)),
        highSeries: seriesEntries.reduce((m, e) => (e.pins > m.pins ? e : m)),
      };
    }
  }

  const viewerTeam = viewer
    ? standings.find((t) => t.bowlers.some((b) => b.user_id === viewer.id)) || null
    : null;

  let addable = [];
  if (viewer && viewer.is_admin && week.status !== 'completed') {
    const signedIds = new Set(signups.map((s) => s.user_id));
    addable = db.prepare('SELECT id, name, average FROM users ORDER BY name ASC').all()
      .filter((u) => !signedIds.has(u.id));
  }

  return {
    week, signups, signupOpen, viewerSignup, oddOut,
    standings, highlights, waitlist, viewerTeam, allScored, addable,
  };
}

// Winning team names for a completed week (for the history page).
function winnersFor(week) {
  if (week.status !== 'completed') return null;
  const smap = scoresMap(week.id);
  const teams = teamsFor(week.id).map((t) => {
    const total = [t.bowler1_id, t.bowler2_id].reduce((sum, uid) => {
      const r = smap[uid];
      return sum + (r ? (r.game1 || 0) + (r.game2 || 0) + (r.game3 || 0) : 0);
    }, 0);
    return { ...t, total };
  });
  if (!teams.length) return null;
  const max = Math.max(...teams.map((t) => t.total));
  if (max === 0) return null;
  const winners = teams.filter((t) => t.total === max);
  return {
    names: winners.map((t) => `${t.b1_name} & ${t.b2_name}`).join(', '),
    total: max,
  };
}

module.exports = {
  getWeek, ensureCurrentWeek, buildWeekView, winnersFor, canEditScores, signupsFor,
};
