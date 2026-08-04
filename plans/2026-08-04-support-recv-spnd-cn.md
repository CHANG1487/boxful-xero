# 支援 Received Money / Spend Money / Credit Note 三種憑證的清單、篩選與列印

## Context

目前工具只支援 BILL（`Invoices` `Type=ACCPAY`）與 MJ（`ManualJournals`）。使用者實務上還需列印：

- **Received Money**（Xero `BankTransactions`，`Type` 為 `RECEIVE` / `RECEIVE-OVERPAYMENT` / `RECEIVE-PREPAYMENT`）
- **Spend Money**（Xero `BankTransactions`，`Type` 為 `SPEND` / `SPEND-OVERPAYMENT` / `SPEND-PREPAYMENT`）
- **Credit Note**（Xero `CreditNotes`，含 `ACCPAY` 與 `ACCREC` 兩種）

清單抓取、明細抓取、篩選下拉、清單標籤、列印範本全部要擴充。無資料庫 / 快取層 key 到 `BILL`/`MJ`，新增 `RECV` / `SPND` / `CN` 代碼不會破壞舊資料。

## 設計決策

| 面向 | 決策 |
|---|---|
| 型別代碼 | `RECV`、`SPND`、`CN`（純大寫、無 `:` / `,`，可安全用於 `${type}:${id}` 複合鍵與 URL） |
| Credit Note 是否拆兩種 | 統一為單一 `CN`，列印範本依 `ACCPAY` / `ACCREC` 動態呈現「應付貸項通知單」或「應收貸項通知單」 |
| BankTransaction 子型 | RECV 涵蓋 `RECEIVE` + `-OVERPAYMENT` + `-PREPAYMENT`；SPND 同理。排除 `-TRANSFER`（銀行內部轉帳） |
| 中文標題 | RECV → `收款單（Received Money）`；SPND → `付款單（Spend Money）`；CN → `應付/應收貸項通知單（Credit Note）` |
| Status 篩選 | BILL/CN 沿用 whitelist `[DRAFT, SUBMITTED, AUTHORISED, PAID]`；RECV/SPND 只有 `AUTHORISED`（VOIDED/DELETED 排除）；使用者選了不適用的 status → 對應型別回空陣列 |
| 列印範本共用 | RECV/SPND/CN 的 `lineItems[]` 結構同 BILL；共用一個明細表 render，只調整標題與 meta |
| 分頁 loop | BankTransactions / CreditNotes 均無 `summaryOnly`；沿用 100/頁 loop（比照 `fetchAllManualJournals`） |

## 修改範圍

### 1. `server/routes/vouchers.js`

- 新增 `fetchAllBankTransactions(client, tenantId, where)` 與 `fetchAllCreditNotes(client, tenantId, where)`，分別呼叫 `getBankTransactions` / `getCreditNotes`，讀 `resp.body.bankTransactions` / `resp.body.creditNotes`；100/頁、`MAX_PAGES = 100`。
- `GET /api/vouchers`：
  - 加 `recvWhere` / `spndWhere` / `cnWhere` 建構（RECV/SPND 一律附 `Status=="AUTHORISED"`；CN 選填 `Status=="..."`）。
  - dispatch 從 2 個 slot 擴為 5，`type` 空 = 全跑，指定 = 只跑對應那支；status 不適用時該 slot 回 `Promise.resolve([])`。
  - 三個新 row mapper（RECV/SPND 用 `bankTransactionID` 首 8 碼當 number、`bt.contact?.name` 或退回 `bankAccount.name`；CN 用 `creditNoteNumber` 或 ID 首 8 碼）。
- `GET /api/vouchers/:type/:id` 加三個 `else if` 分支：
  - RECV/SPND → `getBankTransaction`，回 `{ type, data: resp.body.bankTransactions[0], accounts }`
  - CN → `getCreditNote`，回 `{ type: 'CN', data: resp.body.creditNotes[0], accounts }`

### 2. `public/index.html`

`#f-type` 下拉插入：

```html
<option value="SPND">付款單</option>
<option value="RECV">收款單</option>
<option value="CN">貸項通知單</option>
```

順序：BILL → SPND → RECV → CN → MJ。

### 3. `public/js/app.js`

`renderRows` 內的 `typeBadge` 三元式換成 lookup table：

```js
const TYPE_BADGE = {
  BILL: { cls: 'bill', label: 'BILL' },
  MJ:   { cls: 'mj',   label: 'MJ' },
  RECV: { cls: 'recv', label: '收款' },
  SPND: { cls: 'spnd', label: '付款' },
  CN:   { cls: 'cn',   label: '貸項' },
};
```

### 4. `public/css/app.css`

`.type-badge.bill` / `.mj` 後加：

```css
.type-badge.recv { background:#dcfce7; color:#166534; }
.type-badge.spnd { background:#fee2e2; color:#991b1b; }
.type-badge.cn   { background:#ede9fe; color:#5b21b6; }
```

### 5. `public/js/print.js`

- 新 `renderBankTx(bt, accounts, direction)`（`direction` 為 `'RECV'` / `'SPND'`）：標題依 `direction`；meta 顯示對方（`bt.contact?.name`）、日期、交易編號（ID 首 8 碼）、**銀行帳戶**（`bt.bankAccount` 用 `fmtAccount`）、參考、狀態；明細表沿用 BILL 版式與 tfoot 未稅/稅/總計 + `currencyCode`。
- 新 `renderCreditNote(cn, accounts)`：標題依 `cn.type`（`ACCPAYCREDIT` / `ACCRECCREDIT`）；meta 顯示廠商/客戶、日期、貸項單號、到期日、參考、狀態；明細表同 BILL。
- `build()` dispatcher 擴為 5 個 `else if`。

## 不動的地方

- 分頁 / 選取跨查詢保留 / 取消勾選按鈕 / 篩選 toast / 列印按鈕文字（「輸出成 PDF 檔」）—— 全部不動。
- Session / OAuth / SQLite / tenant 切換 / `fetchAccountsMap` —— 不動。
- `public/css/print.css`、`public/voucher-print.html` —— 不動（class 完全通用）。

## Verification

1. `npm start`，用 BOXFUL TW 登入。
2. **清單抓取（全部型別）**：日期 `2026-07-01 ~ 2026-07-31`、type 留空 → 查詢 → 清單同時出現 BILL / MJ / RECV / SPND / CN，張數對照 Xero 網頁。
3. **type 篩選**：分別選 SPND / RECV / CN，各只顯示對應型別。
4. **RECV/SPND 狀態**：只出現 `AUTHORISED`；VOIDED 應消失。
5. **CN ACCPAY/ACCREC**：兩種同時列在清單；列印標題依 sub-type 動態切換。
6. **列印範本**：勾 RECV / SPND / CN 各 1 張 → 預覽列印：
   - RECV 標題「收款單（Received Money）」、SPND「付款單（Spend Money）」、CN 依 sub-type。
   - RECV/SPND 顯示銀行帳戶；CN 顯示貸項單號。
   - 明細表 `accountCode` 由 `fetchAccountsMap` 補成 `code name`。
   - 每張仍 A4 半張，兩張/頁。
7. **勾選跨查詢保留**：跨型別勾選（BILL + RECV）→ 預覽列印同時渲染。
8. **badge 顯色**：五種顏色互不衝突。
9. **BILL / MJ 不退步**：既有輸出與改動前一致。
10. **黑白列印流程**：【輸出成 PDF 檔】→ 另存為 PDF → Preview 開啟 → 黑白列印，各型別皆正確。
