/* ============================================================
 *  nav_tracer.js —— 导航溯源探针（v7.14 专用，只读诊断）
 *
 *  用途：回答"到底是谁把页面从 3.1 导航到了 5.2？"
 *  做法：在每个 frame 里注入钩子，监听所有可能引发跳转的入口：
 *        · HTMLElement.prototype.click（程序化 click，带调用栈）
 *        · document 捕获阶段 click（真实鼠标点击，带 isTrusted + 命中元素路径）
 *        · history.pushState / replaceState
 *        · location.assign / replace / href 赋值
 *        · window.open
 *        · PCount.next / previous / goto 等学习通播放控制器
 *        · scroll2Job / closeDeleteWindow / jobFinishTip 等遮罩相关全局函数
 *        · beforeunload / pagehide（页面即将离开）
 *  跨页面存活：钩子把记录追加进 localStorage['__navlog']，导航后依然可读。
 *  采集：本进程每 400ms 读一次各 frame 的 localStorage，增量打印并落盘。
 *
 *  运行：node 诊断工具/nav_tracer.js [持续秒数=600]
 *  产出：诊断工具/nav_trace_<时间戳>.log
 *  注意：用 browser.disconnect()，绝不关用户浏览器。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) {
  try { ({ chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'))); } catch (e2) {
    ({ chromium } = require('C:/Users/Public/.workbuddy/binaries/node/workspace/node_modules/playwright-core'));
  }
}

const CDP_PORT = 9222;
const DURATION = Number(process.argv[2] || 600) * 1000;
const OUT = path.join(__dirname, 'nav_trace_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.log');
const out = fs.createWriteStream(OUT, { flags: 'a' });
const say = s => { const line = s + '\n'; process.stdout.write(line); out.write(line); };

/* ---------- 注入到页面里的钩子（每个 frame 各装一份） ---------- */
function HOOK_SRC() {
  try {
    if (window.__navHooked) return 'already';
    window.__navHooked = 1;
    const KEY = '__navlog';
    const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } };
    const push = (k, extra) => {
      try {
        let st = '';
        try {
          const e = new Error();
          const raw = (e.stack || '');
          if (raw.indexOf('__navHooked') === -1) {   // 首帧（本函数自身）不含栈 → 用调用者栈
            st = raw.split('\n').slice(2, 6).map(s => s.trim().replace(/https?:\/\/[^/]+/, '').slice(0, 90)).join(' | ');
          } else {
            st = raw.split('\n').filter(l => l.indexOf('__navHooked') === -1).slice(0, 5)
              .map(s => s.trim().replace(/https?:\/\/[^/]+/, '').slice(0, 90)).join(' | ');
          }
        } catch (e) {}
        const arr = read();
        arr.push(Object.assign({ t: Date.now(), u: location.href.slice(-90), k }, extra, { st }));
        while (arr.length > 400) arr.shift();
        localStorage.setItem(KEY, JSON.stringify(arr));
      } catch (e) {}
    };
    window.__navpush = push;   // 方便别处手动打点

    /* ① history */
    try {
      const ps = history.pushState, rs = history.replaceState;
      history.pushState = function () { push('pushState', { to: String(arguments[2] || '').slice(-80) }); return ps.apply(this, arguments); };
      history.replaceState = function () { push('replaceState', { to: String(arguments[2] || '').slice(-80) }); return rs.apply(this, arguments); };
    } catch (e) {}

    /* ② location */
    try {
      const la = location.assign.bind(location), lr = location.replace.bind(location);
      location.assign = function (u) { push('location.assign', { to: String(u).slice(-80) }); return la(u); };
      location.replace = function (u) { push('location.replace', { to: String(u).slice(-80) }); return lr(u); };
    } catch (e) {}
    try { const wo = window.open; window.open = function (u) { push('window.open', { to: String(u).slice(-80) }); return wo.apply(this, arguments); }; } catch (e) {}

    /* ③ 程序化 click（带上调用栈，最能指认"是谁点的"） */
    try {
      const proto = HTMLElement.prototype;
      const ck = proto.click;
      proto.click = function () {
        try { push('proto.click', { tag: this.tagName, id: this.id || '', cls: String(this.className || '').slice(0, 60), txt: String(this.innerText || '').trim().slice(0, 24) }); } catch (e) {}
        return ck.apply(this, arguments);
      };
    } catch (e) {}

    /* ④ 真实鼠标点击（isTrusted=true 也可能是引擎用 CDP 派发的） */
    try {
      document.addEventListener('click', function (e) {
        try {
          const p = (e.composedPath && e.composedPath()) || [];
          const t = p[0] || e.target;
          push('realClick', {
            trusted: e.isTrusted, x: Math.round(e.clientX), y: Math.round(e.clientY),
            tag: t.tagName, id: t.id || '', cls: String(t.className || '').slice(0, 50),
            txt: String(t.innerText || '').trim().slice(0, 24),
            path: p.slice(0, 4).map(el => el.tagName ? el.tagName + '.' + String(el.className || '').slice(0, 26) : String(el)).join(' > ')
          });
        } catch (err) {}
      }, true);
    } catch (e) {}

    /* ⑤ 学习通播放控制器 & 遮罩相关全局函数 */
    (function hookGlobals() {
      var n = 0;
      const names = {
        PCount: ['next', 'previous', 'goto', 'go', 'goNext', 'change', 'turnPage', 'play'],
        win: {
          scroll2Job: 1, closeDeleteWindow: 1, jobFinishTip: 1, getTeacherAjax: 1,
          changeChapter: 1, openChapter: 1, toOld: 1, closeMask: 1, alert: 1
        }
      };
      const install = () => {
        try {
          const P = window.PCount;
          if (P) {
            names.PCount.forEach(k => {
              if (typeof P[k] === 'function' && !P['__navh_' + k]) {
                P['__navh_' + k] = 1;
                const o = P[k];
                P[k] = function () { push('PCount.' + k, { args: JSON.stringify([].slice.call(arguments)).slice(0, 90) }); return o.apply(this, arguments); };
              }
            });
          }
          Object.keys(names.win).forEach(k => {
            if (typeof window[k] === 'function' && !window['__navh_' + k]) {
              window['__navh_' + k] = 1;
              const o = window[k];
              window[k] = function () {
                push('fn.' + k, { args: JSON.stringify([].slice.call(arguments)).slice(0, 90) });
                return o.apply(this, arguments);
              };
            }
          });
        } catch (e) {}
        if (n++ < 120) setTimeout(install, 400);
      };
      install();
    })();

    /* ⑥ 离开页面 */
    try {
      window.addEventListener('beforeunload', () => push('beforeunload', {}));
      window.addEventListener('pagehide', () => push('pagehide', {}));
    } catch (e) {}

    push('__install', {});
    return 'ok';
  } catch (e) { return 'err:' + e.message; }
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + CDP_PORT, { timeout: 8000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => /studentstudy|mycourse/.test(p.url())) || ctx.pages()[0];
  if (!page) { console.log('未找到页面'); browser.disconnect(); return; }

  say('=== nav_tracer 启动 ===');
  say('页面: ' + page.url());
  say('先清空历史日志…');
  try { await page.evaluate(() => { try { localStorage.removeItem('__navlog'); } catch (e) {} }); } catch (e) {}
  // 清掉所有 frame 里的日志
  for (const f of page.frames()) { try { await f.evaluate(() => { try { localStorage.removeItem('__navlog'); } catch (e) {} }); } catch (e) {} }

  await page.addInitScript(HOOK_SRC);
  for (const f of page.frames()) { try { await f.evaluate(HOOK_SRC); } catch (e) {} }

  page.on('framenavigated', f => say('[' + new Date().toTimeString().slice(0, 8) + '] 🧭 frameNavigated  main=' + (f === page.mainFrame()) + '  ' + f.url().slice(0, 130)));
  page.on('popup', p => say('[' + new Date().toTimeString().slice(0, 8) + '] 🪟 popup  ' + p.url().slice(0, 120)));

  /* ---------- 终极手段：CDP 层抓「导航发起者」 ----------
   *  Network.requestWillBeSent 的 initiator 字段会写明是谁发起的：
   *    initiator.type = 'script'  → 是 JS 发起的，stack.callFrames 直接给出发起调用栈（哪个文件哪一行）
   *    initiator.type = 'parser' / 'other' → 页面自身解析/其他
   *  这是唯一能"指名道姓"的办法：引擎注入的脚本、页面自身脚本、还是 iframe 里的某行代码。
   */
  let cdp = null;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', ev => {
      try {
        if (ev.type !== 'Document') return;
        const f = ev.frame;
        const ini = ev.initiator || {};
        const isMain = !f || !f.parentId;
        const st = (ini.stack && ini.stack.callFrames || []).slice(0, 6)
          .map(c => (c.functionName || '(anon)') + ' @ ' + String(c.url || '').replace(/https?:\/\/[^/]+/, '').slice(-70) + ':' + c.lineNumber)
          .join('\n              ↳ ');
        say('[' + new Date().toTimeString().slice(0, 8) + '] 🚀 DOC导航发起  main=' + isMain +
          '  type=' + ini.type +
          '\n         目标: ' + String(ev.request.url).slice(0, 130) +
          '\n         发起者URL: ' + String(ini.url || '').slice(0, 120) +
          (st ? '\n         发起栈: ' + st : '') +
          (ini.type === 'script' && !st ? '\n         ⚠ 发起栈为空（可能是 CDP 派发/浏览器内部）' : ''));
      } catch (e) {}
    });
    say('✅ CDP Network 已启用（可抓导航发起者）');
  } catch (e) { say('⚠ CDP 启用失败：' + e.message); }

  const seen = new Map();   // frameIndex -> 已处理的条数
  const t0 = Date.now();
  say('开始监听 ' + (DURATION / 1000) + ' 秒…（现在去操作页面 / 或让引擎跑）');
  say('');

  const timer = setInterval(async () => {
    if (Date.now() - t0 > DURATION) {
      clearInterval(timer);
      say('=== 监听结束，共 ' + ((Date.now() - t0) / 1000).toFixed(0) + ' 秒 ===');
      try { browser.disconnect(); } catch (e) {}
      out.end();
      return;
    }
    const frames = page.frames();
    // ⚠ 同源 iframe 共享同一份 localStorage → 若每个 frame 都读一遍会重复刷屏
    //   ⇒ 每个 origin 只选一个代表 frame 读取（其余只装钩子不读取）
    const reader = new Map();   // origin -> frameIndex
    for (let i = 0; i < frames.length; i++) {
      let org = '';
      try { org = new URL(frames[i].url()).origin; } catch (e) { org = 'null' + i; }
      if (!reader.has(org)) reader.set(org, i);
    }
    const readSet = new Set([...reader.values()]);
    for (let i = 0; i < frames.length; i++) {
      try {
        // 立即重装钩子（新 frame / 新文档可能还没装）
        await frames[i].evaluate(HOOK_SRC).catch(() => {});
        if (!readSet.has(i)) continue;
        const arr = await frames[i].evaluate(() => { try { return JSON.parse(localStorage.getItem('__navlog') || '[]'); } catch (e) { return []; } });
        if (!Array.isArray(arr)) continue;
        try { if (arr.length && ['__install', 'beforeunload', 'pagehide'].indexOf(arr[arr.length - 1].k) === -1) arr.push({ t: Date.now(), u: '', k: '__mark', st: '' }); } catch (e) {}
        const key = 'R' + i;
        const done = seen.get(key) || 0;
        for (let j = done; j < arr.length; j++) {
          const e = arr[j];
          const tm = new Date(e.t).toTimeString().slice(0, 8);
          const tail = [e.to ? 'to=' + e.to : '', e.args ? 'args=' + e.args : '', e.tag ? e.tag + (e.id ? '#' + e.id : '') + (e.cls ? '.' + e.cls : '') : '',
            e.txt ? '“' + e.txt + '”' : '', e.x !== undefined ? '@' + e.x + ',' + e.y : '', e.trusted !== undefined ? 'trusted=' + e.trusted : ''].filter(Boolean).join('  ');
          say('[' + tm + '] F' + i + ' ' + e.k + '  ' + tail + (e.st ? '\n          栈: ' + e.st : ''));
        }
        seen.set(key, arr.length);
      } catch (e) {}
    }
  }, 400);
})();
