'use strict';

const express = require('express');
const { clientFromSession } = require('../xero-client');
const { preloadTenant } = require('../preload');
const cache = require('../cache');

const router = express.Router();

router.get('/me', (req, res) => {
  const loggedIn = !!(req.session && req.session.tokenSet);
  res.json({
    loggedIn,
    tenants: loggedIn ? req.session.tenants || [] : [],
    activeTenantId: loggedIn ? req.session.activeTenantId || null : null,
  });
});

router.post('/tenants/switch', express.json(), async (req, res) => {
  const { tenantId } = req.body || {};
  if (!req.session.tenants || !req.session.tenants.some((t) => t.id === tenantId)) {
    return res.status(400).json({ error: '無效的 tenantId' });
  }
  req.session.activeTenantId = tenantId;
  cache.bust(tenantId);
  res.json({ ok: true, activeTenantId: tenantId });

  clientFromSession(req.session, req)
    .then((client) => client && preloadTenant(client, tenantId))
    .catch((err) => console.error('[preload after tenant switch]', err && err.message));
});

module.exports = router;
