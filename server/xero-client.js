'use strict';

const { XeroClient } = require('xero-node');
const { saveRefreshToken } = require('./db');

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const refreshLocks = new Map();

function buildClient() {
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID,
    clientSecret: process.env.XERO_CLIENT_SECRET,
    redirectUris: [process.env.XERO_REDIRECT_URI],
    scopes: (process.env.XERO_SCOPES || '').split(/\s+/).filter(Boolean),
    httpTimeout: 30000,
  });
}

function normalizeXeroError(err) {
  const resp = err && err.response;
  if (resp && resp.statusCode === 429) {
    const headers = resp.headers || {};
    const retryAfter = Number(headers['retry-after']) || 0;
    const problem = headers['x-rate-limit-problem'] || 'unknown';
    const e = new Error(`Xero rate limit (${problem})`);
    e.statusCode = 429;
    e.retryAfter = retryAfter;
    e.rateLimitProblem = problem;
    return e;
  }
  return err;
}

async function refreshTokenSetOnce(client, session, req) {
  const key = (req && req.sessionID) || (session.tokenSet && session.tokenSet.refresh_token);
  if (!key) {
    const newTokenSet = await client.refreshToken();
    session.tokenSet = JSON.parse(JSON.stringify(newTokenSet));
    client.setTokenSet(session.tokenSet);
    return session.tokenSet;
  }
  if (refreshLocks.has(key)) {
    await refreshLocks.get(key);
    client.setTokenSet(session.tokenSet);
    return session.tokenSet;
  }
  const p = (async () => {
    try {
      const newTokenSet = await client.refreshToken();
      session.tokenSet = JSON.parse(JSON.stringify(newTokenSet));
      client.setTokenSet(session.tokenSet);

      try {
        const claims = newTokenSet.claims ? newTokenSet.claims() : null;
        const uid = claims && claims.xero_userid;
        if (uid && newTokenSet.refresh_token) {
          saveRefreshToken(uid, newTokenSet.refresh_token);
        }
      } catch (_) {}

      if (req && req.session && typeof req.session.save === 'function') {
        await new Promise((r, j) => req.session.save((err) => (err ? j(err) : r())));
      }
      return session.tokenSet;
    } catch (err) {
      const isInvalidGrant =
        err &&
        (err.error === 'invalid_grant' ||
          (err.response && err.response.statusCode === 400) ||
          /invalid[_ ]grant/i.test(err.message || ''));
      if (isInvalidGrant && req && req.session && typeof req.session.destroy === 'function') {
        try {
          await new Promise((r) => req.session.destroy(() => r()));
        } catch (_) {}
      }
      const wrapped = new Error(
        isInvalidGrant ? '登入已過期，請重新登入' : 'token refresh failed: ' + (err && err.message)
      );
      wrapped.statusCode = 401;
      throw wrapped;
    } finally {
      refreshLocks.delete(key);
    }
  })();
  refreshLocks.set(key, p);
  return p;
}

async function clientFromSession(session, req) {
  if (!session || !session.tokenSet) return null;
  const client = buildClient();
  client.setTokenSet(session.tokenSet);

  const expiresAt = session.tokenSet.expires_at ? session.tokenSet.expires_at * 1000 : 0;
  if (expiresAt && expiresAt - Date.now() < REFRESH_BUFFER_MS) {
    await refreshTokenSetOnce(client, session, req);
  }

  if (!session.tenants || !session.tenants.length) {
    const tenants = await client.updateTenants(false);
    session.tenants = tenants.map((t) => ({
      id: t.tenantId,
      name: t.tenantName || t.tenantId,
    }));
  }

  return client;
}

module.exports = { buildClient, clientFromSession, normalizeXeroError };
