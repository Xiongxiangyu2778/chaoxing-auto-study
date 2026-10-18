// 只读探测 2：读取未完成目录行的完整 HTML + 当前节任务点 chips 的完整结构
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) {
  ({ chromium } = require('C:/Users/Public/.workbuddy/binaries/node/workspace/node_modules/playwright-core'));
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 8000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => /studentstudy/i.test(p.url())) || ctx.pages()[0];

  for (const f of page.frames()) {
    // A) 未完成目录行完整 HTML（含 7.2 那行）
    const unfinished = await f.evaluate(() => {
      const out = [];
      document.querySelectorAll('li').forEach(li => {
        if (li.querySelector('.posCatalog_name') && /7\.2|9\.1/.test(li.innerText)) {
          out.push({ text: (li.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50), html: li.outerHTML.replace(/\s+/g, ' ').slice(0, 700) });
        }
      });
      return out;
    }).catch(() => []);
    if (unfinished.length) {
      console.log('[未完成目录行完整 HTML]', f.url().slice(0, 70));
      unfinished.forEach(u => console.log('>>>', u.text, '\n', u.html, '\n'));
    }

    // B) 已完成目录行（1.1）对比
    const done = await f.evaluate(() => {
      const out = [];
      document.querySelectorAll('li').forEach(li => {
        if (li.querySelector('.posCatalog_name') && /^1\.1/.test(li.innerText)) out.push(li.outerHTML.replace(/\s+/g, ' ').slice(0, 700));
      });
      return out;
    }).catch(() => []);
    if (done.length) {
      console.log('[已完成目录行对比]', f.url().slice(0, 70));
      done.forEach(d => console.log('>>>', d, '\n'));
    }

    // C) 当前节任务点 chips 完整结构（含 onclick / 属性）
    const chips = await f.evaluate(() => {
      const out = [];
      document.querySelectorAll('li').forEach(el => {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (/^(1|2|3)?\s*(学习目标|视频|章节测验|讨论|文档|课件|阅读|作业|考试|直播)$/.test(t) && t.length < 16) {
          out.push({ text: t, html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 400) });
        }
      });
      return out.slice(0, 10);
    }).catch(() => []);
    if (chips.length) {
      console.log('[当前节任务点 chips 完整结构]', f.url().slice(0, 70));
      chips.forEach(c => console.log('>>>', c.text, '\n   ', c.html, '\n'));
    }

    // D) 页面全局变量里有没有任务点数据
    const globals = await f.evaluate(() => {
      const keys = [];
      for (const k of Object.keys(window)) {
        if (/job|task|point|chapter/i.test(k) && typeof window[k] !== 'function') {
          const v = window[k];
          if (v && typeof v === 'object') keys.push(k + ' = ' + JSON.stringify(v).slice(0, 160));
        }
      }
      return keys.slice(0, 12);
    }).catch(() => []);
    if (globals.length) {
      console.log('[全局变量候选]', f.url().slice(0, 70));
      globals.forEach(g => console.log('   ', g));
    }
  }
  process.exit(0);
})();
