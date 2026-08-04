# 列印頁「開啟列印對話框」改為導向 PDF 匯出流程，解決黑白列印失效

## Context

使用者在預覽列印頁按下「開啟列印對話框」列印時，即使印表機驅動已設為「黑白」，實際輸出仍是彩色。

探索結論：
- 現行列印頁 (`public/voucher-print.html` + `public/css/print.css`) 內容其實已經**幾乎全是黑白** —— 只用了 `#333` / `#444` / `#999` / `#f0f0f0` / `#fafafa` 這類灰階值，沒有品牌色、沒有 badge，沒有 `<img>`、沒有 SVG。整份 codebase 也沒有任何 `print-color-adjust: exact` / `-webkit-print-color-adjust` 強制彩色。
- `public/js/print.js:222` 直接呼叫 `window.print()`，沒有 iframe、沒有 PDF 產生器、沒有第三方套件。
- 沒有現成的 PDF 匯出程式碼；`package.json` 也沒有任何 PDF 相依。
- 「黑白設定失效」是**瀏覽器→印表機色彩協商**問題（Chrome 列印對話框的「彩色/黑白」下拉預設為「彩色」並覆蓋 CUPS 驅動的黑白設定），單靠 CSS 修不了。

使用者已同意：把按鈕改成引導使用者走「先存成 PDF、再用 PDF 檢視器列印」的流程。這樣印表機的黑白設定就會在 PDF 檢視器的列印路徑上正確套用。實作上仍呼叫 `window.print()`（Chrome / Edge / Safari 的列印對話框都內建「另存為 PDF」目的地，產出的是**向量 PDF、中文字最清楚**），只是把按鈕文字與周邊說明改成 PDF 匯出的心智模型。

## 修改範圍

### 1. `public/voucher-print.html` — 改按鈕文字 + 加提示

`public/voucher-print.html:13` 的 `#print-btn`：

- 按鈕文字從 `開啟列印對話框` 改為 `輸出成 PDF 檔`。
- 在按鈕旁（同一 `.toolbar` 內、給 `no-print` class）加一段小灰字提示：

  ```html
  <span class="print-hint muted small no-print">
    列印黑白請按【輸出成 PDF 檔】→ 目的地選「另存為 PDF」→ 存檔後用 PDF 檢視器列印
  </span>
  ```

### 2. `public/js/print.js` — 保留 `window.print()`

`public/js/print.js:222` 這行維持不變：

```js
els.printBtn.addEventListener('click', () => window.print());
```

不改邏輯，只有按鈕文字/提示的視覺變更；`window.print()` 呼叫的瀏覽器對話框天然支援「另存為 PDF」目的地。

### 3. CSS — 提示樣式（微幅）

`.muted` 與 `.small` 已存在，直接復用；如需微調間距，於 print 頁工具列樣式旁加一條 `.print-hint { margin-left: 8px; }` 即可。

## 不動的地方

- 列印頁的排版、資料抓取、`sheet` 分頁邏輯、`@media print` 規則、CSS 灰階值 —— 皆不動。
- `window.print()` 呼叫本身不動。
- 不引入 `html2pdf.js` / `jsPDF` / puppeteer 等新相依。
- 主清單頁 (`public/index.html`)、後端、SQLite、OAuth 不動。

## Verification

1. `npm start`，登入任一 tenant，勾幾張憑證 → 按【預覽列印】→ 開啟 `voucher-print.html`。
2. **按鈕文字**：工具列的按鈕應顯示「輸出成 PDF 檔」，旁邊有一行小灰字提示，說明選「另存為 PDF」的步驟。
3. **提示不會被印出**：按下按鈕 → 出現瀏覽器列印對話框 → 列印預覽區內只有憑證，沒有工具列與提示文字。
4. **PDF 匯出流程可走通**：目的地選「另存為 PDF」→ 存檔 → 用 macOS Preview 或 Adobe Reader 打開 → Cmd/Ctrl+P → 在該 PDF 檢視器裡選印表機、勾「黑白 / 灰階」→ 送印 → 輸出應為純黑白。
5. **中文字品質**：PDF 內憑證的中文字（廠商名、摘要、公司名）應保持向量清晰。
6. **原流程不退步**：若使用者不理提示，直接在對話框選印表機列印，行為與現況相同。
