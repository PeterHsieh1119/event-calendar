# 每日 07:00 · 定價與新事件

每個交易日台北時間早上 7:00 執行。用繁體中文回覆，語氣直接，不要客套開場。

**先讀 `routines/_shared.md`**，那份是四個任務共用的規範（合法 cat、`t` 格式、
來源分級、被擋的網域、不准捏造、閘門、commit 規則）。以下只寫這個任務自己的部分。

你負責 `data/priced.json` 與 `data/curated.json`。不要動 `index.html`、`scripts/`、
`.github/`、`data/events.json`、`data/px.json`、`data/reviews.json`、`data/regime.json`。

---

## 第零步 · 閘門與自我修復

跑 `python scripts/validate_data.py && node scripts/smoke_test.js`。
在你動任何東西之前就失敗的話，照 `_shared.md` 第八節處理（找出並 revert）。

接著清理自己負責的兩個檔案，這一步每天都要做：

- `curated.json`：`cat` 不在合法清單裡的改掉；`t` 缺漏或格式不對的補正；
  日期已經過去超過 60 天的移除；同一件事被寫成兩筆不同名字的合併。
- `priced.json`：日期已經過去的 items 移除。

沒有人會回頭清這些，只有你會。放著不管，三個月後這兩個檔案就沒人敢用了。

---

## 第一步 · 更新已定價程度

`priced.json` 決定網站的「定價落差」排序。日曆本身回答「這件事多大」，
它回答「市場已經知道多少」。**沒有這個檔案，整個工具只是一份漂亮的事件重要性排行榜。**

範圍：未來 14 天內、衝擊分數 45 以上的事件。範圍外的不要碰。

### 財報 — 用 IBKR 選擇權鏈自己算

不要去找二手報導的隱含變動數字，自己算比較準，步驟固定：

1. `ToolSearch` 載入 `Interactive_Brokers` 的 `search_contracts`、`get_option_parameters`、
   `get_option_data`、`get_price_snapshot`
2. `search_contracts` 查標的，取 **symbol 完全相符**那一列的 `underlying_contract_id`
   （很多槓桿型 ETF 也有 OPT，光看 sections 會挑錯）
3. `get_price_snapshot` 取現貨 `last`
4. `get_option_parameters` 找出**財報日之後最近的**到期日
5. `get_option_data` 取現貨上下各兩檔 strike，拿 call 與 put 的 `contract_id`
6. `get_price_snapshot` 分別取 call 與 put 的 `last`
7. 隱含變動 % ＝（call 權利金 ＋ put 權利金）÷ 現貨。**用兩個相鄰 strike 各算一次交叉檢查**，
   差太多代表報價有問題，那就不要寫這一筆
8. 跟過去四季實際單日變動的中位數比：

| 隱含 vs 歷史實際 | pxd | 讀法 |
|---|---|---|
| 兩倍以上 | 0.65 – 0.75 | 市場已充分防範，落差小 |
| 大致相當 | 0.40 – 0.50 | 正常定價 |
| 低於歷史實際 | 0.25 – 0.35 | **市場沒在防，這種才是真有落差的** |

### FOMC 與利率決議

CME FedWatch 或 Fed Funds 期貨的隱含機率。單一結果機率 90% 以上 → `pxd` 0.85–0.95；
接近 50/50 → 0.20–0.35。有點陣圖的會議另外看 OIS 對明年路徑的定價跟上次點陣圖的落差，
落差越大 `pxd` 越低。

### CPI、非農、PCE

看事件日的隱含波動溢價，以及過去三次的意外方向。
**連續三次同方向的意外**代表共識有系統性偏誤，第四次通常還會偏同一邊 → `pxd` 調低。

### 順便查共識

同一趟就把**市場預期**查回來，寫進同一筆的 `cons` / `prev` / `unit` / `consSrc`。
網站會在事件卡上顯示「已有共識」，事件公布後跟實際值一比就能標出有沒有超乎預期。

- 總經數據：查機構調查的中位數（Bloomberg、Reuters 調查、Wolfe、Capital Economics）。
  `cons` 只放**數字**，單位放 `unit`（`%`、`K`、`bp`）。`prev` 放前值。
- 財報：除了 `cons` 放共識 EPS，**再填一個 `metrics` 陣列**，把市場在看的指標逐項列出。
  網站會把它畫成一張「指標 / 市場預期 / 實際 / 差異」的表，公布後自動標出各項優於或低於。
  至少要有 EPS 與營收；有分項共識（例如 NVDA 的資料中心營收、TSM 的先進製程佔比）就一併列。

  ```json
  "metrics":[{"n":"EPS","cons":"1.20","unit":"USD"},
             {"n":"營收","cons":"46.5","unit":"B"},
             {"n":"資料中心營收","cons":"41.0","unit":"B"}]
  ```

  `cons` 只放純數字，單位放 `unit`（`USD`、`B`、`%`）。查不到某一項就不要放那一列。
- 一定要填 `consSrc`，寫明是哪一家的調查。**查不到出處的共識數字不要寫**——
  閘門會擋有 `cons` 卻沒有 `consSrc` 的條目。
- 同一個指標要跟盤後複盤用同一個口徑。例如 PCE 就固定用**核心年增率**，
  不要這次寫核心、下次寫總體，那樣意外判定會前後不一致。

### 寫入格式

整個檔案覆蓋寫入，保留仍在範圍內的既有 items：

```json
{"generated":"YYYY-MM-DDTHH:MM:SSZ","items":[
 {"date":"YYYY-MM-DD",
  "title":"必須跟日曆上的事件標題完全一致",
  "pxd":0.68,
  "basis":"一句話說明這個數字怎麼算出來的，要帶數字",
  "src":"來源，照 _shared.md 的分級標註",
  "cons":"0.2","prev":"0.3","unit":"%","consSrc":"Bloomberg 調查中位數",
  "asof":"YYYY-MM-DD"}]}
```

`title` 對不上就整筆失效。寫之前先讀 `events.json` 確認正確名稱；
規則引擎自己生成的事件（`NVDA 財報`、`CPI`、`FOMC 決議＋點陣圖` 等）不在那個檔案裡，
名稱以網站上顯示的為準。日期差三天以內會自動對上，確認日微調不影響。

`basis` 是必填。**沒有依據的定價數字不可信，寧可不要寫。** 閘門會擋。

---

## 第二步 · 掃新事件與日期變更

範圍：接下來 30 天。重點放在規則引擎算不出來的：

- 臨時的 Fed 官員演說與政策訊號
- **官方數據排程異動** — 政府關門或行政因素常讓 BEA、BLS 的發布日整批位移，
  規則引擎完全不知道，只有你會發現。這一類優先級最高
- 財報日變更
- 突發關稅、出口管制、貿易政策
- 大型 IPO 與指數調整（S&P 500 成分股異動、Russell 年度重組）
- OPEC+ 會議、日本央行與歐洲央行決議
- **突發事件（`cat: headline`）**：關稅或出口管制的發文與公告、地緣衝突升級、
  監管開罰、突發的政策談話。只收**已經發生、而且找得到第一到三級來源**的，
  不要收傳聞與預測。`t` 填實際發生的美東時間。
  判斷要不要收的標準：它有沒有讓某個資產在當天出現可辨識的價格反應？
  沒有的話就是新聞，不是事件，不要收。

規則引擎自己會算的（CPI、非農、FOMC、PCE、四巫日、月選擇權到期、台積電月營收）
不要重複寫進來，**除非官方公布的日期跟推算不同**——那時候就照下面的更正規則寫。

### 日期更正

`curated.json` 同時是「新增事件」和「更正日期」兩個用途。
寫一筆 `title` 跟日曆上**完全相同**、`date` 在 ±10 天以內的條目，就會覆蓋掉推算日。

所以官方把某個數據提前或延後時，**不要另外造一個新名字的事件**。
用一模一樣的 title、正確的 date、`est: false`，它會直接取代掉錯的那一筆。

### 寫入格式

```json
{"generated":"YYYY-MM-DDTHH:MM:SSZ","items":[
 {"date":"YYYY-MM-DD","kind":"N 或 D 或 R","cat":"合法代碼","title":"事件名",
  "est":false,"t":"合法格式","note":"一句話說明為什麼重要","src":"來源"}]}
```

舊格式（最外層直接是陣列）網站也讀得懂，但**請改用上面這種帶 `generated` 的包法**——
資料頁靠 `generated` 顯示「這個檔案幾天沒動了」，少了它就看不出這個任務是不是掛了。

分類原則：改變未來現金流判斷的是 `N`；改變折現率的是 `D`；主要動風險溢酬的是 `R`。

---

## 驗收條件

做完之前逐項確認：

- [ ] `python scripts/validate_data.py && node scripts/smoke_test.js` 通過
- [ ] `priced.json` 每一筆都有 `basis`，`pxd` 在 0–1，`title` 對得上日曆
- [ ] `curated.json` 每一筆的 `cat` 在合法清單裡、`t` 格式正確
- [ ] 過期條目已清掉
- [ ] `changelog.json` 加了一行
- [ ] 只動了 `data/priced.json`、`data/curated.json`、`data/changelog.json`

commit 訊息：`daily: 更新定價 N 筆、新增事件 M 筆、修正 K 筆`

回報五行以內：清掉什麼、更新幾筆定價、新增幾筆事件、有沒有你不確定的地方。
沒有任何變動就說「今天沒有變動」，不要 commit。
