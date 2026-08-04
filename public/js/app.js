'use strict';

const state = {
  loggedIn: false,
  tenants: [],
  activeTenantId: null,
  items: [],
  selected: new Set(),
  refreshedAt: null,
  loaded: false,
  dirty: false,
  appliedRange: { from: '', to: '' },
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
  },
  page: 1,
  pageSize: 10,
};

const els = {
  tenantSelect: document.getElementById('tenant-select'),
  logoutBtn: document.getElementById('logout-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  refreshStatus: document.getElementById('refresh-status'),
  appliedRange: document.getElementById('applied-range'),
  selectionCount: document.getElementById('selection-count'),
  clearSelectionBtn: document.getElementById('clear-selection'),
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
  searchBtn: document.getElementById('search-btn'),
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

function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

const TYPE_BADGE = {
  BILL: { cls: 'bill', label: 'BILL' },
  MJ:   { cls: 'mj',   label: 'MJ' },
  RECV: { cls: 'recv', label: '收款' },
  SPND: { cls: 'spnd', label: '付款' },
  CN:   { cls: 'cn',   label: '貸項' },
};

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
    applyAndRender();
  } catch (err) {
    console.error(err);
    if (window.notify) window.notify.error('初始化失敗：' + err.message);
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

function markDirty() {
  state.dirty = true;
  els.refreshStatus.textContent = '條件已變更，按【查詢】重新載入';
}

function bindEvents() {
  els.tenantSelect.addEventListener('change', async () => {
    const tenantId = els.tenantSelect.value;
    try {
      await api('/api/tenants/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId }),
      });
    } catch (err) {
      if (window.notify) window.notify.error('切換公司失敗：' + err.message);
      return;
    }
    state.activeTenantId = tenantId;
    state.selected.clear();
    state.items = [];
    state.loaded = false;
    state.page = 1;
    refreshVouchers();
  });

  els.logoutBtn.addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch (_) {
      /* ignore */
    }
    window.location.href = '/login.html';
  });

  els.refreshBtn.addEventListener('click', () => refreshVouchers());

  els.searchBtn.addEventListener('click', () => {
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

  els.clearSelectionBtn.addEventListener('click', () => {
    if (!state.selected.size) return;
    state.selected.clear();
    renderRows();
    updateSelectionUI();
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

  // filter events：只更新 state，不即時過濾——要按【查詢】才會重打後端
  const bindFilter = (el, key, transform) => {
    const handler = () => {
      state.filters[key] = transform ? transform(el.value) : el.value;
      if (state.loaded) markDirty();
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

  els.clearFilters.addEventListener('click', () => {
    state.filters = {
      type: '', dateFrom: '', dateTo: '', number: '',
      contact: '', narration: '', amountMin: null, amountMax: null,
      status: '',
    };
    for (const el of [
      els.fType, els.fDateFrom, els.fDateTo, els.fNumber, els.fContact,
      els.fNarration, els.fAmountMin, els.fAmountMax, els.fStatus,
    ]) el.value = '';
    state.page = 1;
    refreshVouchers();
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
    const total = state.items.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page < totalPages) {
      state.page++;
      applyAndRender();
    }
  });
}

/* ---------- data pipeline ---------- */

function buildQueryString() {
  const qs = new URLSearchParams();
  const f = state.filters;
  const set = (k, v) => {
    if (v == null) return;
    const s = String(v).trim();
    if (s === '') return;
    qs.set(k, s);
  };
  set('type', f.type);
  set('dateFrom', f.dateFrom);
  set('dateTo', f.dateTo);
  set('number', f.number);
  set('contact', f.contact);
  set('narration', f.narration);
  set('amountMin', f.amountMin);
  set('amountMax', f.amountMax);
  set('status', f.status);
  const s = qs.toString();
  return s ? '?' + s : '';
}

async function refreshVouchers() {
  els.refreshBtn.disabled = true;
  els.searchBtn.disabled = true;
  els.refreshStatus.textContent = '讀取中…';
  try {
    const data = await api('/api/vouchers' + buildQueryString());
    state.items = data.items || [];
    state.loaded = true;
    state.dirty = false;
    state.refreshedAt = new Date(data.refreshedAt);
    state.appliedRange = {
      from: data.appliedDateFrom || '',
      to: data.appliedDateTo || '',
    };
    if (state.appliedRange.from && state.appliedRange.to) {
      els.appliedRange.textContent = `已套用 ${state.appliedRange.from} ~ ${state.appliedRange.to}（共 ${state.items.length} 張）`;
    } else {
      els.appliedRange.textContent = `共 ${state.items.length} 張`;
    }
    applyAndRender();
    els.refreshStatus.textContent = `最後更新：${state.refreshedAt.toLocaleTimeString(
      'zh-Hant'
    )}`;
  } catch (err) {
    els.refreshStatus.textContent = '讀取失敗';
    if (window.notify) window.notify.error('讀取失敗：' + err.message);
  } finally {
    els.refreshBtn.disabled = false;
    els.searchBtn.disabled = false;
  }
}

function getPageItems() {
  const start = (state.page - 1) * state.pageSize;
  return state.items.slice(start, start + state.pageSize);
}

function applyAndRender() {
  const total = state.items.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  renderRows();
  renderPagination(total, totalPages);
  updateSelectionUI();
}

/* ---------- render ---------- */

function renderRows() {
  const pageItems = getPageItems();
  const totalCount = state.items.length;

  if (!pageItems.length) {
    const msg = totalCount === 0
      ? (state.loaded
        ? '沒有符合條件的憑證。'
        : '請於上方輸入條件後按【查詢】載入憑證。')
      : '此頁無資料。';
    els.tbody.innerHTML = `<tr class="empty-row"><td colspan="7" class="muted">${msg}</td></tr>`;
    return;
  }

  const html = pageItems.map((v) => {
    const key = `${v.type}:${v.id}`;
    const checked = state.selected.has(key) ? 'checked' : '';
    const rowCls = state.selected.has(key) ? 'selected' : '';
    const b = TYPE_BADGE[v.type] || { cls: 'mj', label: v.type || '' };
    const typeBadge = `<span class="type-badge ${b.cls}">${escapeHtml(b.label)}</span>`;
    return `
      <tr class="${rowCls}" data-key="${key}">
        <td class="col-check"><input type="checkbox" ${checked} /></td>
        <td class="col-type">${typeBadge}</td>
        <td class="col-date">${fmtDate(v.date)}</td>
        <td class="col-number">${escapeHtml(v.number || v.reference || '-')}</td>
        <td class="col-contact">${escapeHtml(v.contact || v.reference || '-')}</td>
        <td class="col-amount">${fmtMoney(v.total, v.currency)}</td>
        <td class="col-status">${escapeHtml(v.status || '')}</td>
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
  els.clearSelectionBtn.disabled = n === 0;
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
