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

function isValidIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toXeroDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `DateTime(${y},${m},${d})`;
}

function defaultDateRange() {
  const now = new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = new Date(to);
  from.setDate(from.getDate() - 60);
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;
  return { from: iso(from), to: iso(to) };
}

async function fetchAllInvoices(client, tenantId, where, statuses) {
  const all = [];
  const pageSize = 1000; // 配合 summaryOnly=true
  const MAX_PAGES = 100;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await client.accountingApi.getInvoices(
      tenantId,
      undefined,
      where,
      'Date DESC',
      undefined,
      undefined,
      undefined,
      statuses,
      page,
      false,
      false,
      undefined,
      true,
      pageSize
    );
    const items = (resp.body && resp.body.invoices) || [];
    all.push(...items);
    if (items.length < pageSize) return all;
  }
  console.warn(
    `fetchAllInvoices reached MAX_PAGES for tenant ${tenantId}; results may be truncated`
  );
  return all;
}

async function fetchAllManualJournals(client, tenantId, where) {
  const all = [];
  const pageSize = 100; // Xero MJ 上限
  const MAX_PAGES = 100;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await client.accountingApi.getManualJournals(
      tenantId,
      undefined,
      where,
      'Date DESC',
      page,
      pageSize
    );
    const items = (resp.body && resp.body.manualJournals || []);
    all.push(...items);
    if (items.length < pageSize) return all;
  }
  console.warn(
    `fetchAllManualJournals reached MAX_PAGES for tenant ${tenantId}; results may be truncated`
  );
  return all;
}

router.get('/vouchers', requireAuth, async (req, res, next) => {
  try {
    const client = await clientFromSession(req.session);
    const tenantId = req.session.activeTenantId;

    const q = req.query || {};
    const type = String(q.type || '').toUpperCase();
    const number = String(q.number || '').trim();
    const contact = String(q.contact || '').trim();
    const narration = String(q.narration || '').trim();
    const status = String(q.status || '').trim().toUpperCase();
    const amountMin =
      q.amountMin !== undefined && q.amountMin !== ''
        ? Number(q.amountMin)
        : null;
    const amountMax =
      q.amountMax !== undefined && q.amountMax !== ''
        ? Number(q.amountMax)
        : null;

    const defaults = defaultDateRange();
    const dateFrom = isValidIsoDate(q.dateFrom) ? q.dateFrom : defaults.from;
    const dateTo = isValidIsoDate(q.dateTo) ? q.dateTo : defaults.to;

    const dateClause = `Date>=${toXeroDate(dateFrom)} && Date<=${toXeroDate(
      dateTo
    )}`;

    const billsWhere = `Type=="ACCPAY" && ${dateClause}`;
    const billsStatuses =
      status && ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID'].includes(status)
        ? [status]
        : ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID'];

    let mjWhere = dateClause;
    if (status && ['DRAFT', 'POSTED'].includes(status)) {
      mjWhere += ` && Status=="${status}"`;
    }

    const tasks = [];
    if (type !== 'MJ') {
      tasks.push(fetchAllInvoices(client, tenantId, billsWhere, billsStatuses));
    } else {
      tasks.push(Promise.resolve([]));
    }
    if (type !== 'BILL') {
      tasks.push(fetchAllManualJournals(client, tenantId, mjWhere));
    } else {
      tasks.push(Promise.resolve([]));
    }
    const [rawInvoices, rawMjs] = await Promise.all(tasks);

    const bills = rawInvoices.map((inv) => ({
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

    const mjs = rawMjs.map((mj) => ({
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

    const contains = (s, needle) =>
      !needle ||
      String(s || '')
        .toLowerCase()
        .includes(needle.toLowerCase());

    const filtered = [...bills, ...mjs].filter((v) => {
      if (
        number &&
        !contains(v.number, number) &&
        !contains(v.reference, number)
      )
        return false;
      if (contact && !contains(v.contact, contact)) return false;
      if (narration && !contains(v.reference, narration)) return false;
      if (amountMin != null && Number(v.total || 0) < amountMin) return false;
      if (amountMax != null && Number(v.total || 0) > amountMax) return false;
      return true;
    });

    const merged = filtered.sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : 0
    );

    res.json({
      tenantId,
      items: merged,
      appliedDateFrom: dateFrom,
      appliedDateTo: dateTo,
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
