#!/usr/bin/env node
/*
 * 回測：衝擊分數到底有沒有預測力？
 *
 * 70 分門檻、B 的那些數字、環境放大係數——目前全部是「看起來合理」的先驗，
 * 沒有一個數字說得出「照這個排序去看事件，比隨機挑好多少」。這支就是去算那個數字。
 *
 * 方法：
 *   1. 用 index.html 自己的 score()。不另外實作一份——兩份實作遲早會分岔，
 *      分岔之後回測出來的就不是網站在用的那個模型。
 *   2. 每一筆過去的事件配到它「被哪個美股交易日吸收」（用 index.html 的 session()）。
 *      盤後財報打到的是隔一個交易日，這一步弄錯的話整份回測就是在對齊噪音。
 *   3. 實際變動取那一天 QQQ 的絕對日報酬，再除以前 20 個交易日的已實現日波動
 *      （不含當日）換算成 z。不除的話高波動月份的每一件事都會看起來「反應大」，
 *      量到的會是波動叢聚，不是事件的預測力。
 *   4. 算 Spearman rank IC（分數的名次 vs 實際 z 的名次）與十分位表。
 *
 *   node scripts/backtest.js            # 寫進 data/backtest.json
 *   node scripts/backtest.js --dry      # 只印結果不寫檔
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.dirname(__dirname);
const DRY = process.argv.includes("--dry");

/* ── 用跟 smoke_test.js 同一套 DOM stub 把 index.html 的 script 跑起來 ── */
function makeEl() {
  const el = {
    style: {}, dataset: {}, children: [], value: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    appendChild() {}, addEventListener() {}, removeEventListener() {},
    scrollIntoView() {}, focus() {}, click() {}, remove() {},
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
    get innerHTML() { return ""; }, set innerHTML(v) {},
    get textContent() { return ""; }, set textContent(v) {},
    get scrollLeft() { return 0; }, set scrollLeft(v) {},
    clientWidth: 0, scrollWidth: 0, firstElementChild: null, parentElement: null,
  };
  return el;
}
const store = new Map();
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Math, JSON, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
  isFinite, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  requestAnimationFrame() { return 0; },
  fetch() { return Promise.reject(new Error("backtest 不連網")); },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  },
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  location: { protocol: "file:" },
  addEventListener() {}, removeEventListener() {}, scrollTo() {},
  matchMedia() { return { matches: false, addEventListener() {} }; },
  innerWidth: 1280, innerHeight: 800,
  document: {
    getElementById: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener() {},
    body: makeEl(), documentElement: makeEl(),
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("找不到 index.html 裡的 <script> 區塊"); process.exit(1); }
const EXPORT = "\n;globalThis.__T={CAT:CAT,score:score,session:session,dayScore:dayScore," +
  "mergeRemote:mergeRemote,applyRegime:applyRegime,applyRemoteReviews:applyRemoteReviews," +
  "getEVENTS:function(){return EVENTS;}};\n";
vm.createContext(sandbox);
vm.runInContext(m[1] + EXPORT, sandbox, { filename: "index.html<script>", timeout: 20000 });
const T = sandbox.__T;

/* ── 資料 ── */
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
const px = readJSON("px.json");

// 環境與校準要跟網站當下用的一致，否則算出來的不是網站在用的那組分數
try { T.applyRegime(readJSON("regime.json")); } catch (e) {}
try {
  const r = readJSON("reviews.json");
  T.applyRemoteReviews(Array.isArray(r) ? r : r.items);
} catch (e) {}

// 事件：規則引擎 + events.json + curated.json，疊法與網站相同
try { T.mergeRemote(readJSON("events.json").events || []); } catch (e) {}
try {
  const c = readJSON("curated.json");
  T.mergeRemote(Array.isArray(c) ? c : c.items || []);
} catch (e) {}
const EVENTS = T.getEVENTS();

/* ── QQQ 日報酬與前 20 日已實現波動 ── */
const qq = px.series && px.series.QQQ;
if (!qq) { console.error("px.json 裡沒有 QQQ"); process.exit(1); }
const days = Object.keys(qq).sort();
const idx = new Map(days.map((d, i) => [d, i]));
const ret = {};     // 交易日 → 當日 % 報酬
const sd20 = {};    // 交易日 → 前 20 日（不含當日）已實現日波動
for (let i = 1; i < days.length; i++) {
  ret[days[i]] = (qq[days[i]] / qq[days[i - 1]] - 1) * 100;
}
for (let i = 21; i < days.length; i++) {
  const w = [];
  for (let j = i - 20; j < i; j++) w.push(ret[days[j]]);
  const mu = w.reduce((a, b) => a + b, 0) / w.length;
  sd20[days[i]] = Math.sqrt(w.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (w.length - 1));
}

/* 事件被哪個美股交易日吸收。盤後（AMC / 美東 16:00 之後）打到下一個交易日。
   事件日本身不是交易日（週末、假日）時，往後找最近的交易日——
   週六公布的東西是下週一吸收，不是憑空消失。 */
function absorbDay(e) {
  const after = T.session(e).us === "美股隔一交易日";
  let i = idx.has(e.date) ? idx.get(e.date) : days.findIndex((d) => d > e.date);
  if (i < 0) return null;
  if (after && idx.has(e.date)) i += 1;
  return days[i] || null;
}

/* ── 樣本 ── */
const today = new Date(); today.setHours(0, 0, 0, 0);
const todayISO = today.getFullYear() + "-" +
  String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
const first = days[21];   // 前 20 日波動算得出來的第一天

const rows = [];
EVENTS.forEach((e) => {
  if (!e.date || e.date >= todayISO) return;
  const d = absorbDay(e);
  if (!d || d < first || !(d in ret) || !(d in sd20) || !(sd20[d] > 0)) return;
  const sc = T.score(e);
  rows.push({
    date: e.date, day: d, cat: e.cat, title: e.title,
    s: sc.s, gap: sc.gap,
    move: ret[d], z: Math.abs(ret[d]) / sd20[d],
  });
});

/* ── Spearman rank IC ── */
function ranks(v) {
  const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length);
  let i = 0;
  while (i < o.length) {                       // 同分給平均名次，不然整串同分會偏掉
    let j = i;
    while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[o[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(x, y) {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2;
  }
  return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null;
}
const rankIC = (xs, ys) => pearson(ranks(xs), ranks(ys));
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/* 十分位：照分數由低到高切十份，看每一格的平均 z。
   有預測力的話這一欄應該是往上爬的，而且第十格明顯高於第一格。 */
function deciles(list, key) {
  const sorted = [...list].sort((a, b) => a[key] - b[key]);
  const out = [];
  for (let k = 0; k < 10; k++) {
    const a = Math.floor(k * sorted.length / 10), b = Math.floor((k + 1) * sorted.length / 10);
    const seg = sorted.slice(a, b);
    if (!seg.length) continue;
    out.push({
      d: k + 1, n: seg.length,
      sLo: seg[0][key], sHi: seg[seg.length - 1][key],
      z: r2(seg.reduce((x, y) => x + y.z, 0) / seg.length),
      absPct: r2(seg.reduce((x, y) => x + Math.abs(y.move), 0) / seg.length),
    });
  }
  return out;
}

/* 日層級：同一天有多個事件時，單一事件的實際變動本來就分不乾淨，
   所以另外用 dayScore（平方和開根號）對同一天的 z 算一次。
   這一個數字比事件層級乾淨，事件層級的那個天生偏低。 */
const byDay = new Map();
EVENTS.forEach((e) => {
  if (!e.date || e.date >= todayISO) return;
  const d = absorbDay(e);
  if (!d || d < first || !(d in ret) || !(d in sd20) || !(sd20[d] > 0)) return;
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d).push(e);
});
const dayRows = [...byDay.entries()].map(([d, list]) => ({
  day: d, n: list.length, s: T.dayScore(list), z: Math.abs(ret[d]) / sd20[d],
})).sort((a, b) => (a.day < b.day ? -1 : 1));

/* 分類型的平均分數與平均 z。兩欄擺在一起才看得出模型錯在哪裡：
   排序沒有預測力的時候，IC 這個單一數字只會說「沒用」，說不出是哪一類被高估或低估。 */
const byCat = {};
rows.forEach((r) => {
  if (!byCat[r.cat]) byCat[r.cat] = { n: 0, z: 0, s: 0 };
  byCat[r.cat].n++; byCat[r.cat].z += r.z; byCat[r.cat].s += r.s;
});
const cats = Object.entries(byCat)
  .map(([k, v]) => ({ cat: k, n: v.n, s: Math.round(v.s / v.n), z: r2(v.z / v.n) }))
  .sort((a, b) => b.s - a.s);

/* 對照組：事件日跟沒有事件的日子比起來，到底有沒有比較會動。
   這一個數字比 IC 更早該問——如果兩邊一樣，那不是「排序不準」，是「事件日這個概念本身沒有篩出東西」。 */
const tradable = days.slice(21);
const zOf = (d) => Math.abs(ret[d]) / sd20[d];
const evDays = new Set(dayRows.map((r) => r.day));
const nonEv = tradable.filter((d) => !evDays.has(d));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const baseline = {
  allDays: { n: tradable.length, z: r2(avg(tradable.map(zOf))) },
  eventDays: { n: evDays.size, z: r2(avg([...evDays].map(zOf))) },
  quietDays: { n: nonEv.length, z: r2(avg(nonEv.map(zOf))) },
};

const icS = rankIC(rows.map((r) => r.s), rows.map((r) => r.z));
const icGap = rankIC(rows.map((r) => r.gap), rows.map((r) => r.z));
const icDay = rankIC(dayRows.map((r) => r.s), dayRows.map((r) => r.z));
const dS = deciles(rows, "s");
const spread = (dS.length === 10) ? r2(dS[9].z - dS[0].z) : null;

const out = {
  generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  asof: todayISO,
  window: { from: days[21], to: days[days.length - 1] },
  n: rows.length,
  nDays: dayRows.length,
  benchmark: "QQQ",
  ic: { score: r3(icS), gap: r3(icGap), day: r3(icDay) },
  spread,
  baseline,
  deciles: dS,
  cats,
  method:
    "分數用 index.html 自己的 score()（不另外實作）。每一筆事件配到它被吸收的美股交易日" +
    "（用 index.html 的 session()，盤後事件打到隔一個交易日），實際變動取該日 QQQ 絕對報酬" +
    "除以前 20 個交易日的已實現日波動換算成 z。ic.score／ic.gap 是事件層級的 Spearman rank IC，" +
    "ic.day 是把同一天的事件用 dayScore 合起來之後再算一次——同一天多個事件時實際變動分不乾淨，" +
    "所以事件層級的 IC 天生偏低，日層級那個比較乾淨。",
  caveats: [
    "樣本內：過去的事件是用「今天的環境設定」重新計分的，不是當時的環境。這回答的是「這組分數排得準不準」，不是「當時照它做會賺多少」。",
    "px.json 只有兩年，低頻事件（期中選舉、年度基準修正）樣本數是個位數甚至 0，分類型的數字不要單獨拿來改參數。",
    "只量幅度不量方向：z 取的是絕對值。衝擊分數本來就只說「會不會動」，不說往哪邊動。",
    "推算日（est）的事件帶著 0.94 的折扣進來，校準係數用的是當下 reviews.json 的狀態。這兩項變動時要重跑。",
    "分母污染：z 除的是前 20 個交易日的已實現波動，而日曆上超過半數的交易日本來就有事件（初領失業金每週一筆），所以分母裡面本來就含著事件日的波動。這會把 IC 往 0 壓，不會憑空造出分類型之間的差距。",
    "只看 QQQ。分母端事件對 10Y 與黃金的作用可能大得多，卻完全不會出現在這個數字裡——IC 低不等於事件沒有作用，只代表它沒有反映在那斯達克的當日幅度上。",
  ],
};

if (DRY) {
  console.log(JSON.stringify(out, null, 1));
} else {
  const p = path.join(ROOT, "data", "backtest.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 1) + "\n");
  console.log("寫入 data/backtest.json");
}
console.log(`樣本 ${out.n} 筆事件 / ${out.nDays} 個交易日（${out.window.from} → ${out.window.to}）`);
console.log(`rank IC  事件層級 分數 ${out.ic.score}  落差 ${out.ic.gap}  ｜ 日層級 ${out.ic.day}`);
console.log(`十分位 平均 z：` + dS.map((d) => d.d + ":" + d.z).join("  "));
console.log(`第十分位 − 第一分位 = ${out.spread} 個標準差`);
