const express = require('express');

const router = express.Router();

router.get('/me', (req, res) => {
  const loggedIn = !!(req.session && req.session.tokenSet);
  res.json({
    loggedIn,
    tenants: loggedIn ? req.session.tenants || [] : [],
    activeTenantId: loggedIn ? req.session.activeTenantId || null : null,
  });
});

router.post('/tenants/switch', express.json(), (req, res) => {
  const { tenantId } = req.body || {};
  if (!req.session.tenants || !req.session.tenants.some((t) => t.id === tenantId)) {
    return res.status(400).json({ error: '無效的 tenantId' });
  }
  req.session.activeTenantId = tenantId;
  res.json({ ok: true, activeTenantId: tenantId });
});

module.exports = router;
