const crypto = require('crypto');
const { Pool, types } = require('pg');

// BIGINT (int8) columns come back as strings by default; every big number in
// this app (epoch-ms timestamps, counts) fits safely in a JS number.
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Point it at the league Postgres database (see .env.example).');
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const ssl = isLocal
  ? false
  : (process.env.DATABASE_SSL === 'no-verify' ? { rejectUnauthorized: false } : { rejectUnauthorized: true });

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl,
  max: 3, // serverless: keep per-instance connections small
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('idle client error', err));

// Apply the schema once per process before the first real query. Idempotent,
// and serialized across concurrent cold starts with a transaction-scoped
// advisory lock (safe under pooled/transaction-mode connections).
const { SCHEMA_SQL } = require('./schema');
let readyPromise = null;

function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(727454001)');
        await client.query(SCHEMA_SQL);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    })().catch((e) => {
      readyPromise = null; // retry on the next request
      throw e;
    });
  }
  return readyPromise;
}

async function q(sql, params = []) {
  await ready();
  const result = await pool.query(sql, params);
  return result.rows;
}

async function one(sql, params = []) {
  await ready();
  const result = await pool.query(sql, params);
  return result.rows[0];
}

async function run(sql, params = []) {
  await ready();
  return pool.query(sql, params);
}

// Run fn inside a transaction; fn receives a client with .query().
async function tx(fn) {
  await ready();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function isUniqueViolation(e) {
  return Boolean(e) && e.code === '23505';
}

// Session-cookie signing key. Prefer an explicit SESSION_SECRET; otherwise
// derive a stable one from the database credentials so sessions survive
// restarts and cold starts with zero configuration.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  return crypto.createHash('sha256').update('luckydoubles-session|' + DATABASE_URL).digest('hex');
}

module.exports = { pool, q, one, run, tx, isUniqueViolation, sessionSecret };
