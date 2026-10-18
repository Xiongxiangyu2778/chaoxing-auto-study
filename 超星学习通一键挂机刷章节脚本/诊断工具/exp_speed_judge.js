// 🧪 对照实验：7.5 视频用 3.0x 播到结尾 → 之后"耐心核验"（最多 5 分钟，含刷新）
// 目的：判断学习通到底按【真实播放时长≥90%】还是【进度≥90%】判定 —— 决定该用快档还是慢档
// 结论写入 实验_倍速判定.log
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) { ({ chromium } = require('C:/Users/Public/.workbuddy/binaries/node/workspace/node_modules/playwright-core')); }
const OUT = path.join(__dirname, '实验_倍速判定.log');
const say = m => { const l = new Date().toISOString().slice(11, 19) + ' ' + m; console.log(l); try { fs.appendFileSync(OUT, l + '\n', 'utf8'); } catch (e) {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = s => (isFinite(s) && s > 0) ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '--';

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 8000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => /chaoxing\.com\/mycourse\/student/i.test(p.url()));
  if (!page) { say('❌ 找不到课程页'); process.exit(1); }
  const cid = (page.url().match(/chapterId=(\d+)/) || [])[1];
  say('实验对象：章节 ' + cid + '（' + page.url().slice(0, 60) + '）');

  // 读视频状态 + 目录行
  const readState = async () => {
    let v = null, icons = null;
    for (const f of page.frames()) {
      const r = await f.evaluate(() => {
        const el = document.querySelector('video');
        const ic = document.querySelector('.ans-job-icon');
        return {
          v: el ? { cur: el.currentTime, dur: el.duration, rate: el.playbackRate, paused: el.paused, ended: el.ended } : null,
          aria: ic ? (ic.getAttribute('aria-label') || '') : null,
        };
      }).catch(() => null);
      if (r && r.v && !v) v = r.v;
      if (r && r.aria && icons === null) icons = r.aria;
    }
    let inc = null;
    for (const f of page.frames()) {
      const r = await f.evaluate(id => {
        const d = document.querySelector('.posCatalog_select[id="cur' + id + '"]');
        if (!d) return null;
        const hid = d.querySelector('input.jobUnfinishCount');
        return hid ? hid.value : null;
      }, cid).catch(() => null);
      if (r !== null && r !== undefined) { inc = r; break; }
    }
    return { v, aria: icons, inc };
  };

  // ① 强制 3.0x 并播到结尾
  say('① 强制 3.0x 播放，目标：播到结尾（位置 100%）');
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < 20 * 60 * 1000) {
    for (const f of page.frames()) await f.evaluate(() => { window.__cxSpeed = 3; }).catch(() => {});
    const st = await readState();
    if (!st.v) { say('   ⚠ 读不到 video 元素，尝试点「视频」标签'); 
      await page.getByText('视频', { exact: false }).first().click({ timeout: 2000 }).catch(() => {}); await sleep(4000); continue; }
    if (st.v.paused && !st.v.ended) {
      for (const f of page.frames()) {
        await f.evaluate(() => { try { const v = document.querySelector('video'); if (v) v.play(); } catch (e) {} }).catch(() => {});
      }
    }
    if (Date.now() - lastLog > 20000) {
      lastLog = Date.now();
      say(`   进度 ${fmt(st.v.cur)}/${fmt(st.v.dur)} @ ${st.v.rate}x  aria=${st.aria || '?'}  目录inc=${st.inc}`);
    }
    if (st.v.ended || (st.v.dur > 0 && st.v.cur >= st.v.dur - 1)) break;
    await sleep(4000);
  }
  let st = await readState();
  const realWall = Math.round((Date.now() - t0) / 1000);
  say(`✅ 第一遍播放结束：位置 ${fmt(st.v && st.v.cur)}/${fmt(st.v && st.v.dur)}，耗时(墙钟) ${fmt(realWall)}，aria=${st.aria}，目录inc=${st.inc}`);
  say(`   → 若按"真实时长≥90%"判定：这一遍只攒了 ${Math.round((st.v.dur / 3) / st.v.dur * 100)}% 真实时长，应当【不登记】`);
  say(`   → 若按"进度≥90%"判定：位置已到 100%，应当【登记】`);

  // ② 耐心核验：每 15 秒查一次，最多 5 分钟；第 60/180 秒各刷新一次页面
  say('② 开始耐心核验（每 15 秒查一次，最多 5 分钟；60s/180s 各刷新一次）');
  const t1 = Date.now();
  let credited = false, reloaded = 0, lastInc = st.inc;
  while (Date.now() - t1 < 5 * 60 * 1000) {
    await sleep(15000);
    const el = Math.round((Date.now() - t1) / 1000);
    if (!credited && (el === 60 || el === 180)) {
      reloaded++;
      say(`   🔄 第 ${reloaded} 次刷新页面（第 ${el} 秒）`);
      await page.reload({ timeout: 30000 }).catch(() => {});
      await sleep(10000);
    }
    const s2 = await readState();
    if (s2.inc !== lastInc) { say(`   📉 目录 inc 变化：${lastInc} → ${s2.inc}`); lastInc = s2.inc; }
    say(`   [${el}s] aria=${s2.aria || '?'}  目录inc=${s2.inc}`);
    if ((s2.aria || '').includes('已完成') || (s2.inc !== null && Number(s2.inc) < 2)) {
      credited = true;
      say(`🎉 结论：任务点已登记！用了约 ${Math.round((Date.now() - t1) / 1000)} 秒（含 ${reloaded} 次刷新）→ 【进度≥90% 模型成立，登记有延迟】`);
      break;
    }
  }
  if (!credited) {
    say('⚠️ 5 分钟内未登记 → 说明 3x 一遍不够，【真实播放时长≥90% 模型成立】（或门槛比 90% 更严）');
  }
  process.exit(0);
})();
