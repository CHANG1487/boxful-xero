const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS printed_vouchers (
    tenant_id     TEXT NOT NULL,
    voucher_type  TEXT NOT NULL CHECK (voucher_type IN ('BILL','MJ')),
    voucher_id    TEXT NOT NULL,
    printed_at    TEXT NOT NULL DEFAULT (datetime('now')),
    printed_by    TEXT,
    PRIMARY KEY (tenant_id, voucher_type, voucher_id)
  );

  CREATE TABLE IF NOT EXISTS xero_auth (
    user_id       TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const stmts = {
  insertPrinted: db.prepare(`
    INSERT OR IGNORE INTO printed_vouchers
      (tenant_id, voucher_type, voucher_id, printed_by)
    VALUES (?, ?, ?, ?)
  `),
  isPrinted: db.prepare(`
    SELECT 1 FROM printed_vouchers
     WHERE tenant_id = ? AND voucher_type = ? AND voucher_id = ?
  `),
  listPrintedIds: db.prepare(`
    SELECT voucher_type, voucher_id FROM printed_vouchers
     WHERE tenant_id = ?
  `),
  upsertRefreshToken: db.prepare(`
    INSERT INTO xero_auth (user_id, refresh_token)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE
      SET refresh_token = excluded.refresh_token,
          updated_at    = datetime('now')
  `),
  getRefreshToken: db.prepare(`SELECT refresh_token FROM xero_auth WHERE user_id = ?`),
};

function markPrinted(tenantId, items, printedBy) {
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      stmts.insertPrinted.run(tenantId, r.type, r.id, printedBy || null);
    }
  });
  tx(items);
}

function printedIdSet(tenantId) {
  const rows = stmts.listPrintedIds.all(tenantId);
  return new Set(rows.map((r) => `${r.voucher_type}:${r.voucher_id}`));
}

function saveRefreshToken(userId, refreshToken) {
  stmts.upsertRefreshToken.run(userId, refreshToken);
}

function loadRefreshToken(userId) {
  const row = stmts.getRefreshToken.get(userId);
  return row ? row.refresh_token : null;
}

module.exports = {
  db,
  markPrinted,
  printedIdSet,
  saveRefreshToken,
  loadRefreshToken,
};
