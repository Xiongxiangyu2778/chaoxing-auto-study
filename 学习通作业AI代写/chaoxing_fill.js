/* 通用：按 answers.json 填答当前超星作业（带逐题验证），填完点暂时保存
   answers.json 格式：
   {
     "single": ["B","B",...],        // 单选按题号顺序
     "judge":  ["A","B",...],        // 判断 A=对 B=错
     "blank":  ["语义", ...],         // 填空按题号顺序
     "essay":  ["答案文本", ...]      // 简答+计算按题号顺序
   } */
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) {
  try { ({ chromium } = require(path.join(__dirname, 'node_modules', 'playwright-core'))); }
  catch (e2) { ({ chromium } = require(path.join(__dirname, '..', '刷章节', 'node_modules', 'playwright-core'))); }
}
// ── 便携化（2026-10-13）：浏览器自动探测 + 登录态目录跟随用户 ──
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => { try { return fs.existsSync(p); } catch (e) { return false; } })
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = process.env.CHX_PROFILE
  ? process.env.CHX_PROFILE
  : (fs.existsSync(path.join(os.homedir(), 'edge-quiz-profile'))
    ? path.join(os.homedir(), 'edge-quiz-profile')
    : path.join(__dirname, '..', 'edge-profile'));
const PORT = process.env.CHX_PORT || '9222';
let ANS;
try {
  ANS = JSON.parse(fs.readFileSync(__dirname + '/answers.json', 'utf-8'));
} catch (e) {
  console.error('[ERROR] 读不到或解析失败 answers.json：' + e.message);
  console.error('        answers.json 必须与本脚本同目录，格式：{ "single": [], "judge": [], "blank": [], "essay": [] }');
  console.log('CHX_RESULT ' + JSON.stringify({ action: 'fill', ok: false, error: 'answers.json 不可用: ' + e.message }));
  process.exit(2);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(new Date().toISOString().slice(11,19), m);

(async () => {
  // 优先连接「独立 Edge」（9222）——与刷课脚本共用同一个窗口，避免两个进程抢同一个
  // user-data-dir 导致 profile 锁冲突；连不上才自己拉起浏览器（兜底）。
  // close() 只是断开调试连接，不会关掉浏览器，窗口始终由你手动关。
  let browser = null;
  let viaCDP = false;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 5000 });
    viaCDP = true;
    log(`已连接独立 Edge（调试端口 ${PORT}）→ 复用现有窗口，不会另开浏览器`);
  } catch (e) {
    log(`未发现独立 Edge（${PORT}）→ 自行启动浏览器`);
    browser = await chromium.launchPersistentContext(PROFILE, {
      executablePath: EDGE, headless: false, viewport: null,
      args: ['--no-first-run', '--window-size=1400,900']
    });
  }
  const ctx = (typeof browser.contexts === 'function')
    ? (browser.contexts()[0] || await browser.newContext())
    : browser;
  let page = ctx.pages()[0] || await ctx.newPage();
  const WAIT_MS = Math.max(0, Number(process.env.CHX_WAIT_SECONDS ?? 600)) * 1000;
  // 作答页识别（v2）：不再死认 dowork —— 有些作业页是 doHomeWorkNew / work/... 格式。
  // 规则：优先 URL 像作答页；否则看哪个页面里**真的有题目块** div.questionLi。
  const ANSWER_URL = /(dowork|doHomeWork|work\/doWork|work\/answer)/i;
  async function findAnswerPage() {
    const pages = ctx.pages();
    const byUrl = pages.find(p => ANSWER_URL.test(p.url()));
    if (byUrl) return byUrl;
    for (const p of pages) {
      const n = await p.$$eval('div.questionLi', els => els.length).catch(() => 0);
      if (n > 0) return p;
    }
    return null;
  }
  let target = await findAnswerPage();
  if (!target) {
    log(`等待你打开作业作答页（最多 ${WAIT_MS / 1000} 秒）...`);
    const t0 = Date.now();
    while (!target && Date.now() - t0 < WAIT_MS) {
      target = await findAnswerPage();
      if (!target) await sleep(3000);
    }
  }
  if (!target) { log('超时退出'); await browser.close(); process.exit(2); }
  page = target;
  await page.waitForSelector('.questionLi', { state: 'attached', timeout: 45000 });
  await page.waitForTimeout(5000);

  const stat = { single: 0, judge: 0, blank: 0, essay: 0, errs: [] };
  const blocks = await page.$$('div.questionLi');

  for (const q of blocks) {
    const type = await q.getAttribute('typename');
    const numTxt = (await q.$eval('h3.mark_name', h => h.innerText).catch(()=> '')) || '';
    const num = parseInt((numTxt.match(/\d+/) || ['0'])[0]);
    try {
      if (type === '单选题') {
        const want = ANS.single[num-1];
        if (!want) continue;
        const qid = (await q.getAttribute('id')).replace('question','');
        for (let a = 1; a <= 3; a++) {
          let cur = await q.$eval(`#answer${qid}`, el => el.value).catch(()=> '');
          if (cur === want) { stat.single++; break; }
          const opts = await q.$$('div.answerBg');
          let hit = null;
          for (const o of opts) {
            const sp = await o.$('span[data]');
            const d = sp ? await sp.getAttribute('data') : '';
            const t = sp ? (await sp.innerText()).trim() : '';
            if (d === want || t === want) { hit = o; break; }
          }
          if (!hit) break;
          await hit.click(); await sleep(500);
          cur = await q.$eval(`#answer${qid}`, el => el.value).catch(()=> '');
          if (cur === want) { stat.single++; break; }
          if (cur === '') await q.$eval(`#answer${qid}`, (el, v) => { el.value = v; }, want);
        }
        const fin = await q.$eval(`#answer${qid}`, el => el.value).catch(()=> '');
        if (fin !== want) stat.errs.push(`单选${num}`);
      }
      else if (type === '判断题') {
        const want = ANS.judge[stat.judge];
        if (!want) continue;
        const opts = await q.$$('div.answerBg');
        let hit = null;
        for (const o of opts) {
          const sp = await o.$('span[data]');
          const d = sp ? await sp.getAttribute('data') : '';
          const t = sp ? (await sp.innerText()).trim() : '';
          if (d === want || t === want || (want === 'A' && d === 'true') || (want === 'B' && d === 'false')) { hit = o; break; }
        }
        if (hit) { await hit.click(); await sleep(400); stat.judge++; } else stat.errs.push(`判断${num}`);
      }
      else if (type === '填空题') {
        const ifr = await q.$$('.edui-editor-iframeholder iframe');
        let filled = 0;
        for (const ed of ifr) {
          const val = ANS.blank[stat.blank];
          if (val === undefined) break;
          await ed.evaluate((el, v) => {
            const b = el.contentDocument && el.contentDocument.body;
            if (b) b.innerHTML = '<p>' + v + '</p>';
          }, val);
          stat.blank++; filled++;
        }
        if (!filled) stat.errs.push(`填空${num}`);
        // 附件上传（老师说填空题用附件提交）：在第一处出现 file 输入的填空题上传一次
        if (ANS.attachment && !stat.attach) {
          const fis = await q.$$('input[type=file]');
          if (fis.length) {
            try {
              await fis[0].setInputFiles(ANS.attachment);
              await sleep(4000);
              stat.attach = 1;
              log(`已上传附件到填空题${num}: ` + require('path').basename(ANS.attachment));
            } catch (e) { log(`填空${num}附件尝试失败: ` + e.message.slice(0, 40)); }
          }
        }
      }
      else if (type === '听力题') {
        // 听力题（2026-10-18）：音频 + 若干挖空 UEditor。答案按顺序取 ANS.blank 队列。
        // ⚠ 必须写进 .edui-editor-iframeholder iframe 的 body（UEditor 界面），
        //    直接改 textarea.value 编辑器不认、保存为空 —— 踩过坑的。
        const ifr = await q.$$('.edui-editor-iframeholder iframe');
        let filled = 0;
        for (const ed of ifr) {
          const val = ANS.blank[stat.blank];
          if (val === undefined) break;
          await ed.evaluate((el, v) => {
            const b = el.contentDocument && el.contentDocument.body;
            if (b) b.innerHTML = '<p>' + v + '</p>';
          }, val);
          stat.blank++; filled++;
        }
        if (!filled) stat.errs.push(`听力${num}`);
      }
      else if (type === '简答题' || type === '计算题') {
        const val = ANS.essay[stat.essay];
        if (val === undefined) continue;
        const ifr = await q.$$('.edui-editor-iframeholder iframe');
        if (ifr.length) {
          const html = val.split('\n').map(l => '<p>' + l + '</p>').join('');
          await ifr[0].evaluate((el, v) => {
            const b = el.contentDocument && el.contentDocument.body;
            if (b) b.innerHTML = v;
          }, html);
          stat.essay++;
        } else stat.errs.push(`问答${num}`);

        // 附件上传（若本题有 file 输入且 answers.json 指定了 attachment；尚未传过才传）
        if (ANS.attachment && !stat.attach) {
          const fis = await q.$$('input[type=file]');
          if (fis.length) {
            try {
              await fis[0].setInputFiles(ANS.attachment);
              await sleep(4000);
              stat.attach = (stat.attach || 0) + 1;
              log(`已上传附件到第${num}题: ` + require('path').basename(ANS.attachment));
            } catch (e) { stat.errs.push(`附件${num}:` + e.message.slice(0, 40)); }
          }
        }
      }
    } catch (e) { stat.errs.push(`${type}${num}: ` + e.message.slice(0,30)); }
  }

  log(`结果: 单选${stat.single} 判断${stat.judge} 填空${stat.blank} 问答${stat.essay} 附件${stat.attach || 0}` + (stat.errs.length ? ' | 异常: ' + stat.errs.join(',') : ' | 全部成功'));
  await page.evaluate(() => { try { for (const k in window.$EDITORUI) { const e = window.$EDITORUI[k]; if (e && e.sync) e.sync(); } } catch (e) {} });
  try {
    await page.click('text=暂时保存', { timeout: 15000 });
    await page.waitForTimeout(1500);
    try { const ok = await page.waitForSelector('.layui-layer-btn0', { timeout: 8000 }); if (ok) await ok.click(); } catch (e) {}
    log('已暂时保存，请人工核对后自行提交！');
  } catch (e) { log('保存异常: ' + e.message.slice(0,50)); }
  await page.screenshot({ path: __dirname + '/quiz_filled.png' });

  // ── 机器可读结果（供 AI / 上层脚本解析）──
  console.log('CHX_RESULT ' + JSON.stringify({
    action: 'fill', ok: stat.errs.length === 0,
    filled: { single: stat.single, judge: stat.judge, blank: stat.blank, essay: stat.essay, attachment: stat.attach || 0 },
    errors: stat.errs,
    files: ['quiz_filled.png']
  }));

  // ── 收尾策略（2026-10-17 接口化改造，向后兼容）──
  //   CHX_AFTER=exit  → 立即退出，浏览器窗口保持打开（AI 调用推荐）
  //   默认 wait       → 保持原行为：留 25 分钟给你核对并手动点「提交作业」
  const AFTER = process.env.CHX_AFTER || 'wait';
  if (AFTER === 'exit') {
    log('CHX_AFTER=exit：立即退出，浏览器窗口保持打开 —— 请核对后自行点「提交作业」');
    if (viaCDP) { try { await browser.close(); } catch (e) {} }   // CDP 只是断开调试连接，不关窗口
    await sleep(300);
    process.exit(stat.errs.length === 0 ? 0 : 3);
  }
  log('浏览器保持打开 25 分钟，请核对答案并自行点击「提交作业」');
  await sleep(Math.max(0, Number(process.env.CHX_KEEP_OPEN_SECONDS ?? 1500)) * 1000);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
