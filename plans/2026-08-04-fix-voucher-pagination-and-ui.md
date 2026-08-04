# 修正 `/api/vouchers` 資料不完整（BOXFUL TW 07/01–07/31 只撈到 136 張）+ 篩選列日期壓縮 + 通知改 SweetAlert2

> **執行第一步**：離開 plan mode 後，將本計畫同步存到 `Xero 2.0/plans/2026-08-04-fix-voucher-pagination-and-ui.md`，維持 `plans/YYYY-MM-DD-<slug>.md` 的歸檔慣例（見 `plans/README.md`）。

## Context

三個相關問題一次處理：

1. **資料撈取不完整**：使用者在 BOXFUL TW 上搜尋 2026-07-01 ~ 2026-07-31 的憑證，結果只出現 136 張，明顯有 Bills 被漏掉。根因：
   - `server/routes/vouchers.js:34-56` 呼叫 `getInvoices` / `getManualJournals` 沒做分頁 loop（Xero 兩個 endpoint 都是分頁的：Invoices 預設 100/頁、`summaryOnly=true` 也只到 1000；Manual Journals 100/頁），沒 loop 就只拿到第 1 頁。
   - Xero `where` 只有 `Type=="ACCPAY"`、`order=Date DESC` → 回的第 1 頁是「跨全部時期最近的 N 筆」，8 月憑證多就把 7 月擠出第 1 頁。
   - 前端 `app.js:229-253` 的 `refreshVouchers()` 沒把 filter state 送給後端，日期過濾在瀏覽器記憶體做——後端沒吐出來的資料永遠過濾不出來。
2. **篩選列「日期」欄位被壓縮**：`.filter-bar` 使用 `grid-template-columns: repeat(auto-fit, minmax(140px, 1fr))`（`app.css:96-97`）——所有 cell 共享 140px 最小寬。日期是 `filter-cell-range` 裡放兩個 `<input type="date">`，各只分到約 55–60px，`2026/07/01` 幾乎看不完整。
3. **通知不一致**：目前錯誤與提示直接寫在 inline text（`refresh-status`、`print-status`），沒有一致的訊息介面。使用者希望以 SweetAlert2 統一呈現。

第二階段計畫（`plans/2026-07-28-list-enhancements.md`）當初決定「Xero 一次撈完、前端記憶體過濾」，但實作沒真的「一次撈完」；同時對兩間公司多年累積的資料而言「一次撈完全部歷史」不切實際。這次順勢把設計改為：**所有 filter 都送後端，後端把日期範圍下推到 Xero、其餘 filter 在後端做**，然後把過濾後的結果一次回傳給前端。

## 設計決策

| 面向 | 決策 |
|---|---|
| 空日期預設 | 後端 fallback 為「今天 − 60 天」到「今天」 |
| Filter 位置 | 全部推到後端；前端只送查詢條件 + 呈現結果 |
| Xero 查詢下推 | 日期範圍（`where`）+ Bills 的 status（`statuses` 參數）+ type（決定要不要呼叫該 endpoint） |
| 其餘條件（number / contact / narration / 金額） | 後端拿到 Xero 資料後在記憶體過濾（Xero `where` 對名稱模糊 / MJ 金額支援薄弱，硬推容易錯） |
| 通知 UI | SweetAlert2（CDN 引入，與現有無 bundler 風格一致）；透過小 wrapper 集中設定 zh-Hant 按鈕文字與主題色 |
| 前端 UI 觸發 | 修改 filter 欄位只更新 `state.filters` 並用 SweetAlert2 toast 顯示「條件已變更，按【查詢】重新載入」；只有【查詢】/【重新整理】/【清除條件】才打後端 |

## 修改範圍

### 1. `server/routes/vouchers.js` — 全面重寫 `GET /api/vouchers` 資料撈取邏輯

新增輔助：

```js
function toXeroDate(iso) {
  // '2026-07-01' -> 'DateTime(2026,7,1)'
  const [y, m, d] = iso.split('-').map(Number);
  return `DateTime(${y},${m},${d})`;
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 60);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

async function fetchAllInvoices(client, tenantId, where, statuses) {
  const all = [];
  const pageSize = 1000; // 配合 summaryOnly=true
  const MAX_PAGES = 100; // 安全閥
  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await client.accountingApi.getInvoices(
      tenantId, undefined, where, 'Date DESC',
      undefined, undefined, undefined, statuses,
      page, false, false, undefined, true, pageSize
    );
    const items = resp.body.invoices || [];
    all.push(...items);
    if (items.length < pageSize) return all;
  }
  console.warn(`fetchAllInvoices reached MAX_PAGES for tenant ${tenantId}`);
  return all;
}

async function fetchAllManualJournals(client, tenantId, where) {
  const all = [];
  const pageSize = 100; // Xero MJ 上限
  const MAX_PAGES = 100;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await client.accountingApi.getManualJournals(
      tenantId, undefined, where, 'Date DESC', page, pageSize
    );
    const items = resp.body.manualJournals || [];
    all.push(...items);
    if (items.length < pageSize) return all;
  }
  console.warn(`fetchAllManualJournals reached MAX_PAGES for tenant ${tenantId}`);
  return all;
}
```

Handler 主體：

- 讀取 query：`type`、`dateFrom`、`dateTo`、`number`、`contact`、`narration`、`amountMin`、`amountMax`、`status`。
- 日期預設：任一為空 → 用 `defaultDateRange()` 回填。
- 組 `where`：
  - Bills：`'Type=="ACCPAY" && Date>=' + toXeroDate(from) + ' && Date<=' + toXeroDate(to)`
  - MJs：`'Date>=' + toXeroDate(from) + ' && Date<=' + toXeroDate(to)`（若 `status` 有值追加 `&& Status=="XXX"`）
- Xero `statuses`：Bills 傳 `[status]` 或預設 `['DRAFT','SUBMITTED','AUTHORISED','PAID']`（VOIDED 仍排除）。
- 依 `type` 決定要呼叫哪些 endpoint：
  - `type='BILL'`：只呼叫 `fetchAllInvoices`
  - `type='MJ'`：只呼叫 `fetchAllManualJournals`
  - 空：兩個都呼叫（`Promise.all` 平行）
- Map 後套用**記憶體 filter**（字串 contains / 數字範圍），邏輯與現有 app.js:255-272 相同、直接搬到後端。
- 回應新增 `appliedDateFrom` / `appliedDateTo`，讓前端可顯示套用日期。

### 2. `public/js/app.js` — 送 filter、拿掉即時前端過濾

- `refreshVouchers()`：把 `state.filters` 全部串成 query string 送出，`state.items = data.items`（已是後端過濾後的結果）。
- 拿掉前端二次過濾：`getFilteredItems()` 改為直接回傳 `state.items`（或整段移除，`getPageItems()` / `applyAndRender()` 直接用 `state.items`）。
- Filter input 事件（app.js:172-183 `bindFilter`）：不再呼叫 `applyAndRender()`；改為只更新 `state.filters[key]`、把 refresh 狀態變為 dirty、跳一次 SweetAlert2 toast（`toast()`，非阻塞、右上角、2 秒）：「條件已變更，按【查詢】重新載入」。用 debounce 避免每個 keystroke 都跳 toast。
- 【查詢】：呼叫 `refreshVouchers()`。
- 【清除條件】：清 `state.filters`、清 UI 值 → **呼叫 `refreshVouchers()`** 重抓（目前只做 `applyAndRender()`，資料會停在舊條件的結果）。
- 【切換公司】：改為呼叫 `refreshVouchers()` 而不是空 `applyAndRender()`。
- **錯誤處理統一改 SweetAlert2**（見第 4 節）。

### 3. `public/css/app.css` — 修復日期欄位被壓縮

問題：`.filter-bar` 用 `repeat(auto-fit, minmax(140px, 1fr))`，日期 range cell 需求比其他 cell 高。

修法（最小改動）：日期 range cell 加獨立寬度 hint，讓它自動佔到能放得下兩個 `2026-07-01` 的寬度。

- HTML：`public/index.html:42` 那個 `.filter-cell.filter-cell-range` 上加識別 class（例如 `filter-cell-date`），與 `.filter-cell-amount`（金額 range）區分。
- CSS 新增：
  ```css
  /* 讓日期欄位在 grid 中佔兩欄，日期輸入才不會被壓成看不完整 */
  .filter-cell-date { grid-column: span 2; }
  /* 或改用 min-width 讓 date input 有底線寬度 */
  .filter-cell-date .range input[type="date"] { min-width: 128px; }
  ```
- 若 grid 排在窄螢幕擠不下 → `@media (max-width: 900px) { .filter-cell-date { grid-column: span 1; } }`（可選，本工具主要在桌機用）。

（金額 range 現況可接受，這次不動——只針對日期。）

### 4. 引入 SweetAlert2，替換現有訊息

- `public/index.html` 與 `public/voucher-print.html`：`<head>` 加入 SweetAlert2 CDN：
  ```html
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.min.css" />
  <script defer src="https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.all.min.js"></script>
  ```
  （工具已需要網路才能連 Xero，CDN 不是新的網路依賴。）
- 新增小 wrapper `public/js/notify.js`（讓所有頁面共用），內容：
  ```js
  window.notify = {
    error(msg)   { Swal.fire({ icon: 'error',   title: '錯誤', text: msg, confirmButtonText: '關閉' }); },
    warn(msg)    { Swal.fire({ icon: 'warning', title: '注意', text: msg, confirmButtonText: '關閉' }); },
    info(msg)    { Swal.fire({ icon: 'info',    title: '提示', text: msg, confirmButtonText: '關閉' }); },
    success(msg) { Swal.fire({ icon: 'success', title: '完成', text: msg, timer: 1500, showConfirmButton: false }); },
    toast(msg, icon = 'info') {
      Swal.fire({
        toast: true, position: 'top-end', icon, title: msg,
        showConfirmButton: false, timer: 2000, timerProgressBar: true,
      });
    },
    confirm(msg) {
      return Swal.fire({
        icon: 'question', title: '確認', text: msg,
        showCancelButton: true, confirmButtonText: '確定', cancelButtonText: '取消',
      }).then((r) => r.isConfirmed);
    },
  };
  ```
- `index.html` 的 `<script>` 順序改為 `notify.js` → `app.js`；`voucher-print.html` 同理放在 `print.js` 之前。
- **改寫既有訊息**：
  - `app.js:247` 讀取失敗：從 inline `refresh-status` 文字改為 `notify.error('讀取失敗：' + err.message)`；inline 只保留短狀態（「讀取中…」/「最後更新：hh:mm」）。
  - `app.js:80-88` `api()` 內 401 現在直接 `window.location.href = '/login.html'`，加一行 `notify.warn('登入已過期，請重新登入')`（可選——即時導離其實已足夠，不強加）。
  - `print.js:186-203` 沒有指定憑證 / 個別憑證讀取失敗：從 inline 訊息改為 `notify.error(...)`（讀取失敗集中一次跳，訊息含所有失敗 id）。
  - Filter 變更提示：`notify.toast('條件已變更，按【查詢】重新載入', 'info')`（debounce 500ms）。

### 5. 微幅提示：套用的日期範圍

在 `refresh-status` 附近（`public/index.html`）新增一小行 `<span id="applied-range" class="muted small"></span>`，`refreshVouchers()` 成功後填入 `已套用 ${appliedDateFrom} ~ ${appliedDateTo}`，讓使用者知道「沒填日期時預設是最近 60 天」。

## 不動的地方

- 版型、列印流程（`voucher-print.html` 版型主體）、SQLite、OAuth、tenant 切換都不動。
- 狀態白名單 (`DRAFT/SUBMITTED/AUTHORISED/PAID`) 不動。
- 前端分頁（10/50/100/500）+ 選取狀態跨頁保留不動。
- `GET /api/vouchers/:type/:id`（單張 detail）不動。
- 金額 range 欄位寬度不動（僅修日期）。

## Verification

1. `npm start`，用 BOXFUL TW 登入。
2. **主案（漏資料）**：日期填 `2026-07-01` ~ `2026-07-31` → 按【查詢】→ 對照 Xero 網頁 (Business → Bills to pay + Accounting → Manual Journals) 相同期間所有 non-VOIDED / non-ARCHIVED 憑證的張數，應**完全一致**（含原先漏掉的 Bills）。
3. **空日期預設**：清空日期後按【查詢】→ 應顯示「最近 60 天」（今天 2026-08-04 → `2026-06-05` ~ `2026-08-04`）；`applied-range` 顯示套用值。
4. **分頁 loop**：故意選一整年（`2026-01-01` ~ `2026-12-31`）→ server console 無截斷警告、清單張數對得上 Xero 網頁。
5. **其他 filter**：廠商 / 金額範圍 / 狀態 / 類型 / 編號 / 摘要——各自能正確篩選；狀態切 `PAID` 時，只有 Bill 的 PAID 出現（MJ 沒有 PAID）。
6. **日期欄位不再被壓縮**：篩選列上兩個日期輸入應完整顯示 `2026/07/01` `2026/07/31`，不再被切掉。桌機常用寬度 (~1280px 以上) 排版正常。
7. **SweetAlert2 通知**：
   - 拔網路後按【查詢】→ 出現紅色錯誤彈窗（不是純文字）。
   - 修改任一 filter 欄位（等 500ms 後）→ 右上角出現 toast「條件已變更，按【查詢】重新載入」。
   - 列印預覽頁沒指定 id / 讀 detail 失敗 → 出現彈窗提示。
8. **UX**：改任何 filter 但不按【查詢】→ 清單不動；按【查詢】才會刷新。
9. **清除條件**：按下後日期回填為預設 60 天並自動重抓（不是保留舊資料）。
10. **切換公司**：切到另一 tenant → 清單重抓，不會殘留前一間公司的資料。
11. **列印流程**：從擴充後的清單挑幾張（尤其原先漏掉的）→ 預覽列印 → 版型與內容都沒因此變更受影響。
