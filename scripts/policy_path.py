#!/usr/bin/env python3
"""
從聯邦資金期貨反推市場定價的政策路徑，寫進 data/policy.json。

## 為什麼要自己算

「Jackson Hole 之後升息機率上升」這種話，網路上到處都有人講，但講的人不會附數字，
而且說法彼此矛盾。這一支不去抄別人的結論，直接從價格反推——
**CME FedWatch 的原料就是這個，它沒有獨家資料，只是把同一組期貨價格換算成機率。**

人要用眼睛看的話：CME FedWatch Tool（cmegroup.com，免費、不用登入）。
但那個站在雲端 routine 的網路環境連不出去，而且它只給「現在」，不給歷史序列，
所以事件當天到底移動了多少，看它是看不出來的。這支給的是完整的每日序列。

## 資料來源

Yahoo 的個別月份合約：ZQ + 月碼 + 年 + .CBT（ZQU26.CBT ＝ 2026 年 9 月）。
合約價 P 換算成該日曆月的**平均**有效聯邦資金利率：r_avg = 100 − P。

## 換算方法

一個有開會的月份，平均利率是會前與會後兩段的加權平均：

    100 − P = (d1/D)·r_前 + (d2/D)·r_後

D＝當月天數，d1＝會議當天為止的天數（決議隔天生效，所以會議日算在舊利率那一段），
d2＝D − d1。已知 r_前 就解得出 r_後。

三個讓結果穩定的作法：

1. **錨定在沒有開會的月份。** 那種月份的合約價直接就是當月實際有效利率，
   不需要任何假設。2026 年的 2、5、8、11 月都沒有會議，所以錨永遠找得到。

2. **會議在月底時，用下個月的合約當會後利率。** 例如 10/28 的會議，
   d2 只有 3 天，用當月合約去解會把 3 天的雜訊放大十倍；
   11 月沒有會議，直接拿 11 月合約就是乾淨的會後利率。

3. **機率是「相對於一碼」的比例，不是聯合機率分布。** 隱含變動 +14.5bp
   對應「一碼升息的機率約 58%」。這是 FedWatch 對單次會議的算法，
   前提是市場只在「不動」與「動一碼」之間選。跨過一碼時會顯示成「1.4 碼」，
   那時候講機率已經沒有意義，要看的是碼數。
"""
import json
import os
import sys
import datetime as dt
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

STEP = 0.25                 # 一碼
HIST_DAYS = 400             # 保留多久的每日序列
MONTH_CODE = "FGHJKMNQUVXZ"  # 1~12 月

# FOMC 決議日。跟 index.html 的 FOMC 表同一份，改一邊就要改另一邊——
# validate_data.py 會逐項對照，走鐘的話閘門會紅。
FOMC = {
    2026: ["01-28", "03-18", "04-29", "06-17", "07-29", "09-16", "10-28", "12-09"],
    2027: ["01-27", "03-17", "04-28", "06-09", "07-28", "09-15", "10-27", "12-08"],
    2028: ["01-26"],
}

UA = {"User-Agent": "Mozilla/5.0 (compatible; event-calendar/1.0)"}


def contract(y, m):
    return "ZQ%s%02d.CBT" % (MONTH_CODE[m - 1], y % 100)


def fetch(sym, rng="2y"):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + sym.replace("=", "%3D") + "?range=%s&interval=1d" % rng)
    for _ in range(3):
        try:
            raw = urlopen(Request(url, headers=UA), timeout=30).read()
        except (URLError, HTTPError, OSError):
            continue
        try:
            res = json.loads(raw)["chart"]["result"][0]
        except (ValueError, KeyError, TypeError, IndexError):
            continue
        ts = res.get("timestamp") or []
        cl = (res.get("indicators", {}).get("quote") or [{}])[0].get("close") or []
        out = {}
        for t, c in zip(ts, cl):
            if c is None:
                continue
            d = dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d")
            out[d] = float(c)
        if out:
            return out
    return {}


def days_in(y, m):
    return (dt.date(y + (m == 12), (m % 12) + 1, 1) - dt.date(y, m, 1)).days


def meetings_in(y, m):
    return [d for d in FOMC.get(y, []) if int(d[:2]) == m]


def meeting_list(today, ahead=8):
    """今天之後的 FOMC 會議，由近而遠。"""
    out = []
    for y in sorted(FOMC):
        for md in FOMC[y]:
            d = dt.date(y, int(md[:2]), int(md[3:]))
            if d >= today:
                out.append(d)
    return out[:ahead]


def solve_day(px, day, meets):
    """算出某一天收盤時，市場對每一次會議之後的政策利率定價。

    回傳 (effr, {會議日字串: 會後隱含利率})。抓不到錨或缺合約就回 (None, {})。
    """
    ym = lambda d: (d.year, d.month)

    def price(y, m):
        return px.get(contract(y, m), {}).get(day)

    # 錨：day 所在月份往回找最近一個「沒有開會」的月份，它的合約價就是當時的有效利率
    y, m = int(day[:4]), int(day[5:7])
    effr = None
    for back in range(0, 7):
        yy, mm = y, m - back
        while mm <= 0:
            mm += 12
            yy -= 1
        if meetings_in(yy, mm):
            continue
        p = price(yy, mm)
        if p is not None:
            effr = round(100.0 - p, 4)
            break
    if effr is None:
        return None, {}

    cur = effr
    out = {}
    for md in meets:
        y, m = md.year, md.month
        if len(meetings_in(y, m)) != 1:
            # 一個月兩次會議（罕見）解不開，之後的也跟著不準，就停在這裡
            break
        ny, nm = (y + (m == 12), (m % 12) + 1)
        nxt = price(ny, nm)
        if not meetings_in(ny, nm) and nxt is not None:
            # 下個月沒有會議：它的合約價直接就是會後利率，不用解方程
            post = 100.0 - nxt
        else:
            p = price(y, m)
            if p is None:
                break
            D = days_in(y, m)
            d1 = md.day          # 決議隔天生效，會議當天仍算舊利率
            d2 = D - d1
            if d2 <= 0:
                break
            post = ((100.0 - p) * D - d1 * cur) / d2
        out[md.isoformat()] = round(post, 4)
        cur = post
    return effr, out


def probs(chg_bp):
    """隱含變動換算成一碼的機率。超過一碼時機率沒有意義，回 None 讓前端顯示碼數。"""
    step_bp = STEP * 100
    n = chg_bp / step_bp
    if abs(n) > 1.0:
        return None
    if n >= 0:
        return {"hike": round(n, 4), "hold": round(1 - n, 4), "cut": 0.0}
    return {"cut": round(-n, 4), "hold": round(1 + n, 4), "hike": 0.0}


def main():
    print("== 政策路徑 ==")
    today = dt.date.today()
    meets = meeting_list(today)
    if not meets:
        print("  ! FOMC 表裡沒有未來的會議了，該補新年度的排程", file=sys.stderr)
        return 1

    # 要抓的合約：今天往前 2 個月（錨可能在過去）到最後一次會議的下個月
    need = set()
    cur = dt.date(today.year, today.month, 1)
    for back in range(1, 8):
        yy, mm = cur.year, cur.month - back
        while mm <= 0:
            mm += 12
            yy -= 1
        need.add((yy, mm))
    last = meets[-1]
    ptr = dt.date(today.year, today.month, 1)
    while (ptr.year, ptr.month) <= (last.year, last.month):
        need.add((ptr.year, ptr.month))
        ptr = dt.date(ptr.year + (ptr.month == 12), (ptr.month % 12) + 1, 1)
    need.add((last.year + (last.month == 12), (last.month % 12) + 1))

    px = {}
    for y, m in sorted(need):
        sym = contract(y, m)
        s = fetch(sym)
        if s:
            px[sym] = s
        print("  %-11s %s" % (sym, ("%d 筆" % len(s)) if s else "抓不到"))
    if not px:
        print("  ! 一個合約都沒抓到，不寫檔", file=sys.stderr)
        return 1

    # 每日序列。日期取所有合約的交集，缺一天就跳過那一天。
    alldays = sorted(set().union(*[set(v) for v in px.values()]))
    cutoff = (today - dt.timedelta(days=HIST_DAYS)).isoformat()
    hist = {}
    for day in alldays:
        if day < cutoff:
            continue
        # 用「那一天當下還沒開的會議」，不然回頭看歷史會把已經開完的會也算進去
        dd = dt.date(int(day[:4]), int(day[5:7]), int(day[8:]))
        fut = [m for m in meeting_list(dd, ahead=8)]
        effr, path = solve_day(px, day, fut)
        if effr is None or not path:
            continue
        hist[day] = {"effr": effr, "m": path}

    # 到期的合約 Yahoo 就不給了，所以往回的錨最多只找得到最近一個沒開會的月份——
    # 這個序列**補不回來**，只能從今天起一天一天累積。所以要跟既有檔案合併，
    # 不是每天重生。重生的話每次 Actions 跑完歷史就被砍到只剩三週。
    old = {}
    prev_path = os.path.join(DATA, "policy.json")
    if os.path.exists(prev_path):
        try:
            with open(prev_path, encoding="utf-8") as f:
                old = (json.load(f) or {}).get("hist") or {}
        except (ValueError, OSError):
            old = {}
    merged = dict(old)
    merged.update(hist)          # 同一天以這次算的為準
    hist = {k: v for k, v in sorted(merged.items()) if k >= cutoff}

    if not hist:
        print("  ! 一天都解不出來，不寫檔", file=sys.stderr)
        return 1

    lastday = sorted(hist)[-1]
    cur = hist[lastday]
    rows = []
    for md in meets:
        k = md.isoformat()
        if k not in cur["m"]:
            continue
        prev_key = None
        for x in meets:
            if x.isoformat() == k:
                break
            prev_key = x.isoformat()
        r_pre = cur["m"][prev_key] if prev_key and prev_key in cur["m"] else cur["effr"]
        chg = round((cur["m"][k] - r_pre) * 100, 1)
        rows.append({
            "date": k,
            "rate": cur["m"][k],
            "chgBp": chg,                                       # 這一次會議自己的變動
            "cumBp": round((cur["m"][k] - cur["effr"]) * 100, 1),  # 從現在累計
            "p": probs(chg),
        })

    payload = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "asof": lastday,
        "step": STEP,
        "effr": cur["effr"],
        "source": "CME 30 天聯邦資金期貨（Yahoo 個別月份合約日收盤）",
        "how": ("合約價換算成當月平均有效利率（100−P），再用沒有開會的月份當錨，"
                "逐次會議解出會後利率。機率＝隱含變動 ÷ 一碼，"
                "超過一碼時機率沒有意義，改看碼數。"
                "人要自己核對的話看 CME FedWatch Tool，原料是同一組期貨價格。"),
        "meetings": rows,
        "histFrom": sorted(hist)[0],
        "hist": hist,
    }
    with open(os.path.join(DATA, "policy.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    print("  錨定有效利率 %.3f%%（%s）" % (cur["effr"], lastday))
    for r in rows[:5]:
        p = r["p"]
        tail = ("升息 %.0f%%" % (p["hike"] * 100)) if p and p["hike"] > p["cut"] else \
               ("降息 %.0f%%" % (p["cut"] * 100)) if p else ("%.2f 碼" % (r["chgBp"] / 25))
        print("  %s  %.3f%%  本次 %+.1fbp  累計 %+.1fbp  %s"
              % (r["date"], r["rate"], r["chgBp"], r["cumBp"], tail))
    print("  每日序列 %d 天（%s 起，逐日累積，到期合約補不回來），寫出 policy.json"
          % (len(hist), sorted(hist)[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
