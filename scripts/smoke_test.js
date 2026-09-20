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
  "ageDays:ageDays,STALE:STALE,applyPolicy:applyPolicy,policyHTML:policyHTML," +
  "policyLine:policyLine,polOdds:polOdds,POLCAT:POLCAT,checksOf:checksOf," +
  "polMoveBp:polMoveBp,verdict:verdict,reviewForm:reviewForm,reactionMag:reactionMag," +
  "backtestHTML:backtestHTML,icVerdict:icVerdict," +
  "polSurprise:polSurprise,spcHTML:spcHTML,polMoves:polMoves,SPC:SPC," +
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

/* 日期夾具一律相對於「今天」算，不要寫死。
   mergeRemote 對已經過去的事件是不動的（那是歷史紀錄），所以寫死的日期只要被
   今天追過，整組夾具就會靜靜失真：2026-09-11 那天起，下面 10b 與 14 的固定日期
   全部落到過去，三條斷言一起紅——程式沒壞，是測試自己爛掉。
   這種「某天開始就會紅」的測試比沒有測試更糟：它會擋住部署，而且看起來像真的壞了。 */
const D = (n) => {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
    "-" + String(d.getDate()).padStart(2, "0");
};

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
  T.setEVENTS([E(D(14), false, { note: "推算的" })]);
  T.mergeRemote([E(D(6), false, { note: "官方公告的" })]);
  let after = T.getEVENTS().filter((e) => e.title === "測試 財報");
  eq("確認日被確認的更正取代後只剩一筆", after.length, 1);
  eq("留下來的是更正後的日期", after[0].date, D(6));
  eq("更正的 note 也跟著進來", after[0].note, "官方公告的");

  // (2) 反向：est 的猜測日蓋不掉已確認的日期
  T.setEVENTS([E(D(14), false, { note: "官方確認的" })]);
  T.mergeRemote([E(D(6), true, { note: "猜的" })]);
  after = T.getEVENTS().filter((e) => e.title === "測試 財報").sort(
    (a, b) => a.date.localeCompare(b.date));
  eq("猜測日不會取代已確認的日期", after.length, 2);
  ok("已確認的那筆還在", after.some((e) => e.date === D(14) && !e.est));

  // (3) 週期性重複的同名事件：只下架最接近的一筆，隔壁幾週不能被連坐
  T.setEVENTS([E(D(7), true), E(D(14), true), E(D(21), true)]);
  T.mergeRemote([E(D(15), false)]);
  after = T.getEVENTS().filter((e) => e.title === "測試 財報").map((e) => e.date).sort();
  eq("只取代最接近的那一筆", after.join(","), [D(7), D(15), D(21)].sort().join(","));

  // (4) 已經過去的事件是歷史紀錄，更正不去動它
  T.setEVENTS([E(D(-250), true, { note: "很久以前的" })]);
  T.mergeRemote([E(D(-247), false, { note: "更正" })]);
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
  const weeks = [D(7), D(14), D(21), D(28)];
  const dates = () => T.getEVENTS().filter((e) => e.title === "初領失業金")
    .map((e) => e.date).sort().join(",");
  const sorted = (a) => a.slice().sort().join(",");

  // (1) routine 只是把某一週標成已確認，日期沒變
  T.setEVENTS(weeks.map(W));
  T.mergeRemote([{ date: D(14), kind: "D", title: "初領失業金", cat: "claims",
                   est: false, note: "官方確認" }]);
  eq("確認同一天不會刪掉隔壁那一週", dates(), sorted(weeks));
  ok("確認的那一筆不再是推算日",
    T.getEVENTS().filter((e) => e.date === D(14))[0].est === false);

  // (2) 一次確認整串，也不能互相刪
  T.setEVENTS(weeks.map(W));
  T.mergeRemote(weeks.map((d) => Object.assign(W(d), { est: false })));
  eq("整串一起確認也不會互相刪", dates(), sorted(weeks));

  // (3) 真的改期時，還是要下架最接近的舊日期
  T.setEVENTS(weeks.map(W));
  T.mergeRemote([{ date: D(15), kind: "D", title: "初領失業金", cat: "claims",
                   est: false, note: "官方延後一天" }]);
  eq("真的改期時舊日期要下架",
    dates(), sorted([D(7), D(15), D(21), D(28)]));

  // (4) 改期的目標日剛好是另一週時，那一週不可以被當成舊日期刪掉
  T.setEVENTS(weeks.map(W));
  T.mergeRemote([{ date: D(21), kind: "D", title: "初領失業金", cat: "claims",
                   est: false, note: "更正" },
                 { date: D(28), kind: "D", title: "初領失業金", cat: "claims",
                   est: false, note: "更正" }]);
  eq("更正層自己列的日期不會被當成舊日期", dates(), sorted(weeks));

  T.setEVENTS(base);
}

/* ── 14b. 台灣端事件的反應強度：美股欄位是空的，不能算成「沒反應」 ──
   台積電月營收、央行理監事會打不到美股，複盤時 spx/ndx/y10 本來就填不出東西。
   沒有退回台股那一欄的話 mag=0，校準會把它當成「意外大、反應小」，
   然後把整個類型的基準敏感度往下修——拿一個根本沒量到的反應去改模型。 */
{
  eq("美股有填的時候照舊看美股",
    T.reactionMag({ spx: "-0.8", ndx: "-1.3", y10: "+7", twse: "+1.7" }).toFixed(2), "0.98");
  eq("美股全空時退回台股",
    T.reactionMag({ spx: "", ndx: "", y10: "", twse: "+1.60" }).toFixed(2), "1.20");
  eq("兩邊都空還是 0", T.reactionMag({}), 0);

  // 判讀的方向也要跟著退回台股，否則台灣端事件永遠判不出「方向背離」
  const e = { date: "2026-09-10", title: "台積電月營收", cat: "twrev", kind: "N", t: "TW" };
  const v = T.verdict(e, { z: "2.0", twse: "+2.4", sigma: "1.0" });
  ok("台灣端事件判得出反應", v && v.t && v.t.indexOf("反應小") === -1, v && v.t);
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
                 "reviews.json", "betas.json", "policy.json", "regime.json",
                 "backtest.json", "changelog.json"];
  eq("STALE 涵蓋所有雲端檔案",
    FILES.filter((f) => !(f in T.STALE)).join(","), "");
  eq("STALE 沒有多餘的 key",
    Object.keys(T.STALE).filter((f) => FILES.indexOf(f) < 0).join(","), "");
}

/* ── 16. 政策路徑：升降息定價，以及事件當天把它推了多少 ── */
{
  const LT = String.fromCharCode(60);
  const POL = {
    asof: "2026-08-31", histFrom: "2026-08-03", effr: 3.63,
    source: "CME 30 天聯邦資金期貨",
    meetings: [
      { date: "2026-09-16", rate: 3.775, chgBp: 14.5, cumBp: 14.5 },
      { date: "2026-10-28", rate: 3.845, chgBp: 7.0, cumBp: 21.5 },
      { date: "2026-12-09", rate: 3.993, chgBp: 14.8, cumBp: 36.3 },
    ],
    hist: {
      "2026-08-27": { effr: 3.63, m: { "2026-09-16": 3.7157, "2026-12-09": 3.8593 } },
      "2026-08-28": { effr: 3.63, m: { "2026-09-16": 3.7746, "2026-12-09": 3.9930 } },
    },
  };

  // 機率換算：一碼以內講機率，超過一碼講碼數
  eq("+14.5bp ≈ 升息 58%", T.polOdds(14.5), "升息 58%");
  eq("−12.5bp ≈ 降息 50%", T.polOdds(-12.5), "降息 50%");
  eq("幾乎沒動就是按兵不動", T.polOdds(0.1), "按兵不動");
  eq("超過一碼改講碼數", T.polOdds(37.5), "升息 1.50 碼");
  eq("超過一碼（降息方向）也講碼數", T.polOdds(-40), "降息 1.60 碼");

  // 哪些事件會撼動政策路徑：看前端利率那條管道
  ok("CPI 會撼動政策路徑", T.POLCAT({ cat: "cpi" }));
  ok("FOMC 會撼動政策路徑", T.POLCAT({ cat: "fomc" }));
  ok("Jackson Hole 會撼動政策路徑", T.POLCAT({ cat: "jackson" }));
  ok("權值財報不會（它走分子端）", !T.POLCAT({ cat: "earn3" }));
  ok("四巫日不會", !T.POLCAT({ cat: "quad" }));
  ok("未知類型退回 ISM 也不會爆", typeof T.POLCAT({ cat: "不存在" }) === "boolean");

  // 沒有 policy.json 時整段消失，不是顯示壞掉的表
  T.applyPolicy(null);
  eq("沒有政策資料時不顯示這一段", T.policyHTML({ date: "2026-09-11", cat: "cpi" }), "");
  eq("沒有政策資料時頂部那行也是空的", T.policyLine(), "");
  T.applyPolicy({ meetings: [], hist: {} });
  eq("空的 hist 等於沒有資料", T.policyHTML({ date: "2026-09-11", cat: "cpi" }), "");

  T.applyPolicy(POL);
  ok("頂部那行講得出目前定價", T.policyLine().indexOf("3.63%") >= 0, T.policyLine());

  // 未來事件：顯示現在定價到哪
  const fut = T.policyHTML({ date: D(120), cat: "cpi", title: "CPI" });
  ok("未來事件顯示目前的路徑", fut.indexOf("09/16") >= 0, fut.slice(0, 120));
  ok("未來事件顯示有效利率", fut.indexOf("3.63%") >= 0);

  // 過去事件：顯示當天把路徑推了多少（Jackson Hole 8/28，盤中吸收）
  const jh = T.policyHTML({ date: "2026-08-28", cat: "jackson", title: "Jackson Hole",
                            t: "10:00" });
  ok("過去事件算得出當日變動", jh.indexOf("當日變動") >= 0, jh.slice(0, 140));
  ok("8/28 那天是鷹派重定價", jh.indexOf("鷹派") >= 0, jh.slice(-260));
  ok("當日變動算的是相對有效利率的累計", jh.indexOf("+13.4bp") >= 0 || jh.indexOf("+5.9bp") >= 0,
    jh);

  // 序列還沒涵蓋到的舊事件：講清楚為什麼沒有，而不是顯示空表
  const old = T.policyHTML({ date: "2026-06-10", cat: "cpi", title: "CPI" });
  ok("序列涵蓋不到的舊事件講清楚原因", old.indexOf("補不回來") >= 0, old.slice(0, 160));

  // 不走利率管道的事件不顯示這一段
  eq("財報不顯示政策路徑",
    T.policyHTML({ date: "2026-09-11", cat: "earn3", title: "NVDA 財報" }), "");

  // 雲端字串照樣要跳脫
  T.applyPolicy(Object.assign({}, POL, { source: LT + "img src=x onerror=alert(1)" }));
  ok("policy.json 的字串也跳脫",
    T.policyHTML({ date: D(120), cat: "cpi" }).indexOf(LT + "img") === -1);
  T.applyPolicy(null);
}

/* ── 17. 每一種事件類型都要有自己的判讀重點 ── */
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const ckSrc = (html.split("const CK={")[1] || "").split("\n};")[0];
  const ck = new Set((ckSrc.match(/^ {2}(\w+):\[/gm) || [])
    .map((x) => x.trim().replace(":[", "")));
  ok("抓得到 CK 表", ck.size > 0, String(ck.size));
  const missing = Object.keys(T.CAT).filter((k) => !ck.has(k));
  eq("每一種事件類型都有專屬的判讀重點（不然會落到通用預設，等於沒寫）",
    missing.join(","), "");
  ok("仍然保留通用預設當保險", ck.has("default"));

  // routine 寫進 curated.json 的事件沒有 checks 欄位，必須依類型退回 CK，
  // 不然那些事件（突發新聞、央行演說）永遠只有標題沒有判讀重點
  const own = T.checksOf({ cat: "cpi", checks: [["自己的", "說明"]] });
  eq("事件自己有 checks 就用自己的", own[0][0], "自己的");
  const fb = T.checksOf({ cat: "jackson", checks: [] });
  ok("沒有 checks 時依類型退回", fb.length > 0 && fb[0][0].length > 0, JSON.stringify(fb[0]));
  ok("Jackson Hole 退回的是它自己那一組，不是通用預設",
    JSON.stringify(fb) !== JSON.stringify(T.checksOf({ cat: "不存在的類型" })));
  ok("checks 欄位整個沒有也不會爆", T.checksOf({ cat: "cpi" }).length > 0);
  ok("未知類型退回通用預設", T.checksOf({ cat: "亂寫" }).length > 0);
  // 每一種類型退回來的內容都必須是 [標題, 說明] 的成對陣列
  const badShape = Object.keys(T.CAT).filter((k) => {
    const r = T.checksOf({ cat: k });
    return !Array.isArray(r) || !r.length
      || r.some((x) => !Array.isArray(x) || x.length !== 2 || !x[0] || !x[1]);
  });
  eq("每一種類型的判讀重點都是成對的 [標題, 說明]", badShape.join(","), "");
}

/* ── 18. 政策事件的判讀：沒有 z 分數時，意外程度＝政策路徑被推了多少 ── */
{
  const POL = {
    asof: "2026-08-31", histFrom: "2026-08-03", effr: 3.63, source: "測試",
    meetings: [{ date: "2026-09-16", rate: 3.775, chgBp: 14.5, cumBp: 14.5 }],
    hist: {
      "2026-08-27": { effr: 3.63, m: { "2026-09-16": 3.7157, "2026-12-09": 3.8593 } },
      "2026-08-28": { effr: 3.63, m: { "2026-09-16": 3.7746, "2026-12-09": 3.9930 } },
      "2026-08-31": { effr: 3.63, m: { "2026-09-16": 3.7750, "2026-12-09": 3.9935 } },
    },
  };
  const jh = { date: "2026-08-28", title: "Jackson Hole", cat: "jackson", kind: "D",
               t: "10:00" };
  // 演說當天沒有共識數字，所以 z 一定是空的——這正是原本會被判成「非事件」的情境
  const react = { spx: "-0.25", ndx: "-0.65", y10: "+4.8", z: "", sigma: "1.13" };

  T.applyPolicy(null);
  eq("沒有政策資料時算不出路徑移動", T.polMoveBp(jh), null);
  const noPol = T.verdict(jh, react);
  eq("沒有政策資料時退回原本的四象限", noPol.k, 2);

  T.applyPolicy(POL);
  const mv = T.polMoveBp(jh);
  ok("算得出當天的平均路徑移動", mv > 8 && mv < 10, String(mv));
  ok("鷹派方向是正值", mv > 0);

  const v = T.verdict(jh, react);
  eq("政策路徑大動但大盤沒跟上＝第五種判讀", v.k, 5);
  ok("標題講得出移動幾 bp", v.t.indexOf("9.6bp") >= 0, v.t);
  ok("不會被誤判成「非事件」", v.t.indexOf("非事件") < 0);
  ok("不會被誤判成「已被定價」", v.t.indexOf("已被定價") < 0);
  ok("有三條可執行的建議", Array.isArray(v.a) && v.a.length === 3);

  // 大盤也大動時，回到「環境確認」，不要停在第五種
  const bigReact = { spx: "-2.4", ndx: "-3.1", y10: "+4.8", z: "", sigma: "1.13" };
  eq("大盤也跟上時是環境確認", T.verdict(jh, bigReact).k, 1);

  // 路徑沒動的日子不套用這一條
  const quiet = { date: "2026-08-31", title: "CPI", cat: "cpi", kind: "D", t: "08:30" };
  const qmv = T.polMoveBp(quiet);
  ok("平靜的日子路徑幾乎不動", Math.abs(qmv) < 1, String(qmv));
  eq("路徑沒動就不是第五種", T.verdict(quiet, react).k, 2);

  // 不走利率管道的事件不看政策路徑
  eq("財報不看政策路徑",
    T.polMoveBp({ date: "2026-08-28", cat: "earn3", title: "財報", t: "AMC" }), null);

  // 有 z 分數時以 z 為準，方向背離仍然要判得出來
  const div = { spx: "+1.2", ndx: "+1.5", y10: "+4.8", z: "2.1", sigma: "1.13" };
  eq("有 z 且方向背離時仍判背離", T.verdict(jh, div).k, 4);

  T.applyPolicy(null);
}

/* ── 19. 同一天多個事件：複盤表單的欄位不可以撞名 ── */
{
  const e1 = { date: "2026-08-28", title: "甲事件", cat: "jackson", kind: "D" };
  const e2 = { date: "2026-08-28", title: "乙事件", cat: "nfp", kind: "D" };
  const h0 = T.reviewForm(e1, 0), h1 = T.reviewForm(e2, 1);
  const ids = (h) => (h.match(/id="rv[^"]*"/g) || []).sort();
  ok("表單有欄位", ids(h0).length >= 8, String(ids(h0).length));
  eq("兩個區塊的欄位數一樣", ids(h0).length, ids(h1).length);
  const overlap = ids(h0).filter((x) => ids(h1).indexOf(x) >= 0);
  eq("同一天兩個事件的欄位 id 完全不重疊（撞名會把甲的數字存進乙）",
    overlap.join(","), "");
  ok("存檔按鈕帶著自己的區塊序號", h1.indexOf('data-bi="1"') >= 0);
  ok("存檔按鈕帶著自己的事件 key",
    h1.indexOf(encodeURIComponent("2026-08-28|乙事件")) >= 0);
}

/* ── 20. 政策路徑：往回的錨到期時，要能從未來的月份往回解 ──
   policy_path.py 原本只肯用「已經過去、而且沒開會」的月份當錨。那種月份的合約
   一到月底就到期，Yahoo 就不給價了，於是每逢「當月有會議、上一個沒開會的月份剛到期」
   整條每日序列就會靜靜停住：generated 每天照更新，asof 卻不動。
   2026-09-01 之後真的斷了四個交易日才被發現，而這個序列是補不回來的。
   這裡用合成價格驗證「往回找不到錨」時仍然解得出當下的有效利率與整條路徑。 */
{
  const { execFileSync } = require("child_process");
  const py = [
    "import importlib.util, json, datetime as dt",
    "spec = importlib.util.spec_from_file_location('pp', " +
      JSON.stringify(path.join(ROOT, "scripts", "policy_path.py")) + ")",
    "pp = importlib.util.module_from_spec(spec); spec.loader.exec_module(pp)",
    // 9 月合約：9/16 會議，會前 3.63%、會後 3.88%（升一碼）。
    // 10、11 月都是 3.88%。八月（往回唯一沒開會的月份）的合約刻意不給，模擬到期。
    "sep = 100 - (16 * 3.63 + 14 * 3.88) / 30",
    "px = {'ZQU26.CBT': {}, 'ZQV26.CBT': {}, 'ZQX26.CBT': {}}",
    "for d in ('2026-09-02', '2026-09-25'):",
    "    px['ZQU26.CBT'][d] = sep",
    "    px['ZQV26.CBT'][d] = 100 - 3.88",
    "    px['ZQX26.CBT'][d] = 100 - 3.88",
    "out = {}",
    "for d in ('2026-09-02', '2026-09-25'):",
    "    dd = dt.date(int(d[:4]), int(d[5:7]), int(d[8:]))",
    "    e, p = pp.solve_day(px, d, pp.meeting_list(dd))",
    "    out[d] = {'effr': e, 'sep': p.get('2026-09-16'), 'n': len(p)}",
    "print(json.dumps(out))",
  ].join("\n");
  let sol = null;
  try {
    sol = JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8" }));
  } catch (e) {
    ok("policy_path.py 跑得起來", false, String((e && e.message) || e).slice(0, 200));
  }
  if (sol) {
    const pre = sol["2026-09-02"], post = sol["2026-09-25"];
    ok("往回的錨到期時仍然解得出有效利率（斷掉就補不回來）",
      pre.effr !== null, "得到 null，序列會從這天起停住");
    eq("會議前解出來的是會前利率", pre.effr, 3.63);
    eq("會議之後解出來的是會後利率", post.effr, 3.88);
    eq("同時解得出這次會議的會後隱含利率", pre.sep, 3.88);
    ok("整條路徑不是只有一次會議", pre.n >= 2, "只解出 " + pre.n + " 次");
  }
}

/* ── 18. 回測面板：backtestHTML 把 data/backtest.json 畫成「資料」頁那一段 ──
   這一段的重點不是排版，是「結果不好看的時候不能悄悄不顯示」。
   一個只在自己準的時候才給看的回測沒有任何用處，所以 IC 接近 0 必須印出紅字結論。 */
{
  const BT = {
    generated: "2026-09-13T00:00:00Z", asof: "2026-09-13",
    window: { from: "2024-10-11", to: "2026-09-11" },
    n: 421, nDays: 285, benchmark: "QQQ",
    ic: { score: 0.033, gap: -0.017, day: -0.004 },
    spread: -0.01,
    baseline: { allDays: { n: 480, z: 0.82 }, eventDays: { n: 285, z: 0.82 },
                quietDays: { n: 195, z: 0.82 } },
    deciles: [{ d: 1, n: 42, sLo: 22, sHi: 27, z: 0.84, absPct: 0.9 },
              { d: 10, n: 42, sLo: 76, sHi: 91, z: 0.83, absPct: 0.9 }],
    cats: [{ cat: "cpi", n: 21, s: 82, z: 0.50 },
           { cat: "nfp", n: 22, s: 78, z: 1.25 },
           { cat: "twrev", n: 21, s: 27, z: 1.09 },
           { cat: "jolts", n: 21, s: 27, z: 0.48 },
           { cat: "ecb", n: 1, s: 48, z: 1.32 }],
    caveats: ["樣本內：用今天的環境設定重新計分。"],
  };
  const h = T.backtestHTML(BT);

  ok("IC 三個數字都印出來", h.indexOf("+0.033") >= 0 && h.indexOf("-0.017") >= 0 &&
    h.indexOf("-0.004") >= 0, h.slice(0, 200));
  ok("IC 接近 0 時說的是「沒有可辨識的預測力」，不是含糊帶過",
    h.indexOf("沒有可辨識的預測力") >= 0);
  ok("沒有預測力時用紅字，不會跟有預測力長得一樣", h.indexOf("#FF5C5C") >= 0);
  ok("樣本數與區間要寫出來", h.indexOf("421") >= 0 && h.indexOf("2024-10-11") >= 0);
  ok("事件日與非事件日的對照組要顯示", h.indexOf("0.82") >= 0 && h.indexOf("195") >= 0);
  ok("兩邊一樣時要講出「篩不出東西」這個結論", h.indexOf("沒有篩出任何東西") >= 0);
  ok("十分位表印得出來", h.indexOf("第 1 分位") >= 0 && h.indexOf("第 10 分位") >= 0);
  ok("警語要顯示，不能只報好消息", h.indexOf("樣本內") >= 0);

  // 分類型：樣本 6 筆以下的不列（一筆 ecb 不能拿來說任何事）
  ok("分類型只列樣本 6 筆以上的", h.indexOf("1.32") < 0, "樣本 1 筆的 ecb 被列出來了");
  // 高分低反應＝高估（紅），低分高反應＝低估（藍）。兩個方向都要標得出來
  ok("高分但實際不太動的類型標成高估", h.indexOf("0.50") >= 0 && h.indexOf("#FF5C5C") >= 0);
  ok("低分但實際會動的類型標成低估", h.indexOf("var(--den)") >= 0);
  ok("類型顯示的是看得懂的名稱不是代碼",
    h.indexOf(T.CAT.twrev.label) >= 0, "找不到 " + T.CAT.twrev.label);

  // 沒有資料 / 壞資料時不能整頁爆掉
  ok("還沒有回測結果時給的是「怎麼產生」而不是空白",
    T.backtestHTML(null).indexOf("scripts/backtest.js") >= 0);
  ok("缺 ic 欄位時當成沒有資料", T.backtestHTML({ n: 1 }).indexOf("scripts/backtest.js") >= 0);
  ok("只有 ic 沒有其他欄位也不會爆",
    T.backtestHTML({ ic: { score: 0.5, gap: null, day: null } }).length > 0);

  // 門檻：IC 大到有意義時就不能再說「沒有預測力」
  const strong = T.backtestHTML(Object.assign({}, BT, { ic: { score: .3, gap: .3, day: .3 } }));
  ok("IC 夠大時結論要跟著變", strong.indexOf("沒有可辨識的預測力") < 0 &&
    strong.indexOf("明顯") >= 0);

  // 回測檔案本身也要被新鮮度監看，不然它靜靜停在幾個月前也沒人知道
  ok("backtest.json 有新鮮度門檻", T.STALE["backtest.json"] > 0);
  ok("每週產生的回測門檻不比每日檔案嚴",
    T.STALE["backtest.json"] > T.STALE["events.json"]);
}

/* ── 19. 政府撥款期限：這是會過期的硬編日期，不是規則推得出來的 ──
   2026-09-13 從 2027-01-15（est）改成 2026-12-11（9/1 通過的短期撥款到期日）。
   沒有這條斷言的話，下次有人把它改回推算值也不會有人發現。 */
{
  const f = T.EVENTS.filter((e) => e.title === "政府撥款期限");
  eq("日曆上只有一筆政府撥款期限", f.length, 1);
  eq("日期是實際的撥款到期日", f[0] && f[0].date, "2026-12-11");
  ok("已確認不是推算", f[0] && f[0].est === false);
  eq("走風險溢酬那一端，跟規則引擎原本那筆同一個代碼", f[0] && f[0].cat, "election");
}


/* ── 20. 意外空間（利率端）：公式裡原本只有「已定價 × 環境放大」兩段 ──
   首頁文案寫的是三段，B 卻是類型層級的常數，同一個 CPI 不管市場當下對利率多敏感
   都拿同一個基準分數。polSurprise 用 policy.json 的每日序列補上第三段：
   公布前整條政策路徑平均每天被重定價幾 bp ÷ 這條序列自己的中位數。
   下面每一條都是在守「算不出來就不要給數字」與「不可以偷看事件之後的資料」。 */
{
  /* 造一條可以指定每天推幾 bp 的序列。正負交替，測的是絕對值。
     effrStepAt：第幾天讓有效聯邦資金利率自己跳一階（升息生效日），用來釘 polDelta 的錨點修正。 */
  const mkPol = (moves, opts) => {
    const o = opts || {};
    const d0 = Date.UTC(2026, 0, 1);
    const day = (i) => new Date(d0 + i * 864e5).toISOString().slice(0, 10);
    let r1 = 4.00, r2 = 4.20, effr = 3.50;
    const hist = {};
    hist[day(0)] = { effr, m: { "2026-10-28": r1, "2026-12-09": r2 } };
    moves.forEach((bp, i) => {
      const sgn = i % 2 ? -1 : 1;
      r1 += sgn * bp / 100; r2 += sgn * bp / 100;
      if (o.effrStepAt === i + 1) effr += 0.25;
      hist[day(i + 1)] = { effr, m: { "2026-10-28": r1, "2026-12-09": r2 } };
    });
    return { day, pol: { asof: day(moves.length), histFrom: day(0), effr, source: "測試",
      meetings: [{ date: "2026-10-28", rate: r1, chgBp: 10, cumBp: 10 }], hist } };
  };
  const rep = (n, v) => new Array(n).fill(v);
  const EV = (date, cat) => ({ date, title: "測試", cat: cat || "cpi", kind: "D", t: "08:30" });

  // 沒有 policy.json 就沒有意外空間——不能拿類型先驗假裝成估計值
  T.applyPolicy(null);
  eq("沒有政策資料時算不出意外空間", T.polSurprise(EV("2026-02-01")), null);
  eq("算不出來時抽屜裡那一段整個消失", T.spcHTML(EV("2026-02-01")), "");
  eq("算不出來時分數不受影響", T.score(EV("2026-02-01")).spc, 1);

  // 序列太短：20 個交易日以下一律不給估計
  const shortSeq = mkPol(rep(12, 1.0));
  T.applyPolicy(shortSeq.pol);
  eq("序列不到 20 個交易日就不給估計", T.polSurprise(EV("2026-02-01")), null);

  // 序列夠長、最近明顯比平常熱 → 放大，而且被 ±12% 的上限擋住
  const hot = mkPol(rep(20, 1.0).concat(rep(10, 4.0)));
  T.applyPolicy(hot.pol);
  const sHot = T.polSurprise(EV("2026-02-01"));
  ok("序列夠長就算得出來", !!sHot, String(sHot));
  eq("取的是最近 10 個交易日", sHot && sHot.n, 10);
  eq("基準用的是事件之前的整條序列", sHot && sHot.all, 30);
  ok("最近 10 日平均約 4bp", Math.abs(sHot.recent - 4.0) < 0.01, String(sHot.recent));
  ok("序列中位數約 1bp", Math.abs(sHot.base - 1.0) < 0.01, String(sHot.base));
  ok("比值約 4 倍", Math.abs(sHot.ratio - 4) < 0.02, String(sHot.ratio));
  ok("放大幅度被上限擋住，不會無限放大",
    Math.abs(sHot.mult - 1.12) < 1e-9, String(sHot.mult));

  // 溫和放大：沒撞到上限時要按對數比例給，不是給上限
  const mild = mkPol(rep(20, 1.0).concat(rep(10, 1.5)));
  T.applyPolicy(mild.pol);
  const sMild = T.polSurprise(EV("2026-02-01"));
  ok("溫和放大時不是直接給上限", sMild.mult > 1.0 && sMild.mult < 1.12, String(sMild.mult));
  ok("倍率是 1+0.15×ln(比值)",
    Math.abs(sMild.mult - (1 + 0.15 * Math.log(1.5))) < 1e-9, String(sMild.mult));

  // 反方向：最近幾乎沒在改路徑 → 縮小。少了這一條，這一項就只會放大不會縮小
  const quiet = mkPol(rep(20, 2.0).concat(rep(10, 1.0)));
  T.applyPolicy(quiet.pol);
  const sQuiet = T.polSurprise(EV("2026-02-01"));
  ok("最近沒在改路徑時要縮小而不是維持 1", sQuiet.mult < 1, String(sQuiet.mult));
  ok("對數映射是對稱的：比值 0.5 與比值 2 的調整幅度相同",
    Math.abs((1 - sQuiet.mult) - 0.15 * Math.log(2)) < 1e-9, String(sQuiet.mult));

  // 不可以偷看事件之後的資料。同一條序列、同一個 hot 樣本，
  // 事件落在變熱之前時必須完全看不到後面那 10 天。
  T.applyPolicy(hot.pol);
  const early = T.polSurprise(EV(hot.day(21)));
  ok("事件之前的資料不足以看到後面那段熱度", early && Math.abs(early.ratio - 1) < 1e-9,
    early ? String(early.ratio) : "null");
  eq("所以事件當下的倍率是 1，不是事後才知道的 1.12", early && early.mult, 1);

  // 不走利率管道的事件沒有這一項（分子端要走選擇權隱含變動，還沒做）
  eq("財報沒有利率端的意外空間", T.polSurprise(EV("2026-02-01", "earn3")), null);
  eq("四巫日也沒有", T.polSurprise(EV("2026-02-01", "quad")), null);

  // 真的有作用在分數上，不是只印在抽屜裡
  {
    const e = EV("2026-02-01", "claims");
    T.applyPolicy(null);
    const base = T.score(e);
    T.applyPolicy(hot.pol);
    const lift = T.score(e);
    eq("沒有政策序列時倍率是 1", base.spc, 1);
    ok("有序列且市場正在快速重定價時分數要跟著升高",
      lift.spc > base.spc && lift.s > base.s, base.s + "→" + lift.s);
    T.applyPolicy(quiet.pol);
    const cut = T.score(e);
    ok("市場沒在改路徑時分數要低於基準", cut.spc < 1 && cut.s < base.s,
      base.s + "→" + cut.s);
  }

  // 抽屜裡那一段要把數字攤出來，使用者才有得核對
  T.applyPolicy(hot.pol);
  const h = T.spcHTML(EV("2026-02-01"));
  ok("抽屜列出最近的平均 bp", h.indexOf("4.00bp") >= 0, h.slice(0, 200));
  ok("抽屜列出序列中位數", h.indexOf("1.00bp") >= 0, h.slice(0, 200));
  ok("抽屜列出倍率", h.indexOf("1.120") >= 0, h.slice(0, 260));
  ok("利率端事件的政策路徑區塊帶著意外空間",
    T.policyHTML(EV("2026-02-01")).indexOf("意外空間") >= 0);
  ok("財報的抽屜不會冒出意外空間",
    T.spcHTML(EV("2026-02-01", "earn3")).indexOf("意外空間") < 0);

  /* 錨點修正：有效聯邦資金利率自己跳一階的那一天（升息生效日），
     「相對 effr 的累計」會整條掉 25bp，但隱含利率其實只動了 1bp。
     當日變動改看隱含利率本身的差之後才不會噴出假的鴿派重定價。
     2026-09-17 真實資料上就是這個情形：舊算法 −25.2bp、實際只有 +0.85bp。 */
  const stepped = mkPol(rep(30, 1.0), { effrStepAt: 25 });
  T.applyPolicy(stepped.pol);
  const mv = T.polMoveBp(EV(stepped.day(25)));
  ok("升息生效日不會被算成一天之內鴿派重定價二十幾 bp",
    mv != null && Math.abs(mv) < 2, String(mv));
  ok("那一天量到的就是隱含利率真正的變動", Math.abs(mv - 1.0) < 0.01, String(mv));
  const ph = T.policyHTML(EV(stepped.day(25)));
  const bps = (ph.match(/[+-]\d+(?:\.\d+)?bp/g) || []).map(parseFloat);
  ok("抽屜裡印得出當日變動", bps.length > 0, ph.slice(0, 200));
  ok("當日變動欄位也不會出現那個假數字",
    bps.every((v) => Math.abs(v) < 5), bps.join(","));
  // effr 沒動的日子，兩種算法本來就完全相同——修正不可以改到正常日子
  const mvNormal = T.polMoveBp(EV(stepped.day(10)));
  ok("effr 沒動的日子維持原本的數字", Math.abs(mvNormal) - 1.0 < 0.01, String(mvNormal));

  T.applyPolicy(null);
}

/* ── 報告 ── */
console.log("");
if (fails.length) {
  fails.forEach((f) => console.error("  失敗  " + f));
  console.error("\n煙霧測試失敗：" + fails.length + " 項不通過、" + pass + " 項通過。不要 commit。");
  process.exit(1);
}
console.log("煙霧測試通過：" + pass + " 項。");
