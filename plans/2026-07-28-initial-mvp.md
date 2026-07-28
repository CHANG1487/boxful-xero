# Xero 中文會計憑證列印平台

> **執行第一步**：離開 plan mode 後，立即將此計畫檔複製到專案根目錄 `Xero 2.0/PLAN.md`，方便專案內查閱。

## Context

全新專案（空的 git repo）。目的：串接 Xero 平台，抓取兩間公司帳號下「已新增、未列印」的 Bills 與 Manual Journals，選取後產出中文格式的 A4 直向「中一刀」PDF 供列印，並記錄哪些憑證已列印過。

Xero 本身沒有「已列印」欄位，也不支援中文會計憑證版型，這是為什麼需要自建平台。

## 核心決策（已與使用者確認）

| 面向 | 決策 |
|---|---|
| 前端 | 純 HTML / CSS / JS（無框架、無 bundler） |
| 後端 | 最小 Node.js + Express（兩三個檔案），只做 OAuth、API 代理、SQLite 讀寫 |
| 版型 | A4 直向、上下切一刀 → 每頁 2 張 A5 直式（148 × 148.5 mm each） |
| PDF | 用瀏覽器 `window.print()` + CSS `@page`，不使用 PDF library |
| 排程 | 不做自動排程；改成使用者按【重新整理】按鈕觸發 API 更新 |
| 憑證版型 | 沿用 Xero Bills / MJ 內建欄位翻成中文 |
| 列印狀態 | 後端 SQLite |
| Xero 認證 | OAuth 2.0，支援多 tenant（兩間公司） |

## 目錄結構

```
xero-print/
├── server/
│   ├── index.js           # Express bootstrap + session
│   ├── xero-client.js     # xero-node wrapper（OAuth + API）
│   ├── db.js              # better-sqlite3 setup + schema
│   └── routes/
│       ├── auth.js        # /auth/login, /auth/callback, /auth/logout
│       ├── tenants.js     # /api/tenants（列出兩間公司、切換）
│       ├── vouchers.js    # /api/vouchers（未列印清單）、/api/refresh
│       └── print.js       # /api/mark-printed
├── public/
│   ├── index.html         # 首頁（清單 UI）
│   ├── login.html         # 未登入時的引導頁
│   ├── voucher-print.html # 列印預覽頁（開新分頁）
│   ├── css/
│   │   ├── app.css        # UI 樣式
│   │   └── print.css      # @page + 中一刀版型
│   └── js/
│       ├── app.js         # 首頁：登入態、切公司、列表、選取、觸發列印
│       └── print.js       # 列印頁：抓 detail、render、window.print()
├── data/                  # SQLite 檔案存放（.gitignored）
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Xero Developer App 建立步驟（README.md 內附）

1. 到 https://developer.xero.com/app/manage 用其中一間公司的 Xero 帳號登入
2. **New app** → 選 **Web app**
3. Company or application name：任意（例：`中文憑證列印`）
4. Integration type：Web app
5. Company URL：填一個任意 URL 即可（例 `http://localhost:3000`）
6. Redirect URI：
   - Dev：`http://localhost:3000/auth/callback`
   - Prod：日後有雲端網址再新增一筆
7. 建立後在 **Configuration** 拿到 **Client ID** 與 **Client Secret**（Secret 只顯示一次）
8. **Authorised users** 內新增第二間公司的擁有人帳號（讓兩間公司的授權都能發到同一個 app）

`.env`：
```
XERO_CLIENT_ID=...
XERO_CLIENT_SECRET=...
XERO_REDIRECT_URI=http://localhost:3000/auth/callback
XERO_SCOPES=offline_access accounting.transactions accounting.journals.read accounting.contacts.read
SESSION_SECRET=<隨機字串>
PORT=3000
```

## 後端 dependency

- `express` — HTTP server
- `xero-node` — 官方 SDK，內建 OAuth 2.0 + Bills / Manual Journal API
- `better-sqlite3` — 同步、零設定的 SQLite
- `express-session` + `connect-sqlite3` — session 儲存（存 access token / 目前選中的 tenant）
- `dotenv`

## SQLite Schema（`server/db.js` 內宣告）

```sql
-- 記錄哪些憑證已列印
CREATE TABLE IF NOT EXISTS printed_vouchers (
  tenant_id     TEXT NOT NULL,
  voucher_type  TEXT NOT NULL CHECK (voucher_type IN ('BILL','MJ')),
  voucher_id    TEXT NOT NULL,
  printed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  printed_by    TEXT,
  PRIMARY KEY (tenant_id, voucher_type, voucher_id)
);

-- 儲存 refresh token（access token 短命，用 session 就好；refresh token 需持久化）
CREATE TABLE IF NOT EXISTS xero_auth (
  user_id       TEXT PRIMARY KEY,   -- Xero user identifier
  refresh_token TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 主要流程

### 1. OAuth 登入
- 首頁 `app.js` 檢查 `/api/me`；若未登入，跳 `login.html`
- 按【使用 Xero 登入】→ `GET /auth/login` → server 用 `xero-node` 產生 authorize URL 302 到 Xero
- Xero 回 `/auth/callback?code=...` → server 換 tokens、取得 tenants 列表
- 授權碼交換的 tokens 存 session；refresh token 存 `xero_auth`
- 302 回 `/`

### 2. 選公司（tenant switch）
- `GET /api/tenants` 回 `[{id, name}, ...]`（xero-node `updateTenants()`）
- 首頁右上角下拉切換；選擇存 session 的 `activeTenantId`

### 3. 列出未列印憑證
- `GET /api/vouchers?tenantId=X` → server 平行呼叫：
  - `accountingApi.getInvoices(tenantId, ..., where: 'Type=="ACCPAY"', statuses: ['DRAFT','SUBMITTED','AUTHORISED'])` — Bills
  - `accountingApi.getManualJournals(tenantId, ..., where: 'Status=="DRAFT" OR Status=="POSTED"')` — MJs
- 用 `printed_vouchers` 過濾掉已列印，回傳未列印清單（合併 type、id、日期、金額、對象/敘述）

### 4. 手動【重新整理】
- 前端按鈕直接再打 `GET /api/vouchers`（不需另設 `/refresh` endpoint；Xero SDK 內部會處理 rate limit 與 token 續期）
- 頂端顯示「最後更新時間 hh:mm」

### 5. 選取 → 預覽 → 列印
- 使用者勾選多筆 → 按【預覽列印】→ 開新分頁 `voucher-print.html?ids=BILL:uuid,MJ:uuid,...`
- `print.js` 對每個 id 打 `GET /api/vouchers/:type/:id` 拿完整 line items → 依序渲染
- 每頁 A4 直向裡放 2 張 A5 直式，中間虛線裁切線
- 頁面就緒後彈出瀏覽器列印對話框（`window.print()`）
- 使用者列印完（或按頁面上的【已列印，標記完成】按鈕）→ `POST /api/mark-printed` `{ items: [...] }` → SQLite 寫入
- `afterprint` 事件也可以順便觸發標記，但為避免誤按預覽就標記，**採用顯式按鈕確認**

### 6. 取消（回上一頁）
- 列印預覽頁按【取消】→ `window.close()` 或返回首頁；SQLite 完全不動

## 版型（`public/css/print.css`）

```css
@page { size: A4 portrait; margin: 0; }

@media print {
  body { margin: 0; }
  .voucher-sheet {
    width: 210mm;
    height: 297mm;
    display: flex;
    flex-direction: column;
    page-break-after: always;
  }
  .voucher {
    height: 148.5mm;      /* A4 對切 */
    padding: 10mm 12mm;
    box-sizing: border-box;
    border-bottom: 1px dashed #666;   /* 中一刀裁切線 */
  }
  .voucher:last-child { border-bottom: none; }
}

body {
  font-family: "PingFang TC", "Microsoft JhengHei",
               "Noto Sans TC", system-ui, sans-serif;
}
```

### Bill 中文版欄位對照（沿用 Xero 版型翻譯）
| Xero 欄位 | 中文欄名 |
|---|---|
| Contact | 廠商 |
| Date | 日期 |
| Due Date | 到期日 |
| Reference | 參考編號 |
| Line items (Account / Description / Qty / Unit / Amount / Tax) | 帳戶 / 摘要 / 數量 / 單價 / 金額 / 稅額 |
| Subtotal / Total Tax / Total | 未稅金額 / 稅額 / 總計 |

### Manual Journal 中文版欄位對照
| Xero 欄位 | 中文欄名 |
|---|---|
| Date | 日期 |
| Narration | 摘要 |
| Journal Lines (Account / Description / Debit / Credit / Tax) | 會計科目 / 說明 / 借方 / 貸方 / 稅額 |
| Status | 狀態 |

## 使用者原始流程圖 vs 實作差異

| 原流程 | 實作 |
|---|---|
| 每日 09:00 AM 從 API 重整 | 改為使用者按【重新整理】按鈕觸發 |
| 帳密輸入 | 改成 Xero OAuth 2.0（不會經過我們的伺服器輸入密碼） |
| 帳密錯誤訊息 | 由 Xero 登入頁處理；我方只需處理 callback 失敗頁 |

其餘流程完全按照原 mermaid 圖實作。

## Verification / 測試計畫

### 開發過程
1. 用 Xero **Demo Company (Global)** 測試 OAuth flow 與 Bills / MJ 抓取
2. `.env` 內 `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` 填好後 `npm install && npm start`，開 `http://localhost:3000`
3. 完整走一遍：登入 → 切公司 → 看清單 → 選 2~3 張 → 預覽 → 瀏覽器列印對話框選【儲存為 PDF】→ 確認是 2 張 A5 直式在 A4 上、中間有裁切線
4. 按【已列印】→ 回首頁重新整理 → 確認剛列印那幾張不再出現

### 上線前
- 兩間真實公司都跑一次 OAuth 授權（確認 `Authorised users` 設定正確）
- 兩間公司的 Bill 與 MJ 各印一張、確認欄位對應正確
- 印出的 A4 用剪刀從中線裁開，確認尺寸符合 A5

### 邊界情況
- 選中的憑證在 Xero 上被別人刪掉 → `/api/vouchers/:type/:id` 回 404，預覽頁跳過並顯示提示
- SQLite 已標記已印，但使用者想重印 → 提供「顯示已列印」切換 checkbox
- 多人同時操作：SQLite `PRIMARY KEY` 保證同一憑證只會被標記一次

## 未來擴充（本次不做，先記下）

- 每日排程自動 refresh（等未來搬雲端再加 `node-cron`）
- 憑證版型細節微調（用真實範本比對後）
- 匯出 zip 一次多份 PDF
