// Lucky Doubles schema (Postgres). Single source of truth — applied
// automatically on boot (see db.js) and by `npm run schema`. Idempotent.

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  average INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS weeks (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  deadline BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paired', 'completed')),
  paired_at BIGINT,
  completed_at BIGINT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS signups (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  waitlisted INTEGER NOT NULL DEFAULT 0,
  avg_snapshot INTEGER,
  UNIQUE (week_id, user_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  team_number INTEGER NOT NULL,
  bowler1_id INTEGER NOT NULL REFERENCES users(id),
  bowler2_id INTEGER NOT NULL REFERENCES users(id),
  UNIQUE (week_id, team_number)
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game1 INTEGER,
  game2 INTEGER,
  game3 INTEGER,
  UNIQUE (week_id, user_id)
);
`;

module.exports = { SCHEMA_SQL };
