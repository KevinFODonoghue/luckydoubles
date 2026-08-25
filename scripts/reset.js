// Deletes the database for a fresh start. Run with: npm run reset
// After a reset, the FIRST account to register becomes the league admin.

const fs = require('fs');
const path = require('path');

const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
let removed = 0;
for (const f of ['league.db', 'league.db-wal', 'league.db-shm']) {
  try {
    fs.rmSync(path.join(dir, f));
    removed++;
  } catch {}
}
console.log(removed ? 'Database deleted — fresh start.' : 'No database found — already fresh.');
console.log('The first account to register becomes the league admin.');
