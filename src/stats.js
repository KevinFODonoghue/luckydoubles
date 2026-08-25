const { db } = require('./db');

// Season stats across all completed weeks: per bowler — nights bowled, team wins,
// games entered, average per game, high game, high series.
function seasonStats() {
  const weeks = db.prepare("SELECT * FROM weeks WHERE status = 'completed' ORDER BY date ASC").all();
  const perUser = new Map();

  const touch = (userId) => {
    if (!perUser.has(userId)) {
      perUser.set(userId, { user_id: userId, nights: 0, wins: 0, games: 0, pins: 0, highGame: 0, highSeries: 0 });
    }
    return perUser.get(userId);
  };

  for (const week of weeks) {
    const teams = db.prepare('SELECT * FROM teams WHERE week_id = ?').all(week.id);
    if (!teams.length) continue;

    const scores = {};
    for (const r of db.prepare('SELECT * FROM scores WHERE week_id = ?').all(week.id)) {
      scores[r.user_id] = r;
    }

    const totals = teams.map((t) => {
      const total = [t.bowler1_id, t.bowler2_id].reduce((sum, uid) => {
        const s = scores[uid];
        return sum + (s ? (s.game1 || 0) + (s.game2 || 0) + (s.game3 || 0) : 0);
      }, 0);
      return { team: t, total };
    });
    const max = Math.max(...totals.map((t) => t.total));

    for (const { team, total } of totals) {
      for (const uid of [team.bowler1_id, team.bowler2_id]) {
        const stat = touch(uid);
        stat.nights++;
        if (max > 0 && total === max) stat.wins++;

        const s = scores[uid];
        if (s) {
          const games = [s.game1, s.game2, s.game3].filter((g) => g !== null && g !== undefined);
          if (games.length) {
            stat.games += games.length;
            const series = games.reduce((a, b) => a + b, 0);
            stat.pins += series;
            stat.highGame = Math.max(stat.highGame, ...games);
            stat.highSeries = Math.max(stat.highSeries, series);
          }
        }
      }
    }
  }

  const rows = [];
  for (const stat of perUser.values()) {
    const user = db.prepare('SELECT name, average FROM users WHERE id = ?').get(stat.user_id);
    if (!user) continue;
    rows.push({
      ...stat,
      name: user.name,
      average: user.average,
      avgPerGame: stat.games ? Math.round(stat.pins / stat.games) : null,
    });
  }

  rows.sort((a, b) => (b.wins - a.wins) || ((b.avgPerGame || 0) - (a.avgPerGame || 0)) || a.name.localeCompare(b.name));
  return { rows, completedWeeks: weeks.length };
}

module.exports = { seasonStats };
