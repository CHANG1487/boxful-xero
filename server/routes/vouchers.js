'use strict';

const express = require('express');
const { clientFromSession } = require('../xero-client');
const cache = require('../cache');
const { preloadTenant, PRELOAD_DAYS } = require('../preload');

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

function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function defaultDateRange() {
  const now = new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = new Date(to);
  from.setDate(from.getDate() - PRELOAD_DAYS);
  return { from: isoDay(from), to: isoDay(to) };
}

async function ensureCacheReady(client, tenantId) {
  if (cache.getTenant(tenantId)) return;
  const inflight = cache.waitIfLoading(tenantId);
  if (inflight) {
    await inflight;
    return;
  }
  await preloadTenant(client, tenantId);
}

function billsToRows(rawInvoices) {
  return rawInvoices.map((inv) => ({
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
}

function mjsToRows(rawMjs) {
  return rawMjs.map((mj) => ({
    type: 'MJ',
    id: mj.manualJournalID,
    number: mj.manualJournalID ? mj.manualJournalID.slice(0, 8).toUpperCase() : '',
    reference: mj.narration || '',
    date: normalizeDate(mj.date || ''),
    dueDate: '',
    status: mj.status || '',
    contact: '',
    total: (mj.journalLines || []).reduce((s, l) => s + Math.max(0, l.lineAmount || 0), 0),
    currency: '',
  }));
}

function bankTxToRow(typeCode) {
  return (bt) => ({
    type: typeCode,
    id: bt.bankTransactionID,
    number: bt.bankTransactionID ? bt.bankTransactionID.slice(0, 8).toUpperCase() : '',
    reference: bt.reference || '',
    date: normalizeDate(bt.date || ''),
    dueDate: '',
    status: bt.status || '',
    contact: bt.contact ? bt.contact.name : bt.bankAccount ? bt.bankAccount.name : '',
    total: bt.total != null ? bt.total : 0,
    currency: bt.currencyCode || '',
  });
}

function cnsToRows(rawCns) {
  return rawCns.map((cn) => ({
    type: 'CN',
    id: cn.creditNoteID,
    number:
      cn.creditNoteNumber ||
      (cn.creditNoteID ? cn.creditNoteID.slice(0, 8).toUpperCase() : ''),
    reference: cn.reference || '',
    date: normalizeDate(cn.date || ''),
    dueDate: normalizeDate(cn.dueDate || ''),
    status: cn.status || '',
    contact: cn.contact ? cn.contact.name : '',
    total: cn.total != null ? cn.total : 0,
    currency: cn.currencyCode || '',
  }));
}

function filterAndMerge(tc, q) {
  const type = String(q.type || '').toUpperCase();
  const number = String(q.number || '').trim();
  const contact = String(q.contact || '').trim();
  const narration = String(q.narration || '').trim();
  const status = String(q.status || '').trim().toUpperCase();
  const amountMin =
    q.amountMin !== undefined && q.amountMin !== '' ? Number(q.amountMin) : null;
  const amountMax =
    q.amountMax !== undefined && q.amountMax !== '' ? Number(q.amountMax) : null;

  const defaults = defaultDateRange();
  const dateFrom = isValidIsoDate(q.dateFrom) ? q.dateFrom : defaults.from;
  const dateTo = isValidIsoDate(q.dateTo) ? q.dateTo : defaults.to;

  const cacheFromIso = isoDay(tc.preloadedFrom);
  const stale = dateFrom < cacheFromIso;

  const wantsBill = !type || type === 'BILL';
  const wantsMJ = !type || type === 'MJ';
  const wantsRecv = !type || type === 'RECV';
  const wantsSpnd = !type || type === 'SPND';
  const wantsCn = !type || type === 'CN';

  let rows = [];
  if (wantsBill) rows = rows.concat(billsToRows(tc.vouchers.BILL || []));
  if (wantsMJ) rows = rows.concat(mjsToRows(tc.vouchers.MJ || []));
  if (wantsRecv) rows = rows.concat((tc.vouchers.RECV || []).map(bankTxToRow('RECV')));
  if (wantsSpnd) rows = rows.concat((tc.vouchers.SPND || []).map(bankTxToRow('SPND')));
  if (wantsCn) rows = rows.concat(cnsToRows(tc.vouchers.CN || []));

  const contains = (s, needle) =>
    !needle || String(s || '').toLowerCase().includes(needle.toLowerCase());

  const filtered = rows.filter((v) => {
    if (v.date && (v.date < dateFrom || v.date > dateTo)) return false;
    if (status && String(v.status || '').toUpperCase() !== status) return false;
    if (number && !contains(v.number, number) && !contains(v.reference, number)) return false;
    if (contact && !contains(v.contact, contact)) return false;
    if (narration && !contains(v.reference, narration)) return false;
    if (amountMin != null && Number(v.total || 0) < amountMin) return false;
    if (amountMax != null && Number(v.total || 0) > amountMax) return false;
    return true;
  });

  const merged = filtered.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return {
    items: merged,
    appliedDateFrom: dateFrom,
    appliedDateTo: dateTo,
    stale,
  };
}

router.get('/vouchers', requireAuth, async (req, res, next) => {
  try {
    const client = await clientFromSession(req.session, req);
    const tenantId = req.session.activeTenantId;
    if (String(req.query.force || '') === '1') cache.bust(tenantId);
    await ensureCacheReady(client, tenantId);
    const tc = cache.getTenant(tenantId);
    if (!tc) {
      return res.status(500).json({ error: '快取準備失敗' });
    }
    const result = filterAndMerge(tc, req.query || {});
    res.json({
      tenantId,
      ...result,
      preloadedAt: tc.preloadedAt,
      preloadedFrom: isoDay(tc.preloadedFrom),
      refreshedAt: tc.preloadedAt,
    });
  } catch (err) {
    next(err);
  }
});

function matchesId(v, type, id) {
  switch (type) {
    case 'BILL':
      return v.invoiceID === id;
    case 'MJ':
      return v.manualJournalID === id;
    case 'RECV':
    case 'SPND':
      return v.bankTransactionID === id;
    case 'CN':
      return v.creditNoteID === id;
    default:
      return false;
  }
}

router.get('/vouchers/:type/:id', requireAuth, async (req, res, next) => {
  try {
    const client = await clientFromSession(req.session, req);
    const tenantId = req.session.activeTenantId;
    const { type, id } = req.params;

    await ensureCacheReady(client, tenantId);
    const tc = cache.getTenant(tenantId);
    if (!tc) return res.status(500).json({ error: '快取準備失敗' });

    const list = tc.vouchers[type];
    if (!list) return res.status(400).json({ error: '未知的憑證類型' });

    const found = list.find((v) => matchesId(v, type, id));
    if (!found) {
      return res
        .status(404)
        .json({ error: '找不到此憑證（可能已超出 90 天預拉範圍，請按【重新整理】重新載入）' });
    }
    res.json({ type, data: found, accounts: tc.accounts || {} });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
