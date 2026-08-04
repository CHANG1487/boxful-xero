# 修正 OAuth scope 錯誤：`accounting.transactions.read` → `accounting.banktransactions.read`

## Context

上一次為了支援 Received Money / Spend Money / Credit Note，我在 `XERO_SCOPES` 加了 `accounting.transactions.read`（舊版傘狀 scope）。使用者按【登入】後 Xero 回 `invalid_scope` / 500，代表這個 scope 不在 Xero App 的允許清單裡。

使用者的 Xero App 顆粒化 scope 清單有：

- `accounting.banktransactions` / `.read` ← BankTransactions（RECV / SPND）需要的
- `accounting.invoices` / `.read` ← Xero 把 **Credit Notes 也歸在這個 scope 底下**，所以 CN 用現有的即可
- `accounting.manualjournals` / `.read`、`accounting.contacts` / `.read`、`accounting.settings` / `.read` ← 已在用

**沒有** `accounting.transactions.read`，也 **沒有** `accounting.creditnotes.read`。

修法：把 `accounting.transactions.read` 換成 `accounting.banktransactions.read`。Credit Notes 沿用 `accounting.invoices.read`。

（Xero App 完整 scope 清單已存進 `~/.claude/projects/.../memory/project_xero_app_scopes.md`。）

## 修改範圍

### `.env`（本地、gitignored）與 `.env.example`（tracked）

`XERO_SCOPES` 內的 `accounting.transactions.read` 換成 `accounting.banktransactions.read`：

```
XERO_SCOPES=offline_access accounting.invoices.read accounting.manualjournals.read accounting.banktransactions.read accounting.contacts.read accounting.settings.read
```

## 不動的地方

- `server/routes/vouchers.js`、`public/js/print.js` 等程式碼不動。上一輪加的 RECV/SPND/CN 邏輯正確，只是授權時要用對 scope。
- 其他所有檔案不動。

## 執行後使用者要做的事

1. 重啟 Node server（讓新 `.env` 生效）。
2. 登出並重新登入：Xero 顯示同意畫面含新的「View your bank transactions」權限；同意後拿到新 access token 含 `accounting.banktransactions.read`。
3. 之後查 SPND / RECV / CN 都會通。

## Verification

1. `npm start` → 登入 → Xero 授權畫面應顯示新 permission（銀行交易讀取）→ 同意後導回。
2. 查詢 `type=SPND` / `type=RECV`：清單張數對照 Xero 網頁 Bank accounts 內的 Spend / Receive Money 交易。
3. 查詢 `type=CN`：ACCPAY + ACCREC 兩種 Credit Notes 都出現。
4. 預覽列印各型別版式與內容正確。

## 後續：ZIP 更新

打包後同事拿到新 ZIP 首次啟動也要重新登入一次，才會拿到帶新 scope 的 access token。
