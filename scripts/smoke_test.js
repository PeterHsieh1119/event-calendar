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
  "isEDT:isEDT,iso:iso,parse:parse,clamp:clamp,setPX:function(o){PX=o;}};\n";

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

/* ── 報告 ── */
console.log("");
if (fails.length) {
  fails.forEach((f) => console.error("  失敗  " + f));
  console.error("\n煙霧測試失敗：" + fails.length + " 項不通過、" + pass + " 項通過。不要 commit。");
  process.exit(1);
}
console.log("煙霧測試通過：" + pass + " 項。");
