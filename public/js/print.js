'use strict';

const params = new URLSearchParams(window.location.search);
const idsParam = params.get('ids') || '';
const items = idsParam
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [type, id] = s.split(':');
    return { type, id };
  });

const els = {
  sheets: document.getElementById('sheets'),
  printBtn: document.getElementById('print-btn'),
  markBtn: document.getElementById('mark-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  status: document.getElementById('print-status'),
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

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '';
  return Number(n).toLocaleString('zh-Hant', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchDetail(item) {
  const r = await fetch(`/api/vouchers/${item.type}/${encodeURIComponent(item.id)}`, {
    credentials: 'same-origin',
  });
  if (!r.ok) throw new Error(`${item.type}:${item.id} 讀取失敗`);
  return r.json();
}

function renderBill(inv) {
  const lines = inv.lineItems || [];
  const total = inv.total != null ? inv.total : 0;
  const tax = inv.totalTax != null ? inv.totalTax : 0;
  const sub = inv.subTotal != null ? inv.subTotal : total - tax;

  const rows = lines
    .map((l) => `
      <tr>
        <td>${escapeHtml((l.accountCode || '') + (l.accountCode && l.description ? ' ' : '') + (l.description || ''))}</td>
        <td class="num">${l.quantity != null ? l.quantity : ''}</td>
        <td class="num">${l.unitAmount != null ? fmtMoney(l.unitAmount) : ''}</td>
        <td class="num">${l.taxAmount != null ? fmtMoney(l.taxAmount) : ''}</td>
        <td class="num">${l.lineAmount != null ? fmtMoney(l.lineAmount) : ''}</td>
      </tr>
    `)
    .join('');

  return `
    <div class="voucher" data-type="BILL" data-id="${escapeHtml(inv.invoiceID)}">
      <h2 class="voucher-title">應付憑單（Bill）</h2>
      <div class="voucher-meta">
        <div class="field"><span class="label">廠商</span><span class="value">${escapeHtml(inv.contact ? inv.contact.name : '')}</span></div>
        <div class="field"><span class="label">日期</span><span class="value">${fmtDate(inv.date)}</span></div>
        <div class="field"><span class="label">憑單號</span><span class="value">${escapeHtml(inv.invoiceNumber || '')}</span></div>
        <div class="field"><span class="label">到期日</span><span class="value">${fmtDate(inv.dueDate)}</span></div>
        <div class="field"><span class="label">參考</span><span class="value">${escapeHtml(inv.reference || '')}</span></div>
        <div class="field"><span class="label">狀態</span><span class="value">${escapeHtml(inv.status || '')}</span></div>
      </div>
      <table class="voucher-lines">
        <thead>
          <tr>
            <th style="width:44%">帳戶 / 摘要</th>
            <th style="width:10%">數量</th>
            <th style="width:15%">單價</th>
            <th style="width:14%">稅額</th>
            <th style="width:17%">小計</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="5" style="text-align:center;color:#999">—</td></tr>`}</tbody>
        <tfoot>
          <tr><td colspan="4" class="num">未稅金額</td><td class="num">${fmtMoney(sub)}</td></tr>
          <tr><td colspan="4" class="num">稅額</td><td class="num">${fmtMoney(tax)}</td></tr>
          <tr><td colspan="4" class="num">總計 (${escapeHtml(inv.currencyCode || '')})</td><td class="num">${fmtMoney(total)}</td></tr>
        </tfoot>
      </table>
      <div class="voucher-footer">
        <div class="notes">${inv.reference ? '備註：' + escapeHtml(inv.reference) : ''}</div>
        <div class="signatures">
          <div class="sig-cell"><span class="label">製表</span></div>
          <div class="sig-cell"><span class="label">會計</span></div>
          <div class="sig-cell"><span class="label">核准</span></div>
        </div>
      </div>
    </div>
  `;
}

function renderMJ(mj) {
  const lines = mj.journalLines || [];
  const totalDebit = lines
    .filter((l) => (l.lineAmount || 0) > 0)
    .reduce((s, l) => s + (l.lineAmount || 0), 0);
  const totalCredit = lines
    .filter((l) => (l.lineAmount || 0) < 0)
    .reduce((s, l) => s + Math.abs(l.lineAmount || 0), 0);

  const rows = lines
    .map((l) => {
      const amt = l.lineAmount || 0;
      const debit = amt > 0 ? fmtMoney(amt) : '';
      const credit = amt < 0 ? fmtMoney(Math.abs(amt)) : '';
      return `
        <tr>
          <td>${escapeHtml(l.accountCode || '')}</td>
          <td>${escapeHtml(l.description || '')}</td>
          <td class="num">${debit}</td>
          <td class="num">${credit}</td>
          <td class="num">${l.taxAmount != null ? fmtMoney(l.taxAmount) : ''}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <div class="voucher" data-type="MJ" data-id="${escapeHtml(mj.manualJournalID)}">
      <h2 class="voucher-title">轉帳傳票（Manual Journal）</h2>
      <div class="voucher-meta">
        <div class="field"><span class="label">日期</span><span class="value">${fmtDate(mj.date)}</span></div>
        <div class="field"><span class="label">狀態</span><span class="value">${escapeHtml(mj.status || '')}</span></div>
        <div class="field" style="grid-column: 1 / -1"><span class="label">摘要</span><span class="value">${escapeHtml(mj.narration || '')}</span></div>
      </div>
      <table class="voucher-lines">
        <thead>
          <tr>
            <th style="width:14%">科目</th>
            <th style="width:38%">說明</th>
            <th style="width:16%">借方</th>
            <th style="width:16%">貸方</th>
            <th style="width:16%">稅額</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="5" style="text-align:center;color:#999">—</td></tr>`}</tbody>
        <tfoot>
          <tr><td colspan="2" class="num">合計</td><td class="num">${fmtMoney(totalDebit)}</td><td class="num">${fmtMoney(totalCredit)}</td><td></td></tr>
        </tfoot>
      </table>
      <div class="voucher-footer">
        <div class="notes"></div>
        <div class="signatures">
          <div class="sig-cell"><span class="label">製表</span></div>
          <div class="sig-cell"><span class="label">會計</span></div>
          <div class="sig-cell"><span class="label">核准</span></div>
        </div>
      </div>
    </div>
  `;
}

async function build() {
  if (!items.length) {
    els.sheets.innerHTML =
      '<p style="padding:40px;text-align:center;color:#666">沒有指定要列印的憑證。</p>';
    els.printBtn.disabled = true;
    els.markBtn.disabled = true;
    return;
  }
  els.status.textContent = '讀取中…';
  const detailBlocks = [];
  for (const it of items) {
    try {
      const detail = await fetchDetail(it);
      if (it.type === 'BILL') detailBlocks.push(renderBill(detail.data));
      else if (it.type === 'MJ') detailBlocks.push(renderMJ(detail.data));
    } catch (err) {
      detailBlocks.push(
        `<div class="voucher"><p style="color:#dc2626">讀取 ${escapeHtml(it.type)}:${escapeHtml(it.id)} 失敗：${escapeHtml(err.message)}</p></div>`
      );
    }
  }

  const sheets = [];
  for (let i = 0; i < detailBlocks.length; i += 2) {
    const first = detailBlocks[i];
    const second = detailBlocks[i + 1] || '<div class="voucher"></div>';
    sheets.push(`<div class="voucher-sheet">${first}${second}</div>`);
  }
  els.sheets.innerHTML = sheets.join('');
  els.status.textContent = `共 ${items.length} 張憑證，${sheets.length} 頁 A4`;
}

async function markPrinted() {
  const r = await fetch('/api/mark-printed', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '標記失敗');
  return data;
}

els.printBtn.addEventListener('click', () => window.print());
els.cancelBtn.addEventListener('click', () => {
  if (window.opener) window.close();
  else history.back();
});
els.markBtn.addEventListener('click', async () => {
  els.markBtn.disabled = true;
  els.status.textContent = '標記中…';
  try {
    await markPrinted();
    els.status.textContent = '已標記完成，視窗即將關閉…';
    setTimeout(() => {
      if (window.opener) {
        try { window.opener.location.reload(); } catch (_) {}
        window.close();
      } else {
        window.location.href = '/';
      }
    }, 600);
  } catch (err) {
    els.status.textContent = '標記失敗：' + err.message;
    els.markBtn.disabled = false;
  }
});

build();
