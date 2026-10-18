/* 🎬 视频弹题处理逻辑 —— 离线仿真测试（在真实 Edge 里跑新代码，验证整条链路）
   做法：从 chaoxing_course.js 里原样抽出弹题处理代码块，配桩函数后加载到本地仿真页面执行。
   覆盖：① 题库命中直接作答 ② 题库没有→蒙 ③ 蒙错→记错题 ④ 同题再弹→自动换另一个选项 ⑤ 点「继续」关闭
   运行：node test_videoquiz.js */
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) { ({ chromium } = require('C:/Users/Public/.workbuddy/binaries/node/workspace/node_modules/playwright-core')); }
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MAIN = path.join(__dirname, '..', 'chaoxing_course.js');
const MARK_A = '// ───────── 🎬 视频内弹题（插入题）2026-10-13 重写 ─────────';
const MARK_B = '// ───────── 主循环 ─────────';

// ── 真实弹题 HTML（2026-10-13 从学习通现场抓的结构，1:1 复刻）──
const POPUP_HTML = `
<div class="fullScreenContainer">
  <div class="x-component ans-videoquiz x-component-default" id="videoquiz-1048">
    <div class="tkTopic">
      <div class="tkTopic_title">判断题</div>
      <div class="tkTopic_con tkScroll" id="ext-gen1060">
        <div class="tkItem">
          <div class="tkItem_title">自主创业的大学生向银行申请开业贷款，担保额度最高为7万元，并享受贷款贴息。</div>
          <ul class="tkItem_ul">
            <li class="ans-videoquiz-opt"><label><span class="tkRadio"><input type="radio" name="ans-videoquiz-opt" value=""><i></i></span>A、对</label></li>
            <li class="ans-videoquiz-opt"><label><span class="tkRadio"><input type="radio" name="ans-videoquiz-opt" value=""><i></i></span>B、错</label></li>
          </ul>
        </div>
      </div>
      <div class="tkTopic_oper" id="ext-gen1061">
        <a class="ans-videoquiz-submit bntLinear fr" id="videoquiz-submit">提交</a>
        <a class="ans-videoquiz-submit bntLinear fr" id="videoquiz-submitting" style="display:none">提交中</a>
        <a class="ans-videoquiz-continue bntLinear fr" id="videoquiz-continue" style="display:none">继续</a>
        <span class="spanHas fr" id="spanHas" style="display:none">回答正确</span>
        <span class="spanNot fr" id="spanNot" style="display:none">回答错误</span>
        <span class="spanNotBack fr" id="spanNotBack" style="display:none">回答错误，回看  分钟</span>
      </div>
    </div>
  </div>
</div>
<script>
  window.__truth = 'A'; window.__submits = 0; window.__picked = []; window.__continued = false;
  document.getElementById('videoquiz-submit').onclick = function () {
    window.__submits++;
    var lis = [].slice.call(document.querySelectorAll('li.ans-videoquiz-opt'));
    window.__picked = lis.map(function (li, i) { return li.querySelector('input').checked ? String.fromCharCode(65 + i) : null; }).filter(Boolean);
    var ok = window.__picked.length === 1 && window.__picked[0] === window.__truth;
    this.style.display = 'none';
    if (ok) { document.getElementById('spanHas').style.display = 'inline'; document.getElementById('videoquiz-continue').style.display = 'inline'; }
    else { var n = document.getElementById('spanNotBack'); n.style.display = 'inline'; n.innerText = '回答错误，回看 1 分钟'; document.getElementById('videoquiz-continue').style.display = 'inline'; }
    window.__ok = ok;
  };
  document.getElementById('videoquiz-continue').onclick = function () { document.querySelector('.ans-videoquiz').style.display = 'none'; window.__continued = true; };
<\/script>`;

// ── 从主脚本原样抽出弹题代码块，配桩后变成可调用模块 ──
function loadModule(bankObj, dir, rand) {
  const src = fs.readFileSync(MAIN, 'utf8');
  const i = src.indexOf(MARK_A), j = src.indexOf(MARK_B);
  if (i < 0 || j < 0) throw new Error('抽不出弹题代码块（标记未找到）');
  // 测试桩：把代码里的 Math.random() 换成可注入的 __RAND()，才能复现"蒙错→记错题→下次换选项"这条链路
  const block = src.slice(i + MARK_A.length, j).replace(/Math\.random\(\)/g, '__RAND()');
  const header = `
    const fs = require('fs');
    const path = require('path');
    const VQ_WRONG_FILE = ${JSON.stringify(path.join(dir, 'vq_wrong.json'))};
    const BANK_FILE = ${JSON.stringify(path.join(dir, 'bank.json'))};
    const __RAND = __RANDOMFN;
    const norm = s => String(s || '').replace(/\\s+/g, '').replace(/[，。、；：？！“”‘’（）【】《》,.;:?!"'()\\[\\]]/g, '').toLowerCase();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const isHomeworkUrl = () => false;
    const log = m => console.log('     [脚本日志] ' + m);
    let bank = Object.assign({}, __BANK);
    let bankKeys = Object.keys(bank);
    let CFG = { videoQuiz: true, videoQuizMaxTry: 3, protectWork: true };
    // 🗂 v7.6 桩：主脚本用课程命名空间过滤题库键，测试里把当前课程设成"无前缀通吃"
    let CUR_CID = 'TEST';
    const COURSE_TAG_RE = /^\\s*\\[(\\w{1,16})\\]\\s*/;
    const stripCourseTag = k => String(k || '').replace(COURSE_TAG_RE, '');
    const tagOfCourse = cid => '[' + cid + '] ';
    function bankKeyInCourse(k, cid) {
      const m = COURSE_TAG_RE.exec(String(k || ''));
      if (!m) return true;                 // 测试数据全部无前缀 → 一律视作本课程
      return m[1] === String(cid);
    }
    function saveBank() {}
  `;
  const factory = new Function('__BANK', '__DIR', '__RANDOMFN', 'require', header + block + `
    return { answerVideoQuiz, getBank: () => bank, getWrong: () => vqWrong, getTries: () => vqTries };
  `);
  return factory(bankObj, dir, rand || Math.random, require);
}

// ── 断言工具 ──
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vqtest-'));
  const Q = '自主创业的大学生向银行申请开业贷款，担保额度最高为7万元，并享受贷款贴息。';

  const newPage = async truth => {
    const p = await browser.newPage();
    await p.setContent(POPUP_HTML.replace("window.__truth = 'A';", `window.__truth = '${truth}';`));
    return p;
  };

  // ─────── 场景 1：题库有答案 → 直接作答（正确答案 B、错）───────
  console.log('\n【场景 1】题库命中（库里写"错"，正确答案就是 B、错）');
  {
    const dir = path.join(tmpRoot, 's1'); fs.mkdirSync(dir);
    const m = loadModule({ [Q]: '错' }, dir);
    const p = await newPage('B');
    await m.answerVideoQuiz(await p.$('.ans-videoquiz'), null);
    const r = await p.evaluate(() => ({ picked: window.__picked, submits: window.__submits, cont: window.__continued, ok: window.__ok }));
    ok(r.picked.join('') === 'B', '选了题库答案 B、错', JSON.stringify(r));
    ok(r.submits === 1, '只提交一次');
    ok(r.ok === true, '服务器判定回答正确');
    ok(r.cont === true, '已点「继续」关闭弹题');
    ok(m.getBank()[Q] === '错', '题库答案保持/已入库为「错」', JSON.stringify(m.getBank()));
    await p.close();
  }

  // ─────── 场景 2：题库没有 → 蒙（第一次故意蒙错）───────
  console.log('\n【场景 2】题库无答案 → 蒙（正确答案 B，第一次强制蒙错）');
  let wrongPick = null;
  {
    const dir = path.join(tmpRoot, 's2'); fs.mkdirSync(dir);
    const m = loadModule({}, dir, () => 0);   // random 恒为 0 → 必选候选里的第一个 = A、对（错）
    const p = await newPage('B');
    await m.answerVideoQuiz(await p.$('.ans-videoquiz'), null);
    const r = await p.evaluate(() => ({ picked: window.__picked, submits: window.__submits, cont: window.__continued, ok: window.__ok }));
    wrongPick = r.picked[0];
    ok(wrongPick === 'A', '蒙了 A、对（random 被固定在第一个候选）', JSON.stringify(r));
    ok(r.ok === false, '服务器判定回答错误（模拟）');
    ok(r.cont === true, '答错后依然点「继续」关掉弹题');
    const wrongFile = JSON.parse(fs.readFileSync(path.join(dir, 'vq_wrong.json'), 'utf8'));
    const rec = wrongFile[Object.keys(wrongFile)[0]] || [];
    ok(rec.some(t => t.startsWith('A')), '错题选项已落盘 .videoquiz_wrong.json', JSON.stringify(wrongFile));
    await p.close();

    // ─────── 场景 3：同一题再次弹出 → 自动避开错项，选 B ───────
    console.log('\n【场景 3】同一道弹题再次弹出（沿用刚才的错题记忆）→ 应自动改选 B');
    const m2 = loadModule({}, dir, () => 0);   // 同一目录 → 读到错题记忆；random 仍偏向第一个候选
    const p2 = await newPage('B');
    await m2.answerVideoQuiz(await p2.$('.ans-videoquiz'), null);
    const r2 = await p2.evaluate(() => ({ picked: window.__picked, submits: window.__submits, ok: window.__ok }));
    ok(r2.picked.join('') !== wrongPick, '没有重复上次的错项', JSON.stringify(r2));
    ok(r2.picked.join('') === 'B', '自动改选 B、错');
    ok(r2.ok === true, '这次答对了');
    // 🗂 v7.6：learnAnswer 写入时会给键加课程前缀（[CUR_CID] ），断言要跟着改
    const bankM2 = m2.getBank();
    const stripTag = k => String(k || '').replace(/^\s*\[\w{1,16}\]\s*/, '');
    const hitKey = Object.keys(bankM2).find(k => stripTag(k) === Q || k === Q);
    ok(hitKey && bankM2[hitKey] === '错', '答对后答案自动入库（带课程前缀）', JSON.stringify(bankM2));
    await p2.close();
  }

  // ─────── 场景 4：多选题（checkbox）→ 题库命中多选（两个都勾）───────
  console.log('\n【场景 4】多选题：题库答案 ["A","B"] → 两个都勾上');
  {
    const dir = path.join(tmpRoot, 's4'); fs.mkdirSync(dir);
    const html = POPUP_HTML
      .replace(/type="radio"/g, 'type="checkbox"')
      .replace('<li class="ans-videoquiz-opt"><label><span class="tkRadio"><input type="checkbox" name="ans-videoquiz-opt" value=""><i></i></span>A、对</label></li>',
               '<li class="ans-videoquiz-opt"><label><span class="tkRadio"><input type="checkbox" name="ans-videoquiz-opt" value=""><i></i></span>A、甲</label></li>')
      .replace('A、对</label>', 'A、甲</label>')
      .replace('B、错</label>', 'B、乙</label>')
      .replace('判断题</div>', '多选题</div>')
      .replace("window.__truth = 'A';", "window.__truth = 'B';")
      .replace("window.__picked.length === 1 && window.__picked[0] === window.__truth", "window.__picked.length === 1 && window.__picked[0] === window.__truth");
    const m = loadModule({ [Q]: ['A', 'B'] }, dir);
    const p = await browser.newPage();
    await p.setContent(html);
    await m.answerVideoQuiz(await p.$('.ans-videoquiz'), null);
    const r = await p.evaluate(() => ({ picked: window.__picked, submits: window.__submits }));
    ok(r.picked.join('') === 'AB', '多选按题库把 A、B 都勾上', JSON.stringify(r));
    ok(r.submits === 1, '多选只提交一次');
    await p.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR: ' + (e && e.stack || e)); process.exit(1); });
