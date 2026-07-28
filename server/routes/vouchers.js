const express = require('express');
const { clientFromSession } = require('../xero-client');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session || !req.session.tokenSet) {
    return res.status(401).json({ error: '尚未登入' });
  }
  if (!req.session.activeTenantId) {
    return res.status(400).json({ error: '尚未選擇公司' });
  }
  next();
}

function normalizeDate(iso) {
  if (!iso) return '';
  const m = /\/Date\((\d+)/.exec(String(iso));
  if (m) {
    const d = new Date(Number(m[1]));
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  const s = String(iso);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

router.get('/vouchers', requireAuth, async (req, res, next) => {
  try {
    const client = await clientFromSession(req.session);
    const tenantId = req.session.activeTenantId;

    const [billsResp, mjResp] = await Promise.all([
      client.accountingApi.getInvoices(
        tenantId,
        undefined,
        'Type=="ACCPAY"',
        'Date DESC',
        undefined,
        undefined,
        undefined,
        ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID'],
        undefined,
        false,
        false,
        undefined,
        true
      ),
      client.accountingApi.getManualJournals(
        tenantId,
        undefined,
        undefined,
        'Date DESC'
      ),
    ]);

    const bills = (billsResp.body.invoices || []).map((inv) => ({
      type: 'BILL',
      id: inv.invoiceID,
      number: inv.invoiceNumber || '',
      reference: inv.reference || '',
      date: normalizeDate(inv.date || ''),
      dueDate: normalizeDate(inv.dueDate || ''),
      status: inv.status || '',
      contact: inv.contact ? inv.contact.name : '',
      total: inv.total != null ? inv.total : 0,
      currency: inv.currencyCode || '',
    }));

    const mjs = (mjResp.body.manualJournals || []).map((mj) => ({
      type: 'MJ',
      id: mj.manualJournalID,
      number: mj.manualJournalID
        ? mj.manualJournalID.slice(0, 8).toUpperCase()
        : '',
      reference: mj.narration || '',
      date: normalizeDate(mj.date || ''),
      dueDate: '',
      status: mj.status || '',
      contact: '',
      total: (mj.journalLines || []).reduce(
        (s, l) => s + Math.max(0, l.lineAmount || 0),
        0
      ),
      currency: '',
    }));

    const merged = [...bills, ...mjs].sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : 0
    );

    res.json({
      tenantId,
      items: merged,
      refreshedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

async function fetchAccountsMap(client, tenantId) {
  try {
    const resp = await client.accountingApi.getAccounts(tenantId);
    const list = (resp.body && resp.body.accounts) || [];
    const map = {};
    for (const a of list) {
      if (a.code) map[a.code] = a.name || '';
    }
    return map;
  } catch (err) {
    console.error('getAccounts 失敗（會退回只顯示編號）:', err.message);
    return {};
  }
}

router.get('/vouchers/:type/:id', requireAuth, async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const client = await clientFromSession(req.session);
    const tenantId = req.session.activeTenantId;

    const accountsPromise = fetchAccountsMap(client, tenantId);

    if (type === 'BILL') {
      const [resp, accounts] = await Promise.all([
        client.accountingApi.getInvoice(tenantId, id),
        accountsPromise,
      ]);
      const inv = (resp.body.invoices || [])[0];
      if (!inv) return res.status(404).json({ error: '找不到 Bill' });
      res.json({ type: 'BILL', data: inv, accounts });
    } else if (type === 'MJ') {
      const [resp, accounts] = await Promise.all([
        client.accountingApi.getManualJournal(tenantId, id),
        accountsPromise,
      ]);
      const mj = (resp.body.manualJournals || [])[0];
      if (!mj) return res.status(404).json({ error: '找不到 Manual Journal' });
      res.json({ type: 'MJ', data: mj, accounts });
    } else {
      res.status(400).json({ error: '未知的憑證類型' });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
