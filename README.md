# 分子／分母 事件衝擊日曆
網址：https://peterhsieh1119.github.io/event-calendar/
手機打得開的公開網址 + 每天自動更新資料 + 每天由 Claude 改進一小塊。

三層機制各司其職，壞掉一層其他兩層照跑：

| 層 | 誰在跑 | 做什麼 | 壞掉會怎樣 |
|---|---|---|---|
| 規則引擎 | 瀏覽器裡的 JS | FOMC／CPI／非農／財報的日期推算 | 不會壞，離線也跑 |
| 資料更新 | GitHub Actions，每天 06:00 台北 | 抓官方＋FMP 的確認日期與 QQQ 日線，寫進 `data/` | 沿用上一次的 JSON |
| 網站改進 | Claude Code 雲端 Routine，每天一次 | 讀最新事件、改 `index.html`、開 PR | 網站維持現狀 |

---

## 同一個站台底下的另一支工具

`tongue/` 是一支獨立的 PWA：**舌象 RGB 量測**——拍舌頭、算取樣區的 RGB 中位色與 B/R 比值、
追蹤青紫舌（瘀血傾向）的變化，支援灰卡白平衡與 24 色卡完整校色。
部署後網址是 `https://<帳號>.github.io/event-calendar/tongue/`，跟日曆互不干擾，可以各自加到主畫面。
用法、拍攝 SOP 與演算法說明見 [`tongue/README.md`](tongue/README.md)。

---

## 一、放上 GitHub Pages（十分鐘，手機就有網址了）

1. 開一個 repo，例如 `event-calendar`，把這整個資料夾推上去（`main` 分支）。
2. **Settings → Pages** → Source 選 **GitHub Actions**。
3. `FMP_API_KEY` 這個 secret **可設可不設**。
   價格走 Yahoo（免 key），事件靠規則引擎與 routine 的網頁搜尋補，
   財報的隱含變動由 routine 直接接 IBKR 選擇權鏈自己算。
   設了的話 Actions 會多抓 FMP 的總經行事曆與財報日，資料更完整一些，但不是必要的。
4. 推上去後 `pages.yml` 會自動部署，網址是
   `https://<你的帳號>.github.io/event-calendar/`
5. **Actions → 每日更新事件資料 → Run workflow** 手動跑一次，確認 `data/events.json` 有東西。

### 手機加到主畫面

用 Safari 或 Chrome 開那個網址 → 分享 → 加入主畫面。已經放了 manifest 跟 service worker，
所以會用全螢幕開啟，而且離線也打得開（顯示上一次抓到的資料）。

---

## 二、每天讓 Claude 維護（三個排程任務）

四段 prompt 是 `routines/` 底下的四個檔案，**那就是唯一的來源**。
cloud routine 的 prompt 只有一句「讀 routines/X.md 照做」，網站的
**資料 → 每日排程** 頁也是 fetch 同樣四個檔來顯示，所以不會有兩邊走鐘的問題。
prompt 進了版控，每週任務可以用 PR 改進自己的指示。

| 任務 | 何時跑 | 指示檔 | 負責的檔案 |
|---|---|---|---|
| 每日：定價與新事件 | 交易日台北 07:00 | `routines/daily.md` | `priced.json`、`curated.json` |
| 每日：盤後複盤 | 交易日台北 08:00 | `routines/review.md` | `reviews.json` |
| 每日：當日校正 | 交易日台北 21:30 | `routines/intraday.md` | `priced.json`、`curated.json` |
| 每週：前瞻、環境、校正、工程 | 週日台北 21:00 | `routines/weekly.md` | `regime.json`、`index.html`、`scripts/`、`routines/` |

四份任務檔開頭都會先讀 `routines/_shared.md`，那份放的是共用規範：
合法的事件類型代碼、`t` 欄位格式、來源分級、雲端擋掉的網域、不准捏造的規則、
以及 commit 前必須通過的兩道閘門。改那一份會同時影響四個任務。

**全部直接 commit 到 main，沒有 PR、不需要你按任何按鈕。**
安全網是閘門，不是人工審查——見下一節。

### 兩道閘門

沒有人在旁邊審 routine 的 commit，所以壞掉的東西必須被機器擋住：

```bash
python scripts/validate_data.py    # 資料閘門
node scripts/smoke_test.js         # 行為煙霧測試
```

`validate_data.py` 檢查的是那些「不會報錯、只會靜默出錯」的事：未知的事件類型會被
當成 ISM 計分、`priced` 對不上標題整筆失效、日期格式錯了整筆消失、複盤缺 `sigma`
等於白填。合法的 `cat` 清單直接從 `index.html` 的 `CAT` 抓，不另外維護一份會走鐘的表。

`smoke_test.js` 把 `index.html` 的整段 script 抽出來，用最小 DOM stub 在 Node 裡跑起來，
對純函式下 287 項斷言：三張設定表的鍵要對得上、規則引擎不能產生未知的 `cat`、
分數與落差的邊界、夏令冬令時區換算、同日聚合的次可加性、當月漲跌對照手算。
`node --check` 只看得出語法錯誤，看不出「時區換算反了」這種事。

兩道閘門都接在 `.github/workflows/pages.yml` 的 `validate` job 裡，
`deploy` 依賴它。**沒過就不部署，線上維持上一個好版本。**
`update-data.yml` 也會在 commit 前跑資料驗證。

routine 在動任何東西之前也會先跑一次；如果在它還沒改東西之前就已經失敗，
代表上一次有人推壞了，它會 `git revert` 那一筆再繼續。

**當日校正**那一趟跑在美東 09:30，也就是當天 08:30 那批數據公布完之後。
它只看今天與未來三天：核對官方排程有沒有跟日曆對不上、更新近身事件的定價。
有了它，「PCE 提前到今天公布」這種事當天晚上就會進日曆，不用等隔天早上。

自我修正的閉環：早上估 pxd → 事件發生 → 複盤任務比對實際反應與當初的 pxd →
指出哪裡估錯 → 隔天早上的任務讀得到這個結論。每日任務開頭還有一道清理程序，
修掉不合法的 `cat`、補上缺漏的 `t`、移除過期條目，資料不會越積越髒。

刻意這樣切：**資料改動直接推、程式碼改動走 PR**。
資料錯了下一次覆蓋就好，程式碼壞了整個網站打不開，那個要你看過再上。

跑在哪裡：Claude Code 網頁版側邊欄 **Routines → New routine → Cloud**，綁這個 repo，
排程照上表設定。雲端 routine 跑在 Anthropic 的機器上，電腦關著也會跑。
偏好本機的話用 Claude Code Desktop 的 Routines → Local，資料夾指到這個 repo，
差別是只有桌面 app 開著、電腦醒著時才會跑。

### 每日任務最重要的那一件事

`data/priced.json` 是三個任務裡價值最高的產出。日曆本身回答「這件事大不大」，
priced.json 回答「市場已經知道多少」，兩者相減才是可能真的造成價格變動的部分。
一次已經 90% 被 price in 的 FOMC，衝擊分數很高，定價落差卻接近零。
沒有這個檔案，這個工具就只是一份漂亮的事件重要性排行榜。

格式：

```json
{"generated":"2026-08-26T22:00:00Z","items":[
 {"date":"2026-09-16",
  "title":"FOMC 決議＋點陣圖",
  "pxd":0.88,
  "basis":"OIS 隱含不動機率 88%",
  "src":"CME FedWatch",
  "asof":"2026-08-26"}
]}
```

`title` 要跟 `data/events.json` 裡的完全一致，日期差三天以內會自動對應，
所以官方確認日微調不會讓對應失效。找不到可靠數字時就不要寫那一筆，
網站會自動退回該事件類型的先驗值——寧可沒有，也不要編一個數字進去。

## 三、檔案結構

```
index.html                   單檔應用，離線可用
manifest.webmanifest         加到主畫面用
sw.js                        service worker，網路優先、離線回快取
icon.svg                     圖示
data/events.json             每天由 Actions 產生（確認過的日期，含公布時間 t）
data/curated.json            routine 放人工策劃事件（Actions 不覆蓋）
data/priced.json             routine 每天寫入的已定價程度 pxd（Actions 不覆蓋）
data/px.json                 QQQ / NDX 日線，年度軸背景與校準用的波動基準
data/changelog.json          每日改動紀錄，網站的「資料」頁會顯示
routines/_shared.md          四個任務共用的規範
routines/daily.md            每日 07:00 任務的指示（網站與 cloud routine 讀同一份）
routines/review.md           每日 08:00 盤後複盤
routines/intraday.md         每日 21:30 當日校正
routines/weekly.md           每週日前瞻與工程改進
scripts/fetch_events.py      Actions 跑的抓取程式
scripts/validate_data.py     資料閘門，routine 與 CI 都會跑
scripts/smoke_test.js        行為煙霧測試，routine 與 CI 都會跑
.github/workflows/           update-data.yml（每天）、pages.yml（部署）
```

## 四、資料優先序

前端啟動時：先讀 `data/events.json`（同源，不需要 key，手機直接可用）→
用它覆蓋規則引擎推算的日期（同名事件 ±10 天內視為同一件事）→
讀 `data/px.json` 畫背景走勢、並當作校準時的波動基準 →
讀 `data/curated.json` 疊上 routine 隨時寫入的新事件與日期更正（同名 ±10 天內覆蓋推算日）→
讀 `data/priced.json` 疊上已定價程度（±3 天內對應）→ 都失敗才退回純規則引擎。

`curated.json` 由前端直接讀取，不用等隔天 Actions 合併，所以 routine 一 push 就生效。

所以就算 Actions 掛了、FMP 額度用完了、你人在飛機上，打開網址還是有一份完整的日曆。

---

## 五、評分模型

兩個並列的數字，不要混為一談：

```
衝擊分數 = 100 × (B/100)^(1 / (1 + Σ wᵢ·rᵢ)) × 校準 × 日期折扣
定價落差 = 衝擊分數 × (1 − 已定價程度)
```

- **B** 是事件類型的基準敏感度，來自事件研究的歷史平均絕對變動。
- **Σ wᵢ·rᵢ** 是環境放大項，作用在「離滿分的距離」上，所以再極端的環境也不會全部擠在 100 分。
- **日期折扣** 只對推算日期的事件生效，而且距離越遠折得越多（三個月內 6%，一年以上 15%）。
- **校準** 由累積的複盤產生。實際變動會先除以當時的一般日波動（前 20 個交易日的已實現波動）
  換算成標準差倍數再比對——不這樣做的話，高波動月份每件事都會看起來「反應大」，
  跟環境設定裡的「波動定價水位」重複計算。樣本少時調整幅度自動往 1 收縮。
- **已定價程度** 來自 `data/priced.json`，沒有資料時退回類型先驗。

同一天有多個事件時，衝擊不是線性相加——它們高度相關。
月曆的熱度條與年度軸的月合計用的是「最大值 + 其餘遞減加權」。

事件都帶公布時間（美東），前端據此算出台北時間，並標出美股與台股各自在哪個交易日吸收。
盤後財報跟盤前數據打到的是不同的交易日，這件事對台北時區的使用者影響很大。
