#!/usr/bin/env python3
"""
資料閘門。所有 routine 在 commit 之前都要跑這支，CI 在部署之前也會跑一次。
沒過就不要 commit，也不要「盡量修一下」——把每一條錯誤修掉再跑。

檢查的重點是那些「不會報錯、只會靜默出錯」的事：
未知的事件類型會被當成 ISM 計分、priced 對不上標題整筆失效、
日期格式錯了整筆消失、複盤缺 sigma 等於白填。這些在網站上都看不出來。
"""
import json
import os
import re
import sys
import datetime as dt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
INDEX = os.path.join(ROOT, "index.html")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TOD_RE = re.compile(r"^(\d{2}:\d{2}|AMC|BMO|TW|TPE:\d{2}:\d{2})$")
NUM_RE = re.compile(r"^[+-]?\d+(\.\d+)?$")
KINDS = {"N", "D", "R"}

errs = []
warns = []


def err(f, msg):
    errs.append("[%s] %s" % (f, msg))


def warn(f, msg):
    warns.append("[%s] %s" % (f, msg))


def load(name, default=None):
    p = os.path.join(DATA, name)
    if not os.path.exists(p):
        return default
    try:
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)
    except ValueError as e:
        err(name, "不是合法的 JSON：%s" % e)
        return default


def cats_from_index():
    """合法的事件類型直接從 index.html 的 CAT 抓，不另外維護一份會走鐘的清單。"""
    try:
        with open(INDEX, encoding="utf-8") as fh:
            src = fh.read()
    except OSError:
        return None
    m = re.search(r"const CAT=\{(.*?)\n\};", src, re.S)
    if not m:
        return None
    return set(re.findall(r"^\s*(\w+)\s*:\s*\{", m.group(1), re.M))


def titles_from_index():
    """規則引擎自己會生成的事件標題。priced.json 對得上它們也算有效，
    不然每天都會噴一堆「NVDA 財報找不到同名事件」的假警告。"""
    try:
        with open(INDEX, encoding="utf-8") as fh:
            src = fh.read()
    except OSError:
        return set()
    out = set()
    m = re.search(r"function buildBaseline\(.*?\n\}", src, re.S)
    if m:
        for lit in re.findall(r'"([^"\n]{2,40})"', m.group(0)):
            if re.search(r"[一-鿿]", lit) or lit.isupper():
                out.add(lit)
    for q in (1, 2, 3, 4):
        out.add("Q%d GDP 初值" % q)
    w = re.search(r"const WATCH=\[(.*?)\n\];", src, re.S)
    if w:
        for name in re.findall(r'n:"([^"]+)"', w.group(1)):
            out.add(name + " 財報")
    return out


def check_metrics(f, title, metrics, need_act):
    """財報這類有多個指標的事件：EPS、營收、分項各一列。
    n 是指標名，cons/act 都要是純數值字串，單位放 unit。"""
    if metrics in (None, ""):
        return
    if not isinstance(metrics, list):
        err(f, "「%s」metrics 必須是陣列" % title)
        return
    seen = set()
    for j, m in enumerate(metrics):
        if not isinstance(m, dict) or not m.get("n"):
            err(f, "「%s」metrics 第 %d 筆缺 n（指標名）" % (title, j + 1))
            continue
        if m["n"] in seen:
            err(f, "「%s」metrics 有兩筆都叫 %r" % (title, m["n"]))
        seen.add(m["n"])
        for fld in ("cons", "act"):
            v = str(m.get(fld, "")).strip()
            if v and not NUM_RE.match(v):
                err(f, "「%s」metrics 的 %s.%s 要是純數值字串（單位放 unit）：%r"
                    % (title, m["n"], fld, m[fld]))
        if need_act and not str(m.get("act", "")).strip():
            err(f, "「%s」metrics 的 %s 缺 act" % (title, m["n"]))


def valid_date(s):
    if not isinstance(s, str) or not DATE_RE.match(s):
        return False
    try:
        dt.date.fromisoformat(s)
        return True
    except ValueError:
        return False


def check_event(f, e, i, cats, require_t):
    if not isinstance(e, dict):
        err(f, "第 %d 筆不是物件" % (i + 1))
        return None
    title = e.get("title")
    if not title or not isinstance(title, str):
        err(f, "第 %d 筆缺 title" % (i + 1))
        return None
    if not valid_date(e.get("date")):
        err(f, "「%s」date 不是合法的 YYYY-MM-DD：%r" % (title, e.get("date")))
    if e.get("kind") not in KINDS:
        err(f, "「%s」kind 必須是 N/D/R，拿到 %r" % (title, e.get("kind")))
    cat = e.get("cat")
    if cats is not None and cat not in cats:
        err(f, "「%s」cat %r 不在 index.html 的 CAT 裡，"
               "網站會靜默地把它當成 ISM 計分" % (title, cat))
    t = e.get("t")
    if t in (None, ""):
        msg = "「%s」缺 t（公布時間），台北時間與交易時段會算錯" % title
        (err if require_t else warn)(f, msg)
    elif not TOD_RE.match(str(t)):
        err(f, "「%s」t 格式不合法：%r，只接受 HH:MM / AMC / BMO / TW / TPE:HH:MM"
            % (title, t))
    return title


def check_routines(cats):
    """routine 檔本身也要被閘門顧到。

    兩件事都屬於「不會報錯、只會靜默走鐘」：
    _shared.md 的合法 cat 清單跟 index.html 的 CAT 對不上時，routine 會照著文件寫出
    網站不認得的代碼，前端靜默當成 ISM 計分；index.html 的 SEEDS 指到不存在的檔名時，
    「每日排程」那頁只顯示「讀取失敗」，沒有人會發現。"""
    root = os.path.join(ROOT, "routines")
    try:
        with open(os.path.join(root, "_shared.md"), encoding="utf-8") as fh:
            sh = fh.read()
    except OSError:
        err("routines/_shared.md", "找不到共用規範，四個任務都會少讀一份")
        return

    m = re.search(r"```\n(總經與政策.*?)\n```", sh, re.S)
    if not m:
        warn("routines/_shared.md", "找不到合法 cat 代碼的區塊，跳過對照")
    elif cats:
        listed = set(re.findall(r"\b([a-z][a-z0-9_]+)\b", m.group(1)))
        missing = sorted(cats - listed)
        extra = sorted(listed - cats)
        if missing:
            err("routines/_shared.md",
                "index.html 的 CAT 有這些代碼但共用規範沒列，routine 不會知道可以用："
                + "、".join(missing))
        if extra:
            err("routines/_shared.md",
                "共用規範列了 index.html 沒有的代碼，routine 照著寫會被前端當成 ISM 計分："
                + "、".join(extra))
        if not missing and not extra:
            print("  routines/_shared.md：cat 清單與 index.html 一致（%d 種）" % len(cats))

    try:
        with open(INDEX, encoding="utf-8") as fh:
            src = fh.read()
    except OSError:
        return
    ms = re.search(r"const SEEDS=\{(.*?)\};", src, re.S)
    if not ms:
        return
    for fn in re.findall(r'f:"([^"]+)"', ms.group(1)):
        if not os.path.exists(os.path.join(root, fn)):
            err("index.html", "SEEDS 指到 routines/%s，但這個檔不存在" % fn)


def main():
    cats = cats_from_index()
    if cats is None:
        warn("index.html", "抓不到 CAT 物件，這一輪跳過事件類型檢查")
    else:
        print("  index.html 合法 cat：%d 種" % len(cats))

    today = dt.date.today()
    titles = titles_from_index()
    if titles:
        print("  規則引擎會生成的標題：%d 種" % len(titles))

    ev = load("events.json", {})
    events = ev.get("events") if isinstance(ev, dict) else None
    if isinstance(events, list):
        for i, e in enumerate(events):
            t = check_event("events.json", e, i, cats, require_t=False)
            if t:
                titles.add(t)
        print("  events.json：%d 筆" % len(events))
    else:
        warn("events.json", "沒有 events 陣列（Actions 還沒跑過的話是正常的）")

    cur = load("curated.json", [])
    if isinstance(cur, dict):
        cur = cur.get("items", [])
    if isinstance(cur, list):
        seen = set()
        for i, e in enumerate(cur):
            t = check_event("curated.json", e, i, cats, require_t=True)
            if not t:
                continue
            titles.add(t)
            d = e.get("date")
            if (d, t) in seen:
                err("curated.json", "「%s」%s 重複了兩筆" % (t, d))
            seen.add((d, t))
            if valid_date(d):
                age = (today - dt.date.fromisoformat(d)).days
                if age > 60:
                    warn("curated.json",
                         "「%s」已經過去 %d 天，每日任務的清理程序應該要移除它" % (t, age))
        print("  curated.json：%d 筆" % len(cur))

    pr = load("priced.json", {})
    items = pr.get("items") if isinstance(pr, dict) else pr
    if isinstance(items, list):
        orphan = 0
        for i, it in enumerate(items):
            if not isinstance(it, dict):
                err("priced.json", "第 %d 筆不是物件" % (i + 1))
                continue
            t = it.get("title")
            if not t:
                err("priced.json", "第 %d 筆缺 title" % (i + 1))
                continue
            if not valid_date(it.get("date")):
                err("priced.json", "「%s」date 不合法：%r" % (t, it.get("date")))
            p = it.get("pxd")
            if not isinstance(p, (int, float)) or isinstance(p, bool) or not (0 <= p <= 1):
                err("priced.json", "「%s」pxd 必須是 0~1 的數字，拿到 %r" % (t, p))
            if not it.get("basis"):
                err("priced.json", "「%s」缺 basis，沒有依據的定價數字不可信，寧可不要寫" % t)
            # 事前共識：有寫就要能追溯來源，而且數值欄位要是純數字
            if it.get("cons") not in (None, ""):
                if not NUM_RE.match(str(it["cons"]).strip()):
                    err("priced.json", "「%s」cons 要是純數值字串（單位放 unit）：%r"
                        % (t, it["cons"]))
                if not it.get("consSrc"):
                    err("priced.json", "「%s」有 cons 就必須有 consSrc，"
                                       "查不到出處的共識數字不要寫" % t)
            if it.get("prev") not in (None, "") and not NUM_RE.match(str(it["prev"]).strip()):
                err("priced.json", "「%s」prev 要是純數值字串：%r" % (t, it["prev"]))
            if it.get("unit") not in (None, "") and len(str(it["unit"])) > 6:
                err("priced.json", "「%s」unit 太長，只放單位本身（%%、K、bp、USD）" % t)
            check_metrics("priced.json", t, it.get("metrics"), need_act=False)
            if titles and t not in titles:
                orphan += 1
                warn("priced.json", "「%s」在 events/curated 裡找不到同名事件，這筆不會生效" % t)
        extra = "（%d 筆對不上標題）" % orphan if orphan else ""
        print("  priced.json：%d 筆%s" % (len(items), extra))

    rv = load("reviews.json", {})
    items = rv.get("items") if isinstance(rv, dict) else rv
    if isinstance(items, list):
        for i, it in enumerate(items):
            if not isinstance(it, dict):
                err("reviews.json", "第 %d 筆不是物件" % (i + 1))
                continue
            t = it.get("title") or ("第 %d 筆" % (i + 1))
            if not valid_date(it.get("date")):
                err("reviews.json", "「%s」date 不合法：%r" % (t, it.get("date")))
            if not str(it.get("sigma", "")).strip():
                err("reviews.json",
                    "「%s」缺 sigma（當天的一般波動基準），"
                    "校正沒有它就只能退回寫死的 0.9%%，等於白填" % t)
            check_metrics("reviews.json", t, it.get("metrics"), need_act=False)
            vs = it.get("views")
            if vs not in (None, ""):
                if not isinstance(vs, list):
                    err("reviews.json", "「%s」views 必須是陣列" % t)
                else:
                    for j, v in enumerate(vs):
                        if not isinstance(v, dict) or not v.get("t"):
                            err("reviews.json", "「%s」views 第 %d 筆缺 t（說法本身）"
                                % (t, j + 1))
                            continue
                        if not v.get("who"):
                            err("reviews.json", "「%s」views 第 %d 筆缺 who，"
                                                "沒有出處的市場說法不要收" % (t, j + 1))
                        if v.get("tone") not in (None, "", "鷹", "鴿", "偏多", "偏空", "中性"):
                            err("reviews.json", "「%s」views 的 tone 只能是 "
                                                "鷹／鴿／偏多／偏空／中性，拿到 %r"
                                % (t, v.get("tone")))
            for fld in ("spx", "ndx", "y10", "dxy", "gld", "sigma", "z"):
                v = str(it.get(fld, "")).strip()
                if v and not NUM_RE.match(v):
                    err("reviews.json", "「%s」%s 不是純數值字串：%r" % (t, fld, v))
        print("  reviews.json：%d 筆" % len(items))

    rg = load("regime.json", {})
    if isinstance(rg, dict) and rg.get("values"):
        allowed = {"shock": (-1, 1), "infl": (0, 1), "pivot": (0, 1),
                   "vol": (0, 1), "conc": (0, 1)}
        for k, v in rg["values"].items():
            if k not in allowed:
                err("regime.json", "未知的欄位 %r" % k)
            elif not isinstance(v, (int, float)) or isinstance(v, bool) \
                    or not (allowed[k][0] <= v <= allowed[k][1]):
                err("regime.json", "%s 必須在 %s 之間，拿到 %r" % (k, allowed[k], v))
        missing = sorted(set(allowed) - set(rg["values"]))
        if missing:
            err("regime.json", "缺少欄位：%s" % missing)
        if not rg.get("basis"):
            err("regime.json", "缺 basis，環境頁要顯示它，沒有依據使用者無法判斷你設得對不對")
        if not valid_date(rg.get("asof", "")):
            err("regime.json", "asof 不是合法日期：%r，本機覆蓋的過期判斷靠它"
                % rg.get("asof"))
        print("  regime.json：已設定 %d 格" % len(rg["values"]))

    px = load("px.json", {})
    if isinstance(px, dict) and px.get("series"):
        ser = px["series"]
        first = next(iter(ser.values()), None)
        if isinstance(first, dict):
            # 多標的：{"QQQ": {"YYYY-MM-DD": 收盤}, ...}
            units = {s.get("k"): s.get("unit") for s in (px.get("symbols") or [])
                     if isinstance(s, dict)}
            for k in ser:
                if k not in units:
                    warn("px.json", "序列 %r 不在 symbols 清單裡，選單不會出現它" % k)
                elif units[k] not in ("pct", "bp"):
                    err("px.json", "%s 的 unit 必須是 pct 或 bp，拿到 %r" % (k, units[k]))
                bad = [d for d in ser[k] if not valid_date(d)]
                if bad:
                    err("px.json", "%s 有 %d 個日期不合法，例如 %s" % (k, len(bad), bad[:3]))
            for k in units:
                if k not in ser:
                    err("px.json", "symbols 列了 %r 但 series 裡沒有這條" % k)
            if px.get("default") and px["default"] not in ser:
                err("px.json", "default 指向不存在的序列 %r" % px["default"])
            if "QQQ" not in ser:
                warn("px.json", "沒有 QQQ，校準會失去波動基準（會退回寫死的 0.9%）")
            print("  px.json：%d 個標的，共 %d 個資料點"
                  % (len(ser), sum(len(v) for v in ser.values())))
        else:
            # 舊格式：單一序列
            bad = [d for d in ser if not valid_date(d)]
            if bad:
                err("px.json", "%d 個日期格式不合法，例如 %s" % (len(bad), bad[:3]))
            print("  px.json：%d 筆（舊的單一序列格式）" % len(ser))

    bt = load("betas.json", {})
    if isinstance(bt, dict) and bt.get("assets"):
        chans = ("front", "real", "be", "erp")
        ok_assets = 0
        for k, r in bt["assets"].items():
            if not isinstance(r, dict):
                err("betas.json", "%s 不是物件" % k)
                continue
            for c in chans:
                v = r.get(c)
                if v is None:
                    continue
                if not isinstance(v, (int, float)) or isinstance(v, bool):
                    err("betas.json", "%s.%s 必須是數字，拿到 %r" % (k, c, v))
                elif abs(v) > 3:
                    err("betas.json", "%s.%s = %s 超出合理範圍（標準化後應在 ±3 內），"
                                      "迴歸可能爆掉了" % (k, c, v))
            r2 = r.get("r2")
            if not isinstance(r2, (int, float)) or not (-1 <= r2 <= 1):
                err("betas.json", "%s 的 r2 不合法：%r" % (k, r2))
            if not isinstance(r.get("n"), int) or r["n"] < 20:
                err("betas.json", "%s 的樣本數 %r 太少" % (k, r.get("n")))
            if not r.get("weak"):
                ok_assets += 1
        if not ok_assets:
            warn("betas.json", "沒有任何資產通過品質門檻，前端會整組退回先驗")
        print("  betas.json：%d 個資產，%d 個採用" % (len(bt["assets"]), ok_assets))

    check_routines(cats)

    cl = load("changelog.json", [])
    if isinstance(cl, list):
        for i, c in enumerate(cl):
            if not isinstance(c, dict) or not valid_date(c.get("date", "")) \
                    or not c.get("text"):
                err("changelog.json", "第 %d 筆需要 date 與 text" % (i + 1))
        print("  changelog.json：%d 筆" % len(cl))

    print("")
    for w in warns:
        print("  警告 %s" % w)
    for e in errs:
        sys.stderr.write("  錯誤 %s\n" % e)
    if errs:
        sys.stderr.write("\n資料驗證失敗：%d 個錯誤、%d 個警告。不要 commit。\n"
                         % (len(errs), len(warns)))
        return 1
    print("\n資料驗證通過（%d 個警告）。" % len(warns))
    return 0


if __name__ == "__main__":
    sys.exit(main())
