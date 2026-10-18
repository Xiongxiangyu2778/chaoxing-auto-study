/**
 * 超星学习通 · 考试页通用填答脚本
 * 位置: 学习通作业助手\考试\chaoxing_exam_fill.js
 * 工作目录: 默认 ..\写作业\（answers.json / 考试单元.json / 题目.txt 都在那里），
 *           可用环境变量 CHX_WORKDIR 覆盖。
 *
 * 通用性：不依赖课程内容，只依赖学习通考试页的统一 DOM 版式。
 *   - 单选题/多选题/阅读理解 → 点 span[data=A/B/C/D]（多选连点多个字母）
 *   - 判断题               → 同上，A=正确 B=错误（自动翻译对/错/true/false）
 *   - 填空题/简答题/计算题   → 写入 UEditor iframe（富文本编辑器）
 * 任何课程、任何科目的考试页都可以直接用，只要题目能从页面上抓到。
 *
 * 用法:
 *   node chaoxing_exam_fill.js
 * 前提:
 *   1) 浏览器调试端口已开（默认 9222）且停在考试页
 *   2) 已跑过一遍导出：python chx.py dump → 生成 考试单元.json + answers.json
 */
const fs = require('fs');
const path = require('path');
const pw = require('playwright-core');

const PORT = process.env.CHX_PORT || '9222';
const WORKDIR = process.env.CHX_WORKDIR
  || (fs.existsSync(path.join(__dirname, '..', '写作业', 'chx.py'))
    ? path.join(__dirname, '..', '写作业')
    : __dirname);
const log = m => console.log('[exam-fill] ' + m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 题型 → answers.json 队列 ──
function queueOf(type, ans) {
  const t = String(type || '');
  if (/判断/.test(t)) return ans.judge || [];
  if (/填空/.test(t)) return ans.blank || [];
  if (/简答|计算|论述|写作|翻译|问答/.test(t)) return ans.essay || [];
  return ans.single || [];   // 单选 / 多选 / 阅读理解
}
// ── 答案归一化：判断对错 → A/B；多选数组 → 字符串 ──
function normOption(v, type) {
  if (Array.isArray(v)) v = v.join('');
  let s = String(v == null ? '' : v).trim();
  if (/判断/.test(String(type))) {
    if (/^(对|正确|是|true|t|√|a)$/i.test(s)) return 'A';
    if (/^(错|错误|否|false|f|×|b)$/i.test(s)) return 'B';
  }
  // 只保留选项字母（"A." / "选A" / "A、C" 都能救）
  const letters = (s.match(/[A-H]/gi) || []).join('').toUpperCase();
  return letters || s.toUpperCase();
}
// ── 文本答案分空：一个空直接写；多个空支持 || ； ; 分隔 ──
function splitBlanks(v) {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v == null ? '' : v);
  const parts = s.split(/\|\||；|;/).map(x => x.trim()).filter(Boolean);
  return parts.length ? parts : [s];
}

async function main() {
  const unitsFile = path.join(WORKDIR, '考试单元.json');
  if (!fs.existsSync(unitsFile)) {
    log('✗ 找不到 考试单元.json —— 请先运行: python chx.py dump（考试页会自动走逐题导出）');
    process.exit(2);
  }
  const meta = JSON.parse(fs.readFileSync(unitsFile, 'utf-8'));
  const units = meta.units || [];
  if (!units.length) { log('✗ 考试单元.json 里没有可答单元'); process.exit(2); }

  let ans = {};
  const ansFile = path.join(WORKDIR, 'answers.json');
  if (fs.existsSync(ansFile)) ans = JSON.parse(fs.readFileSync(ansFile, 'utf-8'));
  if (!ans || !Object.keys(ans).length) { log('✗ answers.json 不存在或为空（先跑 AI 答题）'); process.exit(2); }

  // 按题号分组，保持出现顺序（子题按 sub 升序）
  const byQ = new Map();
  for (const u of units) {
    const k = String(u.examNum);
    if (!byQ.has(k)) byQ.set(k, []);
    byQ.get(k).push(u);
  }
  for (const arr of byQ.values()) arr.sort((a, b) => (a.sub || 0) - (b.sub || 0));

  const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const page = browser.contexts()[0].pages().find(p => /exam-ans|reVersionTest/i.test(p.url()));
  if (!page) { log('✗ 没找到考试作答页（请先进入考试，验证码需人工过）'); process.exit(2); }

  const stat = { filled: 0, skipped: [], errs: [], byType: {} };
  const cursor = { single: 0, judge: 0, blank: 0, essay: 0 };

  for (const [examNum, qUnits] of byQ) {
    // 切到该题
    const okNav = await page.evaluate(n => {
      const li = [...document.querySelectorAll('li')].find(e =>
        (e.innerText || '').trim() === String(n) &&
        (e.getAttribute('onclick') || '').includes('getTheQuestionByStart'));
      if (!li) return false;
      li.click(); return true;
    }, examNum).catch(() => false);
    if (!okNav) { log('✗ 答题卡上找不到第' + examNum + '题，跳过'); stat.skipped.push(examNum); continue; }

    // 等渲染（题干出现 + 有可答元素）
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      ready = await page.evaluate(() => {
        const q = document.querySelector('div.questionLi');
        if (!q || !q.querySelector('h3')) return false;
        return !!q.querySelector('span[data], .edui-editor-iframeholder iframe, textarea');
      }).catch(() => false);
      if (ready) break;
    }
    if (!ready) { log('第' + examNum + '题无可答元素（等待超时），跳过'); stat.skipped.push(examNum); continue; }

    for (const u of qUnits) {
      const type = u.type || '';
      const bucket = /判断/.test(type) ? 'judge'
        : /填空/.test(type) ? 'blank'
        : /简答|计算|论述|写作|翻译|问答/.test(type) ? 'essay'
        : 'single';
      const arr = queueOf(type, ans);
      const raw = arr[cursor[bucket]];
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        stat.errs.push(`第${examNum}题${u.sub ? '-' + u.sub : ''}(${type}) 答案缺失`);
        continue;
      }
      cursor[bucket]++;
      const sub = Number(u.sub || 0);
      const isText = bucket === 'blank' || bucket === 'essay';

      if (!isText) {
        // ── 选择题 / 判断题：点 span[data=字母]，多选连点 ──
        const letters = normOption(raw, type).replace(/[^A-H]/g, '') || normOption(raw, type);
        const filled = await page.evaluate(({ sub, letters }) => {
          const q = document.querySelector('div.questionLi');
          const groups = q.querySelectorAll('.reading_answer');
          const scope = groups.length && sub > 0 ? groups[sub - 1] : q;
          const spans = [...scope.querySelectorAll('span[data]')];
          const done = [];
          for (const ch of letters) {
            const t = spans.find(s => s.getAttribute('data') === ch);
            if (t) { t.click(); done.push(ch); }
          }
          return done.join('');
        }, { sub, letters });
        await sleep(600);
        // 复核选中状态
        const got = await page.evaluate(({ sub }) => {
          const q = document.querySelector('div.questionLi');
          const groups = q.querySelectorAll('.reading_answer');
          const scope = groups.length && sub > 0 ? groups[sub - 1] : q;
          const hits = [...scope.querySelectorAll('span[data]')]
            .filter(s => /check_answer|check|active|select/i.test(s.className))
            .map(s => s.getAttribute('data'));
          return hits.join('');
        }, { sub }).catch(() => '');
        const expect = letters.split('').sort().join('');
        const actual = String(got || '').split('').sort().join('');
        if (actual === expect) { stat.filled++; stat.byType[bucket] = (stat.byType[bucket] || 0) + 1; }
        else if (!filled) stat.errs.push(`第${examNum}题${sub ? '-' + sub : ''}(${type}) 选项 ${letters} 不存在`);
        else { stat.filled++; stat.byType[bucket] = (stat.byType[bucket] || 0) + 1; log(`  第${examNum}题${sub ? '-' + sub : ''} 已点 ${filled}（页面无选中标记，以点击为准）`); }
      } else {
        // ── 填空 / 简答：写 UEditor iframe ──
        const pieces = splitBlanks(raw);
        const res = await page.evaluate(({ sub, pieces }) => {
          const q = document.querySelector('div.questionLi');
          const groups = q.querySelectorAll('.reading_answer');
          const scope = groups.length && sub > 0 ? groups[sub - 1] : q;
          const ifr = [...scope.querySelectorAll('.edui-editor-iframeholder iframe')];
          const tas = [...scope.querySelectorAll('textarea')].filter(t => !t.disabled);
          const n = ifr.length || tas.length;
          if (!n) return { ok: 0, total: pieces.length, why: 'no-editor' };
          let ok = 0;
          for (let i = 0; i < n && i < pieces.length; i++) {
            const val = pieces[i];
            if (ifr[i]) {
              const bd = ifr[i].contentDocument && ifr[i].contentDocument.body;
              if (bd) { bd.innerHTML = '<p>' + val.replace(/</g, '&lt;') + '</p>'; ok++; }
            } else if (tas[i]) {
              tas[i].value = val;
              tas[i].dispatchEvent(new Event('input', { bubbles: true }));
              tas[i].dispatchEvent(new Event('change', { bubbles: true }));
              ok++;
            }
          }
          // 尝试触发编辑器同步
          try {
            if (window.UE && typeof UE.getEditor === 'function') {
              for (const id in (window.UE.instances || {})) {
                const ed = window.UE.instances[id];
                if (ed && typeof ed.sync === 'function') ed.sync();
              }
            }
            if (window.$EDITORUI) {
              for (const k in window.$EDITORUI) {
                const e = window.$EDITORUI[k];
                if (e && typeof e.sync === 'function') e.sync();
              }
            }
          } catch (e) {}
          return { ok, total: pieces.length, why: '' };
        }, { sub, pieces });
        await sleep(500);
        // 复核：编辑器里确实有文字
        const readBack = await page.evaluate(({ sub }) => {
          const q = document.querySelector('div.questionLi');
          const groups = q.querySelectorAll('.reading_answer');
          const scope = groups.length && sub > 0 ? groups[sub - 1] : q;
          const ifr = [...scope.querySelectorAll('.edui-editor-iframeholder iframe')];
          const tas = [...scope.querySelectorAll('textarea')].filter(t => !t.disabled);
          const texts = ifr.map(f => (f.contentDocument && f.contentDocument.body ? f.contentDocument.body.innerText.trim() : ''));
          const vals = tas.map(t => (t.value || '').trim());
          return texts.length ? texts : vals;
        }, { sub }).catch(() => []);
        const written = (readBack || []).filter(t => t).length;
        if (written >= Math.min(pieces.length, res.ok || 1)) {
          stat.filled++; stat.byType[bucket] = (stat.byType[bucket] || 0) + 1;
        } else {
          stat.errs.push(`第${examNum}题${sub ? '-' + sub : ''}(${type}) 编辑器写入失败(${res.why || 'empty'})`);
        }
      }
    }
    log(`第${examNum}题（${qUnits.length}单元）完成 → 累计 ${stat.filled}`);
  }

  log(`==== 完成：成功 ${stat.filled} / 失败 ${stat.errs.length} / 跳过 ${stat.skipped.length} ====`);
  log('分题型：' + JSON.stringify(stat.byType));
  stat.errs.forEach(e => log('✗ ' + e));
  fs.writeFileSync(path.join(WORKDIR, '考试填答结果.json'), JSON.stringify(stat, null, 2), 'utf-8');
  await browser.close();
  process.exit(stat.errs.length ? 1 : 0);
}

if (require.main === module) {
  main().catch(e => { console.error('[exam-fill] FATAL', e.message); process.exit(1); });
} else {
  // 供单元测试使用（不启动浏览器）
  module.exports = { queueOf, normOption, splitBlanks };
}
