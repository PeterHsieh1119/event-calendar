#!/usr/bin/env python3
"""把版本字串蓋成 index.html 與 sw.js 的內容雜湊。

為什麼要這個東西：

「更新」按鈕的判斷是「伺服器上 sw.js 的 CACHE 跟這個分頁的 APP_VER 一不一樣」，
不一樣才清快取重新載入。但那兩個字串是手動維護的，2026-08-27 之後 index.html
改了十三次、版本字串一次都沒動——於是按鈕永遠認為「沒有新版」，只重抓資料，
使用者手機上跑的還是幾週前的程式碼。**按鈕沒壞，是版本號沒動。**

手動維護的版本號一定會忘記，所以改成從內容算：
把兩個檔案裡的版本字串換成佔位符之後一起雜湊，取前八碼。
內容變了雜湊就變，內容沒變重跑幾次都一樣（不會每次 commit 都製造假差異）。

用法：
    python scripts/stamp_version.py          # 蓋上去
    python scripts/stamp_version.py --check  # 只檢查，不一致回傳 1
"""
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "index.html")
SW = os.path.join(ROOT, "sw.js")

RE_HTML = re.compile(r'(const APP_VER\s*=\s*")([^"]+)(")')
RE_SW = re.compile(r'(CACHE\s*=\s*")([^"]+)(")')


def _read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


def compute(html=None, sw=None):
    """算出這份內容應該有的版本字串。版本字串本身先換成佔位符，避免循環。"""
    html = _read(INDEX) if html is None else html
    sw = _read(SW) if sw is None else sw
    norm = RE_HTML.sub(r"\1__VER__\3", html) + "\x00" + RE_SW.sub(r"\1__VER__\3", sw)
    return "evcal-" + hashlib.sha256(norm.encode("utf-8")).hexdigest()[:8]


def current():
    """回傳 (index.html 裡的, sw.js 裡的)，抓不到就是 None。"""
    mh = RE_HTML.search(_read(INDEX))
    ms = RE_SW.search(_read(SW))
    return (mh.group(2) if mh else None, ms.group(2) if ms else None)


def stamp():
    want = compute()
    changed = []
    for path, rx in ((INDEX, RE_HTML), (SW, RE_SW)):
        src = _read(path)
        new = rx.sub(lambda m: m.group(1) + want + m.group(3), src, count=1)
        if new != src:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(new)
            changed.append(os.path.basename(path))
    return want, changed


def main(argv):
    want = compute()
    have = current()
    if "--check" in argv:
        if have[0] == want and have[1] == want:
            print("版本字串與內容一致：%s" % want)
            return 0
        sys.stderr.write(
            "版本字串對不上內容：index.html=%s、sw.js=%s，應該是 %s。\n"
            "跑 python scripts/stamp_version.py 蓋上去，"
            "不然使用者的「更新」按鈕不會知道有新版。\n" % (have[0], have[1], want))
        return 1
    want, changed = stamp()
    print("版本蓋成 %s%s" % (want, ("（改了 " + "、".join(changed) + "）") if changed else "（本來就一致）"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
