// dump 所有遮罩层(maskDiv)及其按钮，定位 jobFinishTip 弹窗结构
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => /chaoxing\.com\/mycourse\/student/i.test(p.url())) || ctx.pages()[0];
  console.log('URL chapterId =', (page.url().match(/chapterId=(\d+)/) || [, '(空)'])[1]);

  const info = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('div').forEach(d => {
      const c = (d.className || '').toString();
      if (!/maskDiv|jobFinishTip|jobLimitTip|maskFade|layui-layer|popups-box|zc_table/i.test(c)) return;
      const s = getComputedStyle(d);
      const r = d.getBoundingClientRect();
      const btns = [...d.querySelectorAll('a,button,span,input')]
        .filter(x => x.offsetWidth > 0 && x.tagName !== 'INPUT')
        .map(x => ({ t: x.tagName, c: (x.className || '').toString().slice(0, 34), txt: (x.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 16), w: Math.round(x.offsetWidth) }))
        .filter(x => x.txt);
      out.push({ cls: c.slice(0, 70), disp: s.display, op: s.opacity, pe: s.pointerEvents, z: s.zIndex, w: Math.round(r.width), h: Math.round(r.height), txt: (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80), btns: btns.slice(0, 8) });
    });
    return out;
  });
  console.log('=== 遮罩/弹窗容器 ===');
  info.forEach(x => console.log(JSON.stringify(x)));

  try { b.disconnect(); } catch (e) {}
  process.exit(0);
})();
