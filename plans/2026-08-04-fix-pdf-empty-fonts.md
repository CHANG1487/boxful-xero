# 修復 PDF 預覽空白：載入 Noto Sans TC 網頁字型；並回答 GitHub 連結分享的可行性

## Context

同事開啟預覽列印頁後，Chrome PDF 預覽只有表格結構與虛線，**所有中文字（包含硬編在 HTML/JS 的「應付憑單」「摘要」「科目」「廠商」等）都不見了**。使用者已確認：同事在**點「輸出成 PDF 檔」之前**，看列印工具的網頁本體時，畫面上的中文也是空白 —— 也就是**螢幕上就已經沒有中文**，不是 print pipeline 的問題。

診斷（來自 Explore 代理）：

- `public/css/app.css:17` 是專案裡**唯一**的 `font-family` 宣告，內容是 `"PingFang TC", "Microsoft JhengHei", "Noto Sans TC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`。
- 專案**沒有任何 `@font-face` 規則**，也沒有動態字型載入。整個 CJK 顯示 100% 仰賴同事本機是否已安裝上述三種字型之一。
- 若同事機器上 PingFang TC / Microsoft JhengHei / Noto Sans TC **三種都沒有**（例如某些精簡版 Windows、企業封裝映像、Linux base 環境），fallback 會走到 Segoe UI / sans-serif，這些字型沒有 CJK 字符 → Chrome 直接留白，正好符合截圖。
- `server/index.js` 沒有 helmet 或任何 CSP header，也沒有 CSP `<meta>`；用 `<link rel="stylesheet">` 引入 `fonts.googleapis.com` **不會被阻擋**。

使用者選擇的修法：**引入 Google Fonts 的 Noto Sans TC**。

## 修改範圍

### 1. `public/index.html` — 於 `<head>` 中加入 Google Fonts

在既有 `<link rel="stylesheet" href="/css/app.css" />`（第 7 行）之前插入三行：

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;600;700&display=swap">
```

放在 `app.css` 之前，Google Fonts 的 `@font-face` 才會先進 CSSOM，接著 `app.css` 內的 `font-family` fallback list 才能把 Noto Sans TC 當成可用字型優先取用。字重挑 400/600/700 對應 CSS 內用到的 `font-weight` 值（一般 / 600 / 700）。

### 2. `public/voucher-print.html` — 同樣三行

於 `<head>` 中 `<link rel="stylesheet" href="/css/app.css" />`（第 6 行）之前插入與 1. 相同的三行。這是**核心修法所在**：列印預覽本身就是這頁被印出去。

### 3. `public/login.html` — 同樣三行

於 `<head>` 中 `<link rel="stylesheet" href="/css/app.css" />`（第 7 行）之前插入相同三行。同事登入頁如果也是空白他們就進不了應用。

### 4. `public/css/app.css` — 把 Noto Sans TC 提到 font-family 最前面

`app.css:17` 從

```css
font-family: "PingFang TC", "Microsoft JhengHei", "Noto Sans TC",
             -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

改為把 `"Noto Sans TC"` 拉到 PingFang TC 之後、Microsoft JhengHei 之前是可以的；但**更保險的做法是把 Noto Sans TC 放最前**：

```css
font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei",
             -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

理由：Mac / Windows 機器即便本地有 PingFang / JhengHei，用 Google 版本也不會出錯（Noto 的字形品質對列印同樣清晰）；但**同事這種缺字環境**若把 Noto 放後面，還是會先試 PingFang → 失敗 → 試 JhengHei → 失敗 → 才輪到 Noto，若中間某一步觸發 fallback race 反而不穩。放最前一致性最高。

## 不動的地方

- `public/js/print.js`、`public/css/print.css`、`server/**`、資料層、OAuth：全部不動。
- SweetAlert2 CDN 引用維持原樣。
- 不安裝任何 npm 相依。

## 關於「同事點 GitHub 連結就能操作」

書面結論（不做部署，僅記錄可行性給使用者參考）：

**以現況不行。** 原因與可行的替代路徑：

1. **GitHub 連結只是原始碼**。收件人點下去看到的是 repo，不是可執行的網站。要能真的操作，同事必須：`git clone` → `npm install` → 準備自己的 Xero Developer app + `.env` → 在 Xero 後台把 `http://localhost:3000/auth/callback` 加進 redirect URI → `npm start`。這比現在的 `.command` 打包流程還麻煩。
2. **要真的能點連結就用**，就得把 app **部署到公網**（Zeabur / Render / Fly.io / Railway 等），並且：
   - 在 Xero Developer app 加一組 `https://<your-domain>/auth/callback` 的 redirect URI。
   - `server/index.js:38` 的 session cookie 目前 `secure: false`，上 HTTPS 後要改成 `true`（否則 cookie 不會回到 server，登入會壞）。
   - 決定「哪些 Xero 用戶允許登入」的邏輯 —— 目前是任何點過 `/auth/login` 完成 OAuth 的人都能看你選的 tenant，多人共用會出事。可能需要一層 email 白名單。
   - `.env` 的 CLIENT_ID / CLIENT_SECRET 得改用平台的 secrets 管理，別 commit。
3. **維持現狀最簡單**：繼續讓同事下載 `.command` / `.bat` 打包檔本地跑。這次只修 PDF 空白，就把最痛的問題解掉了。

**建議**：先修 PDF 空白（本計畫）。等後續**確認同事真的無法接受下載打包檔**再單獨開一份「部署到 Zeabur」計畫，不要跟這次的字型修復混包。

## Verification

1. `npm start`，在本機瀏覽器打開 `http://localhost:3000/` → 頁面文字仍完整（回歸測試：Mac 本地不該退步）。
2. 開發者工具 → Network 面板 → filter `fonts.googleapis.com`：應該看到 CSS 檔 200 OK，緊接著 `fonts.gstatic.com` 下載 woff2 字型檔案。
3. 打開 Chrome DevTools → Rendering → 右上角搜尋 `font-family` 或用 Elements 面板點 `body`，Computed panel 應能看到 `Noto Sans TC` 是 used font 之一。
4. **模擬缺字型情境**：用 Chrome DevTools Command Menu（Cmd/Ctrl+Shift+P）→ 「Emulate CSS media type: print」，PDF 排版下中文仍應顯示。
5. 勾兩張憑證 → 預覽列印 → 「輸出成 PDF 檔」→ Chrome 存 PDF → 用 Preview / PDF 檢視器打開：憑證上所有中文（含硬編 label 與 Xero 資料）都要清楚可讀。
6. **請同事重新開啟打包版 app** → 重複步驟 5 → 這次應能看到完整中文。若同事回報「還是空白」則代表機器連 `fonts.googleapis.com` 都連不到（受企業防火牆封鎖），此時降級方案是把 Noto Sans TC 的 woff2 放進 repo 用 `@font-face` self-host —— **這種情況再另開計畫處理**，本計畫不預先做。

## 交接說明

- 本計畫寫在 `/Users/likachang/.claude/plans/eager-mixing-beacon.md`，不在 `Xero 2.0/plans/`。依照專案慣例，我進入實作階段前會把它 copy 一份到 `Xero 2.0/plans/2026-08-04-fix-pdf-empty-fonts.md` 再開始改，符合 [Plan folder convention]。
