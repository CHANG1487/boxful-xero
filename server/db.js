const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS xero_auth (
    user_id       TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const stmts = {
  upsertRefreshToken: db.prepare(`
    INSERT INTO xero_auth (user_id, refresh_token)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE
      SET refresh_token = excluded.refresh_token,
          updated_at    = datetime('now')
  `),
  getRefreshToken: db.prepare(`SELECT refresh_token FROM xero_auth WHERE user_id = ?`),
};

function saveRefreshToken(userId, refreshToken) {
  stmts.upsertRefreshToken.run(userId, refreshToken);
}

function loadRefreshToken(userId) {
  const row = stmts.getRefreshToken.get(userId);
  return row ? row.refresh_token : null;
}

module.exports = {
  db,
  saveRefreshToken,
  loadRefreshToken,
};
