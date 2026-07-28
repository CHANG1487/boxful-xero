# Xero 中文會計憑證列印平台

從 Xero 抓取兩間公司的 **Bills（應付憑單）** 與 **Manual Journals（轉帳傳票）**，選擇後列印中文格式、A4 直向「中一刀」（每張 A4 印兩張 A5 直式憑證）的 PDF。

## 特色

- Xero OAuth 2.0 登入，多公司（tenant）帳號切換
- 主頁進入為空白清單；輸入條件後按【查詢】才向 Xero API 抓取憑證
- 純 HTML/CSS/JS 前端；後端只做 OAuth、API 代理、refresh token 儲存
- 列印使用瀏覽器內建 `window.print()`，可直接【儲存為 PDF】

## 專案結構

```
Xero 2.0/
├── package.json
├── .env.example
├── plans/                     # 開發計畫存檔（README + YYYY-MM-DD-*.md）
├── server/
│   ├── index.js
│   ├── xero-client.js
│   ├── db.js
│   └── routes/{auth,tenants,vouchers}.js
├── public/
│   ├── index.html
│   ├── login.html
│   ├── voucher-print.html
│   ├── css/{app,print}.css
│   └── js/{app,print}.js
└── data/     # SQLite 檔（自動建立、已 gitignore）
```

## 建立 Xero Developer App

1. 用其中一間公司的 Xero 帳號登入 https://developer.xero.com/app/manage
2. **New app** → 選 **Web app**
3. 表單填寫：
   - **Company or application name**：任意（例：`中文憑證列印`）
   - **Integration type**：Web app
   - **Company or application URL**：任填一個 URL（例 `http://localhost:3000`）
   - **OAuth 2.0 redirect URI**：`http://localhost:3000/auth/callback`（開發用；上雲後再新增 production URL）
4. 建立後在 **Configuration** 頁面：
   - 複製 **Client ID**
   - 點【Generate a secret】拿到 **Client Secret**（只顯示一次，請立刻複製）
5. **Authorised users**：把第二間公司的擁有人 email 加進來，兩間公司才能都用同一個 App 授權
6. Scopes（Xero 新版顆粒化 scope，一個端點一個 scope，免費方案支援）：
   - `offline_access`（必要，用來取得 refresh_token）
   - `accounting.invoices.read`（Bills，即 AP Invoices）
   - `accounting.manualjournals.read`（Manual Journals，會計轉帳傳票）
   - `accounting.contacts.read`（廠商名稱）
   - `accounting.settings.read`（組織資訊）

   ⚠️ 舊的 `accounting.transactions` 已被 Xero 淘汰；`accounting.journals.read` 是另一個歷史 GL 匯總端點，付費才有，不是本 App 需要的。

## 本機啟動

```bash
# 1. 安裝依賴
npm install

# 2. 複製 env 檔並填入 Xero 憑證
cp .env.example .env
# 用編輯器打開 .env，填入 XERO_CLIENT_ID、XERO_CLIENT_SECRET
# SESSION_SECRET 隨意填一段長字串

# 3. 啟動
npm start
# 或開發模式（檔案異動自動重啟）
npm run dev
```

打開 `http://localhost:3000`：
1. 首次進入會導到 `/login.html`
2. 按【使用 Xero 登入】→ 導到 Xero 官方登入頁
3. 完成授權後回到主頁，右上角可切換公司
4. 在篩選列輸入條件（類型 / 日期 / 廠商…）後按【查詢】從 Xero 抓資料
5. 勾選要列印的憑證 → 按【預覽列印】會開新分頁
6. 新分頁按【開啟列印對話框】→ 用瀏覽器【儲存為 PDF】或直接列印

## API 端點速覽

| Method | Path | 說明 |
|---|---|---|
| GET  | `/auth/login`   | 302 到 Xero 授權頁 |
| GET  | `/auth/callback` | Xero 授權碼交換 |
| POST | `/auth/logout`  | 登出 |
| GET  | `/api/me`       | 目前登入狀態 + tenants |
| POST | `/api/tenants/switch` | 切換公司 |
| GET  | `/api/vouchers` | 憑證清單（Bills + Manual Journals） |
| GET  | `/api/vouchers/:type/:id` | 單張憑證明細（type = BILL / MJ） |

## 測試建議

第一次串接建議先用 Xero **Demo Company (Global)**：
- 在 Xero 網頁右上角公司名稱下拉可切換到 Demo Company
- OAuth 授權時勾選 Demo Company
- Bills 與 Manual Journals 都有預建範例資料，可直接測列印

## Troubleshooting

- **登入回來卡在 500 或空白**：檢查 `.env` 的 `XERO_REDIRECT_URI` 是否**完全一致**於 Developer 後台設定
- **看不到 Bills**：確認 App scopes 有 `accounting.transactions`
- **看不到 Manual Journals**：確認 App scopes 有 `accounting.journals.read`
- **切換公司後看到空清單**：切換後清單會清空，需要重新輸入條件按【查詢】；若查詢後仍為空，可能真的沒有符合條件的憑證，換條件再試
- **中文字型看起來像宋體/系統預設**：印表機/瀏覽器沒有安裝 PingFang / 微軟正黑；Mac / Windows 通常內建即可

## 未來擴充（尚未實作）

- 每日 09:00 自動排程 refresh（要搬到常駐服務，例如 Zeabur / Render / Fly.io）
- 列印憑證樣式微調（拿到真實範本後對照）
- 支援匯出多份 PDF 為 zip
