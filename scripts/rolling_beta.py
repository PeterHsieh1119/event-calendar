#!/usr/bin/env python3
"""
滾動估計各資產對四條傳導管道的曝險係數，寫進 data/betas.json。

為什麼要這個：index.html 的 ASSETS 裡那組 beta 是寫死的常數（那斯達克對長端實質
利率 -1.0 之類），那是某個時期的數字。反身性的重點正是「價格會回頭改變敏感度」——
崩盤時所有相關性都趨近 1，用一組固定係數等於假設那件事不會發生。

方法：60 個交易日滾動視窗，各資產日報酬對四個因子做嶺迴歸（ridge）。

  front  前端利率   ^IRX 13 週國庫券殖利率的日變動（bp）
  real   長端實質   TIP（TIPS ETF）日報酬取負號——TIPS 價格跌代表實質利率升
  be     通膨預期   RINF（通膨預期 ETF）日報酬
  erp    風險溢酬   信用利差走闊 ＝ −(HYG 報酬 − IEF 報酬)
                    **不用 VIX。** VIX 是從 SPX 選擇權算出來的，拿它解釋 SPY 報酬
                    幾乎是同義反覆（實測 SPY R2 衝到 0.66、beta −0.72 大半是機械關係），
                    而且會把利率因子整個擠到接近零。信用利差衡量的是同一件事
                    （風險定價），但不是股價的數學變換。

  eps    盈餘預期   **估不出來，維持 index.html 裡的先驗**
                    它不是日頻可觀測的東西，硬找代理變數（例如景氣循環股對防禦股
                    的比值）會跟被解釋變數共線，算出來的係數沒有意義。

三個刻意的設計：

1. 兩邊都標準化。因子單位不同（bp vs %），不標準化的話係數大小沒得比，
   也沒辦法跟原本手設的 ±1 尺度對照。標準化之後係數就是「因子動一個標準差時，
   資產動幾個標準差」，跟先驗同一個量級。

2. 嶺迴歸 λ=0.1。front 跟 real 高度相關，純 OLS 在 60 個樣本下係數會亂跳。
   加一點收縮換取穩定，代價是係數略微偏向 0，那是可以接受的取捨。

3. 台股用前一天的美國因子。台股 13:30 收盤，那時美股當天還沒開，
   同日迴歸等於拿「還沒發生的事」去解釋「已經收盤的價格」，算出來會接近零。
   ^TWII 的報酬對上前一交易日的美國因子才對得起來。
"""
import json
import math
import os
import sys
import datetime as dt
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

WINDOW = 60          # 滾動視窗（交易日）
RIDGE = 0.1          # 收縮強度，作用在標準化後的資料上
MIN_OBS = 40         # 樣本少於這個數就不出係數
MIN_R2 = 0.10        # 解釋力低於這個就標成 weak，前端會退回先驗

# 因子：(管道代碼, Yahoo 代號, 怎麼從價格變成因子)
#   dbp   = 日變動 × 100，殖利率用（Yahoo 回的是百分比）
#   ret   = 日報酬 %
#   negret= 日報酬 % 取負號
#   dlog  = 日對數變動 × 100
#   spread= 兩檔的報酬差取負號（利差走闊為正）
FACTORS = [
    ("front", "^IRX",     "dbp"),
    ("real",  "TIP",      "negret"),
    ("be",    "RINF",     "ret"),
    ("erp",   "HYG-IEF",  "spread"),
]

# 資產：(ASSETS 裡的 key, Yahoo 代號, 是否要用前一天的因子)
ASSETS = [
    ("ndx",  "QQQ",        False),
    ("spx",  "SPY",        False),
    ("fin",  "XLF",        False),
    ("tlt",  "TLT",        False),
    ("gld",  "GLD",        False),
    ("dxy",  "DX-Y.NYB",   False),
    ("twse", "^TWII",      True),    # 台股早收盤，要對前一天的美國因子
    ("hyg",  "HYG",        False),
]


def fetch(symbol):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(symbol, safe="") + "?range=2y&interval=1d")
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (compatible; event-calendar/1.0)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.load(r)
    res = (j.get("chart") or {}).get("result") or []
    if not res:
        return None
    r0 = res[0]
    ts = r0.get("timestamp") or []
    closes = ((r0.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    out = {}
    for t, v in zip(ts, closes):
        if v is None:
            continue
        d = dt.datetime.fromtimestamp(t, dt.timezone.utc).date().isoformat()
        out[d] = float(v)
    return out or None


def spread_change(a, b):
    """-(a 報酬 - b 報酬)：高收益債相對公債走弱＝利差走闊＝風險溢酬上升。"""
    ra, rb = to_change(a, "ret"), to_change(b, "ret")
    return {d: -(ra[d] - rb[d]) for d in ra if d in rb}


def to_change(series, how):
    """把價位序列轉成日變動序列。"""
    ks = sorted(series)
    out = {}
    for i in range(1, len(ks)):
        a, b = series[ks[i - 1]], series[ks[i]]
        if how == "dbp":
            out[ks[i]] = (b - a) * 100.0
        elif how in ("ret", "negret"):
            if a <= 0:
                continue
            v = (b / a - 1.0) * 100.0
            out[ks[i]] = -v if how == "negret" else v
        elif how == "dlog":
            if a <= 0 or b <= 0:
                continue
            out[ks[i]] = math.log(b / a) * 100.0
    return out


def standardise(v):
    n = len(v)
    if n < 2:
        return None, 0.0
    m = sum(v) / n
    var = sum((x - m) ** 2 for x in v) / (n - 1)
    sd = math.sqrt(var)
    if sd < 1e-12:
        return None, 0.0
    return [(x - m) / sd for x in v], sd


def ridge_solve(X, y, lam):
    """(XᵀX + λI)β = Xᵀy，高斯消去。X 已標準化所以不需要截距。"""
    k = len(X[0])
    a = [[sum(X[r][i] * X[r][j] for r in range(len(X))) + (lam * len(X) if i == j else 0.0)
          for j in range(k)] for i in range(k)]
    b = [sum(X[r][i] * y[r] for r in range(len(X))) for i in range(k)]
    for c in range(k):
        p = max(range(c, k), key=lambda r: abs(a[r][c]))
        if abs(a[p][c]) < 1e-12:
            return None
        a[c], a[p] = a[p], a[c]
        b[c], b[p] = b[p], b[c]
        for r in range(k):
            if r == c:
                continue
            f = a[r][c] / a[c][c]
            if f == 0.0:
                continue
            for j in range(c, k):
                a[r][j] -= f * a[c][j]
            b[r] -= f * b[c]
    return [b[i] / a[i][i] for i in range(k)]


def main():
    print("== 滾動曝險係數 ==")
    fac_raw = {}
    for key, sym, how in FACTORS:
        if how == "spread":
            left, right = sym.split("-")
            a, b = fetch(left), fetch(right)
            if not a or not b:
                print("  ! 因子 %s (%s) 抓不到，整支放棄" % (key, sym), file=sys.stderr)
                return 1
            fac_raw[key] = spread_change(a, b)
        else:
            s = fetch(sym)
            if not s:
                print("  ! 因子 %s (%s) 抓不到，整支放棄" % (key, sym), file=sys.stderr)
                return 1
            fac_raw[key] = to_change(s, how)
        print("  因子 %-6s %-10s %d 筆" % (key, sym, len(fac_raw[key])))

    out_assets = {}
    for akey, sym, lagged in ASSETS:
        s = fetch(sym)
        if not s:
            print("  ! 資產 %s (%s) 抓不到，這個資產維持先驗" % (akey, sym), file=sys.stderr)
            continue
        ret = to_change(s, "ret")

        # 對齊日期。台股要拿前一個交易日的因子。
        fdates = sorted(set.intersection(*[set(fac_raw[k]) for k, _, _ in FACTORS]))
        pos = {d: i for i, d in enumerate(fdates)}
        rows, ys = [], []
        for d in sorted(ret):
            if lagged:
                # 找出嚴格早於 d 的最後一個因子日
                j = None
                for i in range(len(fdates) - 1, -1, -1):
                    if fdates[i] < d:
                        j = i
                        break
                if j is None:
                    continue
                fd = fdates[j]
            else:
                if d not in pos:
                    continue
                fd = d
            rows.append([fac_raw[k][fd] for k, _, _ in FACTORS])
            ys.append(ret[d])

        rows, ys = rows[-WINDOW:], ys[-WINDOW:]
        if len(rows) < MIN_OBS:
            print("  ! %s 只有 %d 個樣本，不足 %d，維持先驗"
                  % (akey, len(rows), MIN_OBS), file=sys.stderr)
            continue

        cols = []
        okcols = True
        for i in range(len(FACTORS)):
            z, _ = standardise([r[i] for r in rows])
            if z is None:
                okcols = False
                break
            cols.append(z)
        zy, _ = standardise(ys)
        if not okcols or zy is None:
            print("  ! %s 有常數序列，維持先驗" % akey, file=sys.stderr)
            continue

        X = [[cols[i][r] for i in range(len(FACTORS))] for r in range(len(rows))]
        beta = ridge_solve(X, zy, RIDGE)
        if beta is None:
            print("  ! %s 迴歸無解，維持先驗" % akey, file=sys.stderr)
            continue

        fit = [sum(X[r][i] * beta[i] for i in range(len(FACTORS))) for r in range(len(X))]
        ss_res = sum((zy[r] - fit[r]) ** 2 for r in range(len(zy)))
        ss_tot = sum(v * v for v in zy)
        r2 = 1.0 - ss_res / ss_tot if ss_tot > 1e-12 else 0.0

        rec = {FACTORS[i][0]: round(beta[i], 3) for i in range(len(FACTORS))}
        rec["r2"] = round(r2, 3)
        rec["n"] = len(rows)
        rec["lagged"] = bool(lagged)
        # 解釋力太低的估計就是雜訊，標出來讓前端退回先驗。
        # XLF 實測 R2 只有 0.05——金融股現在根本不是被這四個因子推動的，
        # 硬用那組係數比用先驗還糟。
        if r2 < MIN_R2:
            rec["weak"] = True
        # erp 因子本身用 HYG-IEF 算的，所以 hyg 這一格是定義上的循環，不可信
        if akey == "hyg":
            rec["circular"] = ["erp"]
        out_assets[akey] = rec
        print("  %-5s %-10s n=%d R2=%.2f  front=%+.2f real=%+.2f be=%+.2f erp=%+.2f%s%s"
              % (akey, sym, rec["n"], r2, rec["front"], rec["real"], rec["be"],
                 rec["erp"], "  (前一日因子)" if lagged else "",
                 "  [解釋力不足，前端退回先驗]" if rec.get("weak") else ""))

    if not out_assets:
        print("  ! 一個資產都沒估出來，不寫檔", file=sys.stderr)
        return 1

    payload = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "window": WINDOW,
        "ridge": RIDGE,
        "note": ("四條管道的曝險係數由 60 日滾動嶺迴歸估計，因子與資產都標準化，"
                 "所以係數是「因子動一個標準差時資產動幾個標準差」。"
                 "erp 用信用利差（HYG-IEF）不用 VIX——VIX 是 SPX 選擇權算出來的，"
                 "拿它解釋股票報酬接近同義反覆。"
                 "hyg 對 erp 那一格是定義上的循環，已標記為不可信、前端會退回先驗。"
                 "R2 低於 0.10 的資產標成 weak，前端整個退回先驗——"
                 "解釋力那麼低的係數是雜訊，用它比用先驗還糟。"
                 "eps（盈餘預期）不是日頻可觀測的東西，估不出來，維持程式內的先驗。"),
        "factors": [{"k": k, "proxy": sym, "how": how} for k, sym, how in FACTORS],
        "assets": out_assets,
    }
    with open(os.path.join(DATA, "betas.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print("  寫出 betas.json：%d 個資產" % len(out_assets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
