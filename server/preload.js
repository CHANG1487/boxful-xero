'use strict';

const cache = require('./cache');
const { normalizeXeroError } = require('./xero-client');

const PRELOAD_DAYS = 90;

function xeroDateLiteral(d) {
  return `DateTime(${d.getFullYear()},${d.getMonth() + 1},${d.getDate()})`;
}

async function fetchAllInvoices(client, tenantId, where, statuses) {
  const all = [];
  const pageSize = 100;
  const MAX_PAGES = 200;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let resp;
    try {
      resp = await client.accountingApi.getInvoices(
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
        false,
        pageSize
      );
    } catch (err) {
      throw normalizeXeroError(err);
    }
    const items = (resp.body && resp.body.invoices) || [];
    all.push(...items);
    if (items.length < pageSize) return all;
  }
  console.warn(`fetchAllInvoices reached MAX_PAGES for tenant ${tenantId}; results may be truncated`);
  return all;
}

async function fetchAllManualJournals(client, tenantId, where) {
  const all = [];
  const pageSize = 100;
  const MAX_PAGES = 200;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let resp;
    try {
      resp = await client.accountingApi.getManualJournals(
        tenantId,
        undefined,
        where,
        'Date DESC',
        page,
        pageSize
      );
    } catch (err) {
      throw normalizeXeroError(err);
    }
    const items = (resp.body && resp.body.manualJournals) || [];
    all.push(...items);
    if (items.length < pageSize) return all;
  }
  console.warn(`fetchAllManualJournals reached MAX_PAGES for tenant ${tenantId}; results may be truncated`);
  return all;
}

async function fetchAllBankTransactions(client, tenantId, where) {
  const all = [];
  const pageSize = 100;
  const MAX_PAGES = 200;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let resp;
    try {
      resp = await client.accountingApi.getBankTransactions(
        tenantId,
        undefined,
        where,
        'Date DESC',
        page,
        undefined,
        pageSize
      );
    } catch (err) {
      throw normalizeXeroError(err);
    }
    const items = (resp.body && resp.body.bankTransactions) || [];
    all.push(...items);
    if (items.length < pageSize) return all;
  }
  console.warn(`fetchAllBankTransactions reached MAX_PAGES for tenant ${tenantId}; results may be truncated`);
  return all;
}

async function fetchAllCreditNotes(client, tenantId, where) {
  const all = [];
  const pageSize = 100;
  const MAX_PAGES = 200;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let resp;
    try {
      resp = await client.accountingApi.getCreditNotes(
        tenantId,
        undefined,
        where,
        'Date DESC',
        page,
        undefined,
        pageSize
      );
    } catch (err) {
      throw normalizeXeroError(err);
    }
    const items = (resp.body && resp.body.creditNotes) || [];
    all.push(...items);
    if (items.length < pageSize) return all;
  }
  console.warn(`fetchAllCreditNotes reached MAX_PAGES for tenant ${tenantId}; results may be truncated`);
  return all;
}

async function fetchAccountsMap(client, tenantId) {
  let resp;
  try {
    resp = await client.accountingApi.getAccounts(tenantId);
  } catch (err) {
    throw normalizeXeroError(err);
  }
  const list = (resp.body && resp.body.accounts) || [];
  const map = {};
  for (const a of list) {
    if (a.code) map[a.code] = a.name || '';
  }
  return map;
}

async function doPreload(client, tenantId) {
  const dateTo = new Date();
  const dateFrom = new Date(Date.now() - PRELOAD_DAYS * 24 * 3600 * 1000);
  const dateClause = `Date>=${xeroDateLiteral(dateFrom)} && Date<=${xeroDateLiteral(dateTo)}`;

  const billsWhere = `Type=="ACCPAY" && ${dateClause}`;
  const billStatuses = ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID'];
  const mjWhere = dateClause;
  const recvWhere = `(Type=="RECEIVE" || Type=="RECEIVE-OVERPAYMENT" || Type=="RECEIVE-PREPAYMENT") && Status=="AUTHORISED" && ${dateClause}`;
  const spndWhere = `(Type=="SPEND" || Type=="SPEND-OVERPAYMENT" || Type=="SPEND-PREPAYMENT") && Status=="AUTHORISED" && ${dateClause}`;
  const cnWhere = `${dateClause} && (Status=="DRAFT" || Status=="SUBMITTED" || Status=="AUTHORISED" || Status=="PAID")`;

  const startedAt = Date.now();
  console.log(`[preload] tenant=${tenantId} 開始拉取近 ${PRELOAD_DAYS} 天資料`);

  const [bills, mjs, recv, spnd, cns, accounts] = await Promise.all([
    fetchAllInvoices(client, tenantId, billsWhere, billStatuses),
    fetchAllManualJournals(client, tenantId, mjWhere),
    fetchAllBankTransactions(client, tenantId, recvWhere),
    fetchAllBankTransactions(client, tenantId, spndWhere),
    fetchAllCreditNotes(client, tenantId, cnWhere),
    fetchAccountsMap(client, tenantId),
  ]);

  cache.setTenantData(tenantId, {
    vouchers: { BILL: bills, MJ: mjs, RECV: recv, SPND: spnd, CN: cns },
    accounts,
    preloadedFrom: dateFrom,
    preloadedAt: new Date(),
  });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const total = bills.length + mjs.length + recv.length + spnd.length + cns.length;
  console.log(`[preload] tenant=${tenantId} 完成 ${total} 張憑證 / ${elapsed} 秒`);
}

async function preloadTenant(client, tenantId) {
  if (!client || !tenantId) return null;
  const inflight = cache.waitIfLoading(tenantId);
  if (inflight) return inflight;
  const p = doPreload(client, tenantId);
  cache.markLoading(tenantId, p);
  return p;
}

module.exports = { preloadTenant, PRELOAD_DAYS };
