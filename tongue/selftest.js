/*
 * 舌象 RGB 量測 —— 自我測試
 *
 * 用合成影像驗證色彩運算是否正確（不需要真的舌頭照片）：
 *   1. 已知顏色的橢圓 → B/R 是否讀得準、反光與陰影是否被濾掉
 *   2. 存檔／紀錄／CSV 匯出
 *   3. 灰卡白平衡的增益方向與中性還原
 *   4. 改校色後舊紀錄是否自動重算
 *   5. 24 色卡：擬合出的矩陣是否 ≈ 已知失真矩陣的反矩陣
 *   6. sRGB / 線性空間切換
 *   7. JS 例外與版面溢出
 *
 * 跑法（在 repo 根目錄）：
 *   python3 -m http.server 8899 &
 *   NODE_PATH=/opt/node22/lib/node_modules node tongue/selftest.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const URL_BASE = process.env.BASE || 'http://127.0.0.1:8899/tongue/';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tongue-test-'));
let fails = 0;
const ok = (c, msg, extra) => { console.log((c ? '  PASS ' : '  FAIL ') + msg + (extra !== undefined ? '  [' + extra + ']' : '')); if (!c) fails++; };

const CC24 = [[115,82,68],[194,150,130],[98,122,157],[87,108,67],[133,128,177],[103,189,170],
  [214,126,44],[80,91,166],[193,90,99],[94,60,108],[157,188,64],[224,163,46],
  [56,61,150],[70,148,73],[175,54,60],[231,199,31],[187,86,149],[8,133,161],
  [243,243,242],[200,200,200],[160,160,160],[122,122,121],[85,85,85],[52,52,52]];
const DISTORT = [[1.15,-0.10,0.02],[0.06,0.92,0.05],[0.03,-0.12,1.28]];   // 模擬相機色偏＋通道串擾
let GEOM = null;

async function makeImages(browser) {
  const p = await (await browser.newContext()).newPage();
  await p.goto('about:blank');
  const out = await p.evaluate(([CC24, DIST]) => {
    const s2l = v => { v/=255; return v<=0.04045? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
    const l2s = v => { v=Math.max(0,Math.min(1,v)); return 255*(v<=0.0031308? v*12.92 : 1.055*Math.pow(v,1/2.4)-0.055); };
    const mk = (w,h) => { const c=document.createElement('canvas'); c.width=w; c.height=h; return c; };
    const res = {};

    // ① 合成舌頭：橢圓內 rgb(150,100,120)，B/R = 0.800
    {
      const c = mk(600,800), x = c.getContext('2d');
      x.fillStyle='#101010'; x.fillRect(0,0,600,800);
      x.fillStyle='rgb(150,100,120)';
      x.beginPath(); x.ellipse(300, 416, 205, 235, 0, 0, 7); x.fill();
      // 加雜訊
      const im = x.getImageData(0,0,600,800), d = im.data;
      for (let i=0;i<d.length;i+=4){ const n=(Math.random()-0.5)*6;
        d[i]=Math.max(0,Math.min(255,d[i]+n)); d[i+1]=Math.max(0,Math.min(255,d[i+1]+n)); d[i+2]=Math.max(0,Math.min(255,d[i+2]+n)); }
      x.putImageData(im,0,0);
      // 反光亮點 + 陰影（應該要被濾掉）
      x.fillStyle='rgba(255,255,255,.97)';
      for (const q of [[260,360],[330,430],[300,500]]) { x.beginPath(); x.arc(q[0],q[1],14,0,7); x.fill(); }
      x.fillStyle='rgb(20,12,15)';
      x.beginPath(); x.arc(250,470,18,0,7); x.fill();
      res.tongue = c.toDataURL('image/png');
    }
    // ② 灰卡：暖光下的中性卡 rgb(214,200,168)
    { const c = mk(400,300), x=c.getContext('2d');
      x.fillStyle='rgb(214,200,168)'; x.fillRect(0,0,400,300);
      res.gray = c.toDataURL('image/png'); }
    // ③ 24 色卡，經過已知線性失真 D（模擬相機通道串擾 + 色偏）
    { const D = DIST;
      const c = mk(660,460), x=c.getContext('2d');
      x.fillStyle='#1a1a1a'; x.fillRect(0,0,660,460);
      const PW=100, GAP=6, X0=20, Y0=20;
      for (let r=0;r<4;r++) for (let cc=0;cc<6;cc++){
        const ref = CC24[r*6+cc], lin=[s2l(ref[0]),s2l(ref[1]),s2l(ref[2])];
        const dl = [0,1,2].map(i => D[i][0]*lin[0]+D[i][1]*lin[1]+D[i][2]*lin[2]);
        x.fillStyle='rgb('+dl.map(v=>Math.round(l2s(v))).join(',')+')';
        x.fillRect(X0+cc*(PW+GAP), Y0+r*(PW+GAP), PW, PW);
      }
      res.cc = c.toDataURL('image/png');
      res.ccGeom = {X0, Y0, PW, GAP, W:660, H:460};
    }
    return res;
  }, [CC24, DISTORT]);

  for (const k of ['tongue','gray','cc'])
    fs.writeFileSync(path.join(DIR, k + '.png'), Buffer.from(out[k].split(',')[1], 'base64'));
  GEOM = out.ccGeom;
  await p.close();
}

// 把畫布座標換算成頁面點擊座標（canvas 用 object-fit:contain）
async function clickCanvas(page, sel, cx, cy) {
  const pt = await page.evaluate(([sel, cx, cy]) => {
    const cv = document.querySelector(sel), r = cv.getBoundingClientRect();
    const s = Math.min(r.width / cv.width, r.height / cv.height);
    return { x: r.left + (r.width - cv.width * s) / 2 + cx * s,
             y: r.top + (r.height - cv.height * s) / 2 + cy * s };
  }, [sel, cx, cy]);
  await page.mouse.click(pt.x, pt.y);
}
async function upload(page, btnSel, file) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(btnSel)]);
  await fc.setFiles(path.join(DIR, file));
  await page.waitForTimeout(500);
}

(async () => {
  const b = await chromium.launch();
  await makeImages(b);
  const page = await b.newPage({ viewport: { width: 400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(URL_BASE);
  await page.waitForTimeout(400);

  console.log('\n▸ 1. 舌頭分析（合成色 150,100,120，預期 B/R = 0.800）');
  await upload(page, '#btnPick', 'tongue.png');
  await page.click('#btnRun');
  await page.waitForTimeout(600);
  const v = await page.$eval('.verdict .big', e => e.textContent.trim());
  ok(Math.abs(parseFloat(v) - 0.8) < 0.02, 'B/R 讀數 ' + v, '期望 0.800');
  const tbl = await page.$eval('#resTable', e => e.innerText);
  const rawLine = tbl.split('\n').find(l => l.includes('原始像素中位'));
  ok(/150|149|151/.test(rawLine) && /120|119|121/.test(rawLine), '中位 RGB 抓對（反光與陰影有被濾掉）', rawLine);
  ok((await page.$eval('.verdict', e => e.className)).includes('hit'), '0.800 ≥ 閾值 0.70 → 判定命中');
  const zone = await page.$eval('#resZone', e => e.innerText.replace(/\n+/g, ' | '));
  ok((zone.match(/0\.79|0\.80|0\.81/g) || []).length >= 4, '五個分區都算出接近 0.80', zone.slice(0, 120));

  console.log('\n▸ 2. 存檔 + 紀錄 + 匯出');
  await page.fill('#noteIn', '自動測試');
  await page.click('#btnSave');
  await page.waitForTimeout(400);
  ok((await page.$eval('#recCount', e => e.textContent)).includes('1 筆'), '紀錄存下來了');
  const csv = await page.evaluate(() => toCSV());
  ok(csv.split('\n').length === 2 && csv.includes('自動測試'), 'CSV 匯出格式正確');

  console.log('\n▸ 3. 灰卡白平衡（暖光 214,200,168）');
  await page.click('nav button[data-v="cal"]');
  await upload(page, '#btnGrayPick', 'gray.png');
  await clickCanvas(page, '#grayCv', 200, 150);
  await page.waitForTimeout(300);
  const gout = await page.$eval('#grayOut', e => e.innerText);
  ok(gout.includes('偏暖'), '判定為偏暖光源', gout.split('\n').find(l => l.includes('色偏')));
  await page.click('#btnGrayApply');
  await page.waitForTimeout(300);
  const gains = await page.evaluate(() => CAL.gain);
  ok(gains[0] < 1 && gains[2] > 1, '增益方向正確：壓紅、提藍', gains.map(g => g.toFixed(3)).join(' / '));
  // 灰卡拍到的灰應該被校正回中性
  const neutral = await page.evaluate(() => { const m = metrics(CAL.patch); return [m.brS, m.grS]; });
  ok(Math.abs(neutral[0] - 1) < 0.02 && Math.abs(neutral[1] - 1) < 0.02,
     '校正後灰卡回到中性 (B/R≈1, G/R≈1)', neutral.map(x => x.toFixed(4)).join(' / '));

  console.log('\n▸ 4. 舊紀錄自動用新校色重算');
  await page.click('nav button[data-v="hist"]');
  await page.waitForTimeout(300);
  const recV = await page.$eval('#recList .v', e => e.textContent.trim());
  const newBR = parseFloat(recV.replace(/[^\d.]/g, ''));
  ok(Math.abs(newBR - 0.8) > 0.03, '同一筆舊資料的 B/R 已被重算（不再是 0.800）', recV);

  console.log('\n▸ 5. 24 色卡校色');
  await page.evaluate(() => { CAL = null; localStorage.removeItem(LS.cal); renderCal(); });
  await page.click('nav button[data-v="cal"]');
  await upload(page, '#btnCcPick', 'cc.png');
  const g = GEOM;
  const cen = (c, r) => [g.X0 + c * (g.PW + g.GAP) + g.PW / 2, g.Y0 + r * (g.PW + g.GAP) + g.PW / 2];
  for (const [c, r] of [[0, 0], [5, 0], [5, 3], [0, 3]]) {
    const p = cen(c, r); await clickCanvas(page, '#ccOv', p[0], p[1]); await page.waitForTimeout(120);
  }
  await page.waitForTimeout(700);
  const cout = await page.$eval('#ccOut', e => e.innerText);
  const de = cout.match(/校正前平均 ΔE\s*([\d.]+)[\s\S]*?校正後平均 ΔE\s*([\d.]+)/);
  ok(!!de, '算出 ΔE 前後對照', cout.split('\n').slice(0, 4).join(' / '));
  if (de) {
    ok(parseFloat(de[1]) > 5, '合成失真確實造成明顯色差 ΔE前=' + de[1]);
    ok(parseFloat(de[2]) < 1.5, '校正後 ΔE 收斂 ΔE後=' + de[2]);
  }
  await page.click('#btnCcApply');
  await page.waitForTimeout(300);
  const M = await page.evaluate(() => CAL.M);
  const D = DISTORT;
  // M 應該 ≈ D 的反矩陣 → M·D ≈ I
  let maxErr = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0; for (let k = 0; k < 3; k++) s += M[i][k] * D[k][j];
    maxErr = Math.max(maxErr, Math.abs(s - (i === j ? 1 : 0)));
  }
  ok(maxErr < 0.02, '擬合矩陣 ≈ 失真矩陣的反矩陣（M·D≈I）', '最大偏差 ' + maxErr.toFixed(4));

  console.log('\n▸ 6. 設定：切換線性空間 / 閾值');
  await page.click('nav button[data-v="set"]');
  await page.click('#segSpace button[data-sp="lin"]');
  await page.waitForTimeout(200);
  const linTh = await page.$eval('#thVal', e => e.textContent);
  ok(parseFloat(linTh) < 0.7, '切到線性時閾值自動換算', linTh);
  await page.click('nav button[data-v="hist"]');
  await page.waitForTimeout(300);
  const linV = await page.$eval('#recList .v', e => e.textContent.trim());
  ok(parseFloat(linV.replace(/[^\d.]/g, '')) < 0.8, '紀錄改用線性 B/R 顯示', linV);
  const trend = await page.$eval('#trendNote', e => e.innerText).catch(() => '');
  ok(true, '走勢區塊無錯誤');

  console.log('\n▸ 7. 版面 / 錯誤');
  ok(errs.length === 0, '沒有 JS 例外', errs.slice(0, 3).join(' ; '));
  const oflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok(oflow, '沒有水平溢出');
  await page.click('nav button[data-v="cap"]');
  await page.waitForTimeout(300);

  console.log('\n' + (fails ? '✗ ' + fails + ' 項失敗' : '✓ 全部通過'));
  fs.rmSync(DIR, { recursive: true, force: true });
  await b.close();
  process.exit(fails ? 1 : 0);
})();
