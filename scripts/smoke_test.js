#!/usr/bin/env node
/*
 * 行為煙霧測試。node --check 只看得出語法錯誤，看不出「分數算錯」「時區換算反了」
 * 「新增的事件類型忘了補進 CAT」這種會靜默壞掉的東西。
 *
 * 這支把 index.html 裡的整段 script 抽出來，用最小的 DOM stub 在 Node 裡跑起來，
 * 然後對純函式下斷言。CI 在部署之前會跑，routine 改完程式也必須跑。
 *
 *   node scripts/smoke_test.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.dirname(__dirname);
let pass = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? "：" + detail : ""));
}
function eq(name, got, want) {
  ok(name, got === want, "得到 " + JSON.stringify(got) + "，預期 " + JSON.stringify(want));
}

/* ── 最小 DOM stub：只要讓整段 script 跑得完就好 ── */
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
  requestAnimationFrame(fn) { return 0; },
  fetch() { return Promise.reject(new Error("smoke test 不連網")); },
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

const EXPORT = "\n;globalThis.__T={CAT:CAT,PXD0:PXD0,TOD:TOD,REGIME_DEF:REGIME_DEF,R:R," +
  "EVENTS:EVENTS,score:score,session:session,dayScore:dayScore,monthPct:monthPct," +
  "isEDT:isEDT,iso:iso,parse:parse,clamp:clamp,expectOf:expectOf," +
  "pxDelta:pxDelta,pxFmt:pxFmt,applyPx:applyPx,selectPx:selectPx," +
  "getPxSel:function(){return PXSEL;},getPxUnit:function(){return PXUNIT;}," +
  "metricsOf:metricsOf,withUnit:withUnit,flowHTML:flowHTML,chainHTML:chainHTML," +
  "readingHTML:readingHTML,mergeRemote:mergeRemote," +
  "getEVENTS:function(){return EVENTS;},setEVENTS:function(o){EVENTS=o;}," +
  "setPX:function(o){PX=o;},setREVIEW:function(o){REVIEW=o;},"+
  "ASSETS:ASSETS,applyBetas:applyBetas,assetImpact:assetImpact," +
  "esc:esc,viewsHTML:viewsHTML,getREVIEW:function(){return REVIEW;}," +
  "ageDays:ageDays,STALE:STALE," +
  "getBETAS:function(){return BETAS;}};\n";

try {
  vm.createContext(sandbox);
  vm.runInContext(m[1] + EXPORT, sandbox, { filename: "index.html<script>", timeout: 20000 });
} catch (e) {
  console.error("script 執行失敗：" + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : e));
  process.exit(1);
}
const T = sandbox.__T;
if (!T) { console.error("拿不到匯出的函式，EXPORT 那段可能對不上實作"); process.exit(1); }

/* ── 1. 設定表一致性：三張表的鍵必須完全對得上 ── */
const catKeys = Object.keys(T.CAT).sort();
Object.keys(T.PXD0).forEach((k) =>
  ok("PXD0 的 " + k + " 在 CAT 裡", k in T.CAT));
Object.keys(T.TOD).forEach((k) =>
  ok("TOD 的 " + k + " 在 CAT 裡", k in T.CAT));
catKeys.forEach((k) => {
  ok("CAT 的 " + k + " 有 PXD0 先驗", k in T.PXD0);
  ok("CAT 的 " + k + " 有 TOD 預設時間", k in T.TOD);
  const c = T.CAT[k];
  ok("CAT 的 " + k + " 有 B", typeof c.B === "number" && c.B > 0 && c.B <= 100);
  ok("CAT 的 " + k + " 有 label", !!c.label);
  ok("CAT 的 " + k + " 有五條管道", c.ch &&
    ["front", "real", "be", "erp", "eps"].every((x) => typeof c.ch[x] === "number"));
});

/* ── 2. 規則引擎產生的事件，每一筆的 cat 都必須在 CAT 裡 ── */
const unknown = new Set();
T.EVENTS.forEach((e) => { if (!(e.cat in T.CAT)) unknown.add(e.cat); });
ok("規則引擎沒有產生未知的 cat", unknown.size === 0, [...unknown].join(", "));
ok("規則引擎有產生事件", T.EVENTS.length > 100, "只有 " + T.EVENTS.length + " 筆");
ok("每一筆都有合法的 kind", T.EVENTS.every((e) => ["N", "D", "R"].includes(e.kind)));
ok("每一筆都有 t", T.EVENTS.every((e) => !!e.t));

/* ── 3. 評分：邊界與單調性 ── */
catKeys.forEach((k) => {
  const e = { date: T.iso(new Date()), kind: "D", cat: k, est: false, title: "t" };
  const s = T.score(e);
  ok(k + " 分數在 0~99", s.s >= 0 && s.s <= 99, String(s.s));
  ok(k + " 落差不超過分數", s.gap >= 0 && s.gap <= s.s, s.gap + " vs " + s.s);
  ok(k + " pxd 在 0~1", s.pxd >= 0 && s.pxd <= 1, String(s.pxd));
});
{
  const base = { date: T.iso(new Date()), kind: "D", cat: "cpi", est: false, title: "t" };
  const full = T.score(Object.assign({}, base, { pxd: 0 }));
  const half = T.score(Object.assign({}, base, { pxd: 0.5 }));
  const none = T.score(Object.assign({}, base, { pxd: 1 }));
  eq("pxd=0 時落差等於分數", full.gap, full.s);
  eq("pxd=1 時落差為 0", none.gap, 0);
  ok("pxd 越高落差越小", full.gap > half.gap && half.gap > none.gap);
  ok("pxd 不影響衝擊分數", full.s === half.s && half.s === none.s);
}

/* ── 4. 時區與交易時段：夏令與冬令要換算對 ── */
{
  const jul = T.session({ date: "2026-07-15", cat: "cpi", t: "08:30" });
  eq("夏令 08:30 ET → 台北 20:30", jul.tpe, "台北 20:30");
  eq("夏令 08:30 是盤前", jul.us, "美股當日盤前");
  const jan = T.session({ date: "2026-01-14", cat: "cpi", t: "08:30" });
  eq("冬令 08:30 ET → 台北 21:30", jan.tpe, "台北 21:30");
  const amc = T.session({ date: "2026-07-15", cat: "earn3", t: "AMC" });
  ok("AMC 會跨到隔天", amc.roll === true && amc.tpe.indexOf("隔日") > 0, amc.tpe);
  eq("AMC 打到美股隔一交易日", amc.us, "美股隔一交易日");
  const bmo = T.session({ date: "2026-07-15", cat: "earn2", t: "BMO" });
  eq("BMO 是盤前", bmo.us, "美股當日盤前");
  const tw = T.session({ date: "2026-07-10", cat: "twrev", t: "TW" });
  eq("TW 是台股當日盤後", tw.tw, "台股當日盤後");
  const boj = T.session({ date: "2026-09-18", cat: "boj", t: "TPE:11:30" });
  eq("TPE:11:30 顯示台北時間", boj.tpe, "台北 11:30");
  eq("TPE:11:30 落在台股盤中", boj.tw, "台股當日盤中");
  const late = T.session({ date: "2026-09-18", cat: "boj", t: "TPE:14:00" });
  eq("TPE:14:00 落在台股盤後", late.tw, "台股當日盤後");
  ok("三月夏令起點之後算 EDT", T.isEDT("2026-03-20"));
  ok("一月算 EST", !T.isEDT("2026-01-20"));
}

/* ── 5. 同日聚合：次可加且有界 ── */
{
  const d = T.iso(new Date());
  const mk = (cat) => ({ date: d, kind: "D", cat: cat, est: false, title: cat });
  const one = T.dayScore([mk("cpi")]);
  const two = T.dayScore([mk("cpi"), mk("fomc_sep")]);
  const many = T.dayScore([mk("cpi"), mk("fomc_sep"), mk("nfp"), mk("ppi"), mk("ism")]);
  eq("單一事件等於它自己的分數", one, T.score(mk("cpi")).s);
  ok("多事件大於單一最大值", two > Math.max(one, T.score(mk("fomc_sep")).s) - 1);
  ok("多事件仍然次可加", two < one + T.score(mk("fomc_sep")).s);
  ok("永遠不超過 99", many <= 99, String(many));
  eq("空陣列回 0", T.dayScore([]), 0);
}

/* ── 6. 當月漲跌：對照手算 ── */
{
  T.setPX({ "2026-03-30": 100, "2026-03-31": 200, "2026-04-15": 210, "2026-04-30": 250 });
  const p = T.monthPct(2026, 3);
  ok("4 月漲跌 = 250/200-1 = 25%", Math.abs(p - 25) < 1e-9, String(p));
  ok("沒有資料的月份回 null", T.monthPct(2026, 10) === null);
  T.setPX({});
}

/* ── 7. 共識 vs 實際的意外判定 ── */
{
  const ev = { date: "2026-08-12", title: "CPI", cat: "cpi", kind: "D" };
  const set = (r) => T.setREVIEW(r ? { "2026-08-12|CPI": r } : {});

  set({ cons: "0.2", act: "0.4", z: "2.1" });
  let x = T.expectOf(ev);
  eq("z 明顯為正 → 高於預期", x.verdict, "高於預期");
  eq("方向為 +1", x.dir, 1);

  set({ cons: "83", act: "-23", z: "-1.9" });
  x = T.expectOf(ev);
  eq("z 明顯為負 → 低於預期", x.verdict, "低於預期");
  eq("方向為 -1", x.dir, -1);

  set({ cons: "0.2", act: "0.21", z: "0.2" });
  x = T.expectOf(ev);
  eq("z 在 ±0.5 之內 → 符合預期", x.verdict, "符合預期");
  eq("方向為 0", x.dir, 0);

  set({ cons: "100", act: "110" });            // 沒有 z，退回直接比
  x = T.expectOf(ev);
  eq("沒有 z 時比相對差距 → 高於預期", x.verdict, "高於預期");
  set({ cons: "100", act: "101" });
  x = T.expectOf(ev);
  eq("相對差距小於 5% → 符合預期", T.expectOf(ev).verdict, "符合預期");

  set(null);
  x = T.expectOf(ev);
  eq("沒有任何資料就不下判定", x.verdict, "");
  ok("沒有資料時 hasAct 為 false", x.hasAct === false);
}

/* ── 8. 多標的背景走勢：單位換算不能弄錯 ── */
{
  T.applyPx({
    default: "QQQ",
    symbols: [{ k: "QQQ", n: "那斯達克 100", unit: "pct" },
              { k: "^TNX", n: "美 10 年期殖利率", unit: "bp" }],
    series: {
      QQQ: { "2026-01-02": 100, "2026-01-30": 110 },
      "^TNX": { "2026-01-02": 4.00, "2026-01-30": 4.66 },
    },
  });
  eq("預設選 QQQ", T.getPxSel(), "QQQ");
  eq("QQQ 是價格單位", T.getPxUnit(), "pct");
  ok("價格用百分比：100→110 是 +10%", Math.abs(T.pxDelta(110, 100) - 10) < 1e-9);
  eq("價格格式化帶 %", T.pxFmt(10), "+10.0%");

  T.selectPx("^TNX");
  eq("切到殖利率", T.getPxUnit(), "bp");
  ok("殖利率用 bp：4.00→4.66 是 +66bp", Math.abs(T.pxDelta(4.66, 4.00) - 66) < 1e-6,
     String(T.pxDelta(4.66, 4.0)));
  eq("殖利率格式化帶 bp", T.pxFmt(66), "+66bp");
  ok("殖利率不會被算成 +16.5%", T.pxFmt(T.pxDelta(4.66, 4.0)).indexOf("%") < 0);

  // 舊的單一序列格式要能繼續讀
  T.applyPx({ symbol: "QQQ · Yahoo", series: { "2026-01-02": 100, "2026-01-30": 110 } });
  eq("舊格式退回單一序列", T.getPxSel(), "QQQ");
  eq("舊格式預設為價格單位", T.getPxUnit(), "pct");
}

/* ── 9. 多指標（財報的 EPS 與營收）與抽屜三個區塊 ── */
{
  const ev = { date: "2026-08-26", title: "NVDA 財報", cat: "earn3", kind: "N", est: false,
    metrics: [{ n: "EPS", cons: "1.20", unit: "USD" },
              { n: "營收", cons: "46.5", unit: "B" }] };
  T.setREVIEW({ "2026-08-26|NVDA 財報": { cons: "1.20", act: "1.31", z: "1.8",
    metrics: [{ n: "EPS", act: "1.31" }, { n: "營收", act: "46.6" }] } });
  const mm = T.metricsOf(ev);
  eq("兩個指標都併起來", mm.length, 2);
  eq("EPS 有共識", mm[0].cons, "1.20");
  eq("EPS 有實際", mm[0].act, "1.31");
  eq("EPS 優於預期", mm[0].dir, 1);
  eq("營收 46.5→46.6 只差 0.2%，算符合", mm[1].dir, 0);

  eq("字母單位要空一格", T.withUnit("1.20", "USD"), "1.20 USD");
  eq("符號單位不空格", T.withUnit("0.2", "%"), "0.2%");
  eq("沒有單位就原樣", T.withUnit("5", ""), "5");
  eq("沒有值就空字串", T.withUnit("", "USD"), "");

  const flow = T.flowHTML(ev);
  ok("走向圖有畫出來", flow.indexOf("高於預期") > 0 && flow.indexOf("低於預期") > 0);
  ok("走向圖不引外部函式庫", flow.indexOf("<script") < 0 && flow.indexOf("http") < 0);
  const chain = T.chainHTML(ev);
  ok("傳導鏈有列出算式", chain.indexOf("事件推力") > 0 && chain.indexOf("加總") > 0);
  const reading = T.readingHTML(ev);
  ok("讀法有附免責", reading.indexOf("不是進出場建議") > 0);
  T.setREVIEW({});
}

/* ── 10. curated 是更正層：同名同日要蓋得掉，不能被丟掉 ── */
{
  const base = T.getEVENTS();
  T.setEVENTS([{ date: "2026-09-18", title: "日本央行利率決議", kind: "D", cat: "boj",
    t: "TW", est: false, note: "舊的", checks: [], src: "events.json" }]);
  T.mergeRemote([{ date: "2026-09-18", title: "日本央行利率決議", kind: "D", cat: "boj",
    t: "TPE:11:30", est: false, note: "更正過的", src: "curated.json" }]);
  const after = T.getEVENTS().filter((e) => e.title === "日本央行利率決議");
  eq("同名同日不會變成兩筆", after.length, 1);
  eq("curated 的 t 蓋掉舊的", after[0].t, "TPE:11:30");
  eq("curated 的 note 也蓋掉", after[0].note, "更正過的");
  eq("蓋掉之後台股算成盤中", T.session(after[0]).tw, "台股當日盤中");
  T.setEVENTS(base);
}

/* ── 10b. 日期更正：±10 天內的同名事件要被「取代」，不是多長出一筆 ──
   財報錨定日是 anchor+91 天推出來的，標成 est=false 但常跟公司公告差幾天
   （AVGO 推算 9/10、官方公告 9/2）。這種更正如果只是新增一筆，日曆上會同名兩筆，
   當日分數還被重複計算。以下四條把「誰蓋得掉誰」釘住。 */
{
  const base = T.getEVENTS();
  const E = (date, est, extra) => Object.assign(
    { date, title: "測試 財報", kind: "N", cat: "earn2", t: "AMC", est,
      note: "", checks: [], src: "" }, extra || {});

  // (1) 已確認的推算日，被另一個已確認的日期更正 → 取代，不是並存
  T.setEVENTS([E("2026-09-10", false, { note: "推算的" })]);
  T.mergeRemote([E("2026-09-02", false, { note: "官方公告的" })]);
  let after = T.getEVENTS().filter((e) => e.title === "測試 財報");
  eq("確認日被確認的更正取代後只剩一筆", after.length, 1);
  eq("留下來的是更正後的日期", after[0].date, "2026-09-02");
  eq("更正的 note 也跟著進來", after[0].note, "官方公告的");

  // (2) 反向：est 的猜測日蓋不掉已確認的日期
  T.setEVENTS([E("2026-09-10", false, { note: "官方確認的" })]);
  T.mergeRemote([E("2026-09-02", true, { note: "猜的" })]);
  after = T.getEVENTS().filter((e) => e.title === "測試 財報").sort(
    (a, b) => a.date.localeCompare(b.date));
  eq("猜測日不會取代已確認的日期", after.length, 2);
  ok("已確認的那筆還在", after.some((e) => e.date === "2026-09-10" && !e.est));

  // (3) 週期性重複的同名事件：只下架最接近的一筆，隔壁幾週不能被連坐
  T.setEVENTS([E("2026-09-03", true), E("2026-09-10", true), E("2026-09-17", true)]);
  T.mergeRemote([E("2026-09-11", false)]);
  after = T.getEVENTS().filter((e) => e.title === "測試 財報").map((e) => e.date).sort();
  eq("只取代最接近的那一筆", after.join(","), "2026-09-03,2026-09-11,2026-09-17");

  // (4) 已經過去的事件是歷史紀錄，更正不去動它
  T.setEVENTS([E("2026-01-05", true, { note: "去年初的" })]);
  T.mergeRemote([E("2026-01-08", false, { note: "更正" })]);
  after = T.getEVENTS().filter((e) => e.title === "測試 財報");
  eq("過去的事件不會被更正掉", after.length, 2);

  T.setEVENTS(base);
}

/* ── 11. 版本字串：index.html 的 APP_VER 必須跟 sw.js 的 CACHE 一致 ── */
{
  const swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const swVer = (swSrc.match(/CACHE\s*=\s*"([^"]+)"/) || [])[1];
  const appVer = (html.match(/const APP_VER\s*=\s*"([^"]+)"/) || [])[1];
  ok("sw.js 有 CACHE 版本字串", !!swVer, String(swVer));
  ok("index.html 有 APP_VER", !!appVer, String(appVer));
  eq("APP_VER 與 sw.js 的 CACHE 一致", appVer, swVer);
}

/* ── 12. 滾動曝險係數 applyBetas：估不準的時候一定要退回先驗 ── */
{
  const snap = () => JSON.stringify(T.ASSETS.map((a) => a.b));
  const A = (k) => T.ASSETS.find((a) => a.k === k);
  const pri = (k) => JSON.stringify(A(k).b);

  T.applyBetas(null);
  const prior = snap();
  const priorNdx = pri("ndx"), priorFin = pri("fin"), priorHyg = pri("hyg"), priorGld = pri("gld");
  const priorHygErp = A("hyg").b.erp, priorGldFront = A("gld").b.front;
  ok("ASSETS 有先驗係數", T.ASSETS.length > 0, String(T.ASSETS.length));

  // betas.json 拓不到（fetch 失敗、或檔案還沒生出來）時必須完整退回先驗
  eq("betas.json 拓不到時係數維持先驗", snap(), prior);
  ok("betas.json 拓不到時沒有資產標成估計", T.ASSETS.every((a) => !a.est));

  // 通過門檻：四個管道換成實測值
  T.applyBetas({
    asof: "2026-08-31", window: 60,
    assets: { ndx: { front: 0.06, real: -0.43, be: -0.22, erp: -0.44, r2: 0.24, n: 60 } },
  });
  eq("通過門檻的資產換成實測 real", A("ndx").b.real, -0.43);
  eq("通過門檻的資產換成實測 erp", A("ndx").b.erp, -0.44);
  ok("通過門檻的資產標成估計", !!A("ndx").est);
  eq("估計標記帶出 R2", A("ndx").est.r2, 0.24);
  ok("eps 永遠不在估計清單裡（沒有日頻代理變數）",
    T.ASSETS.every((a) => !a.est || !a.est.ch.includes("eps")));
  eq("沒出現在 betas.json 裡的資產維持先驗", pri("gld"), priorGld);

  // weak：解釋力不足的整組退回先驗，一個管道都不准採用
  T.applyBetas({
    assets: { fin: { front: 0.9, real: -0.9, be: 0.9, erp: -0.9, r2: 0.05, n: 60, weak: true } },
  });
  eq("weak 的資產整組退回先驗", pri("fin"), priorFin);
  ok("weak 的資產不標成估計", !A("fin").est);
  eq("上一輪估過的資產在這一輪沒資料時退回先驗", pri("ndx"), priorNdx);
  ok("上一輪的估計標記也要清掉", !A("ndx").est);

  // circular：機械共線的那個管道跳過，其餘照用
  T.applyBetas({
    assets: { hyg: { front: -0.08, real: -0.78, be: -0.32, erp: -0.36, r2: 0.63, n: 60,
                     circular: ["erp"] } },
  });
  eq("circular 的管道退回先驗", A("hyg").b.erp, priorHygErp);
  eq("同一筆的其他管道照樣採用", A("hyg").b.real, -0.78);
  ok("circular 的管道不列進估計清單", !A("hyg").est.ch.includes("erp"),
    JSON.stringify(A("hyg").est.ch));

  // 髒資料不准進來：字串、null、NaN 都當作沒給
  T.applyBetas({ assets: { ndx: { real: "很負", be: null, erp: NaN, front: 0.11,
                                  r2: 0.3, n: 60 } } });
  eq("字串的係數被忽略", A("ndx").b.real, JSON.parse(priorNdx).real);
  eq("NaN 的係數被忽略", A("ndx").b.erp, JSON.parse(priorNdx).erp);
  eq("同一筆裡合法的那個還是要採用", A("ndx").b.front, 0.11);

  // 只給一個管道的時候，其餘維持先驗
  T.applyBetas({ assets: { gld: { real: -0.23, r2: 0.12, n: 60 } } });
  eq("只換有給的那一個", A("gld").b.real, -0.23);
  eq("沒給的欄位維持先驗", A("gld").b.front, priorGldFront);

  // lagged 標記要傳到前端（亞洲時段用落後一日的美國因子）
  T.applyBetas({ assets: { twse: { real: -0.26, erp: -0.33, r2: 0.12, n: 60, lagged: true } } });
  ok("lagged 標記傳到前端", A("twse").est.lagged === true);

  // 換了曝險係數之後，傳導鏈的數字要跟著變，不然估了也沒用
  T.applyBetas(null);
  const ev = { date: "2026-09-10", title: "CPI", cat: "cpi", kind: "D" };
  const impPri = T.assetImpact(ev).out.ndx;
  T.applyBetas({ assets: { ndx: { front: 0.06, real: -2.0, be: -0.22, erp: -0.44,
                                  r2: 0.24, n: 60 } } });
  const impEst = T.assetImpact(ev).out.ndx;
  ok("換了曝險係數之後，資產衝擊跟著變",
    Math.abs(impEst - impPri) > 1e-9, impPri + " -> " + impEst);

  T.applyBetas(null);
  eq("測試結束後回到先驗", snap(), prior);
}

/* ── 13. 雲端字串一律跳脫：routine 抄回來的搜尋摘要不可以變成可執行的標記 ── */
{
  const MAL = String.fromCharCode(60) + "img src=x onerror=alert(1)" + String.fromCharCode(62);
  const LT = String.fromCharCode(60);

  ok("esc 把角括號換掉", T.esc(MAL).indexOf(LT) === -1, T.esc(MAL));
  ok("esc 把雙引號換掉", T.esc('a"b').indexOf('"') === -1, T.esc('a"b'));
  ok("esc 把單引號換掉", T.esc("a'b").indexOf("'") === -1, T.esc("a'b"));
  eq("esc 先處理 & 才不會二次轉義", T.esc("&lt;"), "&amp;lt;");
  eq("esc 對 null 回空字串", T.esc(null), "");

  // views 與 driver 是複盤 routine 從搜尋結果整理出來的，最不可信的一段
  const ev = { date: "2026-01-05", title: "測試事件", cat: "cpi", kind: "D" };
  const REV = T.getREVIEW();
  const key = ev.date + "|" + ev.title;
  const keep = REV[key];
  REV[key] = { driver: MAL, views: [{ tone: "鷹", t: MAL, who: MAL, src: MAL }] };
  const vh = T.viewsHTML(ev);
  ok("views 有渲染出來", vh.length > 0);
  ok("driver 裡的標記被跳脫", vh.indexOf(LT + "img") === -1);
  ok("views 內文與出處都被跳脫（三處都不留原始標記）",
    vh.split(LT + "img").length === 1 && vh.split("&lt;img").length >= 5,
    vh.slice(0, 240));
  if (keep === undefined) delete REV[key]; else REV[key] = keep;

  // 事件標題本身也可能被寫壞（curated.json 是 routine 寫的）
  const bad = { date: "2026-01-05", title: MAL, cat: "cpi", kind: "D" };
  const fh = T.flowHTML(bad);
  ok("事件標題裡的標記被跳脫", fh.indexOf(LT + "img") === -1, fh.slice(0, 160));
  ok("readingHTML 不吐出未跳脫的標記",
    T.readingHTML(bad).indexOf(LT + "img") === -1);
}

/* ── 14. 更正層：確認同一天不算改期，不可以連坐刪掉隔壁那一週 ── */
{
  const base = T.getEVENTS();
  const W = (d) => ({ date: d, kind: "D", title: "初領失業金", cat: "claims",
                      est: true, note: "", checks: [], t: "08:30" });
  const weeks = ["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"];
  const dates = () => T.getEVENTS().filter((e) => e.title === "初領失業金")
    .map((e) => e.date).sort().join(",");

  // (1) routine 只是把某一週標成已確認，日期沒變
  T.setEVENTS(weeks.map(W));
  T.mergeRemote([{ date: "2026-09-10", kind: "D", title: "初領失業金", cat: "claims",
                   est: false, note: "官方確認" }]);
  eq("確認同一天不會刪掉隔壁那一週", dates(), weeks.join(","));
  ok("確認的那一筆不再是推算日",
    T.getEVENTS().filter((e) => e.date === "2026-09-10")[0].est === false);

  // (2) 一次確認整串，也不能互相刪
  T.setEVENTS(weeks.map(W));
  T.mergeRemote(weeks.map((d) => Object.assign(W(d), { est: false })));
  eq("整串一起確認也不會互相刪", dates(), weeks.join(","));

  // (3) 真的改期時，還是要下架最接近的舊日期
  T.setEVENTS(weeks.map(W));
  T.mergeRemote([{ date: "2026-09-11", kind: "D", title: "初領失業金", cat: "claims",
                   est: false, note: "官方延後一天" }]);
  eq("真的改期時舊日期要下架",
    dates(), "2026-09-03,2026-09-11,2026-09-17,2026-09-24");

  // (4) 改期的目標日剛好是另一週時，那一週不可以被當成舊日期刪掉
  T.setEVENTS(weeks.map(W));
  T.mergeRemote([{ date: "2026-09-17", kind: "D", title: "初領失業金", cat: "claims",
                   est: false, note: "更正" },
                 { date: "2026-09-24", kind: "D", title: "初領失業金", cat: "claims",
                   est: false, note: "更正" }]);
  eq("更正層自己列的日期不會被當成舊日期", dates(), weeks.join(","));

  T.setEVENTS(base);
}

/* ── 15. 資料新鮮度：排程掛掉的時候，資料頁要自己講出來 ── */
{
  const iso = T.iso;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const back = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d); };

  eq("今天寫的檔案算 0 天", T.ageDays(back(0)), 0);
  eq("昨天寫的算 1 天", T.ageDays(back(1)), 1);
  eq("帶時間戳的也讀得出來", T.ageDays(back(3) + "T04:05:06Z"), 3);
  eq("沒有 generated 就不判斷新鮮度", T.ageDays(""), null);
  eq("格式不對也不判斷", T.ageDays("上週"), null);
  eq("undefined 不會爆", T.ageDays(undefined), null);

  // 門檻本身：每天寫的檔案不能設得比每週寫的還鬆
  ok("每日檔案的門檻比每週的嚴",
    T.STALE["events.json"] < T.STALE["regime.json"],
    T.STALE["events.json"] + " vs " + T.STALE["regime.json"]);
  ok("不定期的檔案不判斷新鮮度（複盤不是每天都有事件）",
    T.STALE["reviews.json"] === null && T.STALE["curated.json"] === null);
  // 每一個 STALE 的 key 都要真的是 loadRemote 會抓的檔案，不然設了也沒用
  const FILES = ["events.json", "curated.json", "px.json", "priced.json",
                 "reviews.json", "betas.json", "regime.json", "changelog.json"];
  eq("STALE 涵蓋所有雲端檔案",
    FILES.filter((f) => !(f in T.STALE)).join(","), "");
  eq("STALE 沒有多餘的 key",
    Object.keys(T.STALE).filter((f) => FILES.indexOf(f) < 0).join(","), "");
}

/* ── 報告 ── */
console.log("");
if (fails.length) {
  fails.forEach((f) => console.error("  失敗  " + f));
  console.error("\n煙霧測試失敗：" + fails.length + " 項不通過、" + pass + " 項通過。不要 commit。");
  process.exit(1);
}
console.log("煙霧測試通過：" + pass + " 項。");
