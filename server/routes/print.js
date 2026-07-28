const express = require('express');
const { markPrinted } = require('../db');

const router = express.Router();

router.post('/mark-printed', express.json(), (req, res) => {
  if (!req.session || !req.session.tokenSet) {
    return res.status(401).json({ error: '尚未登入' });
  }
  const tenantId = req.session.activeTenantId;
  if (!tenantId) return res.status(400).json({ error: '尚未選擇公司' });

  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  const cleaned = items
    .filter((r) => r && (r.type === 'BILL' || r.type === 'MJ') && r.id)
    .map((r) => ({ type: r.type, id: String(r.id) }));

  if (!cleaned.length) return res.status(400).json({ error: '沒有可標記的項目' });

  const printedBy =
    (req.session.tokenSet.claims && (() => {
      try {
        return req.session.tokenSet.claims().email || null;
      } catch (_) {
        return null;
      }
    })()) || null;

  markPrinted(tenantId, cleaned, printedBy);
  res.json({ ok: true, count: cleaned.length });
});

module.exports = router;
