# 明細超過中一刀版面的傳票，自動改印 A4 全頁

> **執行第一步**：離開 plan mode 後，先把本計畫實體寫進 `Xero 2.0/plans/2026-09-11-auto-a4-for-overflow-vouchers.md`（維持 `plans/YYYY-MM-DD-<slug>.md` 慣例，見 `plans/README.md`），再開始改碼。

## Context

目前列印版型是 **A4 中一刀**：一張 A4 上下各放一張 210 × 148.5 mm 的憑證。

問題在 `public/css/print.css:13-22`：

```css
.voucher {
  width: 210mm;
  height: 148.5mm;   /* 固定高度 */
  overflow: hidden;  /* ← 超出的明細被無聲裁掉 */
}
```

明細大約 12–15 行就會撐破 148.5mm，超出的部分被 `overflow: hidden` **直接裁掉且完全沒有任何警告** —— 畫面、console、`#print-status` 都不會提示，使用者拿到的是一張看起來正常但資料不完整的憑證。

目標：**列印前先量測每張傳票的實際高度，放不進中一刀的那幾張自動改用 A4 整頁列印**，其餘維持中一刀兩張一頁。

### 已確認的決策（使用者回答）

| 問題 | 決策 |
|---|---|
| 排版順序 | **重新排列以省紙**：中一刀傳票先依原順序兩兩湊滿，A4 全頁傳票集中排在最後 |
| 明細多到連 A4 也放不下 | **續印下一頁**：讓明細自然流到第 2、3 頁，表頭每頁重複，不裁切任何一行 |

## 現況架構（探索結論）

- 無框架、無 bundler。Express 靜態服務 + vanilla JS。
- `public/voucher-print.html` 只是空殼（`<div id="sheets">`），所有版面 HTML 由 `public/js/print.js` 用 template string 產生。
- 5 個 render 函式（`renderBill:62`、`renderMJ:124`、`renderBankTx:185`、`renderCreditNote:259`）各自產出 `<div class="voucher">…</div>`，內容結構一致：title / meta / `<table class="voucher-lines">`（thead + tbody + tfoot）/ footer。
- 分頁邏輯只有一處，`print.js:362-369` 的 `i += 2`。
- 字型 Noto Sans TC 由 Google Fonts CDN 載入（`voucher-print.html:8`）—— **量測必須等字型載完**，否則 fallback 字型的行高不同會量錯。

**關鍵設計取捨：不改那 5 個 render 函式。** 它們是 5 份幾乎重複的程式碼，動其中任一份都要同步改 5 處。改用「先渲染 → 量測 → 依量測結果重新分頁」的後處理方式，5 個函式一行都不用動。

## 修改範圍

### 1. `public/css/print.css` — 新增 A4 全頁變體與量測區樣式

**a. 抽出幾何常數**（目前 210/297/148.5 三個數字散在各處，JS 也要用到）：

```css
:root {
  --sheet-w: 210mm;
  --sheet-h: 297mm;
  --voucher-h: 148.5mm;
}
```
`.voucher-sheet`、`.voucher` 改引用這三個變數（純替換，視覺零變化）。

**b. A4 全頁變體** —— 用 sheet 上的 class 帶動內部 `.voucher`，JS 不必對個別 voucher 加 class：

```css
/* 明細過長的傳票：獨佔一整張 A4，內容可往下一頁續印 */
.voucher-sheet--full > .voucher {
  height: auto;
  min-height: var(--sheet-h);
  overflow: visible;
  border-bottom: none;
}
```

**c. 量測用的離屏容器**：

```css
.measure-area {
  position: absolute;
  left: -10000px;
  top: 0;
  visibility: hidden;
  width: var(--sheet-w);
}
.measure-area .voucher { height: auto; overflow: visible; }
.measure-area .voucher-lines { flex: 0 0 auto; }  /* 取消 flex:1 拉伸，量到的才是內容真高 */
```

**d. 續印提示樣式**：

```css
.voucher-continued-note {
  font-size: 10px;
  color: #444;
  text-align: right;
  margin-bottom: 1mm;
}
```

**e. `@media print` 區塊內新增**（`print.css:124-141`）：

```css
  /* 續印時表頭在每頁重複；tfoot 改成一般 row group，總計只出現在最後一頁 */
  .voucher-sheet--full .voucher-lines thead { display: table-header-group; }
  .voucher-sheet--full .voucher-lines tfoot { display: table-row-group; }
  .voucher-lines tr { break-inside: avoid; }   /* 不從一列中間切斷 */
  .measure-area { display: none !important; }
```

> `tfoot` 預設是 `table-footer-group`，Chrome 會在**每頁**重複印出「未稅/稅額/總計」，看起來像各頁小計、會誤導。改成 `table-row-group` 讓它只出現一次在最後。

### 2. `public/js/print.js` — `build()` 改為「渲染 → 量測 → 分類 → 分頁」

現有的 `detailBlocks` 產生流程（`print.js:341-360`）**完全不動**。改的是 `print.js:362-369` 那段分頁，替換成下列四步。

**新增輔助函式：**

```js
/** 讀 CSS 變數並換算成 px（避免在 JS 裡硬寫 561.26 這種魔術數字） */
function cssLengthPx(varName) {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;height:var(${varName})`;
  document.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px;
}

/** 把所有 voucher HTML 放進離屏容器量高度，回傳 px 陣列 */
function measureBlocks(blocks) {
  const area = document.createElement('div');
  area.className = 'measure-area';
  area.innerHTML = blocks
    .map((html) => `<div class="voucher-sheet">${html}</div>`)
    .join('');
  document.body.appendChild(area);
  const heights = Array.from(area.querySelectorAll('.voucher')).map(
    (el) => el.getBoundingClientRect().height
  );
  area.remove();
  return heights;
}
```

**`build()` 尾端改寫：**

```js
  // 等字型載入完成再量，否則 fallback 字型行高不同會量錯
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch (e) { /* 不支援就直接量 */ }
  }

  const HALF_PX  = cssLengthPx('--voucher-h');
  const SHEET_PX = cssLengthPx('--sheet-h');
  const TOL = 1; // 次像素容差，避免剛好貼齊的被誤判

  const heights = measureBlocks(detailBlocks);
  const entries = detailBlocks.map((html, i) => ({
    html,
    height: heights[i] || 0,
    full: (heights[i] || 0) > HALF_PX + TOL,
  }));

  // 中一刀依原順序兩兩湊滿，A4 全頁集中排在最後（使用者選定的省紙排法）
  const halves = entries.filter((e) => !e.full);
  const fulls  = entries.filter((e) => e.full);

  const sheets = [];
  for (let i = 0; i < halves.length; i += 2) {
    const second = halves[i + 1] ? halves[i + 1].html : '<div class="voucher"></div>';
    sheets.push(`<div class="voucher-sheet">${halves[i].html}${second}</div>`);
  }
  let fullPages = 0;
  for (const f of fulls) {
    fullPages += Math.max(1, Math.ceil(f.height / SHEET_PX));
    sheets.push(`<div class="voucher-sheet voucher-sheet--full">${f.html}</div>`);
  }

  els.sheets.innerHTML = sheets.join('');
  markContinuedVouchers(SHEET_PX);   // 見下

  const pageCount = Math.ceil(halves.length / 2) + fullPages;
  els.status.textContent = fulls.length
    ? `共 ${items.length} 張憑證（其中 ${fulls.length} 張明細較多，已改用 A4 全頁），約 ${pageCount} 頁 A4`
    : `共 ${items.length} 張憑證，${pageCount} 頁 A4`;
  if (fulls.length && window.notify) {
    window.notify.toast(`有 ${fulls.length} 張傳票明細超過中一刀版面，已自動改用 A4 全頁列印`, 'info');
  }
```

**續印標註**（在真正的 DOM 上做第二次量測，因為只有插進 `#sheets` 後才知道實際會不會跨頁）：

```js
function markContinuedVouchers(sheetPx) {
  document.querySelectorAll('.voucher-sheet--full > .voucher').forEach((el) => {
    const pages = Math.ceil(el.getBoundingClientRect().height / sheetPx);
    if (pages <= 1) return;
    const note = document.createElement('div');
    note.className = 'voucher-continued-note';
    note.textContent = `本傳票明細較多，共 ${pages} 頁（續印至下一頁）`;
    el.insertBefore(note, el.firstChild);
  });
}
```

**已知限制（要讓使用者知道）**：Chrome 的 `@page` 不支援 margin box，無法在**每一頁頁尾**自動印「續」字樣。可行的替代就是上面這行「共 N 頁（續印至下一頁）」標在傳票開頭，再加上表頭每頁重複——明細不會漏印，只是「續」字不在頁尾。

### 3. `public/voucher-print.html` — 無需修改

`#sheets` 容器與 toolbar 都沿用；`notify.js` 已載入（`voucher-print.html:24`），toast 直接可用。

## 不動的地方

- **5 個 render 函式（`print.js:62-330`）一行都不改** —— 欄位、欄寬、tfoot、簽名欄全部沿用。
- `window.print()` 流程、「輸出成 PDF 檔」按鈕與黑白列印提示（`plans/2026-08-04-print-pdf-workflow.md` 的決策）不動。
- 後端 `server/routes/vouchers.js`、cache/preload、OAuth、SQLite 全部不動。
- 主清單頁 `public/index.html` / `public/js/app.js` 不動（`?ids=TYPE:ID,…` 的 URL 契約維持原樣）。
- 不新增任何相依套件（不引入 paged.js / jsPDF / puppeteer）。
- 一般中一刀 sheet 不加 `break-inside: avoid` —— 它高度剛好等於一頁，加上去反而可能被整塊推到下一頁，風險大於好處。

## Verification

1. `npm start`，登入任一 tenant。
2. **回歸（短傳票）**：挑 4 張明細各 2–3 行的憑證 → 【預覽列印】→ 應為 2 頁 A4、每頁上下兩張、中間虛線切線；狀態列顯示「共 4 張憑證，2 頁 A4」。與改動前輸出**完全相同**。
3. **主案（長傳票）**：挑一張明細 ≥ 20 行的 Bill 或 MJ（可在清單頁用金額/廠商找筆數多的）→ 預覽 → 該張應獨佔一整頁 A4、沒有虛線切線、**明細一行都沒被裁掉**；狀態列出現「其中 1 張明細較多，已改用 A4 全頁」，右上角跳 toast。
4. **省紙排序**：一次選 A(短) B(長) C(短) D(短) → 輸出應為：第 1 頁 A+C、第 2 頁 D+空白、第 3 頁 B 全頁。
5. **臨界值**：找一張明細剛好 12–14 行、接近 148.5mm 的憑證 → 確認判定穩定（重新整理數次結果一致），沒有「有時中一刀有時 A4」的抖動。
6. **超過 A4（續印）**：挑或臨時造一張明細 40+ 行的憑證 → 傳票開頭出現「共 2 頁（續印至下一頁）」；瀏覽器列印預覽中第 2 頁**表頭重複出現**、**總計只在最後一頁出現一次**、沒有任何一列被切成兩半。
7. **字型時序**：Cmd/Ctrl+Shift+R 硬重新整理（清字型快取）→ 判定結果應與暖快取時一致（驗證 `document.fonts.ready` 有效）。
8. **列印/PDF 實測**：按【輸出成 PDF 檔】→ 目的地「另存為 PDF」→ 開啟 PDF 確認：頁數與狀態列一致、A4 全頁那張內容完整、中文字向量清晰、工具列與量測區都沒被印出來。
9. **量測區不殘留**：列印預覽後在 DevTools 檢查 `document.querySelectorAll('.measure-area').length === 0`。
10. **錯誤情境不退步**：故意傳一個不存在的 id（`?ids=BILL:xxx`）→ 仍顯示紅字讀取失敗區塊 + SweetAlert2 錯誤彈窗，不會因量測而報錯。
