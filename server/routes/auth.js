const express = require('express');
const { buildClient } = require('../xero-client');
const { saveRefreshToken } = require('../db');

const router = express.Router();

router.get('/login', async (req, res, next) => {
  try {
    const client = buildClient();
    const consentUrl = await client.buildConsentUrl();
    res.redirect(consentUrl);
  } catch (err) {
    next(err);
  }
});

router.get('/callback', async (req, res, next) => {
  try {
    const client = buildClient();
    const tokenSet = await client.apiCallback(req.protocol + '://' + req.get('host') + req.originalUrl);

    const tenants = await client.updateTenants(false);

    req.session.tokenSet = tokenSet;
    req.session.tenants = tenants.map((t) => ({
      id: t.tenantId,
      name: t.tenantName || t.tenantId,
    }));

    if (!req.session.activeTenantId && req.session.tenants.length) {
      req.session.activeTenantId = req.session.tenants[0].id;
    }

    try {
      const claims = tokenSet.claims ? tokenSet.claims() : null;
      const userId = claims && claims.xero_userid ? claims.xero_userid : null;
      if (userId && tokenSet.refresh_token) {
        saveRefreshToken(userId, tokenSet.refresh_token);
      }
    } catch (_) {}

    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback failed:', err);
    res.status(500).send(
      '<meta charset="utf-8"><h1>登入失敗</h1><p>' +
        (err && err.message ? err.message : '請重試') +
        '</p><a href="/">回首頁</a>'
    );
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

module.exports = router;
