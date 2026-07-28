const { XeroClient } = require('xero-node');

function buildClient() {
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID,
    clientSecret: process.env.XERO_CLIENT_SECRET,
    redirectUris: [process.env.XERO_REDIRECT_URI],
    scopes: (process.env.XERO_SCOPES || '').split(/\s+/).filter(Boolean),
    httpTimeout: 30000,
  });
}

async function clientFromSession(session) {
  if (!session || !session.tokenSet) return null;
  const client = buildClient();
  client.setTokenSet(session.tokenSet);

  const expiresAt = session.tokenSet.expires_at
    ? session.tokenSet.expires_at * 1000
    : 0;
  if (expiresAt && expiresAt - Date.now() < 60_000) {
    const newTokenSet = await client.refreshToken();
    session.tokenSet = newTokenSet;
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

module.exports = { buildClient, clientFromSession };
