# 憑證勾選跨查詢保留、拿掉「請重新搜尋」toast、新增「取消勾選」按鈕

## Context

現況：使用者要做「多次查詢、逐批勾選、最後一次列印」的工作流程，但目前程式做不到：

1. `public/js/app.js:295-299` 在每次 `refreshVouchers()` 完成後會把 `state.selected` 過濾成「只保留目前結果集中還存在的 key」，導致換條件搜尋後之前勾選的憑證被靜默取消。
2. 只要改動篩選列的任一欄位（`app.js:206` 觸發 `markDirty()`），就會透過 `notifyDirtyToast`（`app.js:135-137`）跳出 SweetAlert2 toast「條件已變更，按【查詢】重新載入」——連打幾個字就會連跳，使用者覺得很吵。
3. 選取狀態改成跨查詢保留後，使用者需要一個一次清空所有勾選的方法；目前只能一張一張手動取消。

## 修改範圍

### 1. `public/js/app.js` — 拿掉「換搜尋就清勾選」的行為

`refreshVouchers()` 內第 295–299 行整段刪除：

```js
// 移除這段
state.selected = new Set(
  Array.from(state.selected).filter((k) =>
    state.items.some((v) => `${v.type}:${v.id}` === k)
  )
);
```

刪除後：
- `state.selected` 只有在使用者主動勾選/取消勾選、按下新增的「取消勾選」按鈕、或切換公司時（`app.js:159` 的 `state.selected.clear()` 保留）才會變動。
- 預覽列印 (`app.js:182-189`) 已經是用 `state.selected` 的 key 直接拼 URL 送去 `/voucher-print.html`，該頁再各自去撈 detail，所以「勾選的憑證不在當前結果集」不會影響列印流程。
- `updateSelectionUI()`（`app.js:439-451`）的 `#select-all` checked / indeterminate 是以 `getPageItems()`（當前頁）為基礎，跟 `state.selected` 是否含當前頁以外的 key 無關 —— 不需要改。
- `#selection-count` 顯示 `state.selected.size`，會自動反映跨查詢累積的總張數，正是需要的行為。

### 2. `public/js/app.js` — 靜音「條件已變更」toast

`markDirty()`（`app.js:139-143`）內拿掉 `notifyDirtyToast()` 這一行；同時把 `notifyDirtyToast` 常數（`app.js:135-137`）一起刪掉（沒有其他呼叫者）。

保留 `els.refreshStatus.textContent = '條件已變更，按【查詢】重新載入'` —— 這行只是在 toolbar 內一段 `muted small` 灰字，不會遮擋 UI，是有用的視覺提示。

### 3. HTML/JS — 新增「取消勾選」按鈕

**HTML** — `public/index.html:30-33` 的 `.toolbar-right` 內，放在 `#selection-count` 與 `#preview-btn` 之間：

```html
<div class="toolbar-right">
  <span id="selection-count" class="muted">已選取 0 張</span>
  <button id="clear-selection" class="btn btn-ghost" disabled>取消勾選</button>
  <button id="preview-btn" class="btn btn-primary" disabled>預覽列印</button>
</div>
```

**JS** — `public/js/app.js`：

- 在 `els` 物件（`app.js:28-56`）加：`clearSelectionBtn: document.getElementById('clear-selection'),`
- 在 `bindEvents()`（`app.js:145` 開始）內、`previewBtn` 事件之後加：

  ```js
  els.clearSelectionBtn.addEventListener('click', () => {
    if (!state.selected.size) return;
    state.selected.clear();
    renderRows();
    updateSelectionUI();
  });
  ```

- 在 `updateSelectionUI()`（`app.js:439-451`）內、`els.previewBtn.disabled = n === 0;` 下面加一行：`els.clearSelectionBtn.disabled = n === 0;`

**CSS** — 不用改，`.toolbar-right` 已是 `flex` + `gap: 12px`（`app.css:79-84`），新按鈕會自動排在既有元素之間。

## 不動的地方

- 切換公司仍會清空 `state.selected`（`app.js:159`），跨 tenant 不共用勾選。
- 「清除條件」按鈕（`app.js:221-233`）維持只清 filter 值、不動 `state.selected`。
- `state.dirty` flag、`#refresh-status` 內的灰字提示、SweetAlert2 錯誤彈窗等都不動。
- 後端、列印頁、SQLite、OAuth 都不動。

## Verification

1. `npm start`，用任一 tenant 登入。
2. **跨查詢保留勾選**：日期填 `2026-07-01 ~ 2026-07-15` → 查詢 → 勾 3 張 → 改日期為 `2026-07-16 ~ 2026-07-31` → 查詢 → toolbar 應顯示「已選取 3 張」；再勾 2 張 → 「已選取 5 張」→ 按預覽列印，開出的頁面內含全部 5 張。
3. **不再吵**：連續在編號 / 廠商 / 摘要欄位打字 → 右上角應不再跳 toast；toolbar 內灰字仍會提示「條件已變更，按【查詢】重新載入」。
4. **取消勾選按鈕**：
   - 沒勾任何項時 → 按鈕為 disabled。
   - 勾了 N 張 → 按鈕啟用；按下 → 立刻變「已選取 0 張」、當前頁上顯示的 checkbox / 行反白全部清空、`#preview-btn` 與「取消勾選」自身都變 disabled。
5. **切換公司仍會清空勾選**：A 公司勾 3 張 → 切到 B 公司 → 「已選取 0 張」。
6. **清除條件不影響勾選**：勾 3 張 → 按「清除條件」→ filter 清空並重抓，勾選仍在。
7. **列印路徑穩定**：預覽列印含跨查詢累積的憑證，都能正確渲染。
