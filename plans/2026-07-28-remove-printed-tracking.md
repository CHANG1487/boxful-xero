# 移除「辨識列印」功能 + 篩選後才載入 + 拿掉啟動工具

## Context

目前平台把「辨識列印」（printed / unprinted 狀態追蹤）綁在 SQLite 的 `printed_vouchers` 表 + Xero 憑證日期 + `PRINT_CUTOFF_DATE` 切點日期上。使用者要把整套功能拿掉，因為：

1. 這個功能讓部署到 GitHub / 雲端變複雜（需要持久化 SQLite）
2. 實務上使用者只想「上去自己選要印的憑證」，不需要系統幫忙記住印過什麼
3. 進入頁面就自動載入全部憑證會浪費 Xero API 額度、也看得很雜亂

拿掉之後：
- 後端只剩 OAuth token 存 SQLite（`xero_auth` 表保留），部署更單純
- 前端頁面初始為空白，使用者輸入條件後按【查詢】才打 API
- 兩個啟動工具（`啟動列印工具.bat` / `.command`）與內部安裝文件（`安裝說明.md`）都拿掉，README 的 `npm install` / `npm start` 是唯一啟動路徑

同一時間順便調整憑證預覽表格前兩欄順序（「科目 → 摘要」改成「摘要 → 科目」）。

---

## 修改範圍與具體動作

### A. 後端：拿掉列印狀態儲存與相關邏輯

**`server/db.js`**
- 刪 `CREATE TABLE IF NOT EXISTS printed_vouchers (...)` 整段（保留 `xero_auth` 表）
- 刪 prepared statements：`insertPrinted`、`isPrinted`、`listPrintedIds`
- 刪函式 `markPrinted()`、`printedIdSet()`
- `module.exports` 只保留 `db`、`saveRefreshToken`、`loadRefreshToken`
- 註：既有安裝的 `data/app.sqlite` 會留下孤立的 `printed_vouchers` 表，這是無害的 no-op；`data/` 已在 `.gitignore` line 12，不會上到 GitHub

**`server/routes/print.js`**
- 整檔刪除

**`server/index.js`**
- 刪 line 14：`const printRouter = require('./routes/print');`
- 刪 line 46：`app.use('/api', printRouter);`

**`server/routes/vouchers.js`**（`GET /api/vouchers` 大幅簡化）
- 刪 line 3：`const { printedIdSet } = require('../db');`
- 刪 line 7：`const CUTOFF_DATE = process.env.PRINT_CUTOFF_DATE || '2026-07-01';`
- 刪 line 36：`const includePrinted = req.query.includePrinted === '1';`
- 刪 line 62：`const printedSet = printedIdSet(tenantId);`
- 簡化 `decorate(v)`（lines 64–78）：只把 `date` 標準化，不再產生 `printed` / `printedReason`
- 改 line 115–117：把 `.filter((v) => (includePrinted ? true : !v.printed))` 拿掉，只留排序
- 改 line 119–124：response 只回 `{ tenantId, items, refreshedAt }`，不再回 `cutoffDate`
- `GET /api/vouchers/:type/:id`（line 145 以後）不動

**`.env` / `.env.example`**
- 刪 `PRINT_CUTOFF_DATE=2026-07-01` 及其上一行註解

---

### B. 前端：拿掉 UI + 改成「按【查詢】才載入」

**`public/index.html`**
- 刪 lines 25–28（`#include-printed` checkbox 與 label「顯示已列印」）
- 刪 lines 85–92（「列印狀態」`filter-cell`：`<label>` + `<select id="f-printed">` 整段）
- 在 `.filter-cell-actions` 內（line 93–95）於「清除條件」左邊新增：
  ```html
  <button id="search-btn" class="btn btn-primary btn-sm">查詢</button>
  ```
- 刪 line 108 的 `<col class="col-printed" />`（header colgroup）
- 刪 line 119 的 `<th class="col-printed">列印狀態</th>`
- 刪 line 137 的 `<col class="col-printed" />`（body colgroup）
- 改 line 140 的 `<td colspan="8">` → `<td colspan="7">`，文字改成 `請於上方輸入條件後按【查詢】載入憑證。`

**`public/voucher-print.html`**
- 刪 line 12 的 `<button id="mark-btn" class="btn btn-primary">已列印，標記完成並關閉</button>`

**`public/js/app.js`**
- `state`（lines 3–26）：刪 `includePrinted`、`cutoffDate`、`filters.printed`
- `els`（lines 28–56）：刪 `includePrinted`、`fPrinted`，新增 `searchBtn: document.getElementById('search-btn')`
- `init()`（lines 96–113）：刪 line 109 的 `await refreshVouchers();`（進入頁面不自動載入）
- `bindEvents()`（lines 126–228）：
  - 刪 lines 147–151（`includePrinted` change handler）
  - 刪 line 192 `bindFilter(els.fPrinted, 'printed');`
  - 清除條件的 filter reset object 拿掉 `printed: ''`（line 198），DOM 清單拿掉 `els.fPrinted`（line 202）
  - 新增：`els.searchBtn.addEventListener('click', () => { state.page = 1; refreshVouchers(); });`
- `refreshVouchers()`（lines 232–258）：
  - 改 line 237 為 `const data = await api('/api/vouchers');`（刪掉 query string 組裝）
  - 刪 `state.cutoffDate = ...`（line 239）
  - 刪 `cutoffNote` 邏輯（lines 247–249），最後一行只寫 `最後更新：時間`（line 250–252）
- `getFilteredItems()`：刪 `f.printed` 兩行判斷（lines 275–276）
- `renderRows()`：
  - 刪 `printed` 變數計算整段（lines 320–326）
  - 刪 row template 的 `<td class="col-printed">${printed}</td>`（line 336）
  - 空狀態訊息（lines 302–308）：`colspan="8"` → `colspan="7"`；`尚未載入資料。請點【重新整理】。` → `請於上方輸入條件後按【查詢】載入憑證。`

**`public/js/print.js`**
- `els`（lines 14–20）：刪 `markBtn: document.getElementById('mark-btn'),`
- `build()`（lines 186–216）：刪 line 191 的 `els.markBtn.disabled = true;`（`printBtn.disabled = true` 保留）
- 刪 `markPrinted()` 整段函式（lines 218–228）
- 刪 `els.markBtn.addEventListener('click', ...)` 整段（lines 235–253）

**`public/css/app.css`**
- 刪 line 214：`col.col-printed, th.col-printed, td.col-printed { width: 110px; }`
- 刪 line 218：`td.col-printed { text-align: center; }`
- 刪 lines 232–244：`.printed-tag { ... }` 與 `.printed-tag.cutoff { ... }` 兩個 block

---

### C. 拿掉啟動工具與內部安裝說明

- 刪 `啟動列印工具.bat`（專案根目錄）
- 刪 `啟動列印工具.command`（專案根目錄）
- 刪 `安裝說明.md`（專案根目錄；此檔目前已在 `.gitignore` line 9）
- `.gitignore` 內對 `安裝說明.md` 的規則保留（未追蹤即可）

---

### D. 憑證預覽版型：欄位順序改成「摘要 → 科目」

檔案：`public/js/print.js`（`renderBill` 與 `renderMJ` 兩個函式）

一併調整兩種憑證，確保印出來一致（Bill 的第二欄叫「摘要」、MJ 的第二欄叫「說明」，欄名維持原本用字，只調位置）。

**`renderBill()`**（lines 63–123）
- `<thead>`（lines 96–104）交換前兩個 `<th>`：先「摘要（width:22%）」，再「科目（width:22%）」
- `rows` 迴圈（lines 69–82）交換前兩個 `<td>`：先 `<td>${escapeHtml(l.description || '')}</td>`（摘要），再 `<td>${escapeHtml(fmtAccount(l.accountCode, accounts))}</td>`（科目）

**`renderMJ()`**（lines 125–184）
- `<thead>`（lines 160–167）交換前兩個 `<th>`：先「說明（width:28%）」，再「科目（width:24%）」
- `rows` 迴圈（lines 134–149）交換前兩個 `<td>`：先 `description`，再 `fmtAccount(accountCode, accounts)`

其它欄（數量 / 單價 / 稅額 / 小計 / 借方 / 貸方）與 `<tfoot>` 的 `colspan` 不動——只交換前兩欄的顯示順序，欄寬（width%）跟著頭尾一起搬。

---

### E. 更新 `README.md`

只改與被拿掉的功能相關的行，其它段落不動：

- Line 3 開頭句：刪句尾「，並記錄已列印狀態」
- Line 8：`抓取未列印憑證` → `抓取憑證`
- Line 9：整行刪除（「已列印狀態存在後端 SQLite」）
- Line 24：`routes/{auth,tenants,vouchers,print}.js` → `routes/{auth,tenants,vouchers}.js`
- Line 80：整行 step 7 刪除（「列印完按【已列印，標記完成並關閉】…」）
- Line 91：`/api/vouchers` 那列的說明改成「憑證清單（Bills + Manual Journals）」，拿掉 `?includePrinted=1`
- Line 93：`POST /api/mark-printed` 整列刪除
- Line 107：troubleshooting「切換公司後看到空清單」拿掉「勾選【顯示已列印】確認」的部分，改成「可能真的沒有憑證，換個條件查詢看看」

---

## 執行順序

1. 後端 A 節：改 `server/db.js` → 刪 `server/routes/print.js` → 改 `server/index.js` → 改 `server/routes/vouchers.js` → 改 `.env` / `.env.example`
2. 前端 B 節：改 `public/index.html` → 改 `public/voucher-print.html` → 改 `public/js/app.js` → 改 `public/js/print.js` → 改 `public/css/app.css`
3. C 節：刪三個檔（.bat / .command / 安裝說明.md）
4. D 節：`public/js/print.js` 交換 Bill / MJ 前兩欄
5. E 節：更新 `README.md`
6. 驗證（見下方）
7. `git status` / `git diff` 檢視 → 給使用者檢查 → 才 push GitHub

---

## 驗證清單

啟動：
```
npm start
```
開 `http://localhost:3000`：

- [ ] 未登入時 → 導到 `/login.html` → 完成 Xero OAuth 回主頁（token 仍能持久化 = `xero_auth` 表 OK）
- [ ] 主頁載入後，憑證清單為**空白**，顯示「請於上方輸入條件後按【查詢】載入憑證。」
- [ ] 輸入任意篩選條件（e.g. 類型 = BILL）→ 按【查詢】→ 呼叫 `/api/vouchers` → 出現清單
- [ ] 清單中**沒有「列印狀態」欄位**，篩選列**沒有「列印狀態」選單**，工具列**沒有「顯示已列印」checkbox**
- [ ] 勾選幾張憑證 → 按【預覽列印】→ 新分頁開啟
- [ ] 預覽頁**沒有「已列印，標記完成並關閉」按鈕**，只剩【開啟列印對話框】、【取消 / 回上一頁】
- [ ] 【開啟列印對話框】能正常出瀏覽器列印視窗
- [ ] 預覽頁的憑證表格前兩欄順序為「摘要 → 科目」（Bill 與 MJ 兩種都是），其餘欄位（數量/單價/稅額/小計 或 借方/貸方/稅額）順序不變
- [ ] Network tab 確認：初始不打 `/api/vouchers`；按【查詢】才打，且 URL 沒有 `?includePrinted=1`；`/api/mark-printed` 完全不存在（404 才對）
- [ ] 專案根目錄 `啟動列印工具.bat`、`啟動列印工具.command`、`安裝說明.md` 都不存在

伺服器 log 檢查：
- [ ] `server/index.js` 啟動時不再嘗試 mount `/api/mark-printed`
- [ ] `server/db.js` 第一次啟動只 `CREATE TABLE IF NOT EXISTS xero_auth`

Git / GitHub：
- [ ] `git status` 只看到預期的檔案變動，沒有意外的 `data/*.sqlite` 追蹤
- [ ] `.env` 不會被 commit（`.gitignore` 已排除）
