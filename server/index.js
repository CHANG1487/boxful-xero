require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');

require('./db');

const authRouter = require('./routes/auth');
const tenantsRouter = require('./routes/tenants');
const vouchersRouter = require('./routes/vouchers');
const printRouter = require('./routes/print');

const app = express();

app.set('trust proxy', 1);

const sessionDb = new Database(path.join(__dirname, '..', 'data', 'sessions.sqlite'));

app.use(
  session({
    store: new SqliteStore({
      client: sessionDb,
      expired: {
        clear: true,
        intervalMs: 15 * 60 * 1000,
      },
    }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7,
      secure: false,
    },
  })
);

app.use('/auth', authRouter);
app.use('/api', tenantsRouter);
app.use('/api', vouchersRouter);
app.use('/api', printRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, _next) => {
  console.error(err);
  const status = err.statusCode || err.status || 500;
  const message =
    (err.response && err.response.body && err.response.body.Message) ||
    err.message ||
    '伺服器錯誤';
  res.status(status).json({ error: message });
});

const PORT = Number(process.env.PORT || 3000);

if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
  console.warn(
    '\n⚠️  尚未設定 XERO_CLIENT_ID / XERO_CLIENT_SECRET，請複製 .env.example 為 .env 並填入 Xero App 憑證。\n'
  );
}

app.listen(PORT, () => {
  console.log(`✅ Xero 憑證列印平台已啟動： http://localhost:${PORT}`);
});
