'use strict';

const store = new Map();
const loading = new Map();

function getTenant(tenantId) {
  if (!tenantId) return null;
  return store.get(tenantId) || null;
}

function setTenantData(tenantId, payload) {
  if (!tenantId) return;
  store.set(tenantId, payload);
}

function bust(tenantId) {
  if (!tenantId) return;
  store.delete(tenantId);
}

function markLoading(tenantId, promise) {
  if (!tenantId || !promise) return;
  loading.set(tenantId, promise);
  promise.finally(() => {
    if (loading.get(tenantId) === promise) loading.delete(tenantId);
  });
}

function waitIfLoading(tenantId) {
  if (!tenantId) return null;
  return loading.get(tenantId) || null;
}

module.exports = { getTenant, setTenantData, bust, markLoading, waitIfLoading };
