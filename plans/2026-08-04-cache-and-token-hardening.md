# 避免撞 Xero API 每日配額：登入後預拉 90 天資料，操作全走記憶體快取

## Context

使用者今天撞到 Xero 每日配額（`x-rate-limit-problem: day`、`retry-after: 77000+` 秒）。畫面連中文錯誤都沒有，同事直接不能用。

盤點結論（Explore 代理）：

- 「查詢」= 5 種型別平行分頁抓 = 5–15 次 API。
- 列印預覽的最大浪費：每點一張憑證都會重打 `getAccounts`（`vouchers.js:356`）；勾 10 張 = 10 次多餘呼叫。
- 整份 codebase **零快取、零 429 handling、零 `Retry-After` UI**。
- 客戶端不會自動 refresh，都是手動觸發 → 只要控制**重複觸發**就大幅省下呼叫。

**使用者要求的策略（本計畫核心）**：

> 「登入選完公司後，背景預拉近 90 天所有傳票紀錄一次存進快取。之後任何查詢、列印，都從快取讀，不再打 API。只有按【重新整理】才會重拉。」

這比「per-endpoint TTL 快取」更激進、但也更符合會計場景（同事一天多次反覆查同一批資料、且 Xero 資料變動不即時）。

## 機制可行性

- 目前列表 API 用 `summaryOnly=true` → 只拿摘要，不含 `lineItems`，所以列印詳細每張都要再打一次 API。
- **改成不帶 `summaryOnly`** → 一次就能拿到完整資料。代價：`getInvoices` 的 pageSize 從 1000 降到 100（Xero 對 non-summary 呼叫的分頁上限），大 tenant 分頁次數會變多。
- 90 天資料量估算：中型公司大約 200 張/月 × 3 種主要型別 × 3 個月 ≈ 1800 張；即使全部有 line items，記憶體 <20 MB，可忽略。
- 預拉一次的成本：小 tenant ≈ 5–10 次呼叫；大 tenant 可能 30–50 次；即使 50 次也只用掉每日配額（5000）的 1%。

**結論**：可行，且真的能做到「預拉後零 API」的目標。

## 修改範圍

### 1. `server/cache.js`（新檔，~60 行）

以 `tenantId` 為單位維護一份**整合快取**：

```js
// tenantId → { vouchers, accounts, preloadedAt, preloadedFrom, loading: Promise | null }
const store = new Map();

function getTenant(tenantId) { ... }               // 讀（會清掉過期 loading）
function setTenantData(tenantId, payload) { ... }  // 寫 vouchers + accounts + timestamps
function markLoading(tenantId, promise) { ... }    // 紀錄進行中的預拉 Promise（供並發等候）
function waitIfLoading(tenantId) { ... }           // 若正在預拉，回傳同一個 Promise
function bust(tenantId) { ... }                    // 清整個 tenant 快取（重新整理用）
module.exports = { getTenant, setTenantData, markLoading, waitIfLoading, bust };
```

**沒有 TTL 過期**——快取只在「按重新整理」與「重啟 server」時才失效，符合使用者要求。

### 2. `server/preload.js`（新檔，~80 行）

匯出 `preloadTenant(client, tenantId)`：

```js
async function preloadTenant(client, tenantId) {
  const existing = cache.waitIfLoading(tenantId);
  if (existing) return existing;
  const p = (async () => {
    const dateTo = new Date();
    const dateFrom = new Date(Date.now() - 90*24*3600*1000);
    const [bills, mjs, recv, spnd, cns, accounts] = await Promise.all([
      fetchAllInvoices(client, tenantId, dateFrom, dateTo, /* summaryOnly */ false),
      fetchAllManualJournals(client, tenantId, dateFrom, dateTo),
      fetchAllBankTransactions(client, tenantId, dateFrom, dateTo, 'RECEIVE'),
      fetchAllBankTransactions(client, tenantId, dateFrom, dateTo, 'SPEND'),
      fetchAllCreditNotes(client, tenantId, dateFrom, dateTo),
      fetchAccountsMap(client, tenantId),
    ]);
    cache.setTenantData(tenantId, {
      vouchers: { BILL: bills, MJ: mjs, RECV: recv, SPND: spnd, CN: cns },
      accounts,
      preloadedFrom: dateFrom,
      preloadedAt: new Date(),
    });
  })();
  cache.markLoading(tenantId, p);
  return p;
}
```

`fetchAllInvoices` 需要加參數 `summaryOnly=false` 分支（原本 hardcode true）—— 或直接乾脆改預設 false、pageSize 對應調成 100。

### 3. `server/routes/vouchers.js` — 大改列表 handler 與詳細 handler

**列表 handler（vouchers.js:152）** 重寫：

```js
router.get('/vouchers', requireAuth, async (req, res, next) => {
  try {
    const client = await clientFromSession(req.session);
    const tenantId = req.session.activeTenantId;
    if (req.query.force === '1') cache.bust(tenantId);
    if (!cache.getTenant(tenantId)) await preloadTenant(client, tenantId);
    else await cache.waitIfLoading(tenantId);
    const tc = cache.getTenant(tenantId);
    const items = filterAndMergeFromCache(tc.vouchers, req.query);
    res.json({ items, appliedDateFrom, appliedDateTo, refreshedAt: tc.preloadedAt });
  } catch (err) { next(err); }
});
```

`filterAndMergeFromCache` = 目前 handler 從 `Promise.all` 之後開始那些 in-memory 過濾/合併邏輯（`number/contact/narration/amountMin/amountMax` 等）**原封不動搬進來**，因為那本來就是 server-side 記憶體過濾。

**詳細 handler（vouchers.js:350）** 重寫：

```js
router.get('/vouchers/:type/:id', requireAuth, async (req, res, next) => {
  try {
    const tenantId = req.session.activeTenantId;
    if (!cache.getTenant(tenantId)) await preloadTenant(client, tenantId);
    else await cache.waitIfLoading(tenantId);
    const tc = cache.getTenant(tenantId);
    const found = tc.vouchers[req.params.type].find(v => matchesId(v, req.params.type, req.params.id));
    if (!found) return res.status(404).json({ error: '找不到此憑證（可能已超出 90 天預拉範圍，請按重新整理）' });
    res.json({ type: req.params.type, data: found, accounts: tc.accounts });
  } catch (err) { next(err); }
});
```

**列出使用者日期範圍超過 90 天怎麼辦**：目前 UI 預設會改成 90 天，同事若手動拉到 90 天以外的日期，就在 `filterAndMergeFromCache` 內偵測 `dateFrom < preloadedFrom`，回傳 warning `stale: true` 讓前端 toast「僅顯示近 90 天資料；如需更早請按重新整理並拉大範圍」；這輪不做「動態延伸預拉範圍」，避免複雜化。

### 4. 429 error handling

同上一版計畫的做法：

- 新 helper `normalizeXeroError(err)` 攔截 429，讀 `retry-after` + `x-rate-limit-problem`。
- 各 `fetchAll*` 的 `catch` 改成 `throw normalizeXeroError(err)`。
- `server/index.js:48-56` 全域 error middleware 對 429 回結構化 JSON `{ error, retryAfter, rateLimitProblem }`。
- `public/js/app.js` 的 `api()`（line 100-109）加 429 分支，`notify.error("Xero 已達當日配額，約 X 小時 Y 分鐘後恢復")`；`minute` 問題顯示不同措辭。

即使有預拉快取，預拉本身也可能撞 429（例如同事今天已用完配額後才登入），這時要有明確訊息。

### 5. `public/js/app.js` — 三個 UI 微調

- **同步狀態指示**：header `.brand` 旁或 `#refresh-status` 顯示 `已同步 90 天資料（14:32）` 或 `資料同步中…`。以 `state.syncStatus` 記錄，`refreshVouchers` 觸發時更新。
- **預設日期範圍**：目前預設 `dateFrom = today - 60 days`（vouchers.js:172-174 server 端 fallback），前端 `f-date-from` 也應該預設 today - 90 days；改對應初始化程式碼（`app.js` init 內）。
- **重新整理 vs 查詢**：`refreshVouchers(opts = { force: false })`；重新整理按鈕 → `{ force: true }`；查詢按鈕 → `{}`。切 tenant 也 force。

### 6. 觸發預拉的時機

**選定：選完公司後背景預拉**。實作點：

- OAuth 回來後（`server/routes/auth.js` 的 callback 尾端）若已知 `activeTenantId`，`preloadTenant(client, activeTenantId).catch(err => console.error(...))` 不 await。
- `/api/set-tenant`（或前端切 tenant 打的 endpoint，探索代理未列具體檔案 → 實作時 grep 找）也一樣：切完 tenant 後 fire-and-forget 預拉。
- 客戶端載入完 `/api/me` 得到 activeTenant 後，在畫面顯示「同步中…」狀態；`refreshVouchers` 若正碰到預拉在跑，會被 server 端 `await cache.waitIfLoading(tenantId)` 攔住，等預拉完再回覆。

### 7. Token 硬化（處理「登入約 30 分鐘後失效、需要重登」）

**根因**：Xero access token 壽命 30 分鐘。目前 `server/xero-client.js:21-24` 只在剩餘 <60 秒才 refresh，且**沒有 mutex** — 一次「查詢」平行打 5 支 API 若剛好卡在 30 分鐘那條線，每支請求都獨立呼叫 `refreshToken()`，而 Xero 的 refresh_token 是**單次使用**，第一支成功、剩下四支用作廢的 refresh_token → `invalid_grant` → 整個 session 死掉需要重登。

**四項改動**：

**(a) In-memory refresh mutex — `server/xero-client.js`**

在 module scope 加 `const refreshLocks = new Map(); // sessionId → Promise<TokenSet>`。改寫 `clientFromSession`：

```js
async function refreshTokenSetOnce(client, session, req) {
  const key = req.sessionID; // express-session 賦予的唯一 ID
  if (refreshLocks.has(key)) return refreshLocks.get(key);
  const p = (async () => {
    try {
      const newTokenSet = await client.refreshToken();
      // 防禦性 clone，確保 session store JSON 序列化不掉東西
      session.tokenSet = JSON.parse(JSON.stringify(newTokenSet));
      // 也把最新 refresh_token 存進 DB 給以後救回用
      const claims = newTokenSet.claims ? newTokenSet.claims() : null;
      const uid = claims && claims.xero_userid;
      if (uid && newTokenSet.refresh_token) {
        saveRefreshToken(uid, newTokenSet.refresh_token);
      }
      // 明確 save 避免 session write race
      await new Promise((r, j) => req.session.save(err => err ? j(err) : r()));
      return newTokenSet;
    } finally {
      refreshLocks.delete(key);
    }
  })();
  refreshLocks.set(key, p);
  return p;
}
```

`clientFromSession(session, req)` 簽名要加 `req`，這樣才能拿到 `req.sessionID` 與 `req.session.save`。所有呼叫端（`vouchers.js:154, 353`、`preload.js` 內）都要順手把 `req` 一起傳進去。

**(b) 提早 refresh buffer 到 5 分鐘 — 同檔**

`xero-client.js:21` 條件 `< 60_000` 改成 `< 5 * 60 * 1000`。降低「壓線失誤」機率。

**(c) refresh 失敗時清乾淨 session — 同檔**

`refreshTokenSetOnce` 的 try/catch 內 catch `err`：若是 `invalid_grant`（`err.error === 'invalid_grant'` 或 `err.response?.statusCode === 400`），呼叫 `req.session.destroy(() => {})`，然後 throw 一個 `err.statusCode = 401` 讓前端已有的 401 → 導 `/login.html` 邏輯接手。使用者看到的是「請重新登入」，而不是無意義的 500 或 `invalid_grant` 訊息。

**(d) rolling cookie + 拉長 maxAge — `server/index.js`**

`server/index.js:33-38` cookie 設定加 `rolling: true`，`maxAge` 從 7 天改 30 天。只要 30 天內有用過就自動延後到期時間；60 天沒用超過會回頭撞 Xero refresh_token 60 天上限，那時要重登也合理。

## 不動的地方

- OAuth、SQLite session store、`xero_auth` 表：不動。
- 分頁 UI、篩選 UI、列印 UI：不動。
- `打包.command`、`.env`、README：不動。
- 不引入 Redis、不引入外部 cache 套件、不寫 SQLite 快取表。
- 不做自動 TTL 過期、不做 focus/visibilitychange 自動 refresh、不做跨 session 共享。

## 預期效果

- 一個 session 內：**預拉一次 ≈ 5–50 次 API 呼叫（依 tenant 大小）**，之後查詢、切篩選、列印全部 0 API。
- 若一天內同事重新整理 3 次 → 一天總共 15–150 次 = 極遠低於 5000 的日配額。
- 撞 429 時前端有清楚中文訊息 + 恢復時間預估。
- 副作用：同事想看「剛剛在 Xero 新增的憑單」必須按重新整理才會看到（可接受，且比目前的「隨機失敗」好很多）。
- Token 硬化後：連續使用中的 session 不會因為 30 分鐘 access token 過期而斷（mutex 消除 refresh_token 競爭）；session cookie 從 7 天延到 30 天且 rolling，只要有在用就不會被踢出去；refresh 真的失敗（例如 60 天沒動過）也會清楚導到重登畫面。

## Verification

1. `npm start` → 登入 → 選一個 tenant → 觀察 server console 應在幾秒內連續打幾支 Xero API（預拉），之後平靜下來。
2. **零 API 操作**：預拉完後，在 filter bar 換條件、切分頁、勾選、按查詢 → server console **不該再有任何 Xero 呼叫**。
3. **列印預覽全 hit cache**：勾 10 張憑證 → 預覽 → server console 對 `getAccounts`、`getInvoice/getBankTransaction/…` **應該零呼叫**。
4. **強制重拉**：按重新整理 → server console 應再打預拉 —— 而且大約與第 1 步同樣密度的呼叫。
5. **429 UI（模擬）**：暫時把 `fetchAllInvoices` 改成 `throw normalizeXeroError({ response: { statusCode: 429, headers: { 'retry-after': '77000', 'x-rate-limit-problem': 'day' } } })`（測完拿掉）→ 重新整理 → 前端 toast「Xero 已達當日配額，約 21 小時後恢復」。
6. **日期超出 90 天**：手動把 f-date-from 拉到 100 天前 → 前端應收到 warning toast「僅顯示近 90 天資料」，且清單只有 90 天內容。
7. **實測配額節省**：等現在的 429 過完 → 開 app → 隨便查詢 20 次、列印 3 批 → 觀察 Xero response 上的 `x-daylimit-remaining`，應該只掉了預拉那一次的呼叫數，其他都零。
8. **Token 30 分鐘不斷**：登入 → 打開兩個 tab 同時按查詢 → 等到 access token 剩 <5 分鐘（可看 tokenSet.expires_at 減 Date.now） → 同時按兩個 tab 的查詢 → 兩邊都要成功（測 refresh mutex）。若手邊沒工具算 expires_at，就登入完刻意等 25 分鐘再操作，模擬正常使用節奏。
9. **rolling cookie**：登入後打開 DevTools → Application → Cookies → 看 session cookie 的 Expires。做一次操作後重新看，Expires 時間應該往後跳。
10. **refresh 失敗導引**：暫時把 `.env` 內 `XERO_CLIENT_SECRET` 亂改一位（測試後改回來）→ 觸發任意操作 → 應該看到「請重新登入」而不是 500 錯誤。

## 交接說明

- 本計畫寫在 `/Users/likachang/.claude/plans/eager-mixing-beacon.md`。依 [Plan folder convention]，實作前我會 copy 到 `Xero 2.0/plans/2026-08-04-cache-and-token-hardening.md`。
- 實作完成後：commit + push 排除打包檔（`打包.command`、`啟動列印工具.*`、`使用說明.md`），然後跑 `打包.command` 產新 ZIP。
