'use strict';

const state = {
  loggedIn: false,
  tenants: [],
  activeTenantId: null,
  items: [],
  selected: new Set(),
  includePrinted: false,
  refreshedAt: null,
  cutoffDate: null,
  filters: {
    type: '',
    dateFrom: '',
    dateTo: '',
    number: '',
    contact: '',
    narration: '',
    amountMin: null,
    amountMax: null,
    status: '',
    printed: '',
  },
  page: 1,
  pageSize: 10,
};

const els = {
  tenantSelect: document.getElementById('tenant-select'),
  logoutBtn: document.getElementById('logout-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  includePrinted: document.getElementById('include-printed'),
  refreshStatus: document.getElementById('refresh-status'),
  selectionCount: document.getElementById('selection-count'),
  previewBtn: document.getElementById('preview-btn'),
  tbody: document.getElementById('voucher-tbody'),
  selectAll: document.getElementById('select-all'),
  // filter
  fType: document.getElementById('f-type'),
  fDateFrom: document.getElementById('f-date-from'),
  fDateTo: document.getElementById('f-date-to'),
  fNumber: document.getElementById('f-number'),
  fContact: document.getElementById('f-contact'),
  fNarration: document.getElementById('f-narration'),
  fAmountMin: document.getElementById('f-amount-min'),
  fAmountMax: document.getElementById('f-amount-max'),
  fStatus: document.getElementById('f-status'),
  fPrinted: document.getElementById('f-printed'),
  clearFilters: document.getElementById('clear-filters'),
  // pagination
  pageInfo: document.getElementById('pagination-info'),
  pagePrev: document.getElementById('page-prev'),
  pageNext: document.getElementById('page-next'),
  pageNumbers: document.getElementById('page-numbers'),
  pageSize: document.getElementById('page-size'),
};

function fmtDate(iso) {
  if (!iso) return '';
  const m = /\/Date\((\d+)/.exec(iso);
  const d = m ? new Date(Number(m[1])) : new Date(iso);
  if (isNaN(d)) return String(iso);
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function fmtMoney(n, currency) {
  if (n == null || isNaN(n)) return '';
  const s = Number(n).toLocaleString('zh-Hant', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${s}` : s;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}));
  if (r.status === 401) {
    window.location.href = '/login.html';
    throw new Error('未登入');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

/* ---------- init ---------- */

async function init() {
  try {
    const me = await api('/api/me');
    if (!me.loggedIn) {
      window.location.href = '/login.html';
      return;
    }
    state.loggedIn = true;
    state.tenants = me.tenants;
    state.activeTenantId = me.activeTenantId;

    renderTenants();
    bindEvents();
    await refreshVouchers();
  } catch (err) {
    console.error(err);
  }
}

function renderTenants() {
  els.tenantSelect.innerHTML = '';
  for (const t of state.tenants) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    if (t.id === state.activeTenantId) opt.selected = true;
    els.tenantSelect.appendChild(opt);
  }
}

function bindEvents() {
  els.tenantSelect.addEventListener('change', async () => {
    const tenantId = els.tenantSelect.value;
    await api('/api/tenants/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });
    state.activeTenantId = tenantId;
    state.selected.clear();
    state.page = 1;
    await refreshVouchers();
  });

  els.logoutBtn.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  els.refreshBtn.addEventListener('click', () => refreshVouchers());

  els.includePrinted.addEventListener('change', () => {
    state.includePrinted = els.includePrinted.checked;
    state.page = 1;
    refreshVouchers();
  });

  els.previewBtn.addEventListener('click', () => {
    if (!state.selected.size) return;
    const ids = Array.from(state.selected).join(',');
    window.open(
      `/voucher-print.html?ids=${encodeURIComponent(ids)}`,
      '_blank'
    );
  });

  els.selectAll.addEventListener('change', () => {
    const pageItems = getPageItems();
    if (els.selectAll.checked) {
      for (const v of pageItems) state.selected.add(`${v.type}:${v.id}`);
    } else {
      for (const v of pageItems) state.selected.delete(`${v.type}:${v.id}`);
    }
    renderRows();
    updateSelectionUI();
  });

  // filter events
  const bindFilter = (el, key, transform) => {
    const handler = () => {
      state.filters[key] = transform ? transform(el.value) : el.value;
      state.page = 1;
      applyAndRender();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  };
  bindFilter(els.fType, 'type');
  bindFilter(els.fDateFrom, 'dateFrom');
  bindFilter(els.fDateTo, 'dateTo');
  bindFilter(els.fNumber, 'number');
  bindFilter(els.fContact, 'contact');
  bindFilter(els.fNarration, 'narration');
  bindFilter(els.fAmountMin, 'amountMin', (v) => (v === '' ? null : Number(v)));
  bindFilter(els.fAmountMax, 'amountMax', (v) => (v === '' ? null : Number(v)));
  bindFilter(els.fStatus, 'status');
  bindFilter(els.fPrinted, 'printed');

  els.clearFilters.addEventListener('click', () => {
    state.filters = {
      type: '', dateFrom: '', dateTo: '', number: '',
      contact: '', narration: '', amountMin: null, amountMax: null,
      status: '', printed: '',
    };
    for (const el of [
      els.fType, els.fDateFrom, els.fDateTo, els.fNumber, els.fContact,
      els.fNarration, els.fAmountMin, els.fAmountMax, els.fStatus, els.fPrinted,
    ]) el.value = '';
    state.page = 1;
    applyAndRender();
  });

  els.pageSize.addEventListener('change', () => {
    state.pageSize = Number(els.pageSize.value) || 10;
    state.page = 1;
    applyAndRender();
  });

  els.pagePrev.addEventListener('click', () => {
    if (state.page > 1) {
      state.page--;
      applyAndRender();
    }
  });
  els.pageNext.addEventListener('click', () => {
    const total = getFilteredItems().length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page < totalPages) {
      state.page++;
      applyAndRender();
    }
  });
}

/* ---------- data pipeline ---------- */

async function refreshVouchers() {
  els.refreshBtn.disabled = true;
  els.refreshStatus.textContent = '讀取中…';
  try {
    const q = state.includePrinted ? '?includePrinted=1' : '';
    const data = await api('/api/vouchers' + q);
    state.items = data.items;
    state.cutoffDate = data.cutoffDate || null;
    state.refreshedAt = new Date(data.refreshedAt);
    state.selected = new Set(
      Array.from(state.selected).filter((k) =>
        state.items.some((v) => `${v.type}:${v.id}` === k)
      )
    );
    applyAndRender();
    const cutoffNote = state.cutoffDate
      ? `（切點 ${state.cutoffDate}，早於此日視為已列印）`
      : '';
    els.refreshStatus.textContent = `最後更新：${state.refreshedAt.toLocaleTimeString(
      'zh-Hant'
    )}${cutoffNote}`;
  } catch (err) {
    els.refreshStatus.textContent = '讀取失敗：' + err.message;
  } finally {
    els.refreshBtn.disabled = false;
  }
}

function getFilteredItems() {
  const f = state.filters;
  const contains = (s, needle) =>
    !needle || String(s || '').toLowerCase().includes(needle.toLowerCase());

  return state.items.filter((v) => {
    if (f.type && v.type !== f.type) return false;
    if (f.dateFrom && v.date && v.date < f.dateFrom) return false;
    if (f.dateTo && v.date && v.date > f.dateTo) return false;
    if (f.number && !contains(v.number, f.number) && !contains(v.reference, f.number)) return false;
    if (f.contact && !contains(v.contact, f.contact)) return false;
    if (f.narration && !contains(v.reference, f.narration)) return false;
    if (f.amountMin != null && Number(v.total || 0) < f.amountMin) return false;
    if (f.amountMax != null && Number(v.total || 0) > f.amountMax) return false;
    if (f.status && v.status !== f.status) return false;
    if (f.printed === 'unprinted' && v.printed) return false;
    if (f.printed === 'printed' && !v.printed) return false;
    return true;
  });
}

function getPageItems() {
  const filtered = getFilteredItems();
  const start = (state.page - 1) * state.pageSize;
  return filtered.slice(start, start + state.pageSize);
}

function applyAndRender() {
  const filtered = getFilteredItems();
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  renderRows();
  renderPagination(filtered.length, totalPages);
  updateSelectionUI();
}

/* ---------- render ---------- */

function renderRows() {
  const pageItems = getPageItems();
  const filteredCount = getFilteredItems().length;

  if (!pageItems.length) {
    const msg = filteredCount === 0
      ? (state.items.length === 0
        ? '尚未載入資料。請點【重新整理】。'
        : '沒有符合條件的憑證。')
      : '此頁無資料。';
    els.tbody.innerHTML = `<tr class="empty-row"><td colspan="8" class="muted">${msg}</td></tr>`;
    return;
  }

  const html = pageItems.map((v) => {
    const key = `${v.type}:${v.id}`;
    const checked = state.selected.has(key) ? 'checked' : '';
    const rowCls = state.selected.has(key) ? 'selected' : '';
    const typeBadge =
      v.type === 'BILL'
        ? '<span class="type-badge bill">BILL</span>'
        : '<span class="type-badge mj">MJ</span>';
    let printed;
    if (v.printed) {
      const isCutoff = v.printedReason === 'before-cutoff';
      printed = `<span class="printed-tag ${isCutoff ? 'cutoff' : ''}">${isCutoff ? '早於啟用日' : '已列印'}</span>`;
    } else {
      printed = '<span class="muted small">未列印</span>';
    }
    return `
      <tr class="${rowCls}" data-key="${key}">
        <td class="col-check"><input type="checkbox" ${checked} /></td>
        <td class="col-type">${typeBadge}</td>
        <td class="col-date">${fmtDate(v.date)}</td>
        <td class="col-number">${escapeHtml(v.number || v.reference || '-')}</td>
        <td class="col-contact">${escapeHtml(v.contact || v.reference || '-')}</td>
        <td class="col-amount">${fmtMoney(v.total, v.currency)}</td>
        <td class="col-status">${escapeHtml(v.status || '')}</td>
        <td class="col-printed">${printed}</td>
      </tr>
    `;
  }).join('');
  els.tbody.innerHTML = html;

  els.tbody.querySelectorAll('tr[data-key]').forEach((tr) => {
    tr.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'INPUT') return;
      const cb = tr.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      toggleSelection(tr.dataset.key, cb.checked);
      tr.classList.toggle('selected', cb.checked);
    });
    tr.querySelector('input[type="checkbox"]').addEventListener('change', (ev) => {
      toggleSelection(tr.dataset.key, ev.target.checked);
      tr.classList.toggle('selected', ev.target.checked);
    });
  });
}

function renderPagination(totalCount, totalPages) {
  if (totalCount === 0) {
    els.pageInfo.textContent = '共 0 張';
    els.pageNumbers.innerHTML = '';
    els.pagePrev.disabled = true;
    els.pageNext.disabled = true;
    return;
  }

  const start = (state.page - 1) * state.pageSize + 1;
  const end = Math.min(state.page * state.pageSize, totalCount);
  els.pageInfo.textContent = `顯示 ${start}–${end} / 共 ${totalCount} 張`;

  els.pagePrev.disabled = state.page <= 1;
  els.pageNext.disabled = state.page >= totalPages;

  els.pageNumbers.innerHTML = renderPageNumbers(state.page, totalPages);
  els.pageNumbers.querySelectorAll('button[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.page = Number(btn.dataset.page);
      applyAndRender();
    });
  });
}

function renderPageNumbers(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => btnHtml(i + 1, current)).join('');
  }
  const parts = [];
  const push = (n) => parts.push(btnHtml(n, current));
  push(1);
  if (current > 4) parts.push('<span class="page-ellipsis">…</span>');
  const startMid = Math.max(2, current - 1);
  const endMid = Math.min(total - 1, current + 1);
  for (let i = startMid; i <= endMid; i++) push(i);
  if (current < total - 3) parts.push('<span class="page-ellipsis">…</span>');
  push(total);
  return parts.join('');
}

function btnHtml(n, current) {
  const cls = n === current ? 'page-num active' : 'page-num';
  return `<button class="${cls}" data-page="${n}">${n}</button>`;
}

/* ---------- selection ---------- */

function toggleSelection(key, checked) {
  if (checked) state.selected.add(key);
  else state.selected.delete(key);
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = state.selected.size;
  els.selectionCount.textContent = `已選取 ${n} 張`;
  els.previewBtn.disabled = n === 0;
  const pageItems = getPageItems();
  const pageAllSelected =
    pageItems.length > 0 &&
    pageItems.every((v) => state.selected.has(`${v.type}:${v.id}`));
  els.selectAll.checked = pageAllSelected;
  els.selectAll.indeterminate =
    !pageAllSelected &&
    pageItems.some((v) => state.selected.has(`${v.type}:${v.id}`));
}

init();
