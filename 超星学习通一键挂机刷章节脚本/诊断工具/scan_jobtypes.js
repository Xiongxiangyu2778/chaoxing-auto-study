// 只读探测：扫描右侧目录，读取每节的任务点数（inc）+ 行内原始结构，判断是否存在 >2 个任务点的节
// 只读，不点击任何导航元素，不影响正在运行的刷课脚本
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) {
  ({ chromium } = require('C:/Users/Public/.workbuddy/binaries/node/workspace/node_modules/playwright-core'));
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 8000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => /studentstudy/i.test(p.url()))
    || ctx.pages().find(p => /chaoxing\.com/i.test(p.url()));
  if (!page) { console.log('没找到课程页'); process.exit(1); }

  console.log('当前页:', page.url().slice(0, 100));

  // 1) 当前节的任务点标签（顶部 chips）
  for (const f of page.frames()) {
    const chips = await f.evaluate(() => {
      const out = [];
      // 常见：li 形式的章节内容标签
      document.querySelectorAll('li, .chapter_item, .posCatalog_name').forEach(el => {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (/^\d*\s*(学习目标|视频|章节测验|测验|文档|PPT|课件|阅读|讨论|作业|考试|图书|直播)\s*$/.test(t) && t.length < 20) {
          out.push({ tag: el.tagName, cls: String(el.className).slice(0, 50), text: t, vis: el.offsetWidth > 0 });
        }
      });
      return out.slice(0, 12);
    }).catch(() => []);
    if (chips && chips.length) {
      console.log('\n[任务点标签] frame:', f.url().slice(0, 80));
      chips.forEach(c => console.log('   ', c.text, '|', c.tag, '|', c.cls, '| vis=', c.vis));
    }
  }

  // 2) 右侧目录：每行的未完成数 + 行内 HTML（找 jobcount / 任务点标记）
  for (const f of page.frames()) {
    const rows = await f.evaluate(() => {
      const out = [];
      document.querySelectorAll('[class*="catalog"] li, .posCatalog_level li, ul.jobUncount li').forEach(el => {
        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!txt) return;
        // 未完成数：行尾数字
        const m = txt.match(/(\d+)\s*$/);
        out.push({
          text: txt.slice(0, 40),
          inc: m ? Number(m[1]) : null,
          html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 260),
        });
      });
      return out.slice(0, 60);
    }).catch(() => []);
    if (rows && rows.length) {
      console.log('\n[目录行] frame:', f.url().slice(0, 80), ' 行数:', rows.length);
      rows.forEach(r => console.log(`   inc=${r.inc === null ? '?' : r.inc} | ${r.text}`));
      console.log('\n--- 前 3 行原始 HTML ---');
      rows.slice(0, 3).forEach(r => console.log(r.html, '\n'));
    }
  }

  process.exit(0);
})();
