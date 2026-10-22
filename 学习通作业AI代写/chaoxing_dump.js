/* 通用：导出当前超星作业页的所有题目文本 → 题目.txt
   用法：先手动打开作业作答页（dowork），再运行本脚本

   ═══ v6.2（2026-10-22）★★ 考试页「无效参数」根因修复 ★★ ═══
   症状：所有题目抓完之后，页面立刻跳成「无效参数」，作答会话废掉。
   根因：旧版 total = 答题卡数 + 1，最后一轮对不存在的「第 N+1 题」越界调用
        getTheQuestionByStart(题数, '0')（答题卡下标是 0 基，50 题上限是 49）
        → 学习通前端直接跳错误页。
   修法：① 读每张答题卡 li 的 onclick，解析出真实下标，只调用实际存在的题号；
        ② 切题后检测 URL 跳出 / 题目 12 秒不渲染 → 立刻停手，已抓部分照常落盘；
        ③ 残卷保护：本次抓到的比上次已导出的少 → 不覆盖旧文件；
        ④ 收尾体检：抓完若发现页面已失效，明确提示「题目已存好，填答前需重新进考试」。
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); }                                       // NODE_PATH / 常规安装
catch (e) {
  try { ({ chromium } = require(path.join(__dirname, 'node_modules', 'playwright-core'))); } // 便携：自己的 node_modules
  catch (e2) { ({ chromium } = require(path.join(__dirname, '..', '刷章节', 'node_modules', 'playwright-core'))); } // 便携：借刷章节的
}
// ── 便携化（2026-10-13）：浏览器自动探测 + 登录态目录跟随用户，拷到别的电脑也能用 ──
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
  // 若当前页不是作答页，轮询等待用户进入
  // 等待时长可用环境变量覆盖（AI 调用时建议调小，避免长时间阻塞）
  const WAIT_MS = Math.max(0, Number(process.env.CHX_WAIT_SECONDS ?? 600)) * 1000;
  // 作答页识别（v2）：不再死认 dowork —— 学习通有些作业页是 doHomeWorkNew / work/... 格式。
  // 规则：优先 URL 像作答页；否则看哪个页面里**真的有题目块** div.questionLi。
  // v6（2026-10-22）：把「考试作答页」也纳入 URL 直认。
  // 旧版只认作业页 URL，考试页靠 DOM 兜底探测；但 Edge 的休眠标签页会让 $$eval 永不返回，
  // 导致轮询死等（实测：考试已经开始 90 秒脚本还在「等待你打开作答页」）。
  // 注意 exam-ans/exam/test（列表页）不带 reVersionTest，不会被误认。
  const ANSWER_URL = /(dowork|doHomeWork|work\/doWork|work\/answer|reVersionTest)/i;
  // DOM 探测加超时：单页最多 3s，挂起的标签页直接跳过
  const probeQ = (p) => Promise.race([
    p.$$eval('div.questionLi', els => els.length).catch(() => 0),
    sleep(3000).then(() => 0),
  ]);
  async function findAnswerPage() {
    const pages = ctx.pages();
    // v6.2：URL 命中还不够 —— 必须页面上真有题目块或答题卡，才认定为作答页。
    // （考试列表页/空壳页可能也带 reVersionTest 字样，误认后遍历会全部抓空）
    const hasCards = (p) => Promise.race([
      p.$$eval('li[onclick*="getTheQuestionByStart"]', els => els.length).catch(() => 0),
      sleep(3000).then(() => 0),
    ]);
    for (const p of pages.filter(x => ANSWER_URL.test(x.url()))) {
      if (await probeQ(p) > 0) return p;
      if (await hasCards(p) > 0) return p;
    }
    for (const p of pages) {
      const n = await probeQ(p);
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
  log('已定位作答页');

  // ===== 考试模式（v5, 2026-10-18）：exam-ans/reVersionTestStartNew 逐题版式 =====
  // 一屏只有 1 道题，答题卡 li[onclick=getTheQuestionByStart(下标,'0')] 切题。
  // 策略：逐题切换 → 每屏抽取「可答单元」（大题的子题平铺为独立条目）→ 汇总。
  if (/exam-ans|reVersionTest/i.test(target.url())) {
    log('检测到考试页 → 逐题遍历模式');
    // ═══ v6.2（2026-10-22）★★ 考试页「无效参数」的真凶：越界切题 ★★ ═══
    // 现场观察：页面失效（显示「无效参数」）恰好发生在【所有题目抓完之后】。
    // 原因：旧版 total = 答题卡数 + 1（50 题 → total=51），最后一轮 idx=50 调用
    //       getTheQuestionByStart(50, '0')，而答题卡下标是 0 基（第 50 题 = 49），
    //       传 50 = 越界 → 学习通前端直接跳错误页，把整场考试的作答会话搞死。
    // 修法：不再用 idx 从 0 累加去猜下标，直接读每张答题卡 li 的 onclick，
    //       解析出学习通自己传的真实下标 → 有 50 张卡就只调用这 50 个下标，绝不越界。
    let cardIdx = [];
    for (let k = 0; k < 5; k++) {
      cardIdx = await target.evaluate(() => {
        const lis = [...document.querySelectorAll('li')].filter(e =>
          /^\d{1,2}$/.test((e.innerText || '').trim()) &&
          (e.getAttribute('onclick') || '').includes('getTheQuestionByStart'));
        return lis.map(e => {
          const oc = e.getAttribute('onclick') || '';
          const m = oc.match(/getTheQuestionByStart\(\s*['"]?(\d+)['"]?/);
          if (m) return Number(m[1]);
          // 兜底：onclick 里没写死数字时，用卡面题号（1 基）换算成 0 基
          const n = parseInt((e.innerText || '').trim(), 10);
          return Number.isFinite(n) ? n - 1 : null;
        }).filter(v => v !== null && Number.isFinite(v));
      }).catch(() => []);
      if (cardIdx.length) break;
      log('  答题卡未渲染完，1.5s 后重试…');
      await sleep(1500);
    }
    cardIdx = [...new Set(cardIdx)].sort((a, b) => a - b);   // 去重 + 升序（防重复卡/多套卡）
    const total = cardIdx.length;
    log(total
      ? `共 ${total} 题（答题卡下标 ${cardIdx[0]}~${cardIdx[total - 1]}）开始逐题抓取…`
      : '✗ 没读到任何答题卡，无法遍历');
    const units = [];
    const seen = new Set();
    let partial = false;      // true = 中途页面失效，抓到的是残卷
    for (let n = 0; n < cardIdx.length; n++) {
      const idx = cardIdx[n];
      await target.evaluate(i => getTheQuestionByStart(i, '0'), idx).catch(() => {});
      // 等当前题渲染稳定（题干文本连续两次一致）；同时每轮检查 URL，
      // 一旦发现已经离开作答页（跳错误页/交卷页）立刻断开，不必白等满 12 秒
      let sig = '', stable = 0, urlLost = '';
      for (let w = 0; w < 15; w++) {
        await sleep(800);
        const s = await target.evaluate(() => {
          const el = document.querySelector('div.questionLi');
          return {
            t: el ? (el.innerText || '').replace(/\s+/g, ' ').slice(0, 120) : '',
            url: location.href,
          };
        }).catch(() => ({ t: '', url: '' }));
        if (s.url && !/exam-ans|reVersionTest/i.test(s.url)) { urlLost = s.url; break; }
        if (s.t && s.t === sig) { if (++stable >= 2) break; } else { stable = 0; sig = s.t; }
      }
      // 🛡 v6.2：切题后「页面还活着吗」——URL 跑出作答页，或题干等了 12 秒仍是空，
      // 都说明已经不在作答状态（会话被踢 / 跳了错误页）。此时必须立刻停手：
      // 已抓到的照常落盘，绝不继续切题把整场考试搞废
      if (urlLost || !sig) {
        const st = await target.evaluate(() => ({
          url: location.href,
          head: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 100),
        })).catch(() => ({ url: urlLost || '?', head: '?' }));
        log(`⚠ 第 ${n + 1}/${total} 题切不过去（${urlLost ? '页面已跳出作答页' : '题目长期不渲染'}）`);
        log(`   当前 URL：${st.url}`);
        log(`   页面文字：${st.head || '(空)'}`);
        log(`   已抓 ${units.length} 题 → 立即停止抓取，保留已抓部分`);
        partial = true;
        break;
      }
      const got = await target.evaluate(() => {
        const el = document.querySelector('div.questionLi');
        if (!el) return [];
        const h3txt = (el.querySelector('h3')?.innerText || '').replace(/\s+/g, ' ').trim();
        const examNum = (h3txt.match(/^(\d+)\./) || [])[1] || '?';
        const examType = ((h3txt.match(/[（(]([^,（)]+)[,，]/) || [])[1] || '').trim();
        const audioOids = [...el.querySelectorAll('iframe.ans-insertaudio-module')].map(f => f.getAttribute('data'));
        const units = [];
        const pushUnit = (u) => units.push(u);
        const subs = [...el.querySelectorAll('.reading_answer')];
        if (subs.length) {
          // 大题带子题（听力/阅读）：每个子题是独立可答单元
          subs.forEach((ra, k) => {
            const tit = (ra.querySelector('.reader_answer_tit')?.innerText || '').replace(/\s+/g, ' ').trim();
            const type = ((ra.querySelector('.read_type')?.innerText || '').match(/[（(]([^）)]+)[）)]/) || [])[1] || examType || '单选题';
            pushUnit({
              examNum, sub: k + 1, type,
              text: tit.replace(/^\(\d+\)/, '').replace(/^[（(][^）)]+[）)]/, '').trim(),
              options: [...ra.querySelectorAll('span[data]')].map(s =>
                s.getAttribute('data') + ' ' + (s.parentElement.innerText || '').replace(/\s+/g, ' ').trim()),
              audioOids,
            });
          });
        } else {
          // 普通单题
          const type = examType || (el.getAttribute('typename') || '单选题');
          pushUnit({
            examNum, sub: 0, type,
            text: h3txt.replace(/^\d+\.\s*/, '').replace(/^[（(][^）)]+[,，][^）)]*[）)]\s*/, '').trim(),
            options: [...el.querySelectorAll('span[data]')].map(s =>
              s.getAttribute('data') + ' ' + (s.parentElement.innerText || '').replace(/\s+/g, ' ').trim()),
            audioOids,
          });
        }
        return units;
      });
      for (const u of got) {
        const key = u.examNum + '-' + u.sub;
        if (seen.has(key)) continue;
        seen.add(key);
        units.push(u);
      }
      log(`  [${n + 1}/${total}] 抓到 ${got.length} 个可答单元（累计 ${units.length}）`);
    }
    // 🛡 v6（2026-10-22）：抓 0 题时**不覆盖**已有文件，避免一次竞态把导出的题目清成空文件
    if (!units.length) {
      log('✗ 没抓到任何题目（页面可能正在切换/渲染）→ 保留原有 题目.txt / 答案模板.json 不覆盖');
      log('  建议：在浏览器里点一下答题卡第 1 题，等题目显示出来再重跑');
      await browser.close();
      process.exit(3);
    }
    // 🛡 v6.2：残卷保护 —— 中途页面失效只抓到一部分时，若比上次已导出的还少，
    // 绝不覆盖旧文件（上次就被一次竞态把完整的 50 题冲成了 1 题）
    let prevCount = 0;
    try {
      const pf = __dirname + '/考试单元.json';
      if (fs.existsSync(pf)) prevCount = ((JSON.parse(fs.readFileSync(pf, 'utf-8')).units) || []).length;
    } catch (e) {}
    if (partial && units.length < prevCount) {
      log(`✗ 本次只抓到 ${units.length} 题（上次已导出 ${prevCount} 题更完整）→ 保留旧文件，不覆盖`);
      log('  建议：重新进入考试作答页后重跑；已有题目可直接用 --skip-dump 继续答题');
      await browser.close();
      process.exit(5);
    }
    if (partial) {
      log(`⚠ 本次是残卷：${units.length} 题 / 答题卡 ${total} 题，已按残卷落盘（下游会提示题数不符）`);
    }
    // 写题目.txt：平铺编号，标注考试原题号；听力题在题干里带上音频标记
    let out = '';
    units.forEach((u, i) => {
      const tag = u.sub ? `（考试第${u.examNum}题-${u.sub}）` : `（考试第${u.examNum}题）`;
      out += `${i + 1}. (${u.type}) ${tag} ${u.text}\n`;
      for (const o of u.options) out += '   ' + o + '\n';
      out += '\n';
    });
    fs.writeFileSync(__dirname + '/题目.txt', out, 'utf-8');
    // 📝 考试答案模板（2026-10-18）：按单元题型生成，避免沿用上一份作业的旧模板导致题号错位
    const tmpl = { single: [], judge: [], blank: [], essay: [] };
    for (const u of units) {
      const t = String(u.type || '');
      if (/判断/.test(t)) tmpl.judge.push('');
      else if (/填空/.test(t)) tmpl.blank.push('');
      else if (/单选|多选|阅读|理解|选择/.test(t)) tmpl.single.push('');
      else if (/简答|计算|论述|写作|翻译|问答/.test(t)) tmpl.essay.push('');
      else tmpl.single.push('');   // 未知题型默认按选择题处理（可点击则有效）
    }
    fs.writeFileSync(__dirname + '/答案模板.json', JSON.stringify(tmpl, null, 2), 'utf-8');
    // 🧩 考试单元元数据（供通用填答脚本按题型分派：点选项 / 写编辑器）
    fs.writeFileSync(__dirname + '/考试单元.json', JSON.stringify({
      total: units.length, cardCount: total, partial,
      units: units.map(u => ({
        examNum: u.examNum, sub: u.sub, type: u.type,
        text: u.text, options: u.options, audioOids: u.audioOids
      }))
    }, null, 2), 'utf-8');
    fs.writeFileSync(__dirname + '/考试模式.json', JSON.stringify({
      total: units.length, cardCount: total, partial
    }, null, 2), 'utf-8');
    log(`✓ 考试导出完成：${units.length} 个可答单元 → 题目.txt + 考试单元.json + 答案模板.json`
        + `（单选${tmpl.single.length}/判断${tmpl.judge.length}/填空${tmpl.blank.length}/简答${tmpl.essay.length}）`);
    // 截图 + 课程信息照常
    try {
      await target.screenshot({ path: __dirname + '/作业截图.png', timeout: 15000, animations: 'disabled', fullPage: false });
      log('已保存截图 → 作业截图.png');
    } catch (e) { log('⚠ 截图失败（不影响答题）'); }
    try {
      const meta = await target.evaluate(() => ({
        title: (document.title || '').trim(), url: location.href,
        // v7（2026-10-22）：dowork 页 DOM 里常常没有课程名元素（标题只有"作业作答"），
        // 但 URL 里一定带 courseId —— 把它记下来，chx.py 用「courseId→课程名」缓存做判定
        courseId: (location.href.match(/[?&]courseId=(\d+)/) || [])[1] || null,
        classId: (location.href.match(/[?&]classId=(\d+)/) || [])[1] || null,
        candidates: [(document.querySelector('.mark_title, h1, .tit')?.innerText || document.title || '').replace(/\s+/g, ' ').slice(0, 40)],
      }));
      meta.savedAt = new Date().toISOString();
      fs.writeFileSync(__dirname + '/作业信息.json', JSON.stringify(meta, null, 2), 'utf-8');
    } catch (e) {}
    // 🛡 v6.2：收尾体检 —— 抓完只读 URL、绝不切题。若这时页面已经坏了，
    // 立刻明确告诉用户「题目已存好，但要重新进考试才能填答」，别让人纳闷。
    try {
      const endUrl = await target.evaluate(() => location.href).catch(() => '');
      if (endUrl && !/exam-ans|reVersionTest/i.test(endUrl)) {
        log(`⚠ 抓取结束时页面已离开作答页：${endUrl.slice(0, 100)}`);
        log('  题目已完整存好，但填答前需要你重新进入考试（验证码人工过）');
      }
    } catch (e) {}
    log('下一步：AI 答题 → 考试模式填答（fill 会自动走同一套遍历）');
    await browser.close();
    process.exit(0);
  }

  // 🛠 v4（2026-10-18）：题目是 AJAX 异步渲染的，定位到页面 ≠ 题目已加载。
  //    轮询等 questionLi 出现且数量连续 2 次不变（最多 60s），杜绝「导出 0 题」。
  let items = [];
  let prevCount = -1, stable = 0;
  for (let i = 0; i < 60; i++) {
    items = await target.$$eval('div.questionLi', els => els.map(el => {
      // 🛠 v7.1（2026-10-22）：阅读理解等大题的子题在 .reading_answer 里 —— 旧版只抓 h3，
      //    子题（含 4~5 道单选小题）整块漏掉 → AI 没得答 → 填答也跳过 → 「做一半」。
      //    现在把每个子题平铺成独立条目；长材料（阅读文章）拼进第一个子题，供 AI 上下文。
      const subs = [...el.querySelectorAll('.reading_answer')]
        .map(ra => ({
          hasOpts: ra.querySelectorAll('span[data]').length > 0,
          text: (ra.innerText || '').replace(/\s+/g, ' ').trim(),
          options: [...ra.querySelectorAll('div.answerBg span[data], span[data]')].map(s =>
            s.getAttribute('data') + ' ' + (s.parentElement.innerText || '').replace(/\s+/g, ' ').trim())
            .filter((v, i, a) => a.indexOf(v) === i),
        }))
        .filter(s => s.hasOpts || s.text.length > 15);
      const stem = (el.querySelector('h3')?.innerText || '').replace(/\s+/g, ' ').trim();
      const base = {
        type: el.getAttribute('typename'),
        stem,
        options: [...el.querySelectorAll('div.answerBg span[data]')].map(s =>
          s.getAttribute('data') + ' ' + (s.parentElement.innerText || '').replace(/\s+/g, ' ').trim()),
      };
      if (/阅读/.test(base.type || '') && subs.some(s => s.hasOpts)) {
        // 大题带可作答子题：材料拼给第一个子题，子题逐个平铺
        // ⚠ 只平铺带选项的子题 —— 无选项的说明块不占答案坑，否则与 fill 的队列错位
        return subs.filter(s => s.hasOpts).map((s, k) => ({
          type: '单选题',
          text: (k === 0 ? '【阅读理解材料】' + stem + ' ' : '') + s.text,
          options: s.options,
        }));
      }
      return [{ num: '', type: base.type, text: stem, options: base.options }];
    }).flat());
    if (items.length > 0 && items.length === prevCount) { stable++; if (stable >= 2) break; }
    else stable = 0;
    prevCount = items.length;
    if (i % 5 === 0) log(`等待题目加载…（当前 ${items.length} 题）`);
    await sleep(2000);
  }
  if (!items.length) log('⚠ 等了 60s 仍未见题目（可能不是作答页）→ 按空卷继续');
  let out = '';
  items.forEach((it, n) => {
    // v7.1：编号由导出顺序统一生成（子题平铺后天然连续）；去掉 h3 里自带的「1.」「(单选题)」前缀
    const body = String(it.text || '')
      .replace(/^\s*\d+\s*[.、]\s*/, '')
      .replace(/^[（(][^）)]{0,8}[）)]\s*/, '');
    out += `${n + 1}. (${it.type}) ${body}\n`;
    for (const o of (it.options || [])) out += '   ' + o + '\n';
    out += '\n';
  });
  fs.writeFileSync(__dirname + '/题目.txt', out, 'utf-8');

  // 📸 截图（2026-10-13 新增）：学习通题干有字体反爬 → innerText 可能是乱码，
  //    截图是唯一可靠的信息源（直接发给 AI 看图解题），务必一起导出。
  // 🛠 v2：整页截图在学习通这种超长页面 + CSS 动画下经常 30s 超时 →
  //        先试整页（15s），失败自动退「可视区」截图，绝不让整个流程失败。
  const shoot = async (file) => {
    const plans = [
      { tag: '整页', opt: { fullPage: true } },
      { tag: '可视区', opt: { fullPage: false } },
    ];
    for (const p of plans) {
      try {
        await target.screenshot({
          path: file, timeout: 15000,
          animations: 'disabled', caret: 'initial', ...p.opt,
        });
        return p.tag;
      } catch (e) {
        log(`截图（${p.tag}）失败：${String(e.message).split('\n')[0]}`);
      }
    }
    return null;
  };
  const shotMode = await shoot(__dirname + '/作业截图.png');
  if (shotMode) log(`已保存截图（${shotMode}） → 作业截图.png（发给 AI 解题用）`);
  else log('⚠ 截图未生成（页面过大或动画阻塞）→ 可手动截屏兜底');

  // 🗂 v3：顺手抓「课程名 / 作业标题」→ 作业信息.json，供自动归档建文件夹用
  try {
    const meta = await target.evaluate(() => {
      const texts = [];
      const push = (v) => {
        v = (v || '').replace(/\s+/g, ' ').trim();
        if (v && v.length <= 40 && !texts.includes(v)) texts.push(v);
      };
      push((document.title || '').replace(/\s*[-|].*$/, ''));
      const sels = [
        '.courseName', '#courseName', '.prev_title', '.prevTitle',
        '.nav-content .course', '.mark_title', '.chapterText',
        '.course_title', '.tit h1', 'h1', '.breadcrumb',
      ];
      for (const s of sels) {
        document.querySelectorAll(s).forEach(el => push(el.innerText));
      }
      return {
        title: (document.title || '').trim(),
        // v7：同上 —— URL 的 courseId 是课程唯一标识，进缓存用
        courseId: (location.href.match(/[?&]courseId=(\d+)/) || [])[1] || null,
        classId: (location.href.match(/[?&]classId=(\d+)/) || [])[1] || null,
        candidates: texts.slice(0, 12),
        url: location.href,
      };
    }).catch(() => null);
    if (meta) {
      meta.savedAt = new Date().toISOString();
      meta.total = items.length;
      meta.counts = { single: 0, judge: 0, blank: 0, essay: 0 };
      for (const it of items) {
        const t = String(it.type || '');
        if (/单选/.test(t)) meta.counts.single++;
        else if (/多选/.test(t)) meta.counts.single++;
        else if (/判断/.test(t)) meta.counts.judge++;
        else if (/填空/.test(t)) meta.counts.blank++;
        else meta.counts.essay++;
      }
      fs.writeFileSync(__dirname + '/作业信息.json', JSON.stringify(meta, null, 2), 'utf-8');
      log('已写入 作业信息.json（课程名候选：' + (meta.candidates[0] || '未识别') + ' …）');
    }
  } catch (e) { log('作业信息.json 写入失败：' + e.message); }

  // 📝 答案模板（2026-10-13 新增）：按题型数量生成空模板，AI 只填数组内容，
  //    避免题号对应错位（single 单选 / judge 判断 / blank 填空 / essay 简答计算，都按题号顺序）
  const tmpl = { single: [], judge: [], blank: [], essay: [] };
  for (const it of items) {
    const t = String(it.type || '');
    if (/单选/.test(t)) tmpl.single.push('');
    else if (/判断/.test(t)) tmpl.judge.push('');
    else if (/多选/.test(t)) tmpl.single.push('');      // 多选也按 single 数组顺序写（如 "AB"）
    else if (/填空/.test(t)) tmpl.blank.push('');
    else tmpl.essay.push('');                            // 简答 / 计算 / 论述
  }
  fs.writeFileSync(__dirname + '/答案模板.json', JSON.stringify(tmpl, null, 2), 'utf-8');
  // 作业模式：清掉上次考试留下的单元文件，避免 fill 误走考试填答分支
  try { fs.unlinkSync(__dirname + '/考试单元.json'); } catch (e) {}

  log(`共 ${items.length} 题已导出 → 题目.txt + 作业截图.png + 答案模板.json（单选${tmpl.single.length}/判断${tmpl.judge.length}/填空${tmpl.blank.length}/简答${tmpl.essay.length}）`);
  log('下一步：把 题目.txt（或 作业截图.png）发给 AI → 拿到 answers.json → 双击「一键-自动填答.bat」');

  // ── 机器可读结果（供 AI / 上层脚本解析）──
  console.log('CHX_RESULT ' + JSON.stringify({
    action: 'dump', ok: true, total: items.length,
    counts: { single: tmpl.single.length, judge: tmpl.judge.length, blank: tmpl.blank.length, essay: tmpl.essay.length },
    files: ['题目.txt', '作业截图.png', '答案模板.json']
  }));

  // ── 收尾策略（2026-10-17 接口化改造，向后兼容）──
  //   CHX_AFTER=exit  → 立即退出，不关浏览器（AI 调用推荐，避免阻塞）
  //   默认 wait       → 保持原行为：等 CHX_KEEP_OPEN_SECONDS 秒后再关
  const AFTER = process.env.CHX_AFTER || 'wait';
  if (AFTER === 'exit') {
    log('CHX_AFTER=exit：立即退出，浏览器窗口保持打开');
    if (viaCDP) { try { await browser.close(); } catch (e) {} }   // CDP 只是断开调试连接，不关窗口
    await sleep(300);                                              // 等 stdout 刷完再退
    process.exit(0);
  }
  await sleep(Math.max(0, Number(process.env.CHX_KEEP_OPEN_SECONDS ?? 60)) * 1000);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
