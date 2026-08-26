#!/usr/bin/env python3
"""
每天由 GitHub Actions 執行，產生 data/events.json 與 data/px.json。
只寫「確認過的」事件——推算日期由前端的規則引擎自己算，不需要這裡重複。

需要的 secret（在 repo Settings → Secrets and variables → Actions 設定）：
  FMP_API_KEY   有就抓 FMP 的總經行事曆、財報日、QQQ 日線；沒有就只寫 Fed 官方排程。
"""
import json, os, re, sys, datetime as dt
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
KEY = os.environ.get("FMP_API_KEY", "").strip()
TODAY = dt.date.today()
FROM = TODAY.isoformat()
TO = (TODAY + dt.timedelta(days=400)).isoformat()

WATCH = [
    ("NVDA", "NVDA", "earn3", "AMC"), ("TSM", "台積電", "earn3", "BMO"),
    ("ASML", "ASML", "earn2", "BMO"), ("MU", "MU", "earn2", "AMC"),
    ("AMAT", "AMAT", "earn2", "AMC"), ("LRCX", "LRCX", "earn1", "AMC"),
    ("KLAC", "KLAC", "earn1", "AMC"), ("AMD", "AMD", "earn2", "AMC"),
    ("AVGO", "AVGO", "earn2", "AMC"), ("INTC", "INTC", "earn1", "AMC"),
    ("MSFT", "微軟", "earn3", "AMC"), ("GOOGL", "Google", "earn2", "AMC"),
    ("AMZN", "Amazon", "earn2", "AMC"), ("META", "Meta", "earn2", "AMC"),
    ("AAPL", "Apple", "earn2", "AMC"), ("ORCL", "Oracle", "earn2", "AMC"),
]

# 公布時間（美東）。前端用它換算台北時間，並判斷美股／台股各自在哪個交易日吸收。
# AMC = 收盤後，BMO = 開盤前，TW = 台北時間下午公布。
TOD = {
    "fomc": "14:00", "fomc_sep": "14:00", "minutes": "14:00",
    "cpi": "08:30", "ppi": "08:30", "nfp": "08:30", "pce": "08:30",
    "gdp": "08:30", "retail": "08:30", "refund": "08:30",
    "jolts": "10:00", "ism": "10:00", "jackson": "10:00",
    "quad": "09:30", "opex": "09:30", "election": "19:00", "twrev": "TW",
    "cloud": "AMC", "earn1": "AMC", "earn2": "AMC", "earn3": "AMC",
}

# 官方已公布的 FOMC 排程（2026 確定 / 2027 暫定）。決議日＝會議第二天。
FOMC = {
    2026: [("01-28", 0), ("03-18", 1), ("04-29", 0), ("06-17", 1),
           ("07-29", 0), ("09-16", 1), ("10-28", 0), ("12-09", 1)],
    2027: [("01-27", 0), ("03-17", 1), ("04-28", 0), ("06-09", 1),
           ("07-28", 0), ("09-15", 1), ("10-27", 0), ("12-08", 1)],
    2028: [("01-26", 0)],
}
# BLS 官方公布的 2026 發布日
NFP26 = ["01-09","02-11","03-06","04-03","05-08","06-05",
         "07-02","08-07","09-04","10-02","11-06","12-04"]
CPI26 = ["01-13","02-13","03-11","04-10","05-12","06-10",
         "07-14","08-12","09-11","10-14","11-10","12-10"]

KW = [
    (r"fomc|federal funds|interest rate decision", "D", "fomc", "FOMC 利率決議"),
    (r"nonfarm|non-farm|payroll", "D", "nfp", "非農就業"),
    (r"^cpi|consumer price", "D", "cpi", "CPI"),
    (r"pce", "D", "pce", "PCE 物價指數"),
    (r"\bgdp\b", "D", "gdp", "GDP"),
    (r"ppi|producer price", "D", "ppi", "PPI"),
    (r"\bism\b|\bpmi\b", "D", "ism", "ISM / PMI"),
    (r"retail sales", "D", "retail", "零售銷售"),
    (r"jolts|job openings", "D", "jolts", "JOLTS 職缺"),
]


def get(url, timeout=30):
    req = Request(url, headers={"User-Agent": "event-calendar/1.0"})
    with urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def get_json(url):
    try:
        return json.loads(get(url))
    except (URLError, HTTPError, ValueError, TimeoutError) as e:
        print(f"  ! {type(e).__name__}: {e}", file=sys.stderr)
        return None


def official_fed():
    """不依賴任何 API 的骨幹排程。"""
    out = []
    for year, meetings in FOMC.items():
        for md, sep in meetings:
            d = f"{year}-{md}"
            if d < FROM or d > TO:
                continue
            out.append(dict(
                date=d, kind="D", cat="fomc_sep" if sep else "fomc",
                title="FOMC 決議＋點陣圖" if sep else "FOMC 利率決議",
                est=False, src="federalreserve.gov",
                note=("除利率外更新經濟預測與點陣圖，是重新定價整條殖利率曲線的場合。"
                      if sep else "只有聲明稿與記者會，市場靠措辭變化推斷傾向。")))
    for i, md in enumerate(NFP26):
        d = f"2026-{md}"
        if FROM <= d <= TO:
            out.append(dict(date=d, kind="D", cat="nfp", title="非農就業", est=False,
                            src="bls.gov", note="薪資增速比新增人數更影響利率路徑。"))
    for i, md in enumerate(CPI26):
        d = f"2026-{md}"
        if FROM <= d <= TO:
            out.append(dict(date=d, kind="D", cat="cpi", title="CPI", est=False,
                            src="bls.gov", note="核心服務與房租分項決定通膨黏性，比總數重要。"))
    return out


def fmp_macro():
    if not KEY:
        return []
    url = (f"https://financialmodelingprep.com/stable/economic-calendar"
           f"?from={FROM}&to={TO}&apikey={KEY}")
    j = get_json(url)
    if not isinstance(j, list):
        print("  ! 總經行事曆回傳格式不符", file=sys.stderr)
        return []
    out = []
    for x in j:
        if str(x.get("country", "")).upper() != "US":
            continue
        name = str(x.get("event", ""))
        for pat, kind, cat, title in KW:
            if re.search(pat, name, re.I):
                out.append(dict(date=str(x.get("date", ""))[:10], kind=kind, cat=cat,
                                title=title, est=False, src="FMP economic calendar",
                                note="官方確認的發布時間。"))
                break
    print(f"  總經 {len(out)} 筆")
    return out


def fmp_earnings():
    if not KEY:
        return []
    out = []
    for sym, name, cat, tod in WATCH:
        j = get_json(f"https://financialmodelingprep.com/stable/earnings"
                     f"?symbol={sym}&apikey={KEY}")
        if not isinstance(j, list):
            continue
        for x in j:
            d = str(x.get("date", ""))[:10]
            if FROM <= d <= TO:
                out.append(dict(date=d, kind="N", cat=cat, title=f"{name} 財報",
                                est=False, t=tod, src="FMP earnings",
                                note="指引與資本支出改寫的是未來現金流，不是本季數字。"))
    print(f"  財報 {len(out)} 筆")
    return out


def prices():
    """QQQ 日線，給年度軸當背景。存兩年。"""
    if KEY:
        start = (TODAY - dt.timedelta(days=760)).isoformat()
        j = get_json(f"https://financialmodelingprep.com/stable/historical-price-eod/light"
                     f"?symbol=QQQ&from={start}&to={TODAY.isoformat()}&apikey={KEY}")
        if isinstance(j, list) and j:
            series = {}
            for r in j:
                d = str(r.get("date", ""))[:10]
                v = r.get("price", r.get("close"))
                if d and v is not None:
                    series[d] = round(float(v), 2)
            print(f"  價格 {len(series)} 筆 (QQQ/FMP)")
            return {"symbol": "QQQ · FMP", "series": series}
    try:
        txt = get("https://stooq.com/q/d/l/?s=%5Endx&i=d")
        lines = txt.strip().split("\n")
        head = lines[0].split(",")
        di, ci = head.index("Date"), head.index("Close")
        cutoff = (TODAY - dt.timedelta(days=760)).isoformat()
        series = {}
        for ln in lines[1:]:
            c = ln.split(",")
            if len(c) > max(di, ci) and c[di] >= cutoff:
                try:
                    series[c[di]] = round(float(c[ci]), 2)
                except ValueError:
                    pass
        if series:
            print(f"  價格 {len(series)} 筆 (NDX/Stooq)")
            return {"symbol": "NDX · Stooq", "series": series}
    except Exception as e:
        print(f"  ! 價格抓取失敗: {e}", file=sys.stderr)
    return None


def load(path, default):
    try:
        with open(os.path.join(DATA, path), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, obj):
    with open(os.path.join(DATA, path), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def main():
    print("== 事件排程更新 ==")
    events = official_fed()
    print(f"  官方骨幹 {len(events)} 筆")
    events += fmp_macro()
    events += fmp_earnings()

    # 保留人工／routine 策劃的事件（curated.json 不會被這支程式覆蓋）
    curated = load("curated.json", [])
    if isinstance(curated, list):
        events += [e for e in curated if isinstance(e, dict) and e.get("date")]
        print(f"  策劃事件 {len(curated)} 筆")

    seen, uniq = set(), []
    for e in sorted(events, key=lambda x: (x.get("date", ""), x.get("title", ""))):
        k = (e.get("date"), e.get("title"))
        if not all(k) or k in seen:
            continue
        seen.add(k)
        uniq.append(e)

    # 每筆都要有公布時間，缺的用類型預設值補上
    for e in uniq:
        if not e.get("t"):
            e["t"] = TOD.get(e.get("cat", ""), "08:30")

    save("events.json", {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": ("FMP + 官方排程" if KEY else "官方排程（未設 FMP_API_KEY）"),
        "count": len(uniq),
        "events": uniq,
    })
    print(f"  寫出 events.json：{len(uniq)} 筆")

    px = prices()
    if px:
        save("px.json", px)

    print("完成。")


if __name__ == "__main__":
    main()
