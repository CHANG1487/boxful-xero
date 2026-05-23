import { switchTenant } from './firebase-init.js';

const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5001/xero-frontend/us-central1/api'
    : 'https://us-central1-xero-frontend.cloudfunctions.net/api';

async function getAuthHeaders() {
    const user = window.firebaseAuth?.currentUser;
    if (!user) return {};
    const token = await user.getIdToken();
    return { 'Authorization': `Bearer ${token}` };
}

document.addEventListener('DOMContentLoaded', () => {

    // ==========================================
    // Navigation
    // ==========================================
    const navItems = document.querySelectorAll('.sidebar-nav li');
    const panels = document.querySelectorAll('.panel');
    const pageTitle = document.getElementById('current-page-title');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            pageTitle.innerText = item.dataset.title || item.innerText.replace(/[📥📊⚙️]/g, '').trim();
            const targetId = item.getAttribute('data-target');
            panels.forEach(p => p.id === targetId
                ? p.classList.add('active-panel')
                : p.classList.remove('active-panel'));

            // 進入報表面板時自動載入
            if (targetId === 'panel-reports') initReportsPanel();
        });
    });

    document.getElementById('google-login-btn')?.addEventListener('click', () => window.handleGoogleLogin?.());
    document.getElementById('logout-btn')?.addEventListener('click', () => window.handleLogout?.());
    document.getElementById('connect-xero-btn')?.addEventListener('click', () => window.connectXero?.());
    document.getElementById('reconnect-xero-btn')?.addEventListener('click', () => window.connectXero?.());

    // ==========================================
    // CSV Upload & Preview
    // ==========================================
    const dropZone = document.getElementById('csv-drop-zone');
    const fileInput = document.getElementById('csv-file-input');
    const previewCard = document.querySelector('.preview-card');
    const previewTableHead = document.querySelector('#preview-table thead');
    const previewTableBody = document.querySelector('#preview-table tbody');
    const previewCount = document.getElementById('preview-count');
    let parsedBills = [];

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--primary)';
        dropZone.style.backgroundColor = 'rgba(79,70,229,0.05)';
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = 'var(--border)';
        dropZone.style.backgroundColor = 'transparent';
    });
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--border)';
        dropZone.style.backgroundColor = 'transparent';
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', e => {
        if (e.target.files.length) handleFile(e.target.files[0]);
    });

    function handleFile(file) {
        if (!file.name.endsWith('.csv')) { alert('請上傳 CSV 檔案'); return; }
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: results => {
                parsedBills = results.data;
                renderPreviewTable(results.data, results.meta.fields);
            },
            error: err => { console.error('CSV 解析錯誤:', err); alert('CSV 解析失敗，請檢查格式。'); }
        });
    }

    function renderPreviewTable(data, fields) {
        previewCard.style.display = 'block';
        previewCount.innerText = `${data.length} 筆`;
        previewTableHead.innerHTML = '<tr>' + fields.map(f => `<th>${f}</th>`).join('') + '</tr>';
        previewTableBody.innerHTML = data.map(row =>
            '<tr>' + fields.map(f => `<td>${row[f] || ''}</td>`).join('') + '</tr>'
        ).join('');
    }

    // ==========================================
    // Import Submit + Confirmation Modal
    // ==========================================
    const submitBtn = document.getElementById('submit-bills-btn');
    const importModal = document.getElementById('import-confirm-modal');
    const importConfirmCount = document.getElementById('import-confirm-count');
    const importConfirmCompany = document.getElementById('import-confirm-company');
    const importConfirmBtn = document.getElementById('import-confirm-btn');
    const importCancelBtn = document.getElementById('import-cancel-btn');

    submitBtn?.addEventListener('click', () => {
        if (!parsedBills.length) return;
        importConfirmCount.innerText = parsedBills.length;
        importConfirmCompany.innerText = window.xeroActiveTenantName || '未知公司（請先連結 Xero）';
        importModal.classList.add('active');
    });

    importCancelBtn?.addEventListener('click', () => importModal.classList.remove('active'));
    importConfirmBtn?.addEventListener('click', async () => {
        importModal.classList.remove('active');
        await submitBills();
    });

    async function submitBills() {
        try {
            submitBtn.disabled = true;
            submitBtn.innerText = '匯入中...';
            const headers = { 'Content-Type': 'application/json', ...(await getAuthHeaders()) };
            const res = await fetch(`${API}/bills/bulk`, {
                method: 'POST', headers,
                body: JSON.stringify({ bills: parsedBills })
            });
            const data = await res.json();
            if (data.success) {
                window.showNotification?.(`成功匯入 ${data.count} 筆帳單至「${data.tenantName}」`);
                previewCard.style.display = 'none';
                parsedBills = [];
                fileInput.value = '';
            } else {
                window.showNotification?.('匯入失敗：' + (data.error || '未知錯誤'), 'error');
            }
        } catch (e) {
            window.showNotification?.('網路錯誤，請重試', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = '確認並匯入至 Xero';
        }
    }

    // ==========================================
    // Reports Panel
    // ==========================================
    let reportsLoaded = false;
    let selectedReportId = null;
    let selectedReportMeta = null; // stores defaultParams, dateType

    // 報表類型判斷（哪些用日期區間，哪些用單一日期）
    const SINGLE_DATE_REPORTS = ['BalanceSheet', 'TrialBalance', 'ExecutiveSummary'];

    // 清除所有面板資料（切換公司時使用）
    function clearAllPanelData() {
        document.getElementById('report-result-card').style.display = 'none';
        document.getElementById('report-loading').style.display = 'none';
        document.getElementById('report-error').style.display = 'none';
        document.getElementById('report-search').value = '';
        document.getElementById('search-count').innerText = '';
        document.getElementById('report-table-container').innerHTML = '';
        document.getElementById('report-header-info').innerText = '';

        const previewCard = document.querySelector('.preview-card');
        if (previewCard) previewCard.style.display = 'none';
        parsedBills = [];

        reportsLoaded = false;
        selectedReportId = null;
        selectedReportMeta = null;
        allAccountsData = [];
        selectedAccountIds = [];
        accountComboSetup = false;
        const tagsEl = document.getElementById('account-tags');
        if (tagsEl) tagsEl.innerHTML = '';
        const comboInput = document.getElementById('account-combo-input');
        if (comboInput) { comboInput.value = ''; comboInput.placeholder = '輸入代碼/名稱搜尋'; }
        const dropdown = document.getElementById('account-combo-dropdown');
        if (dropdown) dropdown.style.display = 'none';
        const kwInput = document.getElementById('at-keyword');
        if (kwInput) kwInput.value = '';
    }

    window.onTenantChanged = clearAllPanelData;

    async function initReportsPanel() {
        if (!reportsLoaded) {
            await Promise.all([loadReportsList(), loadAccounts()]);
            reportsLoaded = true;
        }
    }

    async function loadReportsList() {
        const loadingEl = document.getElementById('reports-list-loading');
        const errorEl = document.getElementById('reports-list-error');
        const container = document.getElementById('reports-list-container');
        const radioList = document.getElementById('reports-radio-list');

        loadingEl.style.display = 'block';
        errorEl.style.display = 'none';
        container.style.display = 'none';

        try {
            const headers = await getAuthHeaders();
            const res = await fetch(`${API}/reports/list`, { headers });
            const reports = await res.json();
            if (!res.ok) throw new Error(reports.error || res.statusText);

            loadingEl.style.display = 'none';

            if (!reports.length) {
                errorEl.style.display = 'block';
                errorEl.innerText = '目前沒有可用報表，請確認已在 Xero 中儲存報表';
                return;
            }

            // store full report objects for later use (defaultParams, dateType)
            const reportMap = {};
            reports.forEach(r => { reportMap[r.ReportID + '|' + r.ReportName] = r; });

            radioList.innerHTML = reports.map(r => `
                <label class="report-radio-item" data-id="${r.ReportID}" data-key="${r.ReportID}|${r.ReportName}">
                    <input type="radio" name="report-select" value="${r.ReportID}" data-key="${r.ReportID}|${r.ReportName}">
                    <span class="report-radio-label">${r.ReportName || r.ReportID}</span>
                </label>
            `).join('');

            const firstRadio = radioList.querySelector('input[type="radio"]');
            if (firstRadio) {
                firstRadio.checked = true;
                firstRadio.closest('.report-radio-item').classList.add('selected');
                selectReport(firstRadio.value, reportMap[firstRadio.dataset.key]);
            }

            radioList.querySelectorAll('input[type="radio"]').forEach(radio => {
                radio.addEventListener('change', () => {
                    radioList.querySelectorAll('.report-radio-item').forEach(el => el.classList.remove('selected'));
                    radio.closest('.report-radio-item').classList.add('selected');
                    selectReport(radio.value, reportMap[radio.dataset.key]);
                });
            });

            container.style.display = 'block';
        } catch (err) {
            loadingEl.style.display = 'none';
            errorEl.style.display = 'block';
            errorEl.innerText = '載入報表清單失敗：' + err.message;
        }
    }

    function selectReport(reportId, reportMeta) {
        selectedReportId = reportId;
        selectedReportMeta = reportMeta || {};
        const controls = document.getElementById('report-run-controls');
        const rangeGroup = document.getElementById('report-range-group');
        const singleGroup = document.getElementById('report-single-group');
        controls.style.display = 'flex';

        const isSingle = (selectedReportMeta.dateType === 'single') || SINGLE_DATE_REPORTS.includes(reportId);
        rangeGroup.style.display = isSingle ? 'none' : 'flex';
        singleGroup.style.display = isSingle ? 'flex' : 'none';
    }

    // 設定預設日期
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const todayStr = today.toISOString().split('T')[0];

    const fromDateEl = document.getElementById('report-from-date');
    const toDateEl = document.getElementById('report-to-date');
    const singleDateEl = document.getElementById('report-date');
    const atFromDateEl = document.getElementById('at-from-date');
    const atToDateEl = document.getElementById('at-to-date');

    if (fromDateEl) fromDateEl.value = firstOfMonth.toISOString().split('T')[0];
    if (toDateEl) toDateEl.value = lastOfMonth.toISOString().split('T')[0];
    if (singleDateEl) singleDateEl.value = todayStr;
    if (atFromDateEl) atFromDateEl.value = firstOfMonth.toISOString().split('T')[0];
    if (atToDateEl) atToDateEl.value = lastOfMonth.toISOString().split('T')[0];

    document.getElementById('run-report-btn')?.addEventListener('click', async () => {
        if (!selectedReportId) return;
        const isSingle = (selectedReportMeta?.dateType === 'single') || SINGLE_DATE_REPORTS.includes(selectedReportId);
        const urlParams = new URLSearchParams();
        if (isSingle) {
            urlParams.set('date', singleDateEl.value);
        } else {
            urlParams.set('fromDate', fromDateEl.value);
            urlParams.set('toDate', toDateEl.value);
        }
        // merge defaultParams from report config (e.g. timeframe=MONTH, periods=11)
        const extras = selectedReportMeta?.defaultParams || {};
        Object.entries(extras).forEach(([k, v]) => { if (v) urlParams.set(k, v); });
        await fetchAndRenderReport(`${API}/reports/run/${selectedReportId}?${urlParams}`);
    });

    // ==========================================
    // Account Transactions (科目明細表)
    // ==========================================
    let allAccountsData = [];
    let selectedAccountIds = [];
    let accountComboSetup = false;

    async function loadAccounts() {
        const comboInput = document.getElementById('account-combo-input');
        if (comboInput) comboInput.placeholder = '載入科目中...';
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(`${API}/accounts`, { headers });
            const accounts = await res.json();
            if (!res.ok) throw new Error(accounts.error || res.statusText);

            allAccountsData = accounts.map(a => ({
                accountID: a.accountID,
                code: a.code || '',
                name: a.name || '',
                display: `${a.code ? a.code + ' - ' : ''}${a.name}`,
                searchText: `${a.code || ''} ${a.name || ''}`.toLowerCase()
            }));
            if (comboInput) comboInput.placeholder = '輸入代碼/名稱搜尋';
            setupAccountCombo();
        } catch (err) {
            if (comboInput) comboInput.placeholder = `載入失敗：${err.message}`;
        }
    }

    function renderAccountTags() {
        const tagsEl = document.getElementById('account-tags');
        if (!tagsEl) return;
        tagsEl.innerHTML = selectedAccountIds.map(id => {
            const acc = allAccountsData.find(a => a.accountID === id);
            const label = acc ? (acc.code || acc.name) : id;
            return `<span class="account-tag">${label}<button class="account-tag-remove" data-id="${id}" title="移除">×</button></span>`;
        }).join('');
        tagsEl.querySelectorAll('.account-tag-remove').forEach(btn => {
            btn.addEventListener('mousedown', e => {
                e.preventDefault();
                selectedAccountIds = selectedAccountIds.filter(id => id !== btn.dataset.id);
                renderAccountTags();
                renderAccountDropdown(document.getElementById('account-combo-input')?.value || '');
            });
        });
    }

    function setupAccountCombo() {
        if (accountComboSetup) return;
        accountComboSetup = true;
        const input = document.getElementById('account-combo-input');
        const dropdown = document.getElementById('account-combo-dropdown');
        const wrapper = document.getElementById('account-tags-wrapper');
        if (!input || !dropdown) return;

        wrapper?.addEventListener('click', () => input.focus());

        input.addEventListener('focus', () => {
            renderAccountDropdown(input.value);
            dropdown.style.display = 'block';
        });
        input.addEventListener('input', () => {
            renderAccountDropdown(input.value);
            dropdown.style.display = 'block';
        });
        document.addEventListener('click', e => {
            const combo = document.getElementById('account-combo');
            if (combo && !combo.contains(e.target)) dropdown.style.display = 'none';
        });
    }

    function renderAccountDropdown(query) {
        const dropdown = document.getElementById('account-combo-dropdown');
        if (!dropdown) return;
        const q = query.toLowerCase();
        const filtered = allAccountsData.filter(a =>
            !selectedAccountIds.includes(a.accountID) &&
            (!q || a.searchText.includes(q) || a.display.toLowerCase().includes(q))
        );
        if (!filtered.length) {
            dropdown.innerHTML = '<div class="account-combo-option no-result">無符合結果</div>';
            return;
        }
        dropdown.innerHTML = filtered.map(a => `
            <div class="account-combo-option" data-id="${a.accountID}">
                ${a.display}
            </div>
        `).join('');
        dropdown.querySelectorAll('.account-combo-option[data-id]').forEach(opt => {
            opt.addEventListener('mousedown', e => {
                e.preventDefault();
                if (!selectedAccountIds.includes(opt.dataset.id)) {
                    selectedAccountIds.push(opt.dataset.id);
                    renderAccountTags();
                }
                const input = document.getElementById('account-combo-input');
                if (input) input.value = '';
                renderAccountDropdown('');
            });
        });
    }

    document.getElementById('run-at-btn')?.addEventListener('click', async () => {
        const fromDate = atFromDateEl.value;
        const toDate = atToDateEl.value;
        const keyword = document.getElementById('at-keyword')?.value.trim() || '';
        const params = new URLSearchParams();
        if (selectedAccountIds.length) {
            params.set('accountIds', selectedAccountIds.join(','));
        }
        if (fromDate) params.set('fromDate', fromDate);
        if (toDate) params.set('toDate', toDate);
        await fetchAndRenderReport(`${API}/reports/account-ledger?${params}`, keyword);
    });

    // ==========================================
    // Shared Report Fetch & Render
    // ==========================================
    async function fetchAndRenderReport(url, keyword = '') {
        const loadingEl = document.getElementById('report-loading');
        const errorEl = document.getElementById('report-error');
        const resultCard = document.getElementById('report-result-card');

        loadingEl.style.display = 'block';
        resultCard.style.display = 'none';
        errorEl.style.display = 'none';

        try {
            const headers = await getAuthHeaders();
            const res = await fetch(url, { headers });
            const report = await res.json();
            if (!res.ok) throw new Error(report.error || res.statusText);

            loadingEl.style.display = 'none';
            renderReport(report);
            if (keyword) {
                applySearch(keyword);
                const searchEl = document.getElementById('report-search');
                if (searchEl) searchEl.value = keyword;
            }
        } catch (err) {
            loadingEl.style.display = 'none';
            errorEl.style.display = 'block';
            const isAuthError = err.message.includes('401') || err.message.includes('403') || err.message.toLowerCase().includes('unauthorized') || err.message.toLowerCase().includes('forbidden');
            if (isAuthError) {
                errorEl.innerHTML = `
                    <div>報表存取權限不足。請重新授權 Xero 以取得科目明細查詢權限。</div>
                    <button onclick="window.connectXero?.()" class="primary-btn-sm" style="margin-top:0.75rem;display:inline-block">重新授權 Xero</button>
                `;
            } else {
                errorEl.innerText = '載入失敗：' + err.message;
            }
        }
    }

    function renderReport(report) {
        const headerInfoEl = document.getElementById('report-header-info');
        const container = document.getElementById('report-table-container');

        const name = report.ReportName || report.reportName || '';
        const dateStr = report.ReportDate || report.reportDate || '';
        headerInfoEl.innerText = [name, dateStr].filter(Boolean).join(' — ');

        const rows = report.Rows || report.rows || [];
        const numericFromCol = report.NumericFromCol ?? 1;
        const table = document.createElement('table');
        table.className = 'report-table';
        rows.forEach(row => renderRow(row, table, 0, numericFromCol));

        container.innerHTML = '';
        container.appendChild(table);

        document.getElementById('report-result-card').style.display = 'block';
        const searchEl = document.getElementById('report-search');
        if (searchEl) { searchEl.value = ''; }
        applySearch('');
    }

    function exportToExcel() {
        const table = document.querySelector('#report-table-container table');
        if (!table || typeof XLSX === 'undefined') {
            window.showNotification?.('無法匯出：請確認報表已載入', 'error');
            return;
        }
        const reportTitle = document.getElementById('report-header-info')?.innerText || 'report';
        const wsData = [];
        table.querySelectorAll('tr').forEach(tr => {
            if (tr.classList.contains('report-row-hidden')) return;
            const row = [];
            tr.querySelectorAll('th, td').forEach(cell => {
                const raw = cell.innerText.trim();
                // try to parse number (remove commas + parens)
                const isParen = raw.startsWith('(') && raw.endsWith(')');
                const cleaned = raw.replace(/,/g, '').replace(/^\((.+)\)$/, '-$1');
                const num = parseFloat(cleaned);
                row.push(!isNaN(num) && raw !== '' ? num : raw);
            });
            wsData.push(row);
        });

        const ws = XLSX.utils.aoa_to_sheet(wsData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Report');

        const safeTitle = reportTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
        XLSX.writeFile(wb, `${safeTitle}.xlsx`);
        window.showNotification?.('Excel 已下載');
    }

    document.getElementById('export-excel-btn')?.addEventListener('click', exportToExcel);

    function renderRow(row, table, depth, numericFromCol = 1) {
        const type = (row.RowType || row.rowType || '').toLowerCase();
        const cells = row.Cells || row.cells || [];
        const nested = row.Rows || row.rows || [];
        const title = row.Title || row.title || '';

        if (type === 'header') {
            const tr = document.createElement('tr');
            tr.dataset.searchable = '';
            cells.forEach((cell, i) => {
                const th = document.createElement('th');
                th.innerText = cell.Value || cell.value || '';
                if (i >= numericFromCol) th.style.textAlign = 'right';
                tr.appendChild(th);
            });
            table.appendChild(tr);
            return;
        }

        if (type === 'section') {
            if (title) {
                const tr = document.createElement('tr');
                tr.className = 'report-section-header';
                tr.dataset.searchable = title;
                const td = document.createElement('td');
                td.colSpan = 20;
                td.innerText = title;
                tr.appendChild(td);
                table.appendChild(tr);
            }
            nested.forEach(r => renderRow(r, table, depth + 1, numericFromCol));
            return;
        }

        if (type === 'row' || type === 'summaryrow') {
            const tr = document.createElement('tr');
            if (type === 'summaryrow') tr.className = 'report-summary-row';
            tr.dataset.searchable = cells.map(c => c.Value || c.value || '').join(' ');
            cells.forEach((cell, i) => {
                const td = document.createElement('td');
                const val = cell.Value || cell.value || '';
                if (i >= numericFromCol) {
                    td.innerText = formatCurrency(val);
                    td.style.textAlign = 'right';
                } else {
                    td.innerText = val;
                    if (i === 0 && depth > 0 && type === 'row') {
                        td.style.paddingLeft = (1 + depth * 1.25) + 'rem';
                    }
                }
                tr.appendChild(td);
            });
            table.appendChild(tr);
        }
    }

    function formatCurrency(val) {
        if (!val || val.trim() === '') return val;
        const neg = val.startsWith('(') && val.endsWith(')');
        const clean = neg ? val.slice(1, -1) : val;
        const num = parseFloat(clean.replace(/,/g, ''));
        if (isNaN(num)) return val;
        const abs = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return neg ? `(${abs})` : (num < 0 ? `-${abs}` : abs);
    }

    document.getElementById('report-search')?.addEventListener('input', e => applySearch(e.target.value));

    function applySearch(query) {
        const rows = document.querySelectorAll('#report-table-container tr');
        const countEl = document.getElementById('search-count');
        if (!query.trim()) {
            rows.forEach(tr => tr.classList.remove('report-row-hidden'));
            if (countEl) countEl.innerText = '';
            return;
        }
        const q = query.toLowerCase();
        let visible = 0;
        rows.forEach(tr => {
            const isHeader = tr.querySelector('th') !== null;
            const isSection = tr.classList.contains('report-section-header');
            const searchable = (tr.dataset.searchable || '').toLowerCase();
            if (isHeader || isSection || searchable.includes(q)) {
                tr.classList.remove('report-row-hidden');
                if (!isHeader && !isSection) visible++;
            } else {
                tr.classList.add('report-row-hidden');
            }
        });
        if (countEl) countEl.innerText = `找到 ${visible} 筆`;
    }

    // ==========================================
    // Tenant Switcher Modal
    // ==========================================
    const switchTenantBtn = document.getElementById('switch-tenant-btn');
    const tenantModal = document.getElementById('tenant-switch-modal');
    const tenantListEl = document.getElementById('tenant-list');
    const tenantModalClose = document.getElementById('tenant-modal-close');

    switchTenantBtn?.addEventListener('click', () => {
        const tenants = window.xeroTenants || [];
        tenantListEl.innerHTML = tenants.map(t => `
            <button class="tenant-option ${t.tenantId === window.xeroActiveTenantId ? 'active-tenant' : ''}"
                    data-id="${t.tenantId}">
                <span class="tenant-dot"></span>
                ${t.tenantName}
                ${t.tenantId === window.xeroActiveTenantId ? ' ✓ 目前使用中' : ''}
            </button>
        `).join('');

        tenantListEl.querySelectorAll('.tenant-option').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (btn.dataset.id === window.xeroActiveTenantId) {
                    tenantModal.classList.remove('active');
                    return;
                }
                await switchTenant(btn.dataset.id);
                tenantModal.classList.remove('active');
                clearAllPanelData();
            });
        });

        tenantModal.classList.add('active');
    });

    tenantModalClose?.addEventListener('click', () => tenantModal.classList.remove('active'));

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => {
            if (e.target === overlay) overlay.classList.remove('active');
        });
    });

});
