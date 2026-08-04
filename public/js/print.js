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

function fmtAccount(code, accounts) {
  if (!code) return '';
  const name = accounts && accounts[code];
  return name ? `${code} ${name}` : String(code);
}

async function fetchDetail(item) {
  const r = await fetch(`/api/vouchers/${item.type}/${encodeURIComponent(item.id)}`, {
    credentials: 'same-origin',
  });
  if (!r.ok) throw new Error(`${item.type}:${item.id} 讀取失敗`);
  return r.json();
}

function renderBill(inv, accounts) {
  const lines = inv.lineItems || [];
  const total = inv.total != null ? inv.total : 0;
  const tax = inv.totalTax != null ? inv.totalTax : 0;
  const sub = inv.subTotal != null ? inv.subTotal : total - tax;

  const rows = lines
    .map((l) => {
      return `
      <tr>
        <td>${escapeHtml(l.description || '')}</td>
        <td>${escapeHtml(fmtAccount(l.accountCode, accounts))}</td>
        <td class="num">${l.quantity != null ? l.quantity : ''}</td>
        <td class="num">${l.unitAmount != null ? fmtMoney(l.unitAmount) : ''}</td>
        <td class="num">${l.taxAmount != null ? fmtMoney(l.taxAmount) : ''}</td>
        <td class="num">${l.lineAmount != null ? fmtMoney(l.lineAmount) : ''}</td>
      </tr>
    `;
    })
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
            <th style="width:22%">摘要</th>
            <th style="width:22%">科目</th>
            <th style="width:10%">數量</th>
            <th style="width:15%">單價</th>
            <th style="width:14%">稅額</th>
            <th style="width:17%">小計</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="6" style="text-align:center;color:#999">—</td></tr>`}</tbody>
        <tfoot>
          <tr><td colspan="5" class="num">未稅金額</td><td class="num">${fmtMoney(sub)}</td></tr>
          <tr><td colspan="5" class="num">稅額</td><td class="num">${fmtMoney(tax)}</td></tr>
          <tr><td colspan="5" class="num">總計 (${escapeHtml(inv.currencyCode || '')})</td><td class="num">${fmtMoney(total)}</td></tr>
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

function renderMJ(mj, accounts) {
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
          <td>${escapeHtml(l.description || '')}</td>
          <td>${escapeHtml(fmtAccount(l.accountCode, accounts))}</td>
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
            <th style="width:28%">說明</th>
            <th style="width:24%">科目</th>
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

function renderBankTx(bt, accounts, direction) {
  const lines = bt.lineItems || [];
  const total = bt.total != null ? bt.total : 0;
  const tax = bt.totalTax != null ? bt.totalTax : 0;
  const sub = bt.subTotal != null ? bt.subTotal : total - tax;

  const title =
    direction === 'RECV'
      ? '收款單（Received Money）'
      : '付款單（Spend Money）';
  const counterLabel = direction === 'RECV' ? '付款方' : '受款方';
  const idShort = bt.bankTransactionID
    ? bt.bankTransactionID.slice(0, 8).toUpperCase()
    : '';
  const bankAcct = bt.bankAccount
    ? fmtAccount(bt.bankAccount.code, accounts) || (bt.bankAccount.name || '')
    : '';

  const rows = lines
    .map(
      (l) => `
      <tr>
        <td>${escapeHtml(l.description || '')}</td>
        <td>${escapeHtml(fmtAccount(l.accountCode, accounts))}</td>
        <td class="num">${l.quantity != null ? l.quantity : ''}</td>
        <td class="num">${l.unitAmount != null ? fmtMoney(l.unitAmount) : ''}</td>
        <td class="num">${l.taxAmount != null ? fmtMoney(l.taxAmount) : ''}</td>
        <td class="num">${l.lineAmount != null ? fmtMoney(l.lineAmount) : ''}</td>
      </tr>
    `
    )
    .join('');

  return `
    <div class="voucher" data-type="${direction}" data-id="${escapeHtml(bt.bankTransactionID || '')}">
      <h2 class="voucher-title">${title}</h2>
      <div class="voucher-meta">
        <div class="field"><span class="label">${counterLabel}</span><span class="value">${escapeHtml(bt.contact ? bt.contact.name : '')}</span></div>
        <div class="field"><span class="label">日期</span><span class="value">${fmtDate(bt.date)}</span></div>
        <div class="field"><span class="label">交易編號</span><span class="value">${escapeHtml(idShort)}</span></div>
        <div class="field"><span class="label">銀行帳戶</span><span class="value">${escapeHtml(bankAcct)}</span></div>
        <div class="field"><span class="label">參考</span><span class="value">${escapeHtml(bt.reference || '')}</span></div>
        <div class="field"><span class="label">狀態</span><span class="value">${escapeHtml(bt.status || '')}</span></div>
      </div>
      <table class="voucher-lines">
        <thead>
          <tr>
            <th style="width:22%">摘要</th>
            <th style="width:22%">科目</th>
            <th style="width:10%">數量</th>
            <th style="width:15%">單價</th>
            <th style="width:14%">稅額</th>
            <th style="width:17%">小計</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="6" style="text-align:center;color:#999">—</td></tr>`}</tbody>
        <tfoot>
          <tr><td colspan="5" class="num">未稅金額</td><td class="num">${fmtMoney(sub)}</td></tr>
          <tr><td colspan="5" class="num">稅額</td><td class="num">${fmtMoney(tax)}</td></tr>
          <tr><td colspan="5" class="num">總計 (${escapeHtml(bt.currencyCode || '')})</td><td class="num">${fmtMoney(total)}</td></tr>
        </tfoot>
      </table>
      <div class="voucher-footer">
        <div class="notes">${bt.reference ? '備註：' + escapeHtml(bt.reference) : ''}</div>
        <div class="signatures">
          <div class="sig-cell"><span class="label">製表</span></div>
          <div class="sig-cell"><span class="label">會計</span></div>
          <div class="sig-cell"><span class="label">核准</span></div>
        </div>
      </div>
    </div>
  `;
}

function renderCreditNote(cn, accounts) {
  const lines = cn.lineItems || [];
  const total = cn.total != null ? cn.total : 0;
  const tax = cn.totalTax != null ? cn.totalTax : 0;
  const sub = cn.subTotal != null ? cn.subTotal : total - tax;

  const isPay = cn.type === 'ACCPAYCREDIT';
  const title = isPay
    ? '應付貸項通知單（Credit Note）'
    : '應收貸項通知單（Credit Note）';
  const counterLabel = isPay ? '廠商' : '客戶';
  const numShort = cn.creditNoteNumber
    ? cn.creditNoteNumber
    : cn.creditNoteID
    ? cn.creditNoteID.slice(0, 8).toUpperCase()
    : '';

  const rows = lines
    .map(
      (l) => `
      <tr>
        <td>${escapeHtml(l.description || '')}</td>
        <td>${escapeHtml(fmtAccount(l.accountCode, accounts))}</td>
        <td class="num">${l.quantity != null ? l.quantity : ''}</td>
        <td class="num">${l.unitAmount != null ? fmtMoney(l.unitAmount) : ''}</td>
        <td class="num">${l.taxAmount != null ? fmtMoney(l.taxAmount) : ''}</td>
        <td class="num">${l.lineAmount != null ? fmtMoney(l.lineAmount) : ''}</td>
      </tr>
    `
    )
    .join('');

  return `
    <div class="voucher" data-type="CN" data-id="${escapeHtml(cn.creditNoteID || '')}">
      <h2 class="voucher-title">${title}</h2>
      <div class="voucher-meta">
        <div class="field"><span class="label">${counterLabel}</span><span class="value">${escapeHtml(cn.contact ? cn.contact.name : '')}</span></div>
        <div class="field"><span class="label">日期</span><span class="value">${fmtDate(cn.date)}</span></div>
        <div class="field"><span class="label">貸項單號</span><span class="value">${escapeHtml(numShort)}</span></div>
        <div class="field"><span class="label">到期日</span><span class="value">${fmtDate(cn.dueDate)}</span></div>
        <div class="field"><span class="label">參考</span><span class="value">${escapeHtml(cn.reference || '')}</span></div>
        <div class="field"><span class="label">狀態</span><span class="value">${escapeHtml(cn.status || '')}</span></div>
      </div>
      <table class="voucher-lines">
        <thead>
          <tr>
            <th style="width:22%">摘要</th>
            <th style="width:22%">科目</th>
            <th style="width:10%">數量</th>
            <th style="width:15%">單價</th>
            <th style="width:14%">稅額</th>
            <th style="width:17%">小計</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="6" style="text-align:center;color:#999">—</td></tr>`}</tbody>
        <tfoot>
          <tr><td colspan="5" class="num">未稅金額</td><td class="num">${fmtMoney(sub)}</td></tr>
          <tr><td colspan="5" class="num">稅額</td><td class="num">${fmtMoney(tax)}</td></tr>
          <tr><td colspan="5" class="num">總計 (${escapeHtml(cn.currencyCode || '')})</td><td class="num">${fmtMoney(total)}</td></tr>
        </tfoot>
      </table>
      <div class="voucher-footer">
        <div class="notes">${cn.reference ? '備註：' + escapeHtml(cn.reference) : ''}</div>
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
    if (window.notify) window.notify.warn('沒有指定要列印的憑證。');
    return;
  }
  els.status.textContent = '讀取中…';
  const detailBlocks = [];
  const failed = [];
  for (const it of items) {
    try {
      const detail = await fetchDetail(it);
      if (it.type === 'BILL') detailBlocks.push(renderBill(detail.data, detail.accounts));
      else if (it.type === 'MJ') detailBlocks.push(renderMJ(detail.data, detail.accounts));
      else if (it.type === 'RECV') detailBlocks.push(renderBankTx(detail.data, detail.accounts, 'RECV'));
      else if (it.type === 'SPND') detailBlocks.push(renderBankTx(detail.data, detail.accounts, 'SPND'));
      else if (it.type === 'CN') detailBlocks.push(renderCreditNote(detail.data, detail.accounts));
    } catch (err) {
      failed.push(`${it.type}:${it.id}（${err.message}）`);
      detailBlocks.push(
        `<div class="voucher"><p style="color:#dc2626">讀取 ${escapeHtml(it.type)}:${escapeHtml(it.id)} 失敗：${escapeHtml(err.message)}</p></div>`
      );
    }
  }
  if (failed.length && window.notify) {
    window.notify.error('部分憑證讀取失敗：\n' + failed.join('\n'));
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

els.printBtn.addEventListener('click', () => window.print());
els.cancelBtn.addEventListener('click', () => {
  if (window.opener) window.close();
  else history.back();
});

build();
