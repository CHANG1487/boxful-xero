require('dotenv').config();
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const { XeroClient } = require('xero-node');

admin.initializeApp();

const db = admin.firestore();
const TOKEN_DOC = db.collection('xeroTokens').doc('default');

async function readTokenStore() {
    try {
        const snap = await TOKEN_DOC.get();
        return snap.exists ? snap.data() : {};
    } catch (e) {
        console.error('Error reading token store:', e);
        return {};
    }
}

async function writeTokenStore(data) {
    try {
        await TOKEN_DOC.set(data);
    } catch (e) {
        console.error('Error writing token store:', e);
    }
}

// 相容舊版 token 格式（tenantId 單數 → tenants 陣列）
function normalizeTenantStore(store) {
    if (!store.tokenSet) return store;
    const tenants = store.tenants || (store.tenantId
        ? [{ tenantId: store.tenantId, tenantName: store.tenantName || store.tenantId }]
        : []);
    const activeTenantId = store.activeTenantId || store.tenantId;
    const activeTenantName = store.activeTenantName || store.tenantName;
    return { ...store, tenants, activeTenantId, activeTenantName };
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const xero = new XeroClient({
    clientId: process.env.XERO_CLIENT_ID,
    clientSecret: process.env.XERO_CLIENT_SECRET,
    redirectUris: [process.env.XERO_REDIRECT_URI],
    scopes: ['openid', 'profile', 'email', 'offline_access']
});

const verifyAuth = async (req, res, next) => {
    if (process.env.FUNCTIONS_EMULATOR === 'true') {
        req.user = { uid: 'local-test-user' };
        return next();
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send('Unauthorized');
    }
    try {
        req.user = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        next();
    } catch (error) {
        res.status(401).send('Unauthorized');
    }
};

// ==========================================
// Xero OAuth Routes
// ==========================================

app.get('/xero/auth-url', verifyAuth, async (req, res) => {
    try {
        const scopes = 'openid profile email offline_access accounting.invoices accounting.banktransactions.read accounting.manualjournals.read accounting.contacts accounting.settings.read accounting.reports.balancesheet.read accounting.reports.profitandloss.read accounting.reports.trialbalance.read accounting.reports.executivesummary.read';
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: process.env.XERO_CLIENT_ID,
            redirect_uri: process.env.XERO_REDIRECT_URI,
            scope: scopes,
            state: Math.random().toString(36).substring(7)
        });
        res.json({ url: `https://login.xero.com/identity/connect/authorize?${params}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate auth URL' });
    }
});

app.get('/auth/xero/callback', async (req, res) => {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    try {
        const { code } = req.query;
        if (!code) return res.redirect(`${frontendUrl}/?xero=error&reason=no_code`);

        const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(
                    `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`
                ).toString('base64')
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.XERO_REDIRECT_URI
            }).toString()
        });

        const tokenSet = await tokenResponse.json();
        if (tokenSet.error) {
            console.error('Token exchange error:', tokenSet);
            return res.redirect(`${frontendUrl}/?xero=error&reason=token_exchange`);
        }

        const tenantResponse = await fetch('https://api.xero.com/connections', {
            headers: { 'Authorization': `Bearer ${tokenSet.access_token}` }
        });
        const tenants = await tenantResponse.json();

        if (!Array.isArray(tenants) || !tenants.length) {
            return res.redirect(`${frontendUrl}/?xero=error&reason=no_tenant`);
        }

        const existing = normalizeTenantStore(await readTokenStore());
        const preservedId = existing.activeTenantId && tenants.find(t => t.tenantId === existing.activeTenantId)
            ? existing.activeTenantId
            : tenants[0].tenantId;
        const activeTenant = tenants.find(t => t.tenantId === preservedId);

        await writeTokenStore({
            tokenSet,
            tenants,
            activeTenantId: activeTenant.tenantId,
            activeTenantName: activeTenant.tenantName,
            updatedAt: new Date().toISOString()
        });

        res.redirect(`${frontendUrl}/?xero=connected`);
    } catch (err) {
        console.error('Xero Callback Error:', err);
        res.redirect(`${frontendUrl}/?xero=error&reason=server_error`);
    }
});

app.get('/xero/tenants', verifyAuth, async (req, res) => {
    const store = normalizeTenantStore(await readTokenStore());
    if (!store.tokenSet) return res.json({ connected: false });
    res.json({
        connected: true,
        tenants: store.tenants,
        activeTenantId: store.activeTenantId,
        activeTenantName: store.activeTenantName
    });
});

app.post('/xero/tenant/select', verifyAuth, async (req, res) => {
    try {
        const { tenantId } = req.body;
        const store = normalizeTenantStore(await readTokenStore());
        const tenant = store.tenants.find(t => t.tenantId === tenantId);
        if (!tenant) return res.status(400).json({ error: 'Tenant not found' });
        await writeTokenStore({ ...store, activeTenantId: tenantId, activeTenantName: tenant.tenantName });
        res.json({ success: true, tenantName: tenant.tenantName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function isAccessTokenExpired(tokenSet) {
    try {
        const payload = JSON.parse(Buffer.from(tokenSet.access_token.split('.')[1], 'base64').toString());
        return payload.exp < Math.floor(Date.now() / 1000) + 60; // refresh 60s early
    } catch {
        return true; // if we can't decode, assume expired
    }
}

async function refreshXeroToken(tokenSet) {
    const response = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(
                `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`
            ).toString('base64')
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tokenSet.refresh_token
        }).toString()
    });
    const newTokenSet = await response.json();
    if (newTokenSet.error) throw new Error(`Token refresh failed: ${newTokenSet.error}`);
    return newTokenSet;
}

async function getValidXeroClient() {
    const store = normalizeTenantStore(await readTokenStore());
    if (!store.tokenSet) throw new Error('Xero not connected');
    let tokenSet = store.tokenSet;
    if (isAccessTokenExpired(tokenSet)) {
        console.log('Access token expired, refreshing...');
        tokenSet = await refreshXeroToken(tokenSet);
        await writeTokenStore({ ...store, tokenSet, updatedAt: new Date().toISOString() });
    }
    xero.setTokenSet(tokenSet);
    return { xero, tenantId: store.activeTenantId, tenantName: store.activeTenantName };
}

// 用 raw fetch 呼叫 Xero API（for reports / accounts endpoints not fully wrapped by xero-node）
async function xeroFetch(path, queryParams = {}) {
    // 呼叫前確認 token 未過期
    await getValidXeroClient();
    const freshStore = normalizeTenantStore(await readTokenStore());

    const url = new URL(`https://api.xero.com/api.xro/2.0/${path}`);
    Object.entries(queryParams).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });

    const response = await fetch(url.toString(), {
        headers: {
            'Authorization': `Bearer ${freshStore.tokenSet.access_token}`,
            'Xero-tenant-id': freshStore.activeTenantId,
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Xero API ${response.status}: ${body}`);
    }
    return response.json();
}

// ==========================================
// Reports
// ==========================================

// 報表清單（每個 tenant 可有不同設定）
const TENANT_REPORTS = {
    // Boxful TW
    '2cd792df-9e0c-415f-9cc8-5b42ab48dc1a': [
        { ReportID: 'BalanceSheet',  ReportName: 'Balance Sheet_20220712_M',   dateType: 'single', defaultParams: { timeframe: 'MONTH', periods: '11' } },
        { ReportID: 'ProfitAndLoss', ReportName: 'Profit and Loss_20220718_M', dateType: 'single', defaultParams: { timeframe: 'MONTH', periods: '11' } },
    ],
    // fallback for other tenants
    _default: [
        { ReportID: 'ProfitAndLoss',    ReportName: '損益表 (Profit & Loss)',            dateType: 'range',  defaultParams: {} },
        { ReportID: 'BalanceSheet',     ReportName: '資產負債表 (Balance Sheet)',         dateType: 'single', defaultParams: {} },
        { ReportID: 'TrialBalance',     ReportName: '試算表 (Trial Balance)',             dateType: 'single', defaultParams: {} },
        { ReportID: 'ExecutiveSummary', ReportName: '執行摘要 (Executive Summary)',       dateType: 'single', defaultParams: {} },
    ]
};

app.get('/reports/list', verifyAuth, async (req, res) => {
    const store = normalizeTenantStore(await readTokenStore());
    const tenantId = store.activeTenantId;
    const list = TENANT_REPORTS[tenantId] || TENANT_REPORTS._default;
    res.json(list);
});

// 執行指定報表（by ReportID，支援標準報表 & 自訂報表）
app.get('/reports/run/:reportId', verifyAuth, async (req, res) => {
    try {
        const { reportId } = req.params;
        const { fromDate, toDate, date, timeframe, periods } = req.query;
        const params = {};
        if (fromDate) params.fromDate = fromDate;
        if (toDate) params.toDate = toDate;
        if (date) params.date = date;
        if (timeframe) params.timeframe = timeframe;
        if (periods) params.periods = periods;

        const data = await xeroFetch(`Reports/${reportId}`, params);
        const report = (data.Reports || [data])[0];
        res.json(report);
    } catch (err) {
        console.error('Run report error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 科目明細表 - Account Transactions
app.get('/reports/account-transactions', verifyAuth, async (req, res) => {
    try {
        const { accountID, fromDate, toDate } = req.query;
        const data = await xeroFetch('Reports/AccountTransactions', { accountID, fromDate, toDate });
        const report = (data.Reports || [data])[0];
        res.json(report);
    } catch (err) {
        console.error('Account Transactions error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 科目明細（Invoices + BankTransactions + ManualJournals 合併，涵蓋所有交易類型）
async function fetchAllPages(path, params, arrayKey) {
    const results = [];
    for (let page = 1; page <= 20; page++) {
        const data = await xeroFetch(path, { ...params, page: String(page) });
        const batch = data[arrayKey] || [];
        results.push(...batch);
        if (batch.length < 100) break;
    }
    return results;
}

app.get('/reports/account-ledger', verifyAuth, async (req, res) => {
    try {
        const { accountCodes, fromDate, toDate } = req.query;
        const targetCodes = accountCodes ? accountCodes.split(',').filter(Boolean) : [];

        // Build DateTime where clause (same format works for all three APIs)
        const dateConds = [];
        if (fromDate) { const [y,m,d] = fromDate.split('-').map(Number); dateConds.push(`Date>=DateTime(${y},${m},${d})`); }
        if (toDate)   { const [y,m,d] = toDate.split('-').map(Number);   dateConds.push(`Date<=DateTime(${y},${m},${d})`); }
        const dateWhere = dateConds.join('&&');

        const invWhere  = ['Status!="DELETED"','Status!="VOIDED"', ...dateConds].join('&&');
        const btWhere   = ['Status!="DELETED"', ...dateConds].join('&&');
        const mjWhere   = ['Status!="DELETED"', ...dateConds].join('&&');

        // Fetch all three sources in parallel
        const [invoices, bankTxns, journals] = await Promise.all([
            fetchAllPages('Invoices',          { where: invWhere, summaryOnly: 'false', unitdp: '4' }, 'Invoices'),
            fetchAllPages('BankTransactions',  { where: btWhere,  unitdp: '4' },                       'BankTransactions'),
            fetchAllPages('ManualJournals',    { where: mjWhere },                                      'ManualJournals'),
        ]);

        const dataRows = [];
        let totalDebit = 0, totalCredit = 0;

        const pushRow = (row, rawNet) => {
            const debit  = rawNet > 0 ? rawNet : 0;
            const credit = rawNet < 0 ? -rawNet : 0;
            totalDebit  += debit;
            totalCredit += credit;
            dataRows.push({ ...row, debit, credit });
        };

        // Invoices / Bills
        // Bills (ACCPAY) → Credit; Invoices (ACCREC) → Debit
        for (const inv of invoices) {
            const date    = (inv.DateString || '').substring(0, 10);
            const source  = inv.Type === 'ACCPAY' ? 'Bill' : 'Invoice';
            const contact = inv.Contact?.Name || '';
            const ref     = [inv.InvoiceNumber, inv.Reference].filter(Boolean).join(' / ');
            for (const li of (inv.LineItems || [])) {
                if (targetCodes.length && !targetCodes.includes(li.AccountCode)) continue;
                const amt = Number(li.LineAmount || 0);
                // Bills are credits (negative), Invoices are debits (positive)
                const net = inv.Type === 'ACCPAY' ? -amt : amt;
                pushRow({ date, source, contact, desc: li.Description || '', ref, code: li.AccountCode || '' }, net);
            }
        }

        // Bank Transactions: Receive → Debit (+), Spend → Credit (-)
        for (const bt of bankTxns) {
            const date    = (bt.DateString || '').substring(0, 10);
            const source  = bt.Type === 'SPEND' ? 'Spend' : bt.Type === 'RECEIVE' ? 'Receive' : (bt.Type || 'Bank');
            const contact = bt.Contact?.Name || '';
            const ref     = bt.Reference || '';
            for (const li of (bt.LineItems || [])) {
                if (targetCodes.length && !targetCodes.includes(li.AccountCode)) continue;
                const amt = Number(li.LineAmount || 0);
                const net = bt.Type === 'SPEND' ? -amt : amt;
                pushRow({ date, source, contact, desc: li.Description || '', ref, code: li.AccountCode || '' }, net);
            }
        }

        // Manual Journals: positive LineAmount → Debit, negative → Credit
        for (const j of journals) {
            const date = (j.DateString || '').substring(0, 10);
            const ref  = j.Narration || '';
            for (const jl of (j.JournalLines || [])) {
                if (targetCodes.length && !targetCodes.includes(jl.AccountCode)) continue;
                pushRow({ date, source: 'Journal', contact: '', desc: jl.Description || '', ref, code: jl.AccountCode || '' }, Number(jl.LineAmount || 0));
            }
        }

        dataRows.sort((a, b) => a.date.localeCompare(b.date));

        const label = targetCodes.length ? targetCodes.join(', ') : '全部科目';
        const result = {
            ReportName: `科目明細 — ${label}`,
            ReportDate: `${fromDate || ''} ～ ${toDate || ''}`,
            NumericFromCol: 6,
            Rows: [
                { RowType: 'Header', Cells: [
                    { Value: '日期' }, { Value: '類型' }, { Value: '聯絡人' },
                    { Value: '說明' }, { Value: '參考' }, { Value: '科目' },
                    { Value: 'Debit' }, { Value: 'Credit' }
                ]},
                ...dataRows.map(r => ({
                    RowType: 'Row',
                    Cells: [
                        { Value: r.date }, { Value: r.source }, { Value: r.contact },
                        { Value: r.desc }, { Value: r.ref }, { Value: r.code },
                        { Value: r.debit  > 0 ? r.debit.toFixed(2)  : '' },
                        { Value: r.credit > 0 ? r.credit.toFixed(2) : '' }
                    ]
                })),
                { RowType: 'SummaryRow', Cells: [
                    { Value: '合計' }, { Value: '' }, { Value: '' },
                    { Value: '' }, { Value: '' }, { Value: '' },
                    { Value: totalDebit.toFixed(2) },
                    { Value: totalCredit.toFixed(2) }
                ]}
            ]
        };
        res.json(result);
    } catch (err) {
        console.error('Account Ledger Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 取得科目清單（for Account Transactions 下拉選單）
app.get('/accounts', verifyAuth, async (req, res) => {
    try {
        const { xero, tenantId } = await getValidXeroClient();
        const response = await xero.accountingApi.getAccounts(tenantId);
        const accounts = (response.body.accounts || [])
            .filter(a => a.status === 'ACTIVE')
            .sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }));
        res.json(accounts);
    } catch (err) {
        console.error('Accounts error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// Bills Import
// ==========================================

app.post('/bills/bulk', verifyAuth, async (req, res) => {
    try {
        const { bills } = req.body;
        if (!bills || !bills.length) return res.status(400).json({ error: 'No bills provided' });

        const { xero, tenantId, tenantName } = await getValidXeroClient();

        const invoices = bills.map(bill => ({
            type: 'ACCPAY',
            contact: { name: bill.ContactName },
            date: bill.InvoiceDate,
            dueDate: bill.DueDate,
            invoiceNumber: bill.InvoiceNumber || undefined,
            reference: bill.Reference || undefined,
            lineAmountTypes: 'Exclusive',
            lineItems: [{
                description: bill.Description,
                quantity: parseFloat(bill.Quantity) || 1,
                unitAmount: parseFloat(bill.UnitAmount) || 0,
                accountCode: bill.AccountCode,
                taxType: bill.TaxType || 'NONE'
            }],
            status: 'AUTHORISED',
            currencyCode: bill.Currency || undefined
        }));

        const response = await xero.accountingApi.createInvoices(tenantId, { invoices });
        res.json({ success: true, count: response.body.invoices.length, tenantName });
    } catch (err) {
        console.error('Bulk Create Bills Error:', err);
        res.status(500).json({ error: err.message });
    }
});

exports.api = functions.https.onRequest(app);
