const { XeroClient } = require('xero-node');
const scopes = ['openid', 'profile', 'email', 'accounting.transactions', 'accounting.reports.read', 'accounting.settings', 'accounting.attachments', 'offline_access'];

const xero = new XeroClient({
    clientId: 'B0D377C22B034972B34248B299453352',
    clientSecret: 'vS2ErF0tPDTgJ58RrZKttMbKPUPsFA-2DaoP9uBzwle9fbSV',
    redirectUris: ['http://localhost:5001/xero-frontend/us-central1/api/auth/xero/callback'],
    scopes: scopes
});
console.log(xero.buildConsentUrl());
