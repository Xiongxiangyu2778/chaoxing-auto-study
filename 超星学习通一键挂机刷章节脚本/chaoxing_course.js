/* 学习通自动刷课 v2（2026-10-12）—— 全自动留后台版
   ─────────────────────────────────────────────
   用法：双击「一键-自动刷课.bat」→ 自动打开独立 Edge → 自己登录/进课程一次，
        之后全自动（可最小化窗口挂后台）。

   ═══ v7.15（2026-10-17 凌晨）★★★ "刷不动"的总根源已找到并修复 ★★★ ═══
   症状：手动把页面放到前面章节，4 秒后又被弹回 5.2；全课程刷不动；bug 巨多。
   真凶：killPopups 里 `locator('text=确定').first().click()` —— Playwright 的 text= 是【子串匹配】！
        它命中了目录行「5.2 精确定位工具」的 <span class="posCatalog_name">
        （"精确定位"里正好含连续子串「确定」），点它 = 点目录行
        → 触发行内 onclick getTeacherAjax(courseId, clazzid, '235163955') → 页面被导航到 5.2
        → 引擎以为自己在"已刷过的节" → 一路翻节 → 补刷回来又被点走 → 无限绕圈。
   证据（两条硬证据）：
        ① 引擎侧点击探针：`locator.click("text=确定")` 与页面侧 `realClick SPAN.posCatalog_name "5.2"` 同秒发生；
        ② 诊断打印的目标元素：`SPAN.posCatalog_name @0,2081 292x40` —— 干干净净一个目录行。
   修复：
        ① 所有通用弹窗按钮改【精确匹配】(innerText 全等) + 排除一切目录容器元素（.posCatalog* 或 [id^=cur]）；
        ② 新增 safeClick()：导航类点击一律走【页面内 el.click()】，不用 Playwright 坐标点击
           （坐标点击的落点若被别的元素占据，浏览器就按落点上的真实元素派发事件 ⇒ 必然误伤）；
        ③ findNextBtn / clickChip / dismissStrayPopups 全部加"目录排除"白名单。
   验证：3.1 视频正常播完 →「页面已显示任务点完成」→ 自动补刷 3.2 → 目录未完成数 3→2→1，零绕圈。
   ═══════════════════════════════════════════════════════════════════

   v2 相比 v1 的升级：
   1. 自动点击「视频」任务点标签，不需要你手动点开视频
   2. 翻节不再依赖"任务点已完成"字样 —— 视频播完直接下一节（含跨章衔接）
   3. 测验自动尝试答题（读 题库.json），答案库里没有的题：
      · 题库没答案的题：默认直接蒙（exportUnknown=true 才导出留档）
      · 不提交，等 skipWaitMs 后自动跳过并翻节
   4. 自动处理 beforeunload 弹窗、章节衔接弹窗
   5. 断点续刷：记住上次章节，重跑脚本自动回到那一节
   6. 打印当前章节进度，卡住会明确提示

   停止：终端 Ctrl+C 或关掉浏览器窗口。
   调参（下面 CFG）：
   autoNext=false → 视频播完不自动翻节（改回手动模式）
   skipWaitMs     → 非视频任务点停留多久后跳过翻节（默认 25 秒）
   rate           → 倍速（1.0 最安全，>1.5 有被判定异常的风险） */
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); }                                        // NODE_PATH / 常规安装
catch (e) {
  try { ({ chromium } = require(path.join(__dirname, 'node_modules', 'playwright-core'))); } // 便携模式：随文件夹自带
  catch (e2) {
    // 计划任务/独立启动时没有 NODE_PATH → 用绝对路径兜底
    ({ chromium } = require('C:/Users/Public/.workbuddy/binaries/node/workspace/node_modules/playwright-core'));
  }
}

// ── 便携化（2026-10-13）：全部路径相对本文件夹，「学习通作业助手」整体拷到别的电脑也能跑 ──
// ── 单账号版（2026-10-16）：多账号/多开支持已移除（多开 bug 多、稳定优先）──
//    固定：一个脚本进程 = 一个 Edge（调试端口 9222）= 一份数据目录（本文件夹的上级）
const HOME_DIR = path.join(__dirname, '..');   // 学习通作业助手根目录（题库/状态文件都在这）
const CDP_PORT = 9222;                          // 固定调试端口（单账号）
// 浏览器：Edge 优先（两个常见安装位）→ Chrome 兜底
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => { try { return fs.existsSync(p); } catch (e) { return false; } })
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 浏览器登录态：沿用本机 edge-quiz-profile；新电脑用文件夹内 edge-profile
const PROFILE = fs.existsSync(path.join(os.homedir(), 'edge-quiz-profile'))
  ? path.join(os.homedir(), 'edge-quiz-profile')
  : path.join(HOME_DIR, 'edge-profile');
// 题库：优先用本账号数据目录里的题库.json（同课程可直接共用主目录那份 → 自动回退）
const BANK_FILE = fs.existsSync(path.join(HOME_DIR, '题库.json'))
  ? path.join(HOME_DIR, '题库.json')
  : path.join(__dirname, '..', '题库.json');
const DUMP_DIR = path.join(HOME_DIR, '题库');
const STATE_FILE = path.join(HOME_DIR, '.course_state.json');
const DONE_FILE = path.join(HOME_DIR, '.video_done.json');
const QUIZ_FILE = path.join(HOME_DIR, '.quiz_done.json');   // 已交测验的节（重启后仍记得，用于反推"剩下的必是视频"）
const WATCH_TRY_FILE = path.join(HOME_DIR, '.watch_try.json'); // 每节"核验失败"次数（迟到兜底 & 防死循环用；v6 起不再用于降速）
// （旧版 .speed_learn.json 已被 v6 的"按时长自动匹配倍速"取代，常量一并移除）
const WATCH_REAL_FILE = path.join(HOME_DIR, '.watch_real.json'); // 🎯 每节累计的"真实播放秒数"（v6 按视频时长匹配倍速的依据）
const VIDEO_CREDITED_FILE = path.join(HOME_DIR, '.video_credited.json'); // 视频任务点【已被服务器明确记账】的节（防止已完成还反复重看 → 死循环）
const VQ_WRONG_FILE = path.join(HOME_DIR, '.videoquiz_wrong.json');       // 🎬 视频内弹题"错题"记忆：同一题答错过的选项 → 下次自动换别的（提高蒙对率）

// 配置：优先用上级目录的 刷课配置.json（若存在）；否则用引擎目录这份
const CFG_FILE = fs.existsSync(path.join(HOME_DIR, '刷课配置.json'))
  ? path.join(HOME_DIR, '刷课配置.json')
  : path.join(__dirname, '刷课配置.json');

// 🔒 作业 / 考试页特征：命中则脚本【完全不介入】——不读题、不点选、不提交
//    原因：作业会计入成绩，必须 100% 正确自己写；只有章节测验才允许自动（含蒙答）
//    章节测验是嵌在 studentstudy 页面内的 iframe，URL 不带 /work/，不会被误伤
const HOMEPAT = /(\/mooc2\/(work|exam)\/)|(\/mooc\/(work|exam)\/)|workHandle|add-work|\/ananas\/modules\/work\/|exam-ans/i;
const isHomeworkUrl = u => HOMEPAT.test(String(u || ''));
// ── 🗂 课程命名空间（v7.6，2026-10-15）：一个账号可能刷【多门课】，题库必须按课程隔离 ──
//    背景：题库匹配是"题目文本互相包含"的模糊匹配（下方答题处）。不同课程的题面可能部分重合
//    （甚至同一位老师多门课用同一套题），共用一份题库 → 会用别的课程的答案乱填 → 答案串课程。
//    机制：题库键统一写成 "[课程ID] 原键"；作答时取出当前页面的课程ID，只在该课程的键里匹配。
//    兼容：老题库（无前缀）自动归入"启动时所在的课程"，无需手工整理。
let CUR_CID = '0';                       // 当前页面课程ID（每轮从 URL 刷新）
const COURSE_TAG_RE = /^\s*\[(\w{1,16})\]\s*/;
const stripCourseTag = k => String(k || '').replace(COURSE_TAG_RE, '');
const tagOfCourse = cid => '[' + cid + '] ';

// 键是否属于当前课程：带前缀的必须同课程；无前缀的留给迁移逻辑处理（这里一律不匹配，避免串课程）
function bankKeyInCourse(k, cid) {
  const m = COURSE_TAG_RE.exec(String(k || ''));
  if (!m) return false;
  return m[1] === String(cid);
}

// 启动时把"无前缀"的老键归入 defaultCid（只在写回时发生；defaultCid 为空则纯只读、不写盘）
const untaggedKeys = [];
function migrateBankCourse(bank, defaultCid) {
  if (!defaultCid) return false;
  let changed = false;
  for (const k of Object.keys(bank)) {
    if (COURSE_TAG_RE.test(k)) continue;
    untaggedKeys.push(k);
    const nk = tagOfCourse(defaultCid) + k;
    if (!(nk in bank)) { bank[nk] = bank[k]; changed = true; }
    delete bank[k]; changed = true;
  }
  return changed;
}
function saveBank(bank) {
  try { fs.writeFileSync(BANK_FILE, JSON.stringify(bank, null, 1), 'utf8'); } catch (e) {}
}

const DEFAULTS = {
  speed: 1.5,        // 倍速【上限】：脚本自动匹配出来的倍速不会超过它（想强行快就调高，想稳就调低）
  forceSpeed: true,  // 🚀 强制倍速：播放器菜单里没有这一档也能顶上去，且被播放器偷偷改回 1x 时自动拉回
  autoNext: true,    // 视频播完自动翻节（含跨章）
  autoQuiz: false,   // 测验自动作答并提交（用户要求关闭 → false）
  guessUnknown: true,// 章节测验遇到题库没有的题 → 随机蒙一个也要交（只要任务点，不追求正确率）
  exportUnknown: false,// 📤 是否把没答案的题导出到 题库\ 并截图（想让我解真答案提正确率时再开）
  forceRewatch: false, // 🔁 true = 无视"已看过"记录，每节都重新播放视频（想彻底重刷时开）
  redoNow: false,      // 🎯 true = 下次启动立刻跳到目录里第一个未完成的节（用完自动置回 false）
  // 🎯 按视频时长自动匹配倍速（v6，2026-10-13 新增，取代旧的"逐档降速"）
  //    实测规则：学习通的视频完成条件 = 累计【真实播放秒数】≥ 总时长 × completeRatio。
  //    → 倍速 S 播一遍只能攒到 时长/S 的真实秒数（S 越大攒得越少），所以要"一遍过"必须 S ≤ 1/0.9 ≈ 1.11。
  //    脚本按「还差多少真实秒数 / 还剩多少视频可播」实时算出刚好够的倍速，再与 speed 上限取小。
  autoSpeedByDuration: true,
  completeRatio: 0.9,  // 学习通判定阈值（视频任务点元素明文：观看时长需 ≥ 总时长的 90%）
  bankBuffer: 0,       // 安全余量（默认 0）：目标 = 时长 × (completeRatio + bankBuffer)。调大 → 倍速更保守（1.1x→1x）
  paused: false,     // ⏸ 设为 true = 脚本原地待命、完全不碰页面（你要自己补作业/手动操作就开它）
  // 🎬 视频内弹题（插入题）2026-10-13 新增：视频播到某个时间点会弹出判断题/单选题，必须作答才消失。
  //    实测（2026-10-13 19:13 实证）：答错【没有任何负面影响】——视频不倒回、任务点照常记账
  //    （答错后 aria-label 仍变「任务点已完成」、目录 inc 2→1）→ 所以放心蒙。
  videoQuiz: true,      // 自动处理视频内弹题（题库命中就用题库，没有就蒙）
  videoQuizMaxTry: 3,   // 同一道弹题最多尝试次数（防死循环；不再答也无所谓，不影响任务点）
  video: '视频',        // 🎧 v7.7：任务点标签里"媒体类"的显示名（学习通音频任务点也标「视频」）
  videoAlias: '视频|音频|听力|录音|语音',   // 点「视频」页签时同时认这些词（英语听力课的音频节）
  protectWork: true, // 🔒 作业/考试页保护：这些页面脚本一律不点不交（作业必须 100% 正确，自己写）
  muted: true,       // 静音播放
  skipWaitMs: 15000, // 非视频任务点停留多久后自动跳过翻节
  cooldownMs: 7000,  // 翻节后等待新页加载
  poll: 4000,        // 轮询间隔
  stallMs: 300000,   // 看门狗（按进度）：视频连续 5 分钟毫无进度才判定卡死（旧版按"进节时间"算，长视频会被腰斩）
  autoOpen: true,    // 启动时自动打开上次刷到的章节（无人值守挂机用）
  headless: false,   // 无头模式：不显示窗口（页面自认为在前台，绕过"不可最小化"监控）
  skipVideo: false,  // true=不播视频，直接处理测验后翻节（视频任务点不保完成）
  redoLimit: 50,     // 补刷同一节的最大次数（设大一点，防止某节反复失败后整门课不再回头补）
};
// 倍速档位表（学习通播放器支持的档位；自动匹配结果会吸附到其中最接近且不超过的档）
const SPEED_STEPS = [1, 1.1, 1.25, 1.5, 2, 2.5, 3];

function loadCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (e) {}
  if (c.watchdogMs && !c.stallMs) c.stallMs = c.watchdogMs;   // 兼容旧配置字段 watchdogMs
  const out = { ...DEFAULTS, ...c };
  if (!(out.speed > 0.5 && out.speed <= 3)) out.speed = DEFAULTS.speed;
  if (!(out.completeRatio > 0.3 && out.completeRatio < 1)) out.completeRatio = DEFAULTS.completeRatio;
  if (!(out.bankBuffer >= 0 && out.bankBuffer < 0.3)) out.bankBuffer = DEFAULTS.bankBuffer;
  return out;
}
let CFG = loadCfg();

const LOG_FILE = path.join(HOME_DIR, '刷课日志_' + new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) + '.log');   // 本地日期
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => {
  const line = new Date().toISOString().slice(11, 19) + ' ' + m;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
};
const fmt = s => (isFinite(s) && s > 0)
  ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '--';
const norm = s => String(s || '').replace(/\s+/g, '').replace(/[，。、；：？！“”‘’（）【】《》,.;:?!"'()\[\]]/g, '').toLowerCase();

function loadBank() {
  try { return JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')); } catch (e) { return {}; }
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(o) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {}
}
function loadDone() {
  try { return new Set(JSON.parse(fs.readFileSync(DONE_FILE, 'utf8'))); } catch (e) { return new Set(); }
}
const dumpedSet = new Set();
function dumpUnknown(list) {
  if (!list.length) return;
  try { if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true }); } catch (e) {}
  const fresh = list.filter(q => !dumpedSet.has(norm(q.q)));
  if (!fresh.length) return;
  fresh.forEach(q => dumpedSet.add(norm(q.q)));
  const f = path.join(DUMP_DIR, '未答题目_' + new Date().toISOString().slice(0, 10) + '.json');
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  arr.push(...fresh);
  try { fs.writeFileSync(f, JSON.stringify(arr, null, 2), 'utf8'); } catch (e) {}
  log(`📥 已导出 ${fresh.length} 道未答题目 → 题库\\未答题目_${new Date().toISOString().slice(0, 10)}.json`);
}

(async () => {
  let bank = loadBank();
  // 🗂 v7.6 首次启动：把"无课程前缀"的老题库键归入启动时所在的课程（题库按课程隔离，互不影响）
  const st0 = loadState();
  const bootCid = (String(st0.lastUrl || '').match(/courseId=(\d+)/) || [])[1] || '';
  if (bootCid && migrateBankCourse(bank, bootCid)) {
    saveBank(bank);
    log(`🗂 题库课程隔离：${untaggedKeys.length} 道无归属题目已归入课程 ${bootCid}（备份见 题库.json.bak_*）`);
  }
  let bankKeys = Object.keys(bank);
  log(`题库载入：${bankKeys.length} 道题` + (bankKeys.length ? '' : '（题库为空，测验会被跳过并导出）'));
  const videoDone = loadDone();
  const saveDone = () => { try { fs.writeFileSync(DONE_FILE, JSON.stringify([...videoDone]), 'utf8'); } catch (e) {} };
  // 📌 视频已被服务器记账的节（v5d 新增）：跟 videoDone 的区别 —— videoDone 会在降速重试时被删除，
  //    而这个集合只进不出：只要目录 inc 曾因"视频播完"而下降过一次，就永久记住"这个视频已经算完成任务点了"，
  //    避免后续把剩下的未知任务点误当成视频、反复重看（7.1 卡 2 小时 / 6.7 卡 8 小时都是这个原因）。
  const loadCredited = () => { try { return new Set(JSON.parse(fs.readFileSync(VIDEO_CREDITED_FILE, 'utf8'))); } catch (e) { return new Set(); } };
  const videoCredited = loadCredited();
  const saveCredited = () => { try { fs.writeFileSync(VIDEO_CREDITED_FILE, JSON.stringify([...videoCredited]), 'utf8'); } catch (e) {} };
  const unknownTried = new Map();   // secKey -> Set（本节已尝试过的未知类型任务点标签，防重复点）
  // 🎯 累计"真实播放秒数"（v6）：学习通按【真实播放时长】判定视频任务点（≥ 总时长 × 0.9），
  //    而真实时长 = Σ(播放进度增量 ÷ 倍速)。脚本自己记账 → 才能算出"还差多少、该用多快"。
  //    结构：{ [cid]: { acc: 秒, dur: 秒, at: ISO } }
  const loadWatchReal = () => { try { return JSON.parse(fs.readFileSync(WATCH_REAL_FILE, 'utf8')) || {}; } catch (e) { return {}; } };
  const watchReal = loadWatchReal();
  const saveWatchReal = () => { try { fs.writeFileSync(WATCH_REAL_FILE, JSON.stringify(watchReal), 'utf8'); } catch (e) {} };
  // 已交测验的节也要落盘（重启不丢）→ 用来反推"服务器还显示没做完的部分必然是视频"
  const loadQuiz = () => { try { return new Set(JSON.parse(fs.readFileSync(QUIZ_FILE, 'utf8'))); } catch (e) { return new Set(); } };
  const saveQuiz = () => { try { fs.writeFileSync(QUIZ_FILE, JSON.stringify([...quizSubmitted]), 'utf8'); } catch (e) {} };
  // 📝 v7.10：填空题/简答题 = 蒙不过的测验（10 空×10 词库全蒙对 = 1/10^10）→ 标记人工/AI，
  //   不再自动提交、不再被补刷回跳死循环；落盘保存，重启也记得
  const QUIZ_MANUAL_FILE = path.join(HOME_DIR, '.quiz_manual.json');
  const loadQuizManual = () => { try { return new Set(JSON.parse(fs.readFileSync(QUIZ_MANUAL_FILE, 'utf8'))); } catch (e) { return new Set(); } };
  const saveQuizManual = () => { try { fs.writeFileSync(QUIZ_MANUAL_FILE, JSON.stringify([...quizManual]), 'utf8'); } catch (e) {} };
  const redoFail = new Map();   // 补刷失败次数
  const redoBounce = new Map();  // 🏳 v7.10b：同一节被补刷拉回的次数（≥4 次仍做不完 → 放弃自动完成，掐死死循环）
  log(`已完成清单载入：${videoDone.size} 节`);

  // ── 优先连接「独立 Edge」（--remote-debugging-port=9222，由外部启动、归用户所有）──
  //    脚本被停/被杀/重启都不会关浏览器；只有用户手动关浏览器才会关。
  //    连不上独立 Edge 才自己拉起浏览器（兜底）。
  let ctx = null;
  let browser = null;
  const stealthFn = () => {
    try {
      Object.defineProperty(document, 'hidden', { get: () => false });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
      Object.defineProperty(document, 'webkitHidden', { get: () => false });
      Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible' });
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.onblur = null;
    } catch (e) {}

    // ── 强制倍速接管（2026-10-13 新增）──────────────────────────────────
    // 背景：很多节的播放器菜单里根本没有「1.25x」档（只有 0.5/1/1.5/2），
    //       原来只能 1x 硬播；直接改 video.playbackRate 又会被反作弊/播放器复位。
    // 方案：在 HTMLMediaElement.prototype 层接管 playbackRate ——
    //   ① 任何写入（菜单、播放器内部、反作弊复位）都重定向为目标速率
    //   ② play() 时立即套用
    //   ③ 每 2.5s 巡检，被偷偷改回去就立刻拉回
    // 目标速率写在这个变量里：window.__cxSpeed（0 = 不干预，脚本每轮动态下发）
    try {
      if (window.__cxSpeedHookedV2) return;
      const proto = HTMLMediaElement.prototype;
      const rateDesc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
      const defDesc = Object.getOwnPropertyDescriptor(proto, 'defaultPlaybackRate');
      const origPlay = proto.play;
      if (!rateDesc || !rateDesc.set) return;

      const nativeSet = (el, v) => { try { rateDesc.set.call(el, v); } catch (e) {} };
      const nativeGet = el => { try { return rateDesc.get.call(el); } catch (e) { return NaN; } };
      const want = () => Number(window.__cxSpeed) || 0;

      // ① setter 重定向：不管谁写入什么，一律变成目标速率
      Object.defineProperty(proto, 'playbackRate', {
        configurable: true, enumerable: true,
        get() { return rateDesc.get.call(this); },        // 读取仍返回真实值（脚本据此核验）
        set(v) {
          const t = want();
          nativeSet(this, (t > 0.05 && Math.abs(t - 1) > 0.005) ? t : v);
        }
      });
      Object.defineProperty(proto, 'defaultPlaybackRate', {
        configurable: true, enumerable: true,
        get() { const t = want(); return (t > 0.05 && Math.abs(t - 1) > 0.005) ? t : defDesc.get.call(this); },
        set(v) {
          const t = want();
          try { defDesc.set.call(this, (t > 0.05 && Math.abs(t - 1) > 0.005) ? t : v); } catch (e) {}
        }
      });

      // ② play() 时立刻套用目标速率（新视频元素诞生第一帧就是目标速率）
      proto.play = function () {
        const r = origPlay.apply(this, arguments);
        const t = want();
        if (t > 0.05 && Math.abs(nativeGet(this) - t) > 0.01) nativeSet(this, t);
        return r;
      };

      // ③ 巡检：每 2.5s 纠正一次（防播放器后台悄悄复位）
      // ⚠ 目标是 1x 也照样纠正——否则从 3x 改回 1x 时没人把速率拉回来（2026-10-13 实测踩坑）
      setInterval(() => {
        const t = want();
        if (!t || t <= 0.05) return;
        try {
          document.querySelectorAll('video, audio').forEach(el => {
            const cur = nativeGet(el);
            if (isFinite(cur) && Math.abs(cur - t) > 0.01) {
              nativeSet(el, t);
              el.dispatchEvent(new Event('ratechange'));   // 让播放器 UI 也跟着变
            }
          });
        } catch (e) {}
      }, 2500);

      window.__cxSpeedHookedV2 = true;
    } catch (e) {}
  };
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + CDP_PORT, { timeout: 5000 });
    ctx = browser.contexts()[0] || await browser.newContext();
    log(`已连接独立 Edge（调试端口 ${CDP_PORT}）—— 脚本停止/重启均不关浏览器，浏览器由你手动关闭`);
  } catch (e) {
    log(`未发现独立浏览器（${CDP_PORT}）→ 自行启动浏览器（兜底模式）`);
    browser = await chromium.launchPersistentContext(PROFILE, {
      executablePath: EDGE, headless: !!CFG.headless, viewport: CFG.headless ? { width: 1380, height: 860 } : null,
      // 信号不关浏览器：脚本被停/被杀时浏览器保留，由用户手动关闭
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      args: [
        '--no-first-run',
        '--window-size=1400,900',
        '--remote-debugging-port=' + CDP_PORT,        // 也开调试端口，之后重启脚本可复用这个浏览器
        '--autoplay-policy=no-user-gesture-required', // 免手势自动播放（关键：否则 play() 被拒）
        '--disable-features=CalculateNativeWinOcclusion', // 窗口被遮挡/最小化时不节流
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--mute-audio',                               // 全部静音，挂机不吵
      ]
    });
    ctx = browser;
  }
  // 反检测注入：对已有页面立即生效，对之后的导航/新页面也生效
  for (const p of ctx.pages()) {
    await p.addInitScript(stealthFn).catch(() => {});
    await p.evaluate(stealthFn).catch(() => {});
    p.on('dialog', d => d.accept().catch(() => {}));
  }
  ctx.on('page', p => {
    p.addInitScript(stealthFn).catch(() => {});
    p.on('dialog', d => d.accept().catch(() => {}));
  });
  log('浏览器已就绪 —— 请进入课程、点开任意一节，之后全程自动（可最小化挂后台）');

  // 任何未捕获异常都要留下遗言再死（之前进程会无声消失，排查无门）
  process.on('uncaughtException', e => {
    const msg = new Date().toISOString().slice(11, 19) + ' UNCAUGHT: ' + (e && e.stack ? e.stack.slice(0, 600) : String(e));
    console.error(msg);
    try { fs.appendFileSync(LOG_FILE, msg + '\n', 'utf8'); } catch (e2) {}
  });

  // 断点续刷 / 无人值守：自动打开上次章节（可在 刷课配置.json 里 autoOpen=false 关闭）
  const st = loadState();
  if (st.lastUrl) log('上次刷到：' + st.lastUrl.slice(0, 110));
  await sleep(4000);
  if (CFG.autoOpen && st.lastUrl && !ctx.pages().some(p => /chaoxing\.com\/mycourse\/student/i.test(p.url()))) {
    try {
      const p = ctx.pages()[0] || await ctx.newPage();
      await p.goto(st.lastUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      log('已自动打开上次章节（无人值守模式）');
    } catch (e) { log('自动打开章节失败：' + String(e.message).slice(0, 60)); }
    // 读目录 → 直接跳到第一个「还有未完成任务点」的节（补测验/补视频）
    await sleep(7000);
    const p0 = ctx.pages().find(p => /chaoxing\.com\/mycourse\/student/i.test(p.url())) || ctx.pages()[0];
    let cat = null;
    for (let i = 0; i < 4 && !cat; i++) { cat = p0 && await readCatalog(p0); if (!cat) await sleep(5000); }
    const target = cat && cat.find(x => x.inc > 0);
    const curCid = (st.lastUrl.match(/chapterId=(\d+)/) || [])[1];
    if (target && target.cid !== curCid) {
      log(`🎯 补刷起点：${target.label}（未完成 ${target.inc}）`);
      await gotoSection(p0, target.cid);
    } else if (cat && !target) {
      log('✅ 目录显示所有视频都已刷完');
    }
  }

  if (CFG.redoNow) {
    // 「立刻补刷」一次性开关：不管当前停在哪，直接跳到目录里第一个未完成的节
    const p0 = ctx.pages().find(p => /chaoxing\.com\/mycourse\/student/i.test(p.url()));
    if (p0) {
      let cat = null;
      for (let i = 0; i < 4 && !cat; i++) { cat = await readCatalog(p0); if (!cat) await sleep(4000); }
      const tgt = cat && cat.find(x => x.inc > 0);
      if (tgt) { log(`🎯 redoNow：跳到第一个未完成的节 → ${tgt.label}（未完成 ${tgt.inc}）`); await gotoSection(p0, tgt.cid); }
      else log('✅ redoNow：目录显示全部完成');
    }
    try {
      const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
      c.redoNow = false;
      fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2), 'utf8');
    } catch (e) {}
  }

  let round = 0;
  let noPageCnt = 0;               // 连续找不到课程页的轮数（自动恢复用）

  let loginLostAt = 0;             // 🚪 v7.9：登录失效起始时间（0=登录正常）
  let lastLoginNotifyAt = 0;       // 🚪 v7.9：上次弹窗/日志提醒时间（30 分钟一次，别刷屏）
  let submittingQuiz = false;      // 🏳 v7.10b：handleQuiz 正在提交+等 #popok → killPopups 别抢点取消
  // 🚪 v7.9：Windows 弹窗提醒（扫码登录需要人动手，光写日志用户看不到）
  function notifyUser(title, msg) {
    try {
      const esc = s => String(s).replace(/'/g, "''");
      const ps = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('" + esc(msg) + "', '" + esc(title) + "', 'OK', 'Warning')";
      require('child_process').spawn('powershell', ['-NoProfile', '-c', ps], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {}
  }
  const stuckCnt = new Map();
  const lastCur = new Map();
  const focusFixed = new Set();   // 已开焦点模拟的页面
  let nextDiagDone = false;       // 「下一节找不到」诊断只做一次
  let curSectionKey = '';
  let sectionEnterAt = Date.now();
  let lastProgressAt = Date.now();  // 最近一次视频有进度的时间（看门狗用）
  let incAtEntry = null;            // 进节时目录里的未完成任务点数（用于核验视频是否真完成）
  let replayCnt = 0;                // 本节重播次数（目录核验失败时重播，最多 2 次）
  let chipClicked = new Set();     // 本节已点过的任务点标签
  let lastNextAt = 0;
  const skipLogged = new Set();    // skipVideo 提示每节只打一次
  const vjdLogged = new Set();     // 「视频未完成一票裁决」提示每节只打一次（v7.1）
  const hasLoggedMediaKind = new Set();  // 🎧 v7.7：每节"媒体类型（音频/视频）"提示只打一次
  const mediaScrollTried = new Map();    // 🎯 v7.8d：每节"滚动触发懒加载"已尝试次数（防死循环）
  const quizShotDone = new Set();  // 每节测验只截一次图
  const quizSubmitted = loadQuiz(); // 已成功提交测验的节（防止重复点提交；落盘保存，重启也记得）
  const quizManual = loadQuizManual(); // 📝 v7.10：含填空/简答的节（蒙不过 → 人工/AI，不再自动交）
  const sectionEntryCnt = new Map(); // 🔄 v7.11：每节被进入的次数（环形翻节检测：测验交卷被弹回 → 绕圈）
  let liveCondRatio = null;        // 📅 v7.12：从页面明文解析的真实视频完成条件（英语 90% / CAD 100%）
  let liveCondSec = null;          // 📅 v7.15：该比例属于哪一节 —— 实测【同一门课里逐节都不同】（CAD 3.1=100%、3.3=90%）→ 必须按节重读
  let liveCondMax = null;          // 📅 v7.15：本课程见过的最严值（用于"本节文案还没渲染出来"时兜底，宁严不松）
  let liveCondMaxCid = null;       // 📅 v7.15：上面那个最严值属于哪个课程
  // 当前该按什么比例算"够不够"：本节已读到 → 用它；没读到 → 用本课程最严值；都没有 → 配置默认 0.9
  const condNow = () => (liveCondSec === curSectionKey && liveCondRatio) ? liveCondRatio
    : ((liveCondMaxCid === CUR_CID && liveCondMax) ? liveCondMax : CFG.completeRatio);
  let dailyLimitHit = false;       // 📅 v7.12：今日视频任务点完成数已达上限（触顶后今天视频全都不记账）
  let lastDailyCheckAt = 0;        // 📅 v7.12：上次复查每日额度的时间（30 分钟一次）

  // 🏳 v7.10b（2026-10-16）：放弃自动完成的节（无视频 + 测验/文档交不全，已重试多次仍 inc>0）
  //   —— 治"补刷死循环"：旧版 redoLimit=50 太高 + 不带 excludeCid 的 redoPass 会把这种节无限弹回。
  //   一旦放弃就写入磁盘，redoPass / quizPendingHere 都排除它，引擎不再回头，只留一句"待人工"提示。
  //   （想重新让它自动刷，删掉 题库/.abandon.json 里对应节即可）
  const ABANDON_FILE = path.join(HOME_DIR, '.abandon.json');
  const loadAbandon = () => { try { return new Set(JSON.parse(fs.readFileSync(ABANDON_FILE, 'utf8'))); } catch (e) { return new Set(); } };
  const saveAbandon = () => { try { fs.writeFileSync(ABANDON_FILE, JSON.stringify([...abandon]), 'utf8'); } catch (e) {} };
  const abandon = loadAbandon();
  const modalSeenAt = new Map();   // 🐞 弹窗看门狗：signature -> 首次出现时间
  const submitTry = new Map();     // 每节提交尝试次数（>3 次放弃，防死循环）
  // 🚨 反爬验证码 & 翻节熔断（2026-10-14 新增，2026-10-14 凌晨死循环教训）
  let captchaSeen = false;         // 验证码是否已出现（等待人工输入期间冻结所有点击）
  let captchaLogAt = 0;
  let skipNextFails = 0;           // 「下一节」连点无效计数
  let skipNextBlockUntil = 0;      // 熔断截止时间

  // 检测反爬验证码页（antispiderShowVerify / 【9010】操作异常）
  async function detectCaptcha(page) {
    for (const f of page.frames()) {
      const hit = await f.evaluate(() => {
        if (/antispider/i.test(location.href)) {
          const t = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();
          return t.slice(0, 50) || '反爬验证页面';
        }
        const bt = (document.body && document.body.innerText) || '';
        if (bt.includes('9010') || /请输入图片中的验证码/.test(bt)) {
          const m = bt.match(/【\d+】[^\s]*/);
          return m ? m[0].slice(0, 40) : '验证码页面';
        }
        return null;
      }).catch(() => null);
      if (hit) return hit;
    }
    return null;
  }

  // ───────── 🎯 倍速自动匹配（v6，2026-10-13 重写；已删除旧的"逐档降速 + 学习倍速"）─────────
  // 旧方案的问题：靠"试错"——先用快档，播完发现服务器不认，再降一档重看。既浪费整遍视频，
  //   又会被"服务器上报迟到"误判（7.3 白看 12 分钟）。
  // 新方案：不试错，直接按 [视频总时长 / 已累计真实播放秒数] 算出"保证一遍就够"的倍速。
  //   依据：完成条件 = 累计真实播放秒数 ≥ 总时长 × completeRatio（0.9）。
  //   watchTry 保留下来改作"本节核验失败次数"（迟到兜底 & 防死循环用）。
  const loadWatchTry = () => { try { return new Map(Object.entries(JSON.parse(fs.readFileSync(WATCH_TRY_FILE, 'utf8')))); } catch (e) { return new Map(); } };
  const saveWatchTry = () => { try { fs.writeFileSync(WATCH_TRY_FILE, JSON.stringify(Object.fromEntries(watchTry)), 'utf8'); } catch (e) {} };
  const watchTry = loadWatchTry();   // secKey -> 本节"核验失败"次数（迟到兜底 & 防死循环用）
  let autoSpeed = null;              // 自动匹配出的当前倍速（null = 沿用配置里的 speed 上限）
  let userSpeedSeen = null;          // 上一轮读到的用户配置 speed（检测用户手动改速）
  const effSpeed = () => (autoSpeed !== null ? autoSpeed : CFG.speed);

  // ───────── 目录树（右侧章节列表）─────────
  // 每节一行：<div class="posCatalog_select" id="cur<chapterId>">，行尾数字 = 未完成任务点数
  async function readCatalog(page) {
    for (const f of page.frames()) {
      try {
        const rows = await f.evaluate(() => {
          const out = [];
          document.querySelectorAll('.posCatalog_select[id^="cur"]').forEach(d => {
            const cid = (d.id || '').replace(/^cur/, '');
            const nameEl = d.querySelector('.posCatalog_name');
            const label = ((nameEl && nameEl.innerText) || d.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
            // ① 权威源（2026-10-13 实测）：隐藏字段 jobUnfinishCount = 精确的"待完成任务点数"
            //    比解析行尾数字可靠得多（已完成行尾根本没有数字 → 老版本读出 null → 日志里的"?"）
            let inc = null;
            const hid = d.querySelector('input.jobUnfinishCount');
            if (hid && hid.value !== '' && !isNaN(Number(hid.value))) inc = Number(hid.value);
            // ② 绿色对勾 = 本节全部完成
            if (inc === null && d.querySelector('.icon_Completed')) inc = 0;
            // ③ 兜底：整个 div 的行尾数字（13.1 问卷调查这类没有 input 也没有对勾的）
            if (inc === null) {
              const full = (d.innerText || '').trim().replace(/\s+/g, ' ');
              const m = full.match(/(\d+)\s*$/);
              if (m) inc = parseInt(m[1], 10);
            }
            out.push({ cid, label, inc });
          });
          return out;
        }).catch(() => null);
        if (rows && rows.length) return rows;
      } catch (e) {}
    }
    return null;
  }

  // 读当前节的真实任务点标签：只有带 cardid 的 li 才是任务点
  // （「讨论」这类是页签，id="tit2"、没有 cardid、onclick 是 changePan → 不计数）
  async function readJobTabs(page) {
    for (const f of page.frames()) {
      try {
        const tabs = await f.evaluate(() => {
          const out = [];
          document.querySelectorAll('li[cardid][id^="dct"]').forEach(el => {
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (t) out.push({ id: el.id, cardid: el.getAttribute('cardid') || '', text: t.slice(0, 20) });
          });
          return out;
        }).catch(() => null);
        if (tabs && tabs.length) return tabs;
      } catch (e) {}
    }
    return null;
  }
  const isKnownJob = t => /视频|测验|音频|听力|录音|语音/.test(String(t || ''));

  // 🎧 v7.7（2026-10-15）：任务点类型权威判据 —— 直接读 `.ans-job-icon` 的 class。
  //   为什么需要它：音频任务点（英语听力课的 .mp3/.wav）在学习通里【也标成「视频」】，
  //   旧代码只看标签名 → 认不出是音频 → 落到"未知任务点"分支白等 15 秒 → 目录不下降 → 跳节漏刷。
  //   实测 class 构成：`ans-job-icon ans-job-icon-clear ans-job-video`（视频）
  //                   `ans-job-icon ans-job-icon-clear ans-job-audio`（音频，v7.7 适配）
  //   → 从这里拿到"本节到底要刷什么"，比猜标签可靠。
  // ⚠ 缓存：只有真读到 .ans-job-icon 才写缓存；切换任务点标签时图标会消失（读不到）→ 保留上次结果，
  //   避免点「视频」页签后 type 变 null 导致媒体节被误判成文档节。
  const jobTypesCache = new Map();   // secKey -> { types: [...], at: ms }
  async function readJobTypes(page) {
    for (const f of page.frames()) {
      try {
        const types = await f.evaluate(() => {
          const out = [];
          document.querySelectorAll('.ans-job-icon').forEach(el => {
            const c = String(el.className);
            if (/ans-job-audio/.test(c)) out.push('audio');
            else if (/ans-job-video/.test(c)) out.push('video');
            else if (/ans-job-(doc|ppt|pdf|book)/.test(c)) out.push('doc');
            else out.push('other');
          });
          return out;
        }).catch(() => null);
        if (types && types.length) {
          jobTypesCache.set(curSectionKey, { types, at: Date.now() });
          return types;
        }
      } catch (e) {}
    }
    const c = jobTypesCache.get(curSectionKey);
    // 缓存 2 分钟内有效（否则换节后可能拿着旧课程的类型）
    return (c && Date.now() - c.at < 120000) ? c.types : null;
  }
  // 本节是否含媒体（视频或音频）任务点 —— 含就绝不能被当成"文档节"跳过
  async function hasMediaJob(page) {
    const t = await readJobTypes(page);
    return !!t && t.some(x => x === 'video' || x === 'audio');
  }

  // 🎯 权威判据（2026-10-13 17:35 实锤，比等目录刷新可靠得多）：
  //    学习通给每个任务点渲染一个 `.ans-job-icon`，它的 **aria-label 是明文**
  //    （"任务点未完成" / 可能还有"任务点已完成"）—— 属性值不经过 webfont 反爬，可直接读！
  //    并且 .task-condition 里写明完成条件："观看时长需 ≥ 总时长的 90%
  //    (未完成任务点前, 当前视频不可拖拽、观看时不可离开或将页面最小化)"。
  //    → 这解释了两件事：① 高倍速不记账（按实际播放时间算，1.5x 只有 66% 时长）；
  //      ② 不能拖拽进度条（脚本重看时用 currentTime=0 倒回 = 拖拽，会让本次观看作废！）
  async function readJobIcons(page) {
    for (const f of page.frames()) {
      try {
        const items = await f.evaluate(() => {
          const out = [];
          document.querySelectorAll('.ans-job-icon').forEach(el => {
            const condEl = el.querySelector('.task-condition');
            out.push({
              cls: String(el.className),
              aria: el.getAttribute('aria-label') || '',
              cond: condEl ? condEl.innerText.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
            });
          });
          return out;
        }).catch(() => null);
        if (items && items.length) return items;
      } catch (e) {}
    }
    return null;
  }
  // 每个媒体任务点（视频+音频 🎧v7.7）的完成状态列表（DOM 顺序 = 任务点顺序 = 媒体顺序）
  //   true=已完成 / false=未完成 / null=读不到
  async function readVideoJobList(page) {
    const icons = await readJobIcons(page);
    if (!icons || !icons.length) return null;
    // 🎧 v7.7：音频任务点图标若是别的类名（不是 ans-job-video）也能兜住 —— 只要页面里有音频
    //    iframe（ananas/modules/audio），就把"找不到媒体图标"的情况放宽为"用全部任务点图标"，
    //    避免音频节被误判成"没有媒体任务点"直接跳过（用户 2026-10-15 实测英语课 .wav/.mp3 卡住）。
    let v = icons.filter(i => /ans-job-(video|audio)/.test(i.cls));
    if (!v.length) {
      const hasAudioFrame = page.frames().some(f => /ananas\/modules\/(video|audio)/.test(f.url()));
      if (hasAudioFrame) v = icons.slice();
    }
    if (!v.length) return null;
    return v.map(i => /已完成/.test(i.aria) ? true : (/未完成/.test(i.aria) ? false : null));
  }
  // 视频任务点是否已完成：null = 读不到（未知）
  //   ⚠ v7.3 语义修正（2026-10-14）：改成"【全部】视频任务点都已完成"才算 true。
  //     旧实现只 `find()` 第一个视频图标 → 多视频节里第 1 个刷完就返回 true →
  //     第 2 个视频被当成"已完成"直接放行 → 漏刷。
  async function isVideoJobDone(page) {
    const list = await readVideoJobList(page);
    if (!list || !list.length) return null;
    if (list.some(x => x === false)) return false;
    if (list.every(x => x === true)) return true;
    return null;
  }
  // 当前是否有未完成的视频任务点图标（供"是否还有视频要刷"用）
  async function anyVideoJobUnfinished(page) {
    const d = await isVideoJobDone(page);
    return d === false;
  }
  // 🎧 v7.7：把"视频/音频任务点"统一叫「媒体」（日志用中文更直观）
  const MEDIA_CN = t => (t === 'audio' ? '音频' : '视频');
  // 本节媒体任务点全名的简称（日志里告诉用户"这节要刷的是音频还是视频"）
  async function mediaKindCn(page) {
    const t = await readJobTypes(page);
    if (!t || !t.length) return '视频';
    const hasA = t.includes('audio'), hasV = t.includes('video');
    if (hasA && hasV) return '视频+音频';
    return hasA ? '音频' : '视频';
  }

  // ── 🎯 按视频时长自动匹配倍速（v6，2026-10-13）────────────────────────────
  // 规则来源（实测 + 页面明文）：视频任务点完成 = 累计【真实播放秒数】≥ 总时长 × 0.9
  //   （.task-condition 原文："观看时长需 ≥ 总时长的 90%"；实测 7.3 位置播到 99.6% 仍不算完成，
  //     1.25x 一遍只攒 80% → 必须再补，证明按真实秒数累计）
  //   · 倍速 S 播 1 秒墙钟，攒到 1 秒真实时长，但进度只前进 S 秒
  //   · 所以从 cur 播到 dur 这一遍能攒 (dur - cur) / S 秒
  //   · 要"这一遍播完就达标"： acc + (dur - cur)/S ≥ target → S ≤ (dur - cur) / (target - acc)
  //   取不超过 speed 上限的最大合法档位 → 既最快、又保证一遍就能完成任务点。
  //   · 全新视频（acc=0, cur=0）：S ≤ 1/0.9 ≈ 1.11 → 自动选 1.1x（一遍过）
  //   · 已看过一半（acc=0.5·dur, cur=0）：S ≤ 1/0.4 = 2.5 → 直接上 2.5x（照样一遍过）
  const bankTarget = dur => dur * (condNow() + CFG.bankBuffer);   // 📅 v7.12/7.15：优先用页面明文的真实完成条件（按节）
  function matchSpeedByDuration(dur, cur, acc, cap) {
    if (!(dur > 0)) return cap;            // 读不到时长 → 用用户上限
    const need = bankTarget(dur) - acc;
    if (need <= 1) return cap;             // 真实时长已攒够 → 用最快速度把剩下播完
    const remPos = Math.max(dur - Math.max(cur, 0), 3);
    const fit = remPos / need;             // 这一遍播完刚好达标的倍速
    const want = Math.min(cap, fit);
    let pick = SPEED_STEPS[0];             // 吸附到"不超过 want"的最大档位（保证仍达标）
    for (const s of SPEED_STEPS) if (s <= want + 1e-9) pick = s;
    return pick;
  }
  const accOf = cid => (watchReal[cid] && watchReal[cid].acc) || 0;
  const maxPosOf = cid => (watchReal[cid] && watchReal[cid].maxPos) || 0;   // 历史上播到过的最大进度比例
  function addRealSec(cid, sec, dur, cur) {
    if (!(sec > 0)) return;
    const o = watchReal[cid] || { acc: 0, dur: 0 };
    if (dur > 0) {
      o.dur = Math.round(dur);
      const p = Math.min(cur / dur, 1);
      if (p > (o.maxPos || 0)) o.maxPos = Math.round(p * 1000) / 1000;      // 记最大进度（双保险用）
    }
    o.acc = Math.round((o.acc + sec) * 10) / 10;
    o.at = new Date().toISOString();
    watchReal[cid] = o;
    saveWatchReal();
  }

  // ⚠ 学习通明文规则（.task-condition）："未完成任务点前, 当前视频不可拖拽、观看时不可离开或将页面最小化"
  //    → 用 currentTime=0 倒回视频 = 拖拽 = 本次观看作废！重看只能让视频【自然重载】（整页刷新）。
  async function restartVideoSafely(page, tag) {
    let cur = 0;
    try { const vv = await collectVideos(page); if (vv.length) cur = vv[0].cur || 0; } catch (e) {}
    if (cur > 3) {
      log('🔁 重看 → 整页刷新让视频自然重载（严格遵守"不可拖拽"，不用 currentTime=0）');
      await page.reload({ timeout: 30000 }).catch(() => {});
      await sleep(9000);
    } else if (round % 6 === 1) {
      log(`↺ ${tag || ''}视频已在开头（${fmt(cur)}）→ 直接续播（不拖拽）`);
    }
  }

  // 🧩 未知类型任务点兜底（v5d 新增）：目录还剩任务点，但"视频已记账 + 测验已交" →
  //    剩下的多半是脚本没专门处理的类型（文档 / PPT / 课件 / 图书 / 阅读 …）。
  //    做法：逐个点开、停留观察，若目录未完成数下降就算拿下；否则记录下来，绝不在此死循环。
  // 🎧 v7.7 关键护栏：如果权威判据（.ans-job-icon）显示本节还有【视频/音频】任务点，
  //    那它就不是"未知类型"——是媒体没刷完。绝不能在这里乱点白等 15 秒然后跳节（音频节漏刷的根因）。
  async function tryUnknownJobs(page, secKey) {
    if (await hasMediaJob(page)) {
      if (round % 6 === 1) log('🎧 本节仍有视频/音频任务点未完成 → 不按"未知类型"处理，交回媒体流程');
      return false;
    }
    const tabs = await readJobTabs(page);
    if (!tabs) return false;
    const unknown = tabs.filter(t => !isKnownJob(t.text) && !/音频|听力|录音|语音/.test(t.text));
    if (!unknown.length) return false;
    const triedSet = unknownTried.get(secKey) || new Set();
    let got = false;
    for (const t of unknown) {
      const catA = await readCatalog(page);
      const meA = catA && catA.find(x => x.cid === secKey);
      if (meA && meA.inc === 0) return true;
      if (triedSet.has(t.text)) continue;
      triedSet.add(t.text);
      log(`🧩 检测到未知类型任务点「${t.text}」→ 点开停留观察…`);
      let clicked = false;
      for (const f of page.frames()) {
        try {
          const hit = await f.evaluate(txt => {
            const els = [...document.querySelectorAll('li[cardid]')];
            const el = els.find(e => ((e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20) === txt));
            if (el) { el.click(); return true; }
            return false;
          }, t.text).catch(() => false);
          if (hit) { clicked = true; break; }
        } catch (e) {}
      }
      if (!clicked) { log(`⚠ 未知任务点「${t.text}」没找到可点元素，跳过`); continue; }
      await sleep(15000);
      const catB = await readCatalog(page);
      const meB = catB && catB.find(x => x.cid === secKey);
      const incA = meA && meA.inc !== null ? meA.inc : null;
      if (meB && meB.inc !== null && incA !== null && meB.inc < incA) {
        log(`✅ 未知任务点「${t.text}」已记入（未完成 ${incA} → ${meB.inc}）`);
        got = true;
      } else {
        log(`⚠ 未知任务点「${t.text}」停留后目录未变化（可能需要特殊操作，先记下）`);
      }
    }
    unknownTried.set(secKey, triedSet);
    return got;
  }

  // 📄 同页文档卡片记阅兜底（v7.8g，2026-10-16 0:20）：
  //    文档/PPT 任务点与音频【同页签】、没有独立 tab 可点（tryUnknownJobs 点不到它）。
  //    做法：所有 frame 滚到底部 → 文档 iframe 加载记阅 → 停留 15s → 目录 inc 下降 = 拿下。
  //    实锤：1.1 节的 PPT 卡片，滚动停留 30s 就"未完成 2 → 0"。
  //    每节每次尝试间隔 ≥10 分钟（dwellTried 记上次尝试时间），防止在"跳过翻节"路径上每轮白等 15s。
  const dwellTried = new Map();
  async function dwellDocCards(page, secKey) {
    if (Date.now() - (dwellTried.get(secKey) || 0) < 600000) return false;   // 10 分钟内不重复试
    dwellTried.set(secKey, Date.now());
    const catA = await readCatalog(page);
    const meA = catA && catA.find(x => x.cid === secKey);
    for (const f of page.frames()) {
      await f.evaluate(() => { try { window.scrollTo(0, document.body.scrollHeight); } catch (e) {} }).catch(() => {});
      await sleep(800);
    }
    await sleep(15000);
    const catB = await readCatalog(page);
    const meB = catB && catB.find(x => x.cid === secKey);
    if (meA && meB && meA.inc !== null && meB.inc < meA.inc) {
      log(`✅ 文档卡片已记入（未完成 ${meA.inc} → ${meB.inc}）`);
      return true;
    }
    return false;
  }
  // 🧰 组合兜底：先点未知页签，再滚动记阅同页文档卡片（"跳过翻节"前的最后一道工序）
  async function tryUnknownThenDwell(page, secKey) {
    let got = await tryUnknownJobs(page, secKey);
    if (!got) got = await dwellDocCards(page, secKey);
    return got;
  }

  // 点目录里某一节跳过去（比「下一节」更强：能往回跳）
  async function gotoSection(page, cid) {
    for (const f of page.frames()) {
      try {
        const loc = f.locator('#cur' + cid + ' .posCatalog_name').first();
        if (await loc.isVisible().catch(() => false)) {
          await loc.click({ timeout: 3000 }).catch(() => {});
          await sleep(6000);
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  // 页面上是否出现绿色「任务点已完成」
  // ⚠ 关键坑（2026-10-13 实测）：学习通有字体反爬 —— 页面显示「任务点已完成」，
  //   DOM 里存的其实是乱码码位（靠自定义字体渲染成正常字），所以【文字匹配全部失效】。
  //   → 改用“绿色文字”这个视觉特征识别：绿字 + 文本长度 3~14 个字符 = 任务点已完成
  async function hasTaskDone(page) {
    for (const f of page.frames()) {
      try {
        const r = await f.evaluate(() => {
          const isGreen = c => {
            const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (!m) return false;
            const R = +m[1], G = +m[2], B = +m[3];
            return G > 90 && (G - R) > 35 && (G - B) > 35;
          };
          let hit = null;
          document.querySelectorAll('span,div,p,i,em,a,b,font,li').forEach(el => {
            if (hit) return;
            const rc = el.getBoundingClientRect();
            if (rc.width < 20 || rc.height < 8 || el.children.length > 2) return;
            if (!isGreen(getComputedStyle(el).color)) return;
            const t = (el.innerText || '').trim();
            if (t.length >= 3 && t.length <= 14) hit = { t: t, cps: [...t].map(c => c.codePointAt(0).toString(16)).join(',') };
          });
          // 兜底：少数页面文字没被反爬时，明文匹配仍然有效
          const raw = ((document.body && document.body.innerText) || '').indexOf('任务点已完成') !== -1;
          return { hit, raw };
        }).catch(() => null);
        if (r && (r.hit || r.raw)) return true;
      } catch (e) {}
    }
    return false;
  }

  // 补刷：目录里找第一个「有未完成 && 视频还没刷过」的节跳过去
  // 🔄 补刷：目录里找第一个「有未完成」的节跳过去（v7.9 可排除当前节 → 用于"翻节前先回头清旧账"）
  //   📝 v7.10：quizManual 里的节（填空/简答，蒙不过）不补刷 —— 补也是白补，还会死循环
  async function redoPass(page, excludeCid) {
    const cat = await readCatalog(page);
    if (!cat) return false;
    const cands = cat.filter(x => x.inc > 0 && x.cid !== excludeCid && !quizManual.has(x.cid) && !abandon.has(x.cid) && (redoFail.get(x.cid) || 0) < (CFG.redoLimit || 2));
    if (!cands.length) {
      const left = cat.filter(x => x.inc > 0);
      const manualLeft = left.filter(x => quizManual.has(x.cid));
      const abanLeft = left.filter(x => abandon.has(x.cid));
      const autoLeft = left.filter(x => !quizManual.has(x.cid) && !abandon.has(x.cid));
      if (autoLeft.length === 0) {
        if (manualLeft.length) log(`🎉 可自动完成的任务点已全部刷完；剩余 ${manualLeft.length} 节为【填空/简答题】测验（${manualLeft.map(x => x.label).slice(0, 5).join('、')}）→ 待人工/AI 作答`);
        if (abanLeft.length) log(`🏳 另有 ${abanLeft.length} 节已标记"放弃自动完成"（无视频 + 交不全，如 ${abanLeft.map(x => x.label).slice(0, 5).join('、')}）→ 删 学习通作业助手\.abandon.json 可重开`);
        if (!manualLeft.length && !abanLeft.length) log('🎉 全部任务点已完成，课程刷完！');
      } else if (left.length) {
        log(`🎉 视频任务点全部刷完，剩余 ${left.length} 节未完成项均为测验/问卷（等题库或人工）`);
      }
      else log('🎉 全部任务点已完成，课程刷完！');
      return false;
    }
    const target = cands[0];
    // 🏳 v7.10b：同一节被补刷拉回 ≥4 次仍做不完（典型：要及格分的测验 / 特殊任务点，蒙不过也交不全）
    //   → 按【目录 cid】标记 abandon（用 redoPass 自己掌握的目录 cid，彻底绕开 URL↔catalog 不一致），
    //     并改跳下一节，掐死"补刷→翻节→又补刷"的死循环。用户诉求：这种节直接跳过，后续人工补。
    const bounced = (redoBounce.get(target.cid) || 0) + 1;
    redoBounce.set(target.cid, bounced);
    if (bounced >= 4) {
      if (!abandon.has(target.cid)) {
        abandon.add(target.cid); saveAbandon();
        log(`🏳 补刷拉回「${target.label}」已达 ${bounced} 次仍做不完（需及格分/特殊任务点）→ 已放弃自动完成，后续人工补；删 学习通作业助手\.abandon.json 可重开`);
      }
      const rest = cands.slice(1).filter(x => !abandon.has(x.cid));
      if (!rest.length) { log('🏳 剩余未完成节均已标记放弃 → 删 学习通作业助手\.abandon.json 可重开'); return false; }
      const t2 = rest[0];
      redoFail.set(t2.cid, (redoFail.get(t2.cid) || 0) + 1);
      log(`🔄 改跳下一节：${t2.label}（未完成 ${t2.inc}）→ 跳转过去`);
      return gotoSection(page, t2.cid);
    }
    log(`🔄 补刷：${target.label}（未完成 ${target.inc}）→ 跳转过去`);
    redoFail.set(target.cid, (redoFail.get(target.cid) || 0) + 1);
    return gotoSection(page, target.cid);
  }

  // ───────── 基础工具 ─────────
  async function findNextBtn(page) {
    for (const f of page.frames()) {
      try {
        // 🚧 v7.14：绝不返回 jobFinishTip 全屏遮罩里的「下一节」！
        //   它是 a.nextChapter，会被下面的精确类名选择器命中 → 点它 = PCount.next 真跳走 + 遮罩残留卡死页面
        // 🚧 v7.15：也绝不允许返回【左侧目录行/目录里的元素】—— 那是跳章入口，不是"下一节"
        //   目录容器白名单：.posCatalog_select / .posCatalogBox / #mainCatalog / .zkCatalog / #catalog / .chapter_item / [id^=cur]
        const cands = f.locator('.jb_btn.next, a.nextChapter:visible, .prev_next.next');
        const n = await cands.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const c = cands.nth(i);
          if (!(await c.isVisible().catch(() => false))) continue;
          const inMask = await c.evaluate(el => !!el.closest('.maskDiv.jobFinishTip')).catch(() => false);
          const inCat = await c.evaluate(el => !!el.closest('.posCatalog_select, .posCatalogBox, #mainCatalog, .zkCatalog, #catalog, .chapter_item, [id^="cur"]')).catch(() => true);
          if (!inMask && !inCat) return c;
        }
        let loc = f.locator('a:has-text("下一节"), button:has-text("下一节") >> visible=true').first();
        if (await loc.isVisible().catch(() => false)) {
          const inMask2 = await loc.evaluate(el => !!el.closest('.maskDiv.jobFinishTip')).catch(() => false);
          const inCat2 = await loc.evaluate(el => !!el.closest('.posCatalog_select, .posCatalogBox, #mainCatalog, .zkCatalog, #catalog, .chapter_item, [id^="cur"]')).catch(() => true);
          if (!inMask2 && !inCat2) return loc;
        }
        loc = f.locator('text=下一节 >> visible=true').first();
        if (await loc.isVisible().catch(() => false)) {
          const inMask3 = await loc.evaluate(el => !!el.closest('.maskDiv.jobFinishTip')).catch(() => false);
          const inCat3 = await loc.evaluate(el => !!el.closest('.posCatalog_select, .posCatalogBox, #mainCatalog, .zkCatalog, #catalog, .chapter_item, [id^="cur"]')).catch(() => true);
          if (!inMask3 && !inCat3) return loc;
        }
      } catch (e) {}
    }
    return null;
  }

  // 🏳 v7.10b 通用弹窗兜底 + 看门狗（用户反馈"弹窗一直没处理掉"）
  //   现有 killPopups 只管 layui 弹层 / 文本按钮 / 「章节未完成」三类，漏了：
  //   · 测验"分数不足 / 不及格"等结果提示弹窗
  //   · 卡住的 stray #popok（确认提交）确认框（handleQuiz 没在提交流程里时）
  //   策略：优先点「取消/关闭/✕/×/知道了/好的/确定」等安全按钮（绝不误交坏成绩）；
  //         #popok 确认提交只有"带取消按钮"时才点取消，纯确认交回 handleQuiz 处理。
  //   看门狗：同一弹窗文本持续 >90s 关不掉 → 打印文本 + 截图，精确定位"到底是什么弹窗没处理"。
  const popupWatch = new Map();   // text -> { first, logged }
  async function dismissStrayPopups(f, page) {
    try {
      const found = await f.evaluate(() => {
        const vis = el => el && el.offsetWidth > 0 && el.offsetHeight > 0 && el.getClientRects().length > 0;
        const overlays = [...document.querySelectorAll('div,section')].filter(d => {
          // ⚠ v7.15：目录容器不是弹窗！它的行内有 onclick=跳章 → 一律排除（曾把"确定"匹配到目录行）
          if (d.closest('#mainCatalog, .posCatalogBox, .zkCatalog, #catalog, .posCatalog_select, [id^="cur"]')) return false;
          const s = getComputedStyle(d);
          if (s.position !== 'fixed' && s.position !== 'absolute') return false;
          const r = d.getBoundingClientRect();
          if (r.width < 120 || r.height < 50 || r.width > 1400 || r.height > 1000) return false;
          const hasBtn = [...d.querySelectorAll('a,button,[role=button],.layui-layer-btn0')].some(el => vis(el));
          if (!hasBtn) return false;
          return vis(d);
        });
        const res = [];
        for (const ov of overlays) {
          const t = (ov.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          const btns = [...ov.querySelectorAll('a,button,[role=button],.layui-layer-btn0')].filter(el => vis(el));
          // 安全关闭按钮（排除 #popok 本身，避免误交坏成绩）
          const cancel = btns.find(b => /取消|关闭|暂不|稍后|✕|×|X|知道了|好的|确定/i.test((b.innerText || '').trim()) && b.id !== 'popok');
          let acted = false;
          if (cancel) { try { cancel.click(); acted = true; } catch (e) {} }
          res.push({ text: t, acted });
        }
        return res;
      }).catch(() => []);
      const now = Date.now();
      const seen = new Set();
      for (const o of found) {
        if (!o.text) continue;
        seen.add(o.text);
        if (o.acted) log('🏳 已关闭一个残留弹窗（取消/关闭）：' + o.text.slice(0, 60));
        let w = popupWatch.get(o.text);
        if (!w) { w = { first: now, logged: false }; popupWatch.set(o.text, w); }
        if (!w.logged && now - w.first > 90000) {
          w.logged = true;
          log('⚠️ 看门狗：弹窗持续 >90s 未关闭 → 文本：「' + o.text + '」');
          try { await page.screenshot({ path: path.join(DUMP_DIR, '未处理弹窗_' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.png'), fullPage: false }); } catch (e) {}
        }
      }
      for (const k of [...popupWatch.keys()]) if (!seen.has(k)) popupWatch.delete(k);
    } catch (e) {}
  }

  // 🚧 v7.14（2026-10-17 实锤）：「刷不动」的总根源 —— jobFinishTip 全屏遮罩
  //   实测 DOM：<div class="maskDiv jobFinishTip maskFadeOut" style="z-index:999">
  //               全屏 1370×810、pointer-events:auto → 盖住整个页面 → 所有点击被静默拦截（旧代码 .catch 吞掉）
  //               内含 <a class="... nextChapter" onclick="closeDeleteWindow();PCount.next(...)">下一节</a>
  //                    <a class="btnBlue ... popMoveDele" onclick="scroll2Job()">去学习</a>
  //                    <a class="popClose" onclick="closeDeleteWindow()">✕</a>
  //   致命连锁：遮罩里的「下一节」= a.nextChapter → findNextBtn 第一优先精确匹配到它
  //             → 一"翻节"就点它 → PCount.next() 真跳走（这就是"手动放到前面又被弹回"）
  //             → 且遮罩不消失，继续挡页面 → 刷不动
  //   ⇒ 每次主循环先处理它：点「去学习」(scroll2Job，留在本节) 或 关闭✕(popClose)；绝不点「下一节」
  async function closeJobFinishMask(page) {
    for (const f of page.frames()) {
      try {
        const r = await f.evaluate(() => {
          const mask = document.querySelector('.maskDiv.jobFinishTip');
          if (!mask || getComputedStyle(mask).display === 'none') return null;
          const txt = (mask.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          // ① 先解除点击拦截 —— 遮罩全屏盖住页面，pointer-events:auto 会吞掉所有点击（"刷不动"的直接原因）
          mask.style.pointerEvents = 'none';
          // ② 只点右上角「关闭✕」(closeDeleteWindow)，然后【立即隐藏】不等它的关闭动画
          //    ⚠ 实测不用「去学习」：它的 onclick 是 scroll2Job()，点完会连带把页面导航走（5.2.2 → 父节 5.2）
          //    ⚠ 绝不点「下一节」(a.nextChapter → PCount.next 真跳走) / 「上一节」(a.preChapter → PCount.previous)
          const close = mask.querySelector('a.popClose');
          if (close) close.click();
          mask.style.display = 'none';
          return { txt, how: close ? '关闭✕' : '强制隐藏' };
        }).catch(() => null);
        if (r) { log(`🚧 全屏遮罩「${r.txt}」→ 已点「${r.how}」（否则它会拦截页面所有点击）`); return true; }
      } catch (e) {}
    }
    return false;
  }

  // 🎯 v7.15 安全点击（2026-10-17 实锤后引入）：一律走【页面内 el.click()】，绝不用 Playwright 的坐标点击。
  //   背景：`locator('text=确定').first().click()` 的坐标落点被浏览器交给了**左侧目录行**
  //        → 命中 <span class="posCatalog_name">5.2 精确定位工具</span> 的 onclick=getTeacherAjax(...)
  //        → 页面被导航到 5.2 → 引擎以为自己在"已刷过的节"→ 一路翻节 → 补刷再被点回 → 死循环绕圈。
  //   原理：Playwright 的 click 是"算出落点 → 让浏览器按坐标派发"，落点若落在别的元素上，
  //        浏览器就按落点上的真实元素派发事件 ⇒ 必然误伤（尤其目录这类"行内有 onclick"的元素）。
  //        页面内 el.click() 不产生坐标、不做 hit-test，只触发目标元素自身的处理函数 ⇒ 物理上不会误点别处。
  async function safeClick(loc) {
    if (!loc) return false;
    try { return await loc.evaluate(el => { try { el.click(); return true; } catch (e) { return false; } }); }
    catch (e) { return false; }
  }

  async function killPopups(page) {
    // 🚧 最先处理全屏遮罩（它在最上层，不先关掉下面什么点都被拦）
    await closeJobFinishMask(page);
    for (const f of page.frames()) {
      try {
        const els = await f.$$('.layui-layer .layui-layer-btn0, .popups-box .popbtns');
        for (const b of els) {
          if (await b.isVisible().catch(() => false)) {
            // 🎯 v7.15：改用页面内 click（不用坐标）—— 见下方 1048 行处的详细说明
            await b.evaluate(el => { try { el.click(); } catch (e) {} }).catch(() => {});
            log('已自动关闭一个弹窗');
          }
        }
        for (const t of ['继续观看', '继续学习', '我知道了', '确定']) {
          // 🎯 v7.15（2026-10-17 实锤 —— 本版本最关键修复 = "刷不动"的总根源）
          //   旧写法 `f.locator('text=' + t).first()`：Playwright 的 text= 是【子串匹配】！
          //   实测：'确定' 命中了目录行「5.2 精确定位工具」的 <span class="posCatalog_name">
          //        —— "精确定位" 里恰好含连续子串「确定」。
          //        于是"关弹窗"实际变成"点目录行"：触发该行自己的 onclick
          //        getTeacherAjax(courseId, clazzid, '235163955') → 页面被导航到 5.2
          //        → 引擎以为自己在"已刷过的节" → 一路翻节 → 补刷回来又被点走 → 无限绕圈。
          //   证据①：同秒出现 `locator.click("text=确定")`（引擎侧）与页面 `realClick posCatalog_name "5.2"`；
          //   证据②：目标元素诊断 = `SPAN.posCatalog_name @0,2081 292x40` —— 干干净净一个目录行。
          //   新写法：① 精确匹配（innerText 全等，不是子串）② 命中目录容器(.posCatalog* 或 [id^=cur])一律排除
          //          ③ 页面内 el.click()（不产生坐标、不做 hit-test，物理上不可能误点别处）
          const h = await f.evaluateHandle((t) => {
            const vis = el => {
              const s = getComputedStyle(el);
              if (s.display === 'none' || s.visibility === 'hidden') return false;
              const r = el.getBoundingClientRect();
              return r.width > 1 && r.height > 1;
            };
            const inCatalog = el => !!el.closest('.posCatalog_select, .posCatalogBox, #mainCatalog, .zkCatalog, #catalog, .chapter_item, [id^="cur"]');
            const list = [...document.querySelectorAll('a,button,span,div,p,i,em,li')]
              .filter(el => (el.innerText || '').replace(/\s+/g, '').trim() === t
                && el.children.length <= 1 && vis(el) && !inCatalog(el));
            return list[0] || null;
          }, t).catch(() => null);
          const l = h ? await h.asElement() : null;
          if (l) {
            // ⚠ 2026-10-13："继续观看"这类元素在学习通页面上常驻可见 → 每轮空点会刷屏日志，
            //    而且它可能是 seek 到上次位置的入口（学习通禁止拖拽）→ 只在视频真的暂停时才点
            if (t === '继续观看' || t === '继续学习') {
              let paused = false;
              try { paused = await f.evaluate(() => [...document.querySelectorAll('video, audio')].some(v => v.paused && !v.ended)); } catch (e) {}
              if (!paused) continue;
            }
            // ⚠ v7.13：弹窗「确定」常是导航动作（实测：进 3.1 秒弹某弹窗，点确定 → 5s 被弹回 5.2 绕圈）
            //   → 点之前读所在弹层文本：含导航意图词就不点（留给看门狗/人工）；提交等待期也绝不抢（popok 归 handleQuiz）
            if (t === '确定') {
              if (submittingQuiz) continue;
              const ptxt = await f.evaluate(() => {
                const vis = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden'; };
                const btns = [...document.querySelectorAll('a, button, span, div')].filter(b => vis(b) && /^(确\s*定)$/.test((b.innerText || '').trim()) && b.offsetWidth > 0
                  && !b.closest('.posCatalog_select, .posCatalogBox, #mainCatalog, .zkCatalog, #catalog, .chapter_item, [id^="cur"]'));
                for (const b of btns) {
                  let p = b.parentElement, hops = 0;
                  while (p && p !== document.body && hops < 6) {
                    const s = getComputedStyle(p);
                    if (s.position === 'fixed' || s.position === 'absolute') return (p.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
                    p = p.parentElement; hops++;
                  }
                }
                return '';
              }).catch(() => '');
              if (/去完成|继续学习|继续上次|上次学习|上次学到|跳转|前往|是否去|去学习/.test(ptxt)) {
                log('⚠ 弹窗「' + ptxt + '」的「确定」疑似导航动作 → 不点，避免被弹回（90s 后看门狗留截图）');
                continue;
              }
              if (ptxt) log('已点「确定」（弹窗：「' + ptxt + '」）');
              // 🎯 v7.15（2026-10-17 实锤，本版本最关键修复）
              //   Bug：`locator('text=确定').first().click()` 走的是 Playwright 的【坐标点击】——
              //        它算出一个落点后由浏览器按坐标派发，实测这个落点被交给了**左侧目录行**
              //        → 命中 <span class="posCatalog_name">5.2 精确定位工具</span> 的 onclick
              //        → 执行 getTeacherAjax(courseId,clazzid,'235163955') → 页面被导航到 5.2
              //        → 引擎发现自己在"已刷过的 5.2" → 一路翻节 → 回头补刷 → 又被点回 5.2 → 死循环绕圈
              //        （日志证据：16:08:17 locator.click("text=确定") 与页面 realClick posCatalog_name "5.2" 同秒发生）
              //   Fix：整段流程不用坐标 —— 直接在该元素上调用页面内的 el.click()。
              //        不产生鼠标坐标、不做 hit-test ⇒ 物理上不可能误伤目录行。
              const what = await l.evaluate(el => ({
                tag: el.tagName, cls: String(el.className || '').slice(0, 44),
                inMask: !!el.closest('.maskDiv,.layui-layer,.popups-box'),
                r: (b => Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height))(el.getBoundingClientRect())
              })).catch(() => null);
              const okClicked = await l.evaluate(el => { try { el.click(); return true; } catch (e) { return false; } }).catch(() => false);
              log(`🖱 已点「确定」——页面内 click（不用坐标）${okClicked ? '' : ' ⚠失败'}${what ? ' ｜ 目标 ' + what.tag + '.' + what.cls + ' @' + what.r + (what.inMask ? ' [在弹层内]' : ' [⚠不在弹层内]') : ''}`);
              break;
            }
            const okClicked2 = await l.evaluate(el => { try { el.click(); return true; } catch (e) { return false; } }).catch(() => false);
            log('已点「' + t + '」' + (okClicked2 ? '' : '（⚠页面内 click 失败）'));
            break;
          }
        }
        // 「当前章节还有任务点未完成，是否去完成?」弹窗（点下一节时弹出）
        // → 按「去学习」回到本节把测验做完（用户要求：完成了再下一节）
        //   旧版弹窗：fixed 弹层内两个 a.jb_btn，第一个 =「去学习」（白底）、第二个 =「下一节」（蓝底）
        //   新版弹窗（2026-10-14 实拍）：圆角白底 + 右上 ✕ + 两个胶囊按钮（去学习/下一节），按钮不再是 a.jb_btn
        //   ⚠ 按钮文字可能被字体反爬 → 只能按结构定位：容器内恰好两个可见可点元素横向并排 → 点第一个
        const clickedLearn = await f.evaluate(() => {
          const vis = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
          const BTN_SEL = 'a.jb_btn, a[class*="btn"], button, [role="button"]';
          const digs = [...document.querySelectorAll('div')].filter(d => {
            const s = getComputedStyle(d);
            if (s.position !== 'fixed' && s.position !== 'absolute') return false;
            const r = d.getBoundingClientRect();
            if (r.width < 250 || r.width > 800 || r.height < 80 || r.height > 400) return false;
            const jbs = [...d.querySelectorAll(BTN_SEL)].filter(vis);
            if (jbs.length !== 2) return false;   // 恰好两个按钮（旧版 ≥2，新版实测就是 2）
            // 弹窗特征：两个按钮横向并排（y 相近）且宽度接近（同款样式）
            const r0 = jbs[0].getBoundingClientRect(), r1 = jbs[1].getBoundingClientRect();
            if (Math.abs(r0.y - r1.y) >= 10) return false;
            if (r1.width > 0 && r0.width / r1.width > 3) return false;
            // 排除播放器控制条之类的误命中：弹窗容器内应有可关闭标记或按钮风格互异（一白一蓝）
            const hasClose = !!d.querySelector('[class*="close"], [class*="Close"]');
            const twoStyles = (() => {
              const c0 = getComputedStyle(jbs[0]).backgroundColor, c1 = getComputedStyle(jbs[1]).backgroundColor;
              return c0 !== c1;
            })();
            return hasClose || twoStyles;
          });
          if (!digs.length) return false;
          const d = digs[digs.length - 1];
          const jbs = [...d.querySelectorAll(BTN_SEL)].filter(vis);
          if (!jbs.length) return false;
          jbs[0].click();   // 第一个 =「去学习」（留在本节补完）
          return true;
        }).catch(() => false);
        if (clickedLearn) {
          log('🔙 「章节未完成」弹窗 → 已点「去学习」回到本节完成剩余任务点');
          await sleep(2000);
        }
        // 🏳 v7.10b：通用兜底 —— 关掉残留弹窗（分数不足/不及格提示、stray #popok 等）+ 看门狗
        await dismissStrayPopups(f, page);
      } catch (e) {}
    }
  }

  // 页面上是否存在某个任务点标签（如「测验」）—— 用于推断视频是否已刷完
  async function hasChip(page, re) {
    for (const f of page.frames()) {
      try {
        const loc = f.getByText(re).first();
        if (await loc.isVisible().catch(() => false)) return true;
      } catch (e) {}
    }
    return false;
  }

  // 点击任务点标签（如「2 视频」「节节测验」）
  // ⚠ v7.15：绝不允许命中左侧目录行（否则点击 = 跳章）；只在非目录元素里找
  async function clickChip(page, re, tag) {
    const key = curSectionKey + '|' + tag;
    if (chipClicked.has(key)) return false;
    for (const f of page.frames()) {
      try {
        const h = await f.evaluateHandle((rx) => {
          const re2 = new RegExp(rx);
          const inCatalog = el => !!el.closest('.posCatalog_select, .posCatalogBox, #mainCatalog, .zkCatalog, #catalog, .chapter_item, [id^="cur"]');
          const el = [...document.querySelectorAll('a,button,span,div,li,em,i,p')]
            .find(e => re2.test((e.innerText || '').trim()) && e.children.length <= 1
              && e.getBoundingClientRect().width > 1 && !inCatalog(e));
          return el || null;
        }, re.source).catch(() => null);
        const loc = h ? await h.asElement() : null;
        if (loc) {
          await safeClick(loc);
          chipClicked.add(key);
          log(`已点开任务点「${tag}」标签`);
          await sleep(2500);
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  // 视频卡住时的现场诊断：截图 + 可见元素/弹层统计
  async function dumpDiag(page, v) {
    try {
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
      try { fs.mkdirSync(DUMP_DIR, { recursive: true }); } catch (e) {}
      await page.screenshot({ path: path.join(DUMP_DIR, '截图_' + stamp + '.png') }).catch(() => {});
      const info = await v.frame.evaluate(() => {
        const texts = [];
        document.querySelectorAll('button,a,div,span').forEach(el => {
          const t = (el.innerText || '').trim();
          if (t && t.length <= 24 && el.offsetWidth > 0 && el.offsetHeight > 0) texts.push(t);
        });
        const vids = [...document.querySelectorAll('video, audio')].map(v => ({
          cls: v.className, cur: v.currentTime, dur: v.duration, paused: v.paused,
          muted: v.muted, rate: v.playbackRate, ready: v.readyState
        }));
        const sel = ['.ans-videoquiz', '.ans-videoquiz-opt', '.vjs-overlay', '.vjs-modal-dialog',
                     '.vjs-big-play-button', '.vjs-control-bar', '.prism-popup', '.popups-box',
                     '.layui-layer', '.maskDiv', '.videoquiz'];
        const counts = {};
        sel.forEach(s => { counts[s] = document.querySelectorAll(s).length; });
        return {
          url: location.href, vids, counts,
          frames: [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 90)),
          bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
          texts: [...new Set(texts)].slice(0, 50)
        };
      }).catch(() => null);
      fs.writeFileSync(path.join(DUMP_DIR, '诊断_' + stamp + '.json'), JSON.stringify(info, null, 2), 'utf8');
      log('🔍 现场诊断已存（截图+JSON）→ ' + path.basename(DUMP_DIR) + '\\截图_' + stamp + '.png');
      return info;
    } catch (e) { return null; }
  }

  // 用播放器自带的倍速菜单设速（直接改 playbackRate 会被播放器检测→暂停重置）
  const rateMenuDone = new Set();
  const rateLogged = new Set();     // 每视频「倍速生效」提示只打一次
  const menuMissed = new Set();     // 播放器菜单里没有目标档位的视频
  async function setRateViaUI(v) {
    if (rateMenuDone.has(v.key)) return;
    try {
      // 诊断确认：控件是标准 Video.js —— button.vjs-playback-rate 打开菜单，li.vjs-menu-item 是档位
      const btn = v.frame.locator('button.vjs-playback-rate').first();
      if (!(await btn.isVisible().catch(() => false))) {
        rateMenuDone.add(v.key);
        log('⚠ 未找到播放器倍速按钮，保持默认速度');
        return;
      }
      await btn.click({ timeout: 1500 }).catch(() => {});
      await sleep(800);
      const want = String(effSpeed());
      const item = v.frame.locator(`li.vjs-menu-item:has-text("${want}")`).first();
      if (await item.isVisible().catch(() => false)) {
        await item.click({ timeout: 1500 }).catch(() => {});
        await sleep(500);
        rateMenuDone.add(v.key);
        log(`🎚 已通过播放器菜单设置 ${want}x`);
      } else {
        rateMenuDone.add(v.key);
        menuMissed.add(v.key);
        log(`⚠ 播放器菜单里没有 ${want}x 档 → 交给底层强制倍速接管`);
      }
    } catch (e) { rateMenuDone.add(v.key); }
  }

  // 一次性诊断：把「倍速」按钮及其所在控制栏的 HTML 存下来，供后续精确修复
  let rateDiagDone = false;
  async function dumpRateCtrl(v) {
    if (rateDiagDone) return;
    rateDiagDone = true;
    try {
      const info = await v.frame.evaluate(() => {
        const hits = [];
        document.querySelectorAll('*').forEach(el => {
          const t = (el.innerText || '').trim();
          if (t === '倍速' && el.offsetWidth > 0 && el.offsetHeight > 0 && el.children.length <= 2) {
            hits.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), html: el.parentElement.outerHTML.slice(0, 1200) });
          }
        });
        return hits.slice(0, 3);
      }).catch(() => null);
      try { fs.mkdirSync(DUMP_DIR, { recursive: true }); } catch (e) {}
      fs.writeFileSync(path.join(DUMP_DIR, '倍速控件_诊断.json'), JSON.stringify(info, null, 1), 'utf8');
      log('🔍 倍速控件 HTML 已存 → 题库\\倍速控件_诊断.json');
    } catch (e) {}
  }

  // 🔑 v7.3（2026-10-14）：多视频节的 iframe URL 【一模一样】
  //    （都是 .../ananas/modules/video/index.html?v=2026-0920-1154，连全长 75 字符都相同）
  //    → 旧 key = f.url().slice(0,60) + '|' + i 会让两个视频拿到【同一个 key】→
  //      lastCur / stuckCnt / 真实时长累计 全部串号 → 倍速匹配算错、进度互相覆盖。
  //    改用【视频自身 mp4 地址】当身份（每个视频天然唯一），frame 序号兜底。
  const frameIds = new WeakMap(); let frameSeq = 0;
  const fidOf = f => { if (!frameIds.has(f)) frameIds.set(f, ++frameSeq); return frameIds.get(f); };
  // 🎯 v7.8d（2026-10-15 深夜，探针实锤后重写）：跨 frame 读"这个媒体自己的任务点状态"。
  //   实测结构（英语听力节）：每个真音频一个 ananas/modules/audio iframe（里面还有 1 个空 src
  //   的假 audio），状态由父文档 knowledge/cards 里的 .ans-job-icon（aria-label）说明 ——
  //   1 个 iframe = 1 个真音频 = 1 个任务点图标。
  //   做法：顺着 frame 链向上，在每层父文档里找【y 中心距离最近】的 .ans-job-icon（<150px），
  //   用它的 aria-label 判定（v5e 权威判据：明文、不受字体反爬影响）。比猜颜色标签可靠。
  async function cardDoneAcrossFrames(frame) {
    let f = frame;
    for (let k = 0; k < 3 && f; k++) {
      let fe = null;
      try { fe = await f.frameElement(); } catch (e) { break; }     // 顶层 frame 没有 frameElement
      if (!fe) break;
      const hit = await fe.evaluate(el => {
        const r = el.getBoundingClientRect();
        const myY = (r.top + r.bottom) / 2;
        let best = null, bestD = Infinity;
        document.querySelectorAll('.ans-job-icon').forEach(n => {
          const nr = n.getBoundingClientRect();
          if (nr.width < 2 && nr.height < 2) return;                // 隐藏的图标跳过
          const d = Math.abs((nr.top + nr.bottom) / 2 - myY);
          if (d < bestD) { bestD = d; best = n; }
        });
        if (!best || bestD > 150) return null;                      // 太远 = 不是本卡片的图标
        const aria = best.getAttribute('aria-label') || '';
        if (/已完成/.test(aria)) return true;
        if (/未完成/.test(aria)) return false;
        return null;                                                // aria 空 = 该任务点还没初始化
      }).catch(() => null);
      if (hit !== null) return hit;
      f = f.parentFrame();                                          // 再往上一层找
    }
    return null;
  }
  async function collectVideos(page) {
    const out = [];
    // 📅 v7.12：从页面明文读真实完成条件（实测 CAD 课 3.1="≥100%"、3.3="≥90%" —— 同一门课里逐节都不同！）
    //   按 0.9 攒时长遇到 100% 的节永远差 10% → 永远不记账 → 白看
    // 📅 v7.15：改成按【节】重读 + 课程内取最严值兜底（宁严不松：宁可慢一点，也不能因为算松了白看一遍）
    if (!liveCondRatio || liveCondSec !== curSectionKey) {
      for (const f of page.frames()) {
        if (!/knowledge\/cards/.test(f.url())) continue;
        const pct = await f.evaluate(() => {
          const m = (document.body ? document.body.innerText : '').match(/观看时长需?\s*[≥>=]?\s*总时长的?\s*(\d+)\s*%/);
          return m ? Number(m[1]) : null;
        }).catch(() => null);
        if (pct && pct >= 50 && pct <= 100) {
          liveCondRatio = pct / 100;
          liveCondSec = curSectionKey;
          if (liveCondMaxCid !== CUR_CID) { liveCondMax = null; liveCondMaxCid = CUR_CID; }
          if (liveCondMax === null || liveCondRatio > liveCondMax) liveCondMax = liveCondRatio;
          log(`📅 本节视频完成条件（页面明文）：观看时长 ≥ 总时长的 ${pct}% → 倍速匹配按 ${pct}% 目标执行`);
          break;
        }
      }
    }
    for (const f of page.frames()) {
      try {
        // 🎧 v7.7（2026-10-15）：音频任务点（.wav/.mp3，如英语听力课）也是标准 HTMLMediaElement，
        //    播放/暂停/倍速/真实时长语义与视频完全一致 → 直接一起收集，整套刷法通用。
        // 🎯 v7.8d：只收【真媒体】—— 探针实锤（2026-10-15 23:31）页面里有大量假 audio：
        //    knowledge/cards 文档里 1 个 src=页面URL 的占位、每个 ananas iframe 里 1 个空 src 模板。
        //    假元素 dur 永远 0、点不动，还会把真媒体挤出 active 位。判据：src 非空 且 ≠ 所在 frame 的 URL。
        const fUrl = f.url();
        const hs = await f.$$('video, audio');
        for (let i = 0; i < hs.length; i++) {
          const stt = await hs[i].evaluate(v => {
            const base = {
              paused: v.paused, ended: v.ended,
              cur: v.currentTime || 0, dur: v.duration || 0,
              rate: v.playbackRate || 1,
              src: (v.currentSrc || v.src || '').split('?')[0].slice(-48),
              fullSrc: (v.currentSrc || v.src || ''),
              tag: v.tagName.toLowerCase(),
            };
            return base;
          }).catch(() => null);
          if (!stt) continue;
          if (!stt.fullSrc || stt.fullSrc === fUrl) continue;   // 🎯 v7.8d：假/占位元素 → 直接跳过
          delete stt.fullSrc;
          const key = (stt.tag || 'v') + (stt.src ? 'S' + stt.src : 'F' + fidOf(f)) + '|' + i;
          out.push({ frame: f, el: hs[i], idx: i, key, ...stt });
        }
      } catch (e) {}
    }
    // 🎯 v7.8c：子文档内没读到状态的（独立 iframe 的音频全是这种）→ 跨 frame 补读
    const needDone = out.filter(v => v.done === null);
    for (const v of needDone) {
      v.done = await cardDoneAcrossFrames(v.frame).catch(() => null);
    }
    return out;
  }

  // 读题 + 自动作答（题库匹配）
  async function handleQuiz(page) {
    // 🔒 双保险：作业/考试页绝不作答、绝不提交（题目文本被字体反爬，蒙答必错且会计入成绩）
    if (CFG.protectWork && isHomeworkUrl(page.url())) {
      if (round % 20 === 1) log('🔒 handleQuiz 拦截：作业/考试页不自动作答');
      return { total: 0, matched: 0, unknown: 0 };
    }
    // ⚠ 不再因 quizSubmitted 盲目跳过（7.1 事故，2026-10-13）：
    //   新版测验渲染（doHomeWorkNew）【没有任何 input 元素】，被旧"页面锁定=已提交"判定误判
    //   → 假记录 → mustWatch 把已完成的视频无限重看。现在照常扫描：
    //   页面出现"真已交"证据（有 input 且全禁用）才维持记录；仍可作答就撤销假记录重新处理。
    const unknown = [];
    let total = 0, matched = 0, guessed = 0;
    let liveOpts = 0, lockedItems = 0;   // 可作答选项数 / 已锁死题目数（判断"是否早前已提交"）
    let totalInputs = 0;                 // input 总数（不管禁不禁用）——区分"锁死"和"根本没 input"
    let clickedAny = 0;                  // 实际点选的选项数（无 input 渲染的提交前提）
    let manualQuiz = false;              // 📝 v7.10：本节含填空/简答（蒙不过 → 人工/AI）
    for (const f of page.frames()) {
      let items = [];
      try { items = await f.$$('.TiMu'); } catch (e) {}
      if (!items.length) continue;
      let allOk = true;
      for (const it of items) {
        total++;
        // 已有可选项（没被禁用）才算还能作答；有 input 且全锁住 = 此前已经提交过了
        let inputs = 0, live = 0;
        try {
          inputs = await it.evaluate(el => el.querySelectorAll('input[type=radio],input[type=checkbox]').length).catch(() => 0);
          if (inputs > 0) {
            live = await it.evaluate(el => [...el.querySelectorAll('input[type=radio],input[type=checkbox]')]
              .filter(i => !i.disabled).length).catch(() => 0);
          }
        } catch (e) {}
        totalInputs += inputs;
        liveOpts += live;
        if (inputs > 0 && live === 0) lockedItems++;
        let qText = '';
        try { qText = await it.$eval('.Zy_TItle, .Zy_TItle .clearfix, .Zy_TItle .fl', el => el.innerText.trim()); } catch (e) {}
        if (!qText) { try { qText = (await it.innerText()).split('\n')[0]; } catch (e) {} }
        // 选项
        const opts = [];
        try {
          let lis = await it.$$('.Zy_ulTop li, .Zy_ulTop .clearfix li, ul li');
          if (!lis.length) lis = await it.$$('li');   // 新版渲染（doHomeWorkNew）：选项直接是 .TiMu 下的 li，无 input
          for (const li of lis) {
            let label = await li.$eval('.after, .num_option, i', el => el.innerText.trim()).catch(() => '');
            if (!label) { const t0 = (await li.innerText().catch(() => '')).trim(); label = (t0.split(/\s+/)[0] || '').slice(0, 2); }
            const text = (await li.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            if (text) opts.push({ label, text, el: li });
          }
        } catch (e) {}

        // 📝 v7.10（2026-10-16 上午实锤）：填空题/简答题 = 蒙不过的测验！
        //   实锤："Video Watching & Blank Filling" 1 题 10 空 × 10 词库 → 全蒙对 = 1/10^10，
        //   而且测验提交次数有限（乱交可能锁卷）→ 识别后【不蒙不交】，标记人工/AI 作答。
        //   旧行为：每轮蒙 1 个词 → 提交 → 目录不降 → "误记已交"撤销 → 再提交 → 死循环烧一晚上。
        //   ⚠ 必须放在 opts 收集之后（TDZ：const opts 在后面声明，提前引用直接抛异常）
        if (/填空|简答|论述|选词/.test(qText)) {
          manualQuiz = true;
          allOk = false;   // 绝不提交
          if (!quizManual.has(curSectionKey)) {
            quizManual.add(curSectionKey); saveQuizManual();
            log(`📝 本节含【填空题/简答题】（${(qText || '').slice(0, 34)}）→ 蒙题不可能完成，已标记为人工/AI 作答`);
            log('   📥 题目已导出（题库/待AI作答_*.png + 未答题目_*.json）→ 交给 AI 解出答案后手动提交');
            unknown.push({ q: qText.trim(), options: opts.map(o => o.label + '. ' + o.text) });
            dumpUnknown(unknown);   // 强制导出（不等 exportUnknown 开关）
            try {
              await page.screenshot({
                path: path.join(DUMP_DIR, '待AI作答_' + curSectionKey + '_' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.png'),
                fullPage: true,
              });
            } catch (e) {}
          }
          continue;   // 不点不交，直接看下一题
        }

        // 题库匹配（🗂 v7.6 课程隔离）：**只在当前课程命名空间里**匹配，避免串课程乱填。
        //   —— 老题库无前缀键已在启动时归入启动课程；此处对无前缀键一律不匹配（安全第一）。
        const nq = norm(qText);
        let hit = null;
        for (const k of (CFG.autoQuiz ? bankKeys : [])) {
          if (!bankKeyInCourse(k, CUR_CID)) continue;   // 🗂 只认本课程的键（无前缀/别的课程一律跳过）
          const nk = norm(stripCourseTag(k));
          if (!nk || nk.length < 4) continue;
          if (nq.includes(nk) || nk.includes(nq.slice(0, 20))) { hit = bank[k]; break; }
        }
        if (hit) {
          const ans = Array.isArray(hit) ? hit : [hit];
          for (const a of ans) {
            const na = norm(a);
            const o = opts.find(x => norm(x.label) === na || norm(x.text) === na || norm(x.text).includes(na));
            if (o) { await o.el.click({ timeout: 1500 }).catch(() => {}); clickedAny++; await sleep(300); }
          }
          matched++;
        } else {
          unknown.push({ q: qText.trim(), options: opts.map(o => o.label + '. ' + o.text) });
          // 章节测验：题库没答案 → 随机蒙一个照样交（任务点只认"提交"这个动作）
          // 作业页永远不会走到这里（主循环 HOMEPAT 会提前拦掉）
          if (CFG.guessUnknown) {
            if (opts.length) {
              // 判断单选/多选：checkbox=多选（随机点 2 个）、radio 或读不到=单选（点 1 个）
              const multi = await it.evaluate(el => {
                if (el.querySelector('input[type="checkbox"]')) return true;
                if (el.querySelector('input[type="radio"]')) return false;
                return null;
              }).catch(() => null);
              const pickN = (multi === false || multi === null) ? 1 : Math.min(opts.length, 2);
              const pool = opts.slice();
              for (let k = 0; k < pickN && pool.length; k++) {
                const idx = Math.floor(Math.random() * pool.length);
                await pool[idx].el.click({ timeout: 1500 }).catch(() => {});
                clickedAny++;
                pool.splice(idx, 1);
                await sleep(250);
              }
            }
            // 无选项（填空/简答）也放行 → 留空直接交，避免卡死在一节上
            guessed++;
          } else {
            allOk = false;    // 既不蒙也不交 → 本节留着等题库
          }
        }
      }
      if (total > 0 && totalInputs > 0 && liveOpts === 0) {
        // 【真已提交】的唯一定据：页面有 input 且全部被禁用
        // （⚠ 2026-10-13 7.1 事故：新版渲染根本没有 input，旧判定 lockedItems>0 && liveOpts===0
        //   把"没 input"误判成"全锁死"→ 假记录 → 视频被无限重看）
        if (!quizSubmitted.has(curSectionKey)) {
          quizSubmitted.add(curSectionKey); saveQuiz();
          log('ℹ️ 本节测验此前已提交（input 全部锁死）→ 记录为已交');
        }
      } else if (total > 0 && quizSubmitted.has(curSectionKey)) {
        // 页面仍可作答 → 之前记的"已交"是假的 → 撤销并重新处理
        quizSubmitted.delete(curSectionKey); saveQuiz();
        log('⚠️ 此前误记"测验已交"，但页面仍可作答 → 撤销记录，重新作答提交');
      }
      // 全部命中才提交（同一节最多尝试 3 次，防死循环）
      // 无 input 渲染（doHomeWorkNew）：liveOpts=0 但只要真点选过选项就可以交
      if (allOk && total > 0 && (liveOpts > 0 || (totalInputs === 0 && clickedAny > 0)) && (submitTry.get(curSectionKey) || 0) < 3) {
        submittingQuiz = true;   // 🏳 v7.10b：进入提交流程（含等 #popok）→ killPopups 别抢点取消
        submitTry.set(curSectionKey, (submitTry.get(curSectionKey) || 0) + 1);
        // 铁证基线：取「点提交这一刻」的目录未完成数。
        // 不能用 incAtEntry（进节时的值）——视频完成是异步上报的，会出现 2→1 的假成功
        //（降的那 1 个其实是视频，测验根本没交上去 → 2026-10-13 凌晨 2.4~4.8 全部假提交的根因）
        let incBefore = null;
        {
          const catB = await readCatalog(page);
          const meB = catB && catB.find(x => x.cid === curSectionKey);
          if (meB && meB.inc !== null) incBefore = meB.inc;
        }
        let clickedSubmit = false;
        for (const t of ['提交', '保 存', '保存']) {
          const b = f.locator(`a:has-text("${t}"), button:has-text("${t}"), .Zy_btn:has-text("${t}")`).first();
          if (await b.isVisible().catch(() => false)) {
            await b.click({ timeout: 2500 }).catch(() => {});
            clickedSubmit = true;
            log('已点「提交」→ 等待「确认提交?」弹窗…');
            // 确认弹窗结构已实测：顶层 frame 的 div#workpop.maskDiv，确认按钮 = <a id="popok">
            // （弹窗文字有字体反爬，绝不能用文字匹配，只用 id！）
            let ok = false;
            for (let i = 0; i < 10 && !ok; i++) {
              await sleep(1500);
              for (const ff of page.frames()) {
                const pk = ff.locator('#popok').first();
                if (await pk.isVisible().catch(() => false)) {
                  await pk.click({ timeout: 2000 }).catch(() => {});
                  ok = true;
                  break;
                }
              }
            }
            if (ok) log('✅ 已点「确认提交」(popok)');
            // 铁证校验：目录行尾数字必须比「点提交前」下降，否则视为没提交成功（下轮重试）
            await sleep(4000);
            let verified = false;
            for (let vi = 0; vi < 3 && !verified; vi++) {
              const catS = await readCatalog(page);
              const meS = catS && catS.find(x => x.cid === curSectionKey);
              if (meS && meS.inc !== null && incBefore !== null && meS.inc < incBefore) {
                log(`✅ 目录确认提交成功（未完成 ${incBefore} → ${meS.inc}）`);
                quizSubmitted.add(curSectionKey); saveQuiz();
                if (meS.inc === 0 && !videoDone.has(curSectionKey)) { videoDone.add(curSectionKey); saveDone(); }
                incAtEntry = meS.inc;
                verified = true;
              } else if (vi < 2) {
                await sleep(6000);   // 服务端上报有延迟，多核两次
              }
            }
            if (!verified) {
              if (ok) { log('⚠ 确认已点但目录未下降 → 暂按已提交处理，下轮目录复核兜底'); quizSubmitted.add(curSectionKey); saveQuiz(); }
              else log('⚠ 未等到确认弹窗且目录未下降 → 不标记成功，稍后自动重试');
            }
            await sleep(1500);
            break;
          }
        }
        if (!clickedSubmit) {
          // 新版渲染（doHomeWorkNew）的提交按钮是 div/span，locator 匹配不到 → 按精确文本兜底
          clickedSubmit = await f.evaluate(() => {
            const els = [...document.querySelectorAll('a,button,div,span')].filter(el => {
              const t = (el.innerText || '').trim();
              return t === '提交' && el.offsetWidth > 0 && el.offsetHeight > 0;
            });
            if (!els.length) return false;
            els[els.length - 1].click();   // 取最内层那个（外层容器也含同样文字）
            return true;
          }).catch(() => false);
          if (clickedSubmit) {
            log('已点「提交」（新版渲染 div 按钮）→ 等待「确认提交?」弹窗…');
            let ok2 = false;
            for (let i = 0; i < 10 && !ok2; i++) {
              await sleep(1500);
              for (const ff of page.frames()) {
                const pk = ff.locator('#popok').first();
                if (await pk.isVisible().catch(() => false)) {
                  await pk.click({ timeout: 2000 }).catch(() => {});
                  ok2 = true;
                  break;
                }
              }
            }
            if (ok2) log('✅ 已点「确认提交」(popok)');
            await sleep(4000);
            const catS2 = await readCatalog(page);
            const meS2 = catS2 && catS2.find(x => x.cid === curSectionKey);
            if (meS2 && meS2.inc !== null && incBefore !== null && meS2.inc < incBefore) {
              log(`✅ 目录确认提交成功（未完成 ${incBefore} → ${meS2.inc}）`);
              quizSubmitted.add(curSectionKey); saveQuiz();
              if (meS2.inc === 0 && !videoDone.has(curSectionKey)) { videoDone.add(curSectionKey); saveDone(); }
              incAtEntry = meS2.inc;
            } else if (ok2) {
              log('⚠ 确认已点但目录未下降 → 下轮目录复核兜底');
            } else {
              log('⚠ 未等到确认弹窗 → 稍后自动重试');
            }
            await sleep(1500);
          }
        }
      }
    }
    submittingQuiz = false;   // 🏳 v7.10b：提交流程结束（无论成功与否），复位避免误伤正常弹窗
    // 🏳 v7.10b：提交试满 3 次仍过不了（需要正确率/及格分，脚本蒙不过）→ 放弃本节自动完成，后续人工补
    if (total > 0 && (submitTry.get(curSectionKey) || 0) >= 3) {
      try {
        const catF = await readCatalog(page);
        const meF = catF && catF.find(x => x.cid === curSectionKey);
        if (meF && meF.inc !== null && meF.inc > 0 && !abandon.has(curSectionKey)) {
          abandon.add(curSectionKey); saveAbandon();
          log(`🏳 本节测验已尝试提交 ${submitTry.get(curSectionKey)} 次仍未通过（需要正确率/及格分，脚本蒙不过）→ 已放弃自动完成，留待人工/AI 补；删 学习通作业助手\.abandon.json 可重开`);
        }
      } catch (e) {}
    }
    if (total > 0) {
      if (CFG.autoQuiz) {
        log(`本节测验 ${total} 题：题库命中 ${matched} 题`
          + (guessed ? `，随机蒙答 ${guessed} 题` : '')
          + (unknown.length ? (CFG.exportUnknown ? `（${unknown.length} 题已导出，答案入库后下次更准）` : `（${unknown.length} 题无答案已蒙，未导出）`) : ''));
      } else {
        log(`本节测验 ${total} 题（自动保存已关闭 → 仅记录题目，不点不交）`);
      }
    }
    // 导出开关（exportUnknown）：章节测验蒙答只求任务点，默认不导出不截图；
    // 想要 AI 解真答案提高正确率时，把 刷课配置.json 里 exportUnknown 改成 true
    if (CFG.exportUnknown) {
      if (unknown.length && !quizShotDone.has(curSectionKey)) {
        quizShotDone.add(curSectionKey);
        // 学习通题目有字体反爬（innerText 是乱码）→ 连截图一起存，AI 看图解题
        // fullPage=true 截整页，多选题的长选项不会被视口截断
        try { await page.screenshot({ path: path.join(DUMP_DIR, '测验截图_' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.png'), fullPage: true }); } catch (e) {}
      }
      dumpUnknown(unknown);
    }
    // 📝 v7.10：蒙不过的填空/简答测验 → 没点没交，直接返回（主循环见到 manual=true 会放行翻节，
    //   且补刷回跳（redoPass）会跳过这些节，不会再回来死循环）
    if (manualQuiz) return { total, matched, unknown: unknown.length, manual: true };
    return { total, matched, unknown: unknown.length };
  }

  // ───────── 🎬 视频内弹题（插入题）2026-10-13 重写 ─────────
  // 📌 真实 DOM（本轮实测抓取，见 诊断工具\视频弹题_DOM2.json）：
  //   容器 div.ans-videoquiz（外层 x-component，id 形如 videoquiz-1048）
  //   题型 .tkTopic_title（"判断题" / "单选题" / "多选题"）
  //   题干 .tkItem_title
  //   选项 ul.tkItem_ul > li.ans-videoquiz-opt > label > input[type=radio|checkbox] + 文字"A、对"
  //   提交 a#videoquiz-submit（提交中 a#videoquiz-submitting）
  //   反馈 #spanHas「回答正确」/ #spanNot「回答错误」/ #spanNotBack「回答错误，回看 X 分钟」
  //   继续 a#videoquiz-continue（点掉弹层）
  // ⚠ 旧版两个致命 bug：
  //   ① 只在「视频卡住 2 轮」时才去查弹题 —— 而弹题弹出时视频往往【照常在播】→ 永远不会被处理；
  //   ② 题干用 .ans-videoquiz-tit 读 → 实际类名是 .tkItem_title → 读到空 → 题库永远命中不了。
  // ✅ 政策（用户 2026-10-13 19:13 实证确认）：弹题答错无影响 → 题库没有就蒙。
  //    并做「错题记忆」：蒙错过的选项记下来，同题再次弹出时自动换别的选项。
  const loadVqWrong = () => { try { return JSON.parse(fs.readFileSync(VQ_WRONG_FILE, 'utf8')) || {}; } catch (e) { return {}; } };
  const vqWrong = loadVqWrong();
  const saveVqWrong = () => { try { fs.writeFileSync(VQ_WRONG_FILE, JSON.stringify(vqWrong, null, 2), 'utf8'); } catch (e) {} };
  const vqTries = new Map();     // 本次运行内：同一道弹题尝试次数（防死循环）
  const vqLogged = new Set();    // 日志去重
  let vqBusy = false;            // 同一时刻只处理一个弹题

  // 把题库里的答案（"对" / "D" / ["A","B"]）映射成页面上的选项
  function pickOptions(opts, ans) {
    const na = norm(ans);
    if (!na) return [];
    let o = opts.find(x => norm(x.letter) === na);
    if (!o) o = opts.find(x => norm(x.text) === na);
    if (!o) o = opts.find(x => norm(x.text).includes(na));
    return o ? [o] : [];
  }
  // 答对 → 写回题库（题库热重载，下次同题直接秒答）
  //   🗂 v7.6：写入时带【课程ID】前缀 → 只属于自己的课程，不会污染别的课程
  function learnAnswer(q, val) {
    try {
      if (!q || !val || !String(val).length) return;
      const key = (COURSE_TAG_RE.test(q) ? q : tagOfCourse(CUR_CID) + q);
      bank[key] = val;
      let raw = {};
      try { raw = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')) || {}; } catch (e) {}
      raw[key] = val;
      fs.writeFileSync(BANK_FILE, JSON.stringify(raw, null, 2), 'utf8');
      bankKeys = Object.keys(bank);
      log(`📚 弹题答案已入库（课程 ${CUR_CID}）：${Array.isArray(val) ? val.join('') : val} → ${String(q).slice(0, 26)}`);
    } catch (e) {}
  }

  async function answerVideoQuiz(box, frame) {
    const st = await box.evaluate(el => {
      const vis = s => { const n = el.querySelector(s); return !!(n && n.offsetWidth > 0 && n.offsetHeight > 0); };
      const txt = s => { const n = el.querySelector(s); return n ? (n.innerText || '').replace(/\s+/g, ' ').trim() : ''; };
      const lis = [...el.querySelectorAll('li.ans-videoquiz-opt')];
      const opts = lis.map((li, i) => {
        const inp = li.querySelector('input');
        const t = (li.innerText || '').replace(/\s+/g, ' ').trim();
        return { idx: i, text: t, letter: (t.match(/^([A-Za-z])/) || [, ''])[1], checked: !!(inp && inp.checked), disabled: !!(inp && inp.disabled) };
      });
      return {
        type: txt('.tkTopic_title'), q: txt('.tkItem_title'), opts,
        multi: !!el.querySelector('input[type=checkbox]'),
        correct: vis('#spanHas'), wrong: vis('#spanNot') || vis('#spanNotBack'),
        fbTxt: [txt('#spanHas'), txt('#spanNot'), txt('#spanNotBack')].filter(Boolean).join('/'),
        submitting: vis('#videoquiz-submitting'),
        hasSubmit: vis('#videoquiz-submit'), hasContinue: vis('#videoquiz-continue'),
      };
    }).catch(() => null);
    if (!st || (!st.q && !st.opts.length)) return false;
    const nq = norm(st.q);
    const short = (st.q || '').slice(0, 26);
    if (!CFG.videoQuiz) return true;    // 开关关掉 → 只识别存在，不点任何东西（你自己答）

    // ① 已经答过（有"回答正确/错误"反馈）→ 记录结果，并点「继续」关掉弹层
    if (st.correct || st.wrong) {
      const picked = st.opts.filter(o => o.checked);
      if (st.correct && picked.length && st.q) {
        const val = st.type.includes('判断')
          ? (norm(picked[0].text).includes('错') ? '错' : '对')
          : (st.multi ? picked.map(o => o.letter).filter(Boolean) : (picked[0].letter || picked[0].text));
        if (vqLogged.add('learn' + nq)) learnAnswer(st.q, val);
      } else if (!st.correct && picked.length) {
        const arr = vqWrong[nq] || [];
        picked.forEach(o => { if (!arr.includes(o.text)) arr.push(o.text); });
        vqWrong[nq] = arr; saveVqWrong();
        if (vqLogged.add('fb' + nq + st.fbTxt)) log(`🎬 弹题反馈：${st.fbTxt || '回答错误'}（已选 ${picked.map(o => o.text).join('、')}）→ 已记入错题，下次换别的选项`);
      }
      if (st.hasContinue && vqLogged.add('cont' + nq)) {
        await box.evaluate(el => { const c = el.querySelector('#videoquiz-continue'); if (c) c.click(); }).catch(() => {});
        log(`🎬 已点「继续」关闭弹题（${short}）`);
      }
      return true;
    }
    if (st.submitting) return true;                 // 提交中 → 等下一轮

    const opts = st.opts.filter(o => !o.disabled);
    if (!opts.length || !st.hasSubmit) return false;
    const wrongSet = vqWrong[nq] || [];

    // ② 选答案：题库优先（题库有答案就一定能选出来），否则蒙（排除错题记忆里的选项）
    //    🗂 v7.6：只在本课程命名空间里查（防跨课程串答案）
    let picks = [], fromBank = false;
    for (const k of bankKeys) {
      if (!bankKeyInCourse(k, CUR_CID)) continue;   // 🗂 只认本课程的键（无前缀/别的课程一律跳过）
      const nk = norm(stripCourseTag(k));
      if (!nk || nk.length < 4) continue;
      if (nq && (nq.includes(nk) || nk.includes(nq.slice(0, 20)))) {
        const v = bank[k];
        const got = [];
        for (const a of (Array.isArray(v) ? v : [v])) got.push(...pickOptions(opts, a));
        if (got.length) { picks = got; fromBank = true; break; }
      }
    }
    const tries = vqTries.get(nq) || 0;
    if (fromBank) {
      picks = picks.filter(o => !wrongSet.includes(o.text));   // 题库答案若曾答错 → 换别的
      if (!picks.length) {
        const cands = opts.filter(o => !wrongSet.includes(o.text));
        picks = [cands[0] || opts[0]];
        log(`⚠ 弹题「${short}」题库答案与错题记忆冲突 → 改选 ${picks[0].text}`);
      } else if (vqLogged.add('bank' + nq)) {
        log(`🎬 视频弹题（${st.type || '题'}）「${short}」→ 按题库作答：${picks.map(o => o.text).join('、')}`);
      }
    } else {
      if (tries >= (CFG.videoQuizMaxTry || 3)) {
        if (vqLogged.add('giveup' + nq)) log(`🎬 弹题「${short}」已试 ${tries} 次仍无答案 → 不再蒙（实测不答也不影响任务点，留给你手动）`);
        return true;
      }
      const cands = opts.filter(o => !wrongSet.includes(o.text));
      const pool = (cands.length ? cands : opts).slice();
      const n = st.multi ? Math.min(2, pool.length) : 1;
      for (let i = 0; i < n && pool.length; i++) {
        const k = Math.floor(Math.random() * pool.length);
        picks.push(pool[k]); pool.splice(k, 1);
      }
      if (vqLogged.add('guess' + nq + tries)) {
        log(`🎬 视频弹题（${st.type || '题'}）「${short}」题库无答案 → 第 ${tries + 1} 次蒙：${picks.map(o => o.text).join('、')}`
          + (wrongSet.length ? `（已避开错过的 ${wrongSet.join('、')}）` : ''));
      }
    }
    if (!picks.length) return false;

    // ③ 点选 + 提交
    await box.evaluate((el, idxs) => {
      const lis = [...el.querySelectorAll('li.ans-videoquiz-opt')];
      idxs.forEach(i => {
        const li = lis[i]; if (!li) return;
        const inp = li.querySelector('input');
        if (inp && !inp.checked) inp.click(); else li.click();
      });
    }, picks.map(o => o.idx)).catch(() => {});
    await sleep(700);
    const ok = await box.evaluate(el => { const b = el.querySelector('#videoquiz-submit'); if (b && b.offsetWidth > 0) { b.click(); return true; } return false; }).catch(() => false);
    if (!ok) return false;
    vqTries.set(nq, tries + 1);

    // ④ 等反馈（最多 ~14s）→ 对了入库、错了记错题、点了继续
    for (let i = 0; i < 7; i++) {
      await sleep(2000);
      const fb = await box.evaluate(el => {
        const vis = s => { const n = el.querySelector(s); return !!(n && n.offsetWidth > 0 && n.offsetHeight > 0); };
        const t = s => { const n = el.querySelector(s); return n && n.offsetWidth > 0 ? (n.innerText || '').replace(/\s+/g, ' ').trim() : ''; };
        return { has: vis('#spanHas'), bad: vis('#spanNot') || vis('#spanNotBack'), txt: [t('#spanHas'), t('#spanNot'), t('#spanNotBack')].filter(Boolean).join('/') };
      }).catch(() => null);
      if (fb && (fb.has || fb.bad)) {
        if (fb.has) {
          log(`✅ 弹题回答正确（${fb.txt || '回答正确'}）`);
          const val = st.type.includes('判断')
            ? (norm(picks[0].text).includes('错') ? '错' : '对')
            : (st.multi ? picks.map(o => o.letter).filter(Boolean) : (picks[0].letter || picks[0].text));
          learnAnswer(st.q, val);
          vqWrong[nq] = undefined; delete vqWrong[nq]; saveVqWrong();
        } else {
          log(`❌ 弹题回答错误（${fb.txt || '回答错误'}）→ 已记入错题（下次自动换选项）`);
          const arr = vqWrong[nq] || [];
          picks.forEach(o => { if (!arr.includes(o.text)) arr.push(o.text); });
          vqWrong[nq] = arr; saveVqWrong();
        }
        await sleep(900);
        await box.evaluate(el => { const c = el.querySelector('#videoquiz-continue'); if (c && c.offsetWidth > 0) c.click(); }).catch(() => {});
        return true;
      }
    }
    log(`⚠ 弹题已提交，但 14s 内没读到反馈（下一轮复查）`);
    return true;
  }

  async function handleVideoQuiz(page) {
    if (vqBusy) return false;
    if (CFG.protectWork && isHomeworkUrl(page.url())) return false;   // 🔒 作业/考试页绝不碰
    for (const f of page.frames()) {
      // ⚠ 只在【视频/音频模块 iframe】里找弹题：避免把章节测验/作业页里同名结构误当成弹题去点
      //   🎧 v7.7：音频节（ananas/modules/audio）同样可能有弹题 → 一起认
      if (!/ananas\/modules\/(video|audio)/i.test(f.url())) continue;
      let boxes = [];
      try { boxes = await f.$$('.ans-videoquiz, .tkTopic'); } catch (e) { continue; }
      for (const b of boxes) {
        if (!(await b.isVisible().catch(() => false))) continue;
        vqBusy = true;
        try { return await answerVideoQuiz(b, f); }
        catch (e) { return false; }
        finally { vqBusy = false; }
      }
    }
    return false;
  }

  // ───────── 主循环 ─────────
  while (true) {
    round++;
    try {
      // 配置热重载：改 刷课配置.json 后无需重启
      // ⚠ 键坑（v5c 踩过）：主循环每轮都会 loadCfg()，若把自动算出的倍速写回配置字段就会被冲掉。
      //   所以自动倍速只存在 autoSpeed 里，绝不回写；用户真改了 speed 才清掉它重新匹配。
      const prevQuiz = CFG.autoQuiz;
      const cfgNew = loadCfg();
      if (userSpeedSeen !== null && cfgNew.speed !== userSpeedSeen) {
        log(`⚙ 用户手动改速上限 → ${cfgNew.speed}x（重新按时长匹配倍速）`);
        autoSpeed = null;
      }
      userSpeedSeen = cfgNew.speed;
      CFG = cfgNew;
      if (CFG.autoQuiz !== prevQuiz) log(`⚙ 测验自动作答：${CFG.autoQuiz ? '开' : '关'}`);
      // ⏸ 手动模式：脚本原地待命，一个按钮都不碰（改回 false 立即恢复自动）
      if (CFG.paused) {
        if (round % 15 === 1) log('⏸ 已暂停（刷课配置.json → paused=true）→ 脚本不操作页面，你自己来');
        await sleep(CFG.paused ? 10000 : CFG.poll);
        continue;
      }
      // 题库热重载：AI 解完题写入 题库.json 后自动生效，不用重启
      if (round % 8 === 0) { bank = loadBank(); bankKeys = Object.keys(bank); }

      let page = null;
      for (const p of ctx.pages()) {
        const u = p.url();
        if (/chaoxing\.com\/mycourse\/student/i.test(u)) { page = p; break; }
        if (await findNextBtn(p)) { page = p; break; }
      }
      if (!page) {
        noPageCnt++;
        // 🚪 v7.9（2026-10-16 早上实锤）：登录失效 ≠ 课程页丢失！
        //   凌晨 3:10 学习通会话过期，浏览器被踢回 passport2 登录页，旧逻辑只重开了一次
        //   lastUrl（又被弹回登录页）→ 之后干等 12 小时刷屏"等待章节页"。
        //   ⇒ 识别登录页：弹 Windows 窗提醒人扫码（扫码后脚本自动接着刷），并持续重试恢复。
        const onLoginPage = ctx.pages().some(p => /passport2\.chaoxing\.com\/login/i.test(p.url()));
        if (onLoginPage) {
          if (!loginLostAt) {
            loginLostAt = Date.now();
            lastLoginNotifyAt = Date.now();
            log('🚪 学习通登录已失效（被踢回登录页）→ 请到浏览器重新扫码登录；登录后脚本自动继续，无需重启');
            notifyUser('学习通登录已失效', '请在浏览器里重新扫码登录，脚本会自动继续刷课');
          }
          if (Date.now() - lastLoginNotifyAt > 1800000) {   // 每 30 分钟再提醒一次
            lastLoginNotifyAt = Date.now();
            log('🚪 仍未登录（已等待 ' + Math.round((Date.now() - loginLostAt) / 60000) + ' 分钟）→ 请扫码');
            notifyUser('学习通登录已失效', '已等待 ' + Math.round((Date.now() - loginLostAt) / 60000) + ' 分钟，请到浏览器扫码登录');
          }
          if (noPageCnt % 30 === 0) {                       // 约每 2 分钟重试打开上次章节（万一已登录直接续上）
            let lastUrl = '';
            try { lastUrl = (JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}).lastUrl || ''; } catch (e) {}
            const tgt = ctx.pages().find(p => /chaoxing\.com/i.test(p.url())) || ctx.pages()[0];
            if (lastUrl && tgt) await tgt.goto(lastUrl, { timeout: 30000 }).catch(() => {});
          }
          await sleep(CFG.poll);
          continue;
        }
        if (round % 12 === 1) {
          const urls = ctx.pages().map(p => p.url().slice(0, 70)).join(' | ');
          log('等待章节页... 当前标签页: ' + (urls || '(无)'));
        }
        // 自动恢复：课程页丢了（被关掉/跳到个人空间）→ 用记录的 lastUrl 重新打开，
        // 不再无限死等（2026-10-13 凌晨卡死 8 小时的根因）
        if (noPageCnt === 10) {
          let lastUrl = '';
          try { lastUrl = (JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}).lastUrl || ''; } catch (e) {}
          if (lastUrl) {
            const tgt = ctx.pages().find(p => /chaoxing\.com/i.test(p.url())) || ctx.pages()[0];
            if (tgt) {
              log('⚠ 课程页丢失超过 1 分钟 → 自动恢复：重新打开上次刷到的章节');
              await tgt.goto(lastUrl, { timeout: 30000 }).catch(() => {});
              await sleep(5000);
            }
          }
        }
        await sleep(CFG.poll);
        continue;
      }
      noPageCnt = 0;
      if (loginLostAt) { loginLostAt = 0; log('✅ 登录已恢复 → 继续自动刷课'); }

      // 🔒 作业 / 考试页保护：直接跳过本轮，任何按钮都不碰
      if (CFG.protectWork && isHomeworkUrl(page.url())) {
        if (round % 15 === 1) log('🔒 当前是【作业/考试】页 → 脚本不介入，请自己作答（已自动保护）');
        await sleep(CFG.poll);
        continue;
      }

      // 🚨 反爬验证码检测（2026-10-14）：验证码页弹出后一切点击都无效且会加重风控
      //    → 引擎立即冻结（什么都不点），等人工在浏览器里输完验证码自动恢复
      {
        const cap = await detectCaptcha(page);
        if (cap) {
          if (!captchaSeen) {
            captchaSeen = true; captchaLogAt = 0;
            log('🚨🚨 检测到学习通反爬验证码：' + cap);
            log('   👉 请到浏览器里输入图片验证码；输完引擎自动恢复（无需重启）。冻结期间引擎不点任何东西');
          }
          if (Date.now() - captchaLogAt > 60000) { captchaLogAt = Date.now(); log('⏳ 仍在等待人工输入验证码…（已冻结点击）'); }
          await sleep(15000);
          continue;
        } else if (captchaSeen) {
          captchaSeen = false;
          log('✅ 验证码已通过 → 恢复自动刷课');
        }
      }

      // 📅 v7.12 每日上限检测：学习通每日视频任务点完成数有上限，触顶后今天刷的视频【不记账】（页面明文）
      //    继续刷只会白费 + 持续触发风控（验证码）+ 误标"放弃" → 进入收工待机，30 分钟复查一次（次日 0 点重置）
      const dailyLimitNow = await page.evaluate(() =>
        /今日视频任务点完成数已达上限|今日视频观看时长已达上限/.test(document.body ? document.body.innerText : '')
      ).catch(() => false);
      if (dailyLimitNow && !dailyLimitHit) {
        dailyLimitHit = true;
        log('📅 检测到「今日视频任务点完成数已达上限」→ 今天刷的视频不再计入任务点（页面明文）');
        log('📅 → 进入收工待机：每 30 分钟复查一次，次日额度重置后自动继续刷课');
        log('📅 → 今天被误标「放弃」的节（每日上限所致）→ 删 学习通作业助手\\.abandon.json 可恢复');
        notifyUser('学习通今日额度已用完', '今天完成的任务点数已达上限，再刷也不记账（还容易触发验证码）。\n脚本进入待机，每30分钟自动复查，明天额度重置后继续自动刷。\n被误标放弃的节：删 学习通作业助手\\.abandon.json 即可恢复。');
      }
      if (dailyLimitHit) {
        if (Date.now() - lastDailyCheckAt > 30 * 60 * 1000) {
          lastDailyCheckAt = Date.now();
          log('📅 收工待机中 → 复查额度是否恢复（刷新页面）…');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await sleep(8000);
          const still = await page.evaluate(() =>
            /今日视频任务点完成数已达上限|今日视频观看时长已达上限/.test(document.body ? document.body.innerText : '')
          ).catch(() => true);
          if (!still) {
            dailyLimitHit = false;
            log('📅 额度已恢复（次日重置）→ 继续自动刷课！');
            continue;
          }
          log('📅 仍在每日上限中 → 继续待机（30 分钟后再查）');
        }
        await sleep(60000);
        continue;
      }

      // 章节切换检测
      const url = page.url();
      const secKey = (url.match(/chapterId=(\d+)/) || [, url])[1];
      const isNewSection = secKey !== curSectionKey;
      // 🗂 v7.6 课程命名空间：每轮刷新当前课程ID（题库匹配只在本课程内进行）
      const cidNow = (url.match(/courseId=(\d+)/) || [, ''])[1];
      if (cidNow && cidNow !== CUR_CID) {
        const prev = CUR_CID;
        CUR_CID = cidNow;
        if (prev !== '0') log(`🗂 检测到课程切换 → 题库命名空间切到课程 ${cidNow}（不会用别的课程的答案）`);
      }
      if (isNewSection) {
        curSectionKey = secKey;
        sectionEnterAt = Date.now();
        lastProgressAt = Date.now();
        incAtEntry = null;
        replayCnt = 0;
        chipClicked = new Set();
        stuckCnt.clear(); lastCur.clear();
        // 每次重新进节给新一轮提交机会（3 次/ visit，累计 9 次封顶防死循环）
        if ((submitTry.get(secKey) || 0) < 9) submitTry.delete(secKey);
        // 🎯 倍速自动匹配：进节先清空上一节的匹配值，等读到视频时长 + 已累计真实秒数后现场算
        autoSpeed = null;
        saveState({ lastUrl: url, at: new Date().toISOString() });
        const cat0 = await readCatalog(page);
        const me0 = cat0 && cat0.find(x => x.cid === secKey);
        if (me0) {
          incAtEntry = me0.inc;
          log(`▶ 进入章节 ${me0.label}（未完成任务点 ${me0.inc === null ? '?' : me0.inc}）`);
          if (me0.inc === 0 && !videoDone.has(secKey)) { videoDone.add(secKey); saveDone(); }
        } else {
          log(`▶ 进入章节 chapterId=${secKey}`);
        }
        // 🔄 v7.11 环形翻节检测：同一节被反复进入（典型：测验交卷后被页面弹回父节 → 又顺序绕回来）
        //    计数到阈值且本节还有未完成任务点 → 标记放弃；下轮进门直接翻走，循环即断
        const entryCnt = (sectionEntryCnt.get(secKey) || 0) + 1;
        sectionEntryCnt.set(secKey, entryCnt);
        if (entryCnt >= 4 && !abandon.has(secKey) && me0 && me0.inc > 0) {
          log(`🏳 「${me0.label}」已被反复进入 ${entryCnt} 次（测验交卷被弹回 → 翻节绕圈）→ 放弃本节自动完成，后续人工补；删 学习通作业助手\\.abandon.json 可重开`);
          abandon.add(secKey); saveAbandon();
        }
      }

      // 🚧 v7.14：全屏遮罩必须先关！否则：
      //   ① 它（1370×810, pointer-events:auto）拦截页面所有点击 → 测验点不动、视频点不开（"刷不动"）
      //   ② 它内部的「下一节」(a.nextChapter) 会被 findNextBtn 命中 → 一翻节就 PCount.next() 真跳走
      //   放在翻节判断【之前】，保证下面用的 findNextBtn 拿到的不是遮罩里的按钮
      await closeJobFinishMask(page);

      // 🏳 v7.11：已标记「放弃自动完成」的节 → 进门直接翻走（不碰它的测验/媒体，绕圈即断）
      //    isNewSection 或距上次翻节 >30s 才点，防止页面没翻过去时狂点
      if (CFG.autoNext && abandon.has(secKey) && (isNewSection || Date.now() - lastNextAt > 30000)) {
        const nb = await findNextBtn(page);
        if (nb) {
          log('⏭ 本节已标记「放弃自动完成」→ 直接翻节');
          lastNextAt = Date.now();
          await safeClick(nb);
          await sleep(CFG.cooldownMs);
          continue;
        }
      }

      // 已刷过的节（视频完成/无任务点）→ 直接翻节，不重看
      // 但目录未完成数 > 0 说明本节还有测验没交 → 不能跳，留下来处理测验
      if (CFG.autoNext && isNewSection && videoDone.has(secKey)) {
        const catV = await readCatalog(page);
        const meV = catV && catV.find(x => x.cid === secKey);
        if (!meV || meV.inc === null || meV.inc === 0) {
          const nb = await findNextBtn(page);
          if (nb) {
            log('⏭ 本节已刷过且无剩余任务点 → 直接翻节');
            lastNextAt = Date.now();
            await safeClick(nb);
            await sleep(CFG.cooldownMs);
            continue;
          }
        } else {
          log(`⏭ 本节视频已看过，还剩 ${meV.inc} 个任务点（测验）→ 处理测验`);
        }
      }

      // 主判定 = 目录行尾数字（绿字「任务点已完成」受字体反爬/伪元素影响不可靠，已弃用）：
      //   inc === 0                → 本节全完成 → 直接翻节
      //   inc <= 1 且本节有测验标签 → 视频已刷完，剩下的 1 个是测验 → 跳过视频直接做测验
      if (CFG.autoNext && isNewSection && incAtEntry !== null) {
        if (incAtEntry === 0) {
          if (!videoDone.has(secKey)) { videoDone.add(secKey); saveDone(); }
          log('⏭ 目录显示本节任务点全部完成 → 直接翻节');
          const nb = await findNextBtn(page);
          if (nb) {
            lastNextAt = Date.now();
            await safeClick(nb);
            await sleep(CFG.cooldownMs);
            continue;
          }
        } else if (incAtEntry <= 1 && (await isVideoJobDone(page)) !== false && await hasChip(page, /^\s*\d*\s*(节节测验|章节测验|测验)\s*$/)) {
          if (!videoDone.has(secKey)) { videoDone.add(secKey); saveDone(); }
          log('⏭ 目录推断：媒体任务点已完成（剩余 1 个 = 测验）→ 跳过媒体播放，直接做测验');
          // 不 continue：videoDone 已标记，下方「已看过不重播」会自动清空视频
        }
      }

      // 焦点模拟：让页面以为窗口处于激活状态（学习通会因 blur/失焦暂停视频）
      if (!focusFixed.has(page)) {
        try {
          const cdp = await ctx.newCDPSession(page);
          await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
          focusFixed.add(page);
          log('已开启焦点模拟（防失焦暂停）');
        } catch (e) {}
      }
      // 模拟一点鼠标活动，防"长时间无操作"类暂停
      if (round % 5 === 0) await page.mouse.move(300 + (round % 7) * 40, 380).catch(() => {});

      // ── 强制倍速：把目标速率下发给所有 frame（stealth 钩子在底层接管）──
      // 菜单里有这一档 → 走官方菜单（UI 真实切档，最自然）；没有这一档 → 钩子照样把它顶上去
      const spd = effSpeed();
      for (const f of page.frames()) {
        // 早于本次脚本启动就存在的 iframe 没有 addInitScript → 这里补注入（内部有幂等标记）
        await f.evaluate(stealthFn).catch(() => {});
        await f.evaluate(t => { window.__cxSpeed = t; }, (CFG.forceSpeed && spd) ? spd : 0).catch(() => {});
      }

      await killPopups(page);
      // 🎬 视频内弹题：每轮都查（旧版只在"卡住 2 轮"时才查 → 弹题弹出时视频照播 → 永远不处理）
      await handleVideoQuiz(page);
      let vids = await collectVideos(page);

      // 🎓 迟到记账兜底（v5f，2026-10-13 18:10）—— 治"完成了却没跳"
      //   现场：7.3 视频 1.25x 播完 → 播完那一刻的 30 秒确认窗里目录和图标都没动静 → 误判"没记上"
      //   → 自动降档到 1.1x 从头重看。可实际上服务器只是【上报迟到了】，几十秒后 aria-label 就变成了
      //   「任务点已完成」、目录 7.3 也变成 1（只剩测验）。结果白看 12 分钟。
      //   对策：本节已经有过一次失败的确认（watchTry > 0）时，【每一轮】都复查一次权威判据，
      //   一旦发现视频任务点其实已被确认 → 立刻记账 + 记入"已看过"（让智能跳过生效）→ 转去处理测验。
      if (CFG.autoSpeedByDuration && !CFG.skipVideo && !videoCredited.has(curSectionKey)
          && (watchTry.get(curSectionKey) || 0) > 0) {
        const lateJd = await isVideoJobDone(page);
        if (lateJd === true) {
          videoCredited.add(curSectionKey); saveCredited();
          watchTry.delete(curSectionKey); saveWatchTry();
          if (!videoDone.has(curSectionKey)) { videoDone.add(curSectionKey); saveDone(); }  // 让"本节视频已看过→不重播"生效
          const catL = await readCatalog(page);
          const meL = catL && catL.find(x => x.cid === curSectionKey);
          if (meL && meL.inc !== null) incAtEntry = meL.inc;
          // ⚠ 注意：这次确认来自【之前那一遍】的播放，与"此刻的倍速"无关，所以不改倍速、也不回写任何速率状态。
          lastProgressAt = Date.now();
          log(`🎓 迟到记账兜底：本节视频任务点其实已被服务器确认完成（aria-label=已完成，目录剩 ${incAtEntry === null ? '?' : incAtEntry} 个）→ 立即停止重看，转去处理测验/翻节`);
          vids = [];
          await sleep(CFG.poll);
          continue;
        }
      }

      // ── 🎯 v7.8（2026-10-15 深夜）：全部媒体的任务点都已完成（卡片绿勾）→ 直接记账翻节 ──
      //   现场实锤（英语听力节，5 个音频）：wav 任务点已完成（卡片绿✔）但播放器没播到结尾
      //   （1:26/2:59，永远不 ended）→ 旧 fallback 一直选它重播，真正没完成的 mp3 没人播。
      //   卡片绿勾 = 学习通自己的判定，比"ended"和"图标对位"都权威 → 全绿勾就别再碰播放器。
      if (vids.length && vids.every(v => v.done === true)) {
        if (!videoCredited.has(curSectionKey) || !videoDone.has(curSectionKey)) {
          if (!videoCredited.has(curSectionKey)) { videoCredited.add(curSectionKey); saveCredited(); }
          if (!videoDone.has(curSectionKey)) { videoDone.add(curSectionKey); saveDone(); }
          log(`🎧 本节 ${vids.length} 个媒体的任务点【全部已完成】（卡片绿勾）→ 不再播放，转测验/翻节`);
        }
        vids = [];
      }

      // ── 🎬 v7.3 多视频节：先定出"这一轮只驱动哪一个视频"，并处理累计切换 ──────────
      //   为什么必须放在"倍速匹配"之前：acc（真实观看秒数）是【按视频】核算的。
      //   若先算倍速再切视频，就会拿上一个视频攒的 acc 去算这个视频该几倍速 → 选到过高档
      //   → 这一遍播完攒不满 90% → 白播一遍。所以先切、先定 acc，再算倍速。
      //   🎯 v7.8 优先级反转：【卡片绿勾】绑定媒体本体（不怕图标与媒体顺序错位）→ 第一判据；
      //      图标列表对位（vjobs）退为第二判据（绿勾读不到时才用）。
      let active = null;
      if (vids.length > 1 && !CFG.skipVideo) {
        // 🎯 v7.8b：dur=0 的"幽灵元素"（readyState=0，懒加载没触发）点不动，绝不能占着 active 位
        //    （实锤 2026-10-15 23:25：第 1 个音频 --/-- 反复点播放 8 轮纹丝不动，有进度的第 2 个反被暂停）
        const pend = vids.filter(v => v.done !== true && !v.ended);
        const ready = pend.filter(v => v.dur > 0);          // 已加载真实时长的优先
        const pool = ready.length ? ready : pend;
        if (pool.length) {
          active = pool[0];
          const doneCnt = vids.length - pend.length;
          if (doneCnt > 0 && round % 4 === 0) {
            log(`🎯 卡片绿勾：本节 ${doneCnt}/${vids.length} 个媒体任务点已完成 → 跳过它们，只播未完成的（当前第 ${vids.indexOf(active) + 1} 个）`);
          }
        } else {
          // 绿勾没读全（都 null）→ 退回图标对位
          const vjobs = await readVideoJobList(page);
          if (vjobs && vjobs.length === vids.length) {
            const idx = vjobs.findIndex(x => x !== true);
            if (idx > 0) {
              active = vids[idx];
              if (round % 4 === 0) log(`🎬 本节前 ${idx} 个视频任务点已完成 → 直接处理第 ${idx + 1}/${vids.length} 个`);
            } else if (idx === 0) active = vids[0];
          }
        }
      }
      if (vids.length && !active) {
        // fallback 同样：已完成（绿勾）绝不选；dur>0（已加载）的优先于幽灵元素
        const base = vids.filter(v => v.done !== true && !v.ended);
        const alive = base.filter(v => v.dur > 0);
        const pool = alive.length ? alive : (base.length ? base : vids.filter(v => !v.ended));
        active = pool.find(v => (stuckCnt.get(v.key) || 0) < 4) || pool[0]
              || vids.find(v => !v.ended) || vids[vids.length - 1];
      }
      if (vids.length && active) {
        const w0 = watchReal[curSectionKey];
        const curNow = active.cur > 0 ? active.cur : 0;
        // 同一个视频 → 沿用累计；换视频（或旧数据无 vkey / 多视频节的历史脏数据）→ 重算
        const sameVid = w0 && (w0.vkey
          ? w0.vkey === active.key
          : (!(vids.length > 1) && w0.dur > 0 && active.dur > 0 && Math.abs(w0.dur - active.dur) <= 5));
        if (sameVid) { w0.vkey = active.key; saveWatchReal(); }
        else {
          // 🔒 安全钳制：真实观看秒数【不可能超过】"进度在 1x 下的等价秒数"（倍速 ≥1 → acc ≤ cur）。
          //    旧版 key 撞车把两个视频的进度混算在一起，直接用会偏乐观（→ 选到过高倍速 → 白播一遍）。
          const keepAcc = Math.min((w0 && w0.acc > 0) ? w0.acc : 0, curNow);
          watchReal[curSectionKey] = {
            acc: Math.round(keepAcc * 10) / 10,
            dur: active.dur > 0 ? Math.round(active.dur) : 0,
            maxPos: (active.dur > 0 && curNow > 0) ? Math.round(Math.min(curNow / active.dur, 1) * 1000) / 1000 : 0,
            vkey: active.key, at: new Date().toISOString(),
          };
          saveWatchReal(); lastCur.clear(); autoSpeed = null;
          if (vids.length > 1) log(`🎬 本节共 ${vids.length} 个媒体任务点（视频/音频）→ 这一轮只播第 ${vids.indexOf(active) + 1} 个（${fmt(active.dur)}，${MEDIA_CN(active.tag)}），`
            + `真实观看时长按视频独立累计` + (keepAcc > 0 ? `（沿用已看 ${fmt(keepAcc)}）` : '（从 0 起算）'));
        }
      }

      // ── 🎯 v6 核心：累计"真实播放秒数" + 按视频时长实时匹配倍速 ──────────────
      //    每轮用 (进度增量 ÷ 当前倍速) 折算出这一轮真正贡献了多少"真实观看秒数"（学习通只认这个），
      //    再据此算出"这一遍播完刚好达标"的倍速。不再试错、不再整段重看。
      if (vids.length && !CFG.skipVideo && CFG.autoSpeedByDuration) {
        const v0 = active || vids.find(v => !v.ended) || vids[0];
        const dur0 = v0.dur > 0 ? v0.dur : 0;
        const cur0 = v0.cur > 0 ? v0.cur : 0;
        const rate0 = v0.rate > 0 ? v0.rate : 1;
        const prev0 = lastCur.get(v0.key);
        if (dur0 > 0) {
          const d = (typeof prev0 === 'number') ? (cur0 - prev0) : 0;
          if (d > 0.4 && d < 150) addRealSec(curSectionKey, d / rate0, dur0, cur0);   // 进度回退（刷新）时为负 → 不记账
          const acc = accOf(curSectionKey);
          const tgt = bankTarget(dur0);
          const old = autoSpeed;
          const sp = matchSpeedByDuration(dur0, cur0, acc, CFG.speed);
          if (SPEED_STEPS.includes(sp) && Math.abs((old === null ? CFG.speed : old) - sp) > 0.001) {
            autoSpeed = sp;
            for (const f of page.frames()) {
              await f.evaluate(s => { window.__cxSpeed = s; }, sp).catch(() => {});
            }
            log(`🎯 按时长匹配倍速：${MEDIA_CN(v0.tag)} ${fmt(dur0)}，已累计真实观看 ${fmt(acc)}/${fmt(tgt)} → ${sp}x` +
                (acc < tgt ? `（这一遍播完刚好达标）` : `（已够，用最快速度播完）`));
          }
          if (acc >= tgt && !watchReal[curSectionKey]._logged) {
            watchReal[curSectionKey]._logged = true; saveWatchReal();
            log(`📊 真实观看时长已攒够（${fmt(acc)} ≥ ${fmt(tgt)}）→ 等服务器登记任务点`);
          }
        }
      }

      // 「本节视频要不要重看」判定（2026-10-13）：只能用目录行尾的未完成数反推，
      // 不看 videoDone 记忆——高倍速时服务器常常没记上进度，而脚本这边却以为看过了。
      //   inc === null       → 读不到目录，不重播（保守）
      //   测验已提交成功      → 剩下的必然是视频 → 只要 inc > 0 就重看
      //   有「测验」标签       → 视频+测验两件套：inc >= 2 说明两个都没完成 → 重看
      //   没有测验标签        → 这节只有视频：inc >= 1 就是视频没看完 → 重看
      let mustWatch = false;
      if (!CFG.forceRewatch && !videoCredited.has(secKey) && incAtEntry !== null && incAtEntry > 0) {
        if (quizSubmitted.has(secKey)) mustWatch = true;
        else {
          const hasQ = await hasChip(page, /^\s*\d*\s*(节节测验|章节测验|测验)\s*$/);
          mustWatch = hasQ ? (incAtEntry >= 2) : (incAtEntry >= 1);
        }
        if (mustWatch && videoDone.has(secKey)) {
          videoDone.delete(secKey); saveDone();
          chipClicked.delete(secKey + '|视频');   // 内容区可能停在测验页 → 允许重新点「视频」标签切回去
          log(`🔁 服务器显示本节还有 ${incAtEntry} 个任务点没完成 → 视频重新观看（倍速 ${effSpeed()}x）`);
        }
      }
      // 🎯 权威判据一票裁决（v7.1，2026-10-13 21:46）：
      //    ans-job-icon 的 aria-label 直接说明视频任务点状态，优先级高于一切"目录数字推算"和本节记忆。
      //    修 11.1 翻车：测验用户自己交了（inc 2→1）+ 有测验标签 → 旧逻辑以为"剩下的 1 个是测验"
      //    → 跳过视频直接翻节。实际剩下的就是视频！
      //    同时清掉被误记的 videoDone / videoCredited（当初交卷让 inc 下降，被误当成"视频完成"记的账）。
      if (!CFG.forceRewatch && !CFG.skipVideo) {
        // 🎯 v7.8f（2026-10-16 0:05 实锤）：目录权威计数要【实时】刷新再裁决！
        //   实锤：混合节「2 音频 + 1 文档」，音频播完 + 文档卡片滚动记入（inc 2→0）后，
        //   下一轮一票裁决读到的图标 aria 还是"未完成"（页面图标同步滞后）→ 强制重播已完成的音频。
        //   ⇒ 服务器目录 inc=0 = 本节全部任务点完成，权威级最高 → 直接按完成处理，不进媒体流程。
        const catLive = await readCatalog(page);
        const meLive = catLive && catLive.find(x => x.cid === secKey);
        if (meLive && meLive.inc === 0) {
          incAtEntry = 0;
          mustWatch = false;
          if (!videoDone.has(secKey)) { videoDone.add(secKey); saveDone(); }
          if (!videoCredited.has(secKey)) { videoCredited.add(secKey); saveCredited(); }
          if (round % 4 === 1) log('✅ 目录实时显示本节任务点已全部完成（服务器权威）→ 不重播，直接处理测验/翻节');
        } else {
        const vjd = await isVideoJobDone(page);
        if (vjd === false) {
          if (!vjdLogged.has('n' + secKey)) {
            vjdLogged.add('n' + secKey);
            log('🎯 任务点图标明确显示「媒体任务点（视频/音频）未完成」→ 一票裁决：必须播放（无视目录推算与本节记忆）');
            if (videoDone.has(secKey)) log('   已清除错误的「视频已看过」记忆');
            if (videoCredited.has(secKey)) log('   已清除错误的「视频已记账」标记');
          }
          mustWatch = true;
          if (videoDone.has(secKey)) { videoDone.delete(secKey); saveDone(); chipClicked.delete(secKey + '|视频'); }
          if (videoCredited.has(secKey)) { videoCredited.delete(secKey); saveCredited(); }
        } else if (vjd === true) {
          if (!videoDone.has(secKey)) { videoDone.add(secKey); saveDone(); }
          if (!videoCredited.has(secKey)) { videoCredited.add(secKey); saveCredited(); }
        }
        }
      }
      if (CFG.forceRewatch && videoDone.has(secKey)) { videoDone.delete(secKey); saveDone(); }
      if (CFG.forceRewatch && videoCredited.has(secKey)) { videoCredited.delete(secKey); saveCredited(); }   // 手动重刷 → 记账也要清，否则不会重看

      // 智能跳过：视频已看过的节 → 永不重播，直接走测验/翻节（没看过的正常播放）
      if (vids.length && videoDone.has(curSectionKey)) {
        if (!skipLogged.has('v' + curSectionKey)) {
          skipLogged.add('v' + curSectionKey);
          log(`⏭ 本节媒体已看过 → 不重播（${vids.length} 个视频/音频），直接处理测验后翻节`);
        }
        vids = [];
      }

      // ── 没有视频：先试着点开「视频」标签 ──
      if (vids.length === 0) {
        // 🎧 v7.7：音频节的标签可能叫「音频/听力」而不是「视频」→ 按 CFG.videoAlias 一起试
        const aliasRe = new RegExp('^\\s*\\d*\\s*(' + (CFG.videoAlias || '视频') + ')\\s*$');
        if (await clickChip(page, aliasRe, '视频')) {
          await sleep(3000);
          vids = await collectVideos(page);
        }
      }
      // 🎯 v7.8d：媒体节里没有可播的媒体、但目录还有未完成 → 剩余的媒体多半还没被【懒加载渲染】
      //   （探针实锤 2026-10-15 23:31：页面只见 2 个真音频，目录未完成 3 —— 其余的要滚到才渲染）
      //   → 滚动各 frame 触发加载，再收一次。每节最多滚 8 次，防死循环。
      // 🚧 v7.14（2026-10-17 实锤）：刚进节时 knowledge/cards 还没渲染完 → 三种"未就绪"形态都会让 vids 空：
      //   ① .ans-job-icon 一个都读不到（hasMediaJob=false, iconsReady=false）
      //   ② 图标只渲染成裸元素 —— ans-job-video class 还没挂上 → hasMediaJob 误报 false，但 iconsReady=true
      //      （CAD 3.1 就是这样被跳过：旧判据 mediaHint||!iconsReady 两个都 false → 不滚动 → 判"无媒体"）
      //   ③ 视频/音频模块 iframe（ananas/modules/video）还没被懒加载创建
      //   ⇒ 只要本节 inc>0 且三种"未就绪"任一成立，就滚动 + 等待重试（每节最多 8 次）
      const mediaHint = await hasMediaJob(page);
      const iconsReady = (await readJobIcons(page)) !== null;
      const mediaFrameReady = page.frames().some(f => /ananas\/modules\/(video|audio)/i.test(f.url()));
      if (vids.length === 0 && incAtEntry !== 0 && (mediaHint || !iconsReady || !mediaFrameReady)) {
        const scTried = (mediaScrollTried.get(curSectionKey) || 0);
        if (scTried < 8) {
          mediaScrollTried.set(curSectionKey, scTried + 1);
          // ① 🚧 v7.14：先【轻量等待后重收】—— 实测（CAD 3.1）点进节 2 秒媒体就渲染好了，
          //    根本不用滚。而滚到底部反而可能让学习通的虚拟列表把顶部卡片卸载 → 视频元素消失（越滚越糟）。
          if (scTried < 4) {
            await sleep(3000);
            vids = await collectVideos(page);
            if (vids.length) log(`🎧 等第 ${scTried + 1} 轮渲染后收到 ${vids.length} 个媒体（${MEDIA_CN(vids[0].tag)}）→ 继续播放`);
          }
          // ② 还拿不到 → 才滚动触发懒加载（保留原兜底）
          if (vids.length === 0) {
            let moved = 0;
            for (const f of page.frames()) {
              const m = await f.evaluate(() => {
                try {
                  const s = document.scrollingElement;
                  const before = s ? s.scrollTop : 0;
                  if (s) s.scrollTop = s.scrollHeight;        // 直接到底部（懒加载按"到底"渲染）
                  window.scrollTo(0, document.body.scrollHeight);
                  return (s ? s.scrollTop : 0) - before;
                } catch (e) { return 0; }
              }).catch(() => 0);
              moved += m || 0;
            }
            if (moved > 0 || scTried < 2) {
              log(`🎧 本节还有未完成媒体但页面没有可播元素 → 滚动触发懒加载（第 ${scTried + 1} 次）`);
              await sleep(4000);
              vids = await collectVideos(page);
              if (vids.length) log(`🎧 滚动后加载出 ${vids.length} 个媒体 → 继续播放`);
            }
          }
        }
      }
      // 🎧 v7.7：本轮确定没媒体可播时，用权威判据说清楚"本节要刷的是音频还是视频"，
      //   避免音频节被静默当成文档节跳过（用户看到日志就知道脚本认对了）
      if (vids.length === 0 && !hasLoggedMediaKind.has(curSectionKey)) {
        const kind = await mediaKindCn(page);
        hasLoggedMediaKind.add(curSectionKey);
        if (kind !== '视频') log(`🎧 本节媒体任务点类型：${kind}（已按媒体流程处理）`);
      }

      // ── 有视频：自动播放（v7.3：多视频节【一个一个来】，绝不来回抢焦点）──────────────
      //   实测（2026-10-14 12:4x，9.1 马克思主义，41:48 + 44:48 两个视频）：
      //     · 多个视频 = 多个独立 iframe，学习通播放器 + 浏览器【强制同一时刻只播一个】——
      //       谁拿到焦点谁播，另一个立刻变 paused（我每 1.5s 对两个都调 play()，仍始终只有一个在播）。
      //     · 旧逻辑每轮对【所有】视频都点一次「播放」→ 焦点被抢来抢去 → 两个视频都只有 ~50% 时间在播，
      //       日志刷屏「视频 X 暂停中 → 点击+续播」、进度慢得像爬 → 这就是"来回跳"的真相。
      //   → 正解：一次只驱动一个，播完/记账后再换下一个；其它视频一律不碰。
      if (vids.length > 0) {
        const ai = vids.indexOf(active);
        if (vids.length > 1 && round % 4 === 0) {
          // 🎯 v7.8 三态：✓=播放器播完  ✔=任务点已完成（卡片绿勾）▶=本轮在播  ·=待播
          log('🎬 多媒体节（同时只播一个）：' + vids.map((x, i) =>
            `${i + 1}${x.ended ? '✓' : (x.done === true ? '✔' : (x === active ? '▶' : '·'))} ${fmt(x.cur)}/${fmt(x.dur)}`).join('   '));
        }

        if (active.paused && !active.ended) await page.bringToFront().catch(() => {});
        // ③ 非 active 的视频：凡是在播的显式暂停（保证"同时只有一个在播"；它们本来也会被学习通暂停）
        for (const o of vids) {
          if (o === active || o.ended || o.paused) continue;
          await o.el.evaluate(el => { try { el.pause(); } catch (e) {} }).catch(() => {});
        }

        const v = active;
        if (v.paused && !v.ended) {
          // 🎯 v7.8b+c：滚动到卡片位置触发懒加载。
          //   ⚠ audio 在独立 iframe 里：只滚 iframe 内部没用（父页面不动，学习通的
          //     IntersectionObserver 监听的是父页面里 iframe 的位置）→ 必须顺着 frame 链
          //     把每层父文档里的 <iframe> 元素也滚进视口（实测 2026-10-15 23:30：不滚父层，
          //     第 3/4/5 个音频永远 --/-- readyState=0）。
          await v.el.evaluate(el => { try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {} }).catch(() => {});
          let pf = v.frame;
          for (let k = 0; k < 3 && pf; k++) {
            try {
              const fe = await pf.frameElement();
              if (!fe) break;
              await fe.evaluate(el => { try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {} }).catch(() => {});
              pf = pf.parentFrame();
            } catch (e) { break; }
          }
          await sleep(600);
          // 1) 点「播放」按钮（真实点击算用户手势）
          for (const sel of ['.vjs-big-play-button', '.vjs-play-control', '.prism-big-play-btn', '.prism-play-btn', '.play-btn']) {
            const b = v.frame.locator(sel).first();
            if (await b.isVisible().catch(() => false)) { if (await safeClick(b)) break; }
          }
          const pb = v.frame.getByText('播放', { exact: true }).first();
          if (await pb.isVisible().catch(() => false)) await safeClick(pb);
          // 2) 兜底：置静音 + play()（不动 playbackRate，速度交给播放器菜单）
          await v.el.evaluate((el, m) => {
            try { el.muted = m; } catch (e) {}
            try { el.play(); } catch (e) {}
          }, CFG.muted).catch(() => {});
          log(`${MEDIA_CN(v.tag)} ${fmt(v.cur)}/${fmt(v.dur)} 暂停中 → 点击+续播` + (vids.length > 1 ? `（本节第 ${ai + 1}/${vids.length} 个）` : ''));
        }
        // 播放中但速度不对 → ① 官方菜单优先 ② 菜单没有这一档则由底层钩子强制生效
        if (Math.abs(v.rate - effSpeed()) <= 0.01) {
          if (!rateLogged.has(v.key)) {
            rateLogged.add(v.key);
            const viaMenu = rateMenuDone.has(v.key) && !menuMissed.has(v.key);
            log(`🎚 倍速 ${effSpeed()}x 已生效${viaMenu ? '（播放器菜单）' : '（菜单无此档 → 底层强制接管）'}`);
          }
        } else if (!v.paused && !v.ended) {
          await setRateViaUI(v);
          if (round % 15 === 1) log(`⚠ 倍速未生效（当前 ${v.rate}x / 目标 ${effSpeed()}x）→ 继续尝试`);
        }
        // ④ 进度 / 卡住统计也只跟 active（否则被暂停的那个会误报"反复暂停无进展"）
        if (v.ended) lastProgressAt = Date.now();
        else if (v.dur === 0) {
          // 🎯 v7.8b：幽灵元素（还没加载）不算"卡住"——它是懒加载没触发，正滚动等它加载。
          //    旧逻辑会把它当"反复暂停"→ 误报插入题警告 + 反复截图。
          if (round % 8 === 0) log(`⏳ 第 ${ai + 1} 个${MEDIA_CN(v.tag)}尚未加载（懒加载）→ 已滚动到卡片位置等待加载…`);
          lastCur.set(v.key, 0);
        }
        else {
          const lc = lastCur.get(v.key);
          if (lc !== undefined && v.cur > lc + 0.3) lastProgressAt = Date.now();
          if (v.paused && lc !== undefined && Math.abs(lc - v.cur) < 0.2) {
            const c = (stuckCnt.get(v.key) || 0) + 1;
            stuckCnt.set(v.key, c);
            if (c === 3) await dumpDiag(page, v);
            if (c === 4) log(`⚠️ ${MEDIA_CN(v.tag)} ${fmt(v.cur)} 反复暂停无进展 → 可能弹了插入题，请人工答（脚本会继续尝试）`);
          } else stuckCnt.set(v.key, 0);
          lastCur.set(v.key, v.cur);
        }
        // 卡住 → 也复查一次弹题（每轮已查过，这里只是兜底再确认一次）
        if ((stuckCnt.get(v.key) || 0) >= 2) await handleVideoQuiz(page);
        if (round % 6 === 0) {
          const done = vids.filter(x => x.ended).length;
          const jobDone = vids.filter(x => x.done === true).length;   // 🎯 v7.8：任务点完成数（卡片绿勾）
          log(`${MEDIA_CN(v.tag)}进度 ${done}/${vids.length}（任务点已完成 ${jobDone}/${vids.length}），当前${vids.length > 1 ? `(第 ${ai + 1} 个)` : ''} ${fmt(v.cur)}/${fmt(v.dur)}`);
        }
        const allEnded = vids.every(v2 => v2.ended || (v2.dur > 0 && v2.cur >= v2.dur - 1));
        // 🎯 v6：除了"视频播完"，"真实观看时长已攒够"也触发核验 —— 但要求【进度曾到过或现在已过 90%】，
        //    这样即使服务器其实是按"进度 ≥ 90%"判定，也一样满足（双保险，代价几乎为零）。
        const durVid = (active && active.dur > 0) ? active : (vids.find(v2 => v2.dur > 0) || {});
        const durNow = durVid.dur || 0;
        const curNow = durVid.cur || 0;
        const accNow = accOf(curSectionKey);
        const posOk = durNow > 0 && (curNow >= 0.9 * durNow || maxPosOf(curSectionKey) >= 0.9);
        const bankedEnough = CFG.autoSpeedByDuration && durNow > 0
          && accNow >= bankTarget(durNow) && posOk;
        if ((allEnded || bankedEnough) && CFG.autoNext && Date.now() - lastNextAt > CFG.cooldownMs) {
          // ── 任务点核验（v6 重写：不再"降档试错"，只做"确认 / 等迟到上报 / 补足时长"三件事）──
          //   倍速由 matchSpeedByDuration() 按时长预先算好，不需要靠失败来反推。
          let videoConfirmed = true;
          // 📌 视频早已被服务器记账的节 → 跳过核验（否则会把"剩下的未知任务点"误判成视频没完成 → 7.1 卡 2 小时）
          if (CFG.autoSpeedByDuration && !CFG.skipVideo && !videoCredited.has(curSectionKey)) {
            log(`⏳ ${allEnded ? '视频播完' : '真实时长已攒够'}（当前倍速 ${effSpeed()}x，已累计真实观看 ${fmt(accNow)}/${fmt(durNow ? bankTarget(durNow) : 0)}）→ 等服务器确认任务点…`);
            let incNow = null;
            let jobDone = null;
            // ⏱ 窗口拉长到 ~35 秒（v5f）：实测服务器上报迟到很常见（7.3 就是播完后 1 分多钟才登记），
            //    等在这里视频是【停在结尾】的，不算浪费；比误判后从头重看 12 分钟划算得多。
            for (let vi = 0; vi < 7; vi++) {
              await sleep(5000);
              // 🎯 首选判据：ans-job-icon 的 aria-label（明文、实时）
              jobDone = await isVideoJobDone(page);
              if (jobDone === true) break;
              const catA = await readCatalog(page);
              const meA = catA && catA.find(x => x.cid === curSectionKey);
              if (meA && meA.inc !== null) {
                incNow = meA.inc;
                if (meA.inc < incAtEntry) break;   // 已确认下降 → 不用再等
              }
            }
            // ⚠ 关键坑（2026-10-13 16:00 实锤）：右侧目录 DOM 是【陈旧】的——手机端明明显示
            //   已完成，桌面端目录行尾数字却不更新（视频完成不触发目录刷新）。
            //   → 两个判据都没过，才刷新页面核实（代价：视频被重置回 0）
            if (!(jobDone === true) && !(incNow !== null && incNow < incAtEntry)) {
              log('🔄 目录/任务点图标都没动静 → 刷新页面核实');
              await page.reload({ timeout: 30000 }).catch(() => {});
              await sleep(9000);
              jobDone = await isVideoJobDone(page);
              const catR = await readCatalog(page);
              const meR = catR && catR.find(x => x.cid === curSectionKey);
              if (meR && meR.inc !== null) incNow = meR.inc;
              // 刷新后仍没动静 → 再宽限 ~16 秒（v5f）：宁可多等，也别误降档 + 从头重看
              if (jobDone !== true && !(incNow !== null && incNow < incAtEntry)) {
                for (let gi = 0; gi < 2; gi++) {
                  await sleep(8000);
                  jobDone = await isVideoJobDone(page);
                  if (jobDone === true) break;
                  const catG = await readCatalog(page);
                  const meG = catG && catG.find(x => x.cid === curSectionKey);
                  if (meG && meG.inc !== null && meG.inc < incAtEntry) { incNow = meG.inc; break; }
                }
              }
              if (jobDone === true || (incNow !== null && incNow < incAtEntry)) log('✅ 宽限等待期内服务器完成登记（迟到上报）');
            }
            if (jobDone === true) {
              log(`✅ 视频任务点已完成（ans-job-icon 明文确认）`);
              watchTry.delete(curSectionKey); saveWatchTry();
              if (!videoCredited.has(curSectionKey)) { videoCredited.add(curSectionKey); saveCredited(); }
              if (incNow !== null) incAtEntry = incNow;
            } else if (incNow !== null && incNow < incAtEntry) {
              log(`✅ 服务器已确认任务点（未完成 ${incAtEntry} → ${incNow}）`);
              watchTry.delete(curSectionKey); saveWatchTry();
              // 📌 视频已被服务器记账 → 永久记住，免得后面把"剩下的未知任务点"当成视频反复重看
              if (!videoCredited.has(curSectionKey)) { videoCredited.add(curSectionKey); saveCredited(); }
              incAtEntry = incNow;
            } else if (incNow === 0) {
              // 刷新后目录显示全完成（但 incAtEntry 可能读的就是旧值）→ 按确认处理
              log('✅ 刷新后目录显示本节已全部完成');
              watchTry.delete(curSectionKey); saveWatchTry();
              incAtEntry = 0;
            } else {
              // ── 没确认成功：不再"降档重看"，改成【按时长判断到底是"时长不够"还是"上报迟到"】──
              const tries = (watchTry.get(curSectionKey) || 0) + 1;
              watchTry.set(curSectionKey, tries); saveWatchTry();
              const need = durNow > 0 ? (bankTarget(durNow) - accNow) : 0;
              if (tries >= 5) {
                // 5 次还拿不下 → 剩下的多半不是这个视频（阅读/文档类任务点）→ 试未知任务点，再跳过本节
                log(`⛔ 本节已核验 ${tries} 次服务器仍不认 → 排查未知类型任务点`);
                videoConfirmed = true;   // 按确认处理 → 走正常翻节
                watchTry.delete(curSectionKey); saveWatchTry();
                if (videoDone.has(curSectionKey)) { videoDone.delete(curSectionKey); saveDone(); }
                rateMenuDone.clear(); menuMissed.clear(); rateLogged.clear();
                lastCur.clear(); lastProgressAt = Date.now();
                const got = await tryUnknownJobs(page, curSectionKey);
                if (!got) log('⛔ 未知任务点也未能拿下 → 先跳过本节，稍后目录复核');
              } else if (tries >= 3) {
                // 连续 3 次"自认为攒够"却没登记 → 我们的估算可能比服务器乐观 → 用 1x 慢速补一整遍（1x 能攒满 100%，最保险）
                videoConfirmed = false;
                autoSpeed = 1;
                log(`🐌 连续 ${tries} 次核验未通过 → 改用 1.0x 完整补一遍（1x 攒满 100% 真实时长，最保险）`);
                if (videoDone.has(curSectionKey)) { videoDone.delete(curSectionKey); saveDone(); }
                skipLogged.delete('v' + curSectionKey);
                rateMenuDone.clear(); menuMissed.clear(); rateLogged.clear();
                lastCur.clear(); lastProgressAt = Date.now();
                vids = [];
                await restartVideoSafely(page, '1x 保险补看前');
                await sleep(1200);
              } else if (need > 1) {
                // 我们自己也认为"真实观看时长还没攒够" → 继续补时长（不是降速，是把时长看够）
                videoConfirmed = false;
                autoSpeed = null;   // 让下一轮按时长重新匹配（此时 acc 已更大 → 会自动给出更快的档）
                log(`🕒 真实观看时长还不够（已 ${fmt(accNow)} / 需要 ${fmt(bankTarget(durNow))}，还差 ${fmt(need)}）→ 继续播放补足`);
                if (videoDone.has(curSectionKey)) { videoDone.delete(curSectionKey); saveDone(); }
                skipLogged.delete('v' + curSectionKey);
                rateMenuDone.clear(); menuMissed.clear(); rateLogged.clear();
                lastCur.clear();
                lastProgressAt = Date.now();
                vids = [];
                await restartVideoSafely(page, '补足观看时长前');
                await sleep(1200);
              } else {
                // 真实时长已达标，服务器却没登记 → 判定为上报迟到（实测常见）→ 不重看，继续等（迟到兜底会接手）
                videoConfirmed = false;
                log(`⏳ 真实观看时长已达标（${fmt(accNow)} ≥ ${fmt(bankTarget(durNow))}）但服务器还没登记 → 判定上报延迟，继续等待（不重看、不降速）`);
                if (videoDone.has(curSectionKey)) { videoDone.delete(curSectionKey); saveDone(); }
                lastCur.clear();
                lastProgressAt = Date.now();
                vids = [];
                await restartVideoSafely(page, '等待迟到登记前');
                await sleep(1200);
              }
            }
          }
          if (videoConfirmed) {
            await sleep(2500);   // 等服务端上报完成
            // 🎬 v7.4（2026-10-14）：多视频节里服务器"确认"的只是其中一个任务点！
            //   实锤：13.1 三个视频，第 2 个确认（inc 3→2）就点了「下一节」→ 学习通弹
            //   「当前章节还有任务点未完成，是否去完成？」拦截 → 弹窗挂在屏幕上。
            //   ⇒ 必须全部视频任务点都完成（或全部视频都播完）才准翻节。
            let allDone = true;
            const vjobsNow = await readVideoJobList(page);
            if (vjobsNow && vjobsNow.length) {
              allDone = vjobsNow.every(x => x === true);
            } else if (vids.length > 1) {
              // 图标读不到 → 退化判据：只要还有视频没播完就不翻节
              allDone = vids.every(v => v.ended || (v.dur > 0 && v.cur >= v.dur - 1));
            }
            if (!allDone) {
              // 🎯 v7.8e（2026-10-15 深夜实锤）：本节可能是「2 音频 + 1 文档」混合任务点！
              //   音频全播完后，剩下的未完成任务点图标是【文档/PPT 卡片】（截图：橙点「任务点」+ 幻灯片）。
              //   而文档类图标永远不可能靠"播媒体"变绿 → 旧逻辑在这里死循环
              //   （"不翻节，继续播下一个"刷屏，实际无事可做，永远跳不到下一节）。
              //   ⇒ 判据：所有媒体都已播完（绿勾/ended/播到底）→ 剩余未完成必是非媒体
              //     → 转未知任务点处理（点页签/滚动停留让文档记阅）；
              //     处理不动 → 放行翻节（目录复核 + redoPass 兜底），绝不死循环。
              const mediaOver = vids.length === 0 || vids.every(v =>
                v.done === true || v.ended || (v.dur > 0 && v.cur >= v.dur - 1));
              if (mediaOver) {
                const got = await tryUnknownThenDwell(page, curSectionKey);
                if (got) {
                  videoConfirmed = false;
                  continue;   // 重新读目录：inc 可能已下降 → 正常走测验/翻节
                }
                log('⛔ 媒体已全部播完，剩余任务点为非媒体且未能自动完成 → 放行翻节（稍后目录复核/补刷兜底）');
                allDone = true;   // 走下方正常翻节流程
                // 🏳 v7.10b：媒体做完但仍有未完成任务点（通常是需及格分的测验）→ 标记放弃，避免 redoPass 死循环拉回
                if (!abandon.has(curSectionKey)) {
                  abandon.add(curSectionKey); saveAbandon();
                  log('🏳 本节媒体已刷完但仍有任务点无法自动完成 → 已标记放弃自动完成（后续人工补）');
                }
              } else {
                videoConfirmed = false;
                if (round % 4 === 1) log('🎬 服务器刚确认的只是其中一个视频任务点 → 本节还有视频没完成，不翻节，继续播下一个');
                continue;
              }
            }
            // 看过就算完成（用户明确要求：绝不重播/重复观看）
            const confirmed = await hasTaskDone(page);
            if (!videoDone.has(curSectionKey)) { videoDone.add(curSectionKey); saveDone(); }
            log(confirmed ? '✅ 本节视频播完（页面已显示任务点完成）→ 下一节' : '✅ 本节视频播完 → 下一节');
            // 🔄 v7.9（2026-10-16 早上）：翻节前先回头看看有没有【更早的未完成节】！
            //   实锤：1.2/1.3 没完成，引擎却一路 1.4→2.1→3.1 往前走了一整夜——
            //   旧补刷只在"课程末尾找不到下一节"才触发，中途永远不回头。
            //   ⇒ 现在每次翻节前先查：前面还有没清完的 → 跳回去补，保证"从前往后清干净"。
            if (await redoPass(page, curSectionKey)) { videoConfirmed = false; await sleep(CFG.cooldownMs); continue; }
            const btn = await findNextBtn(page);
            if (btn) {
              lastNextAt = Date.now();
              await safeClick(btn);
              await sleep(CFG.cooldownMs);
            } else {
              if (round % 12 === 1) log('视频播完但找不到「下一节」（可能已是最后一节）');
              // 诊断：全 frame 搜「下一节/下一章/next」元素，直接打进日志
              if (!nextDiagDone) {
                nextDiagDone = true;
                await page.screenshot({ path: path.join(DUMP_DIR, '下一节_诊断.png') }).catch(() => {});
                for (const f of page.frames()) {
                  const hits = await f.evaluate(() => {
                    const out = [];
                    document.querySelectorAll('*').forEach(el => {
                      const s = (el.innerText || '').trim();
                      if ((s.includes('下一节') || s.includes('下一章')) && s.length < 40) {
                        out.push({ tag: el.tagName, cls: String(el.className).slice(0, 40), text: s, vis: el.offsetWidth > 0 && el.offsetHeight > 0 });
                      }
                    });
                    return out.slice(0, 8);
                  }).catch(() => null);
                  if (hits && hits.length) log('🔎 ' + f.url().slice(0, 70) + ' → ' + JSON.stringify(hits));
                }
              }
              await sleep(CFG.poll);
              // 课程末尾（无「下一节」）→ 回头补刷
              if (round % 6 === 0) await redoPass(page);
            }
          }
          continue;
        }
        // 看门狗（按进度）：视频连续 stallMs 毫秒毫无进度才强翻（不再按进节时间算，避免腰斩长视频）
        if (CFG.autoNext && Date.now() - lastProgressAt > CFG.stallMs && Date.now() - lastNextAt > CFG.cooldownMs) {
          const btn = await findNextBtn(page);
          if (btn) {
            log(`🐕 看门狗：${Math.round((Date.now() - lastProgressAt) / 1000)}s 无进度 → 尝试下一节`);
            lastNextAt = Date.now();
            await safeClick(btn);
            await sleep(CFG.cooldownMs);
            continue;
          } else if (round % 12 === 1) log('🐕 看门狗：停留过久但找不到「下一节」（可能已到课程末尾）');
        }
        await sleep(CFG.poll);
        continue;
      }

      // ── 无视频节：测验自动答 / 到点跳过翻节 ──
      const q = await handleQuiz(page);
      if (q.total === 0) {
        // 可能是文档/阅读/PPT 类任务点，先试着点开「测验/文档」标签
        await clickChip(page, /^\s*\d*\s*(节节测验|章节测验|测验)\s*$/, '测验');
      }
      // 测验已提交成功 → 立即翻节，不再等停留时间
      if (quizSubmitted.has(curSectionKey)) {
        // ⚠ 先别急着翻节：目录还显示本节有未完成 → 剩下的必然是视频
        //   （高倍速时服务器常常没记上进度）→ 留下来重看
        const catQ = await readCatalog(page);
        const meQ = catQ && catQ.find(x => x.cid === curSectionKey);
        if (meQ && meQ.inc !== null && meQ.inc > 0) {
          // 📌 先判断「剩下的任务点到底是什么」（v5d 新增）：
          //   videoCredited（视频已被服务器记账）+ quizSubmitted（测验已交）
          //   → 剩下的必然是【未知类型任务点】（文档/PPT/课件/阅读…），不是视频！
          //   → 绝不能重看视频（那就是 7.1 卡 2 小时、6.7 卡 8 小时的死循环）
          if (videoCredited.has(curSectionKey)) {
            incAtEntry = meQ.inc;
            if (round % 4 === 1) log(`🧩 测验已交 + 媒体已记账，目录还差 ${meQ.inc} 个 → 剩余不是视频/音频，转排查未知类型任务点`);
            const got = await tryUnknownJobs(page, curSectionKey);
            if (!got) {
              // 拿不下 → 跳过本节（每个未知任务点只试一次，回来也不会再耗）
              const btnU = await findNextBtn(page);
              if (btnU && Date.now() - lastNextAt > CFG.cooldownMs) {
                log('⛔ 未知任务点未拿下 → 先跳过本节（稍后目录复核）');
                lastNextAt = Date.now();
                await safeClick(btnU);
                await sleep(CFG.cooldownMs);
              }
            }
            await sleep(CFG.poll);
            continue;
          }
          if (replayCnt < 3) {
            if (videoDone.has(curSectionKey)) { videoDone.delete(curSectionKey); saveDone(); }
            incAtEntry = meQ.inc;
            replayCnt++;   // ⚠ v5c 及之前从没自增过 → 这个闸门是虚设的，卡死循环的帮凶
            // ⚠ 关键：此刻内容区多半还停在测验页（视频元素已不在）→ 必须允许重新点「视频」
            //   标签切回视频视图，否则 vids 永远为空，永远走不到重看逻辑（7.1 卡死 25s/轮的根因）
            chipClicked.delete(curSectionKey + '|视频');
            if (round % 4 === 1) log(`🔁 测验已交，但目录还差 ${meQ.inc} 个任务点 → 切回视频重看（第 ${replayCnt} 次，${effSpeed()}x）`);
            await sleep(CFG.poll);
            continue;
          }
          // 重看 3 次仍不行 → 不再纠缠，放行
          if (round % 8 === 1) log(`⛔ 本节重看 ${replayCnt} 次目录仍未下降 → 放行下一节`);
        }
        const btn = await findNextBtn(page);
        if (btn && Date.now() - lastNextAt > CFG.cooldownMs) {
          log('📤 本节测验已提交完成 → 下一节');
          lastNextAt = Date.now();
          await safeClick(btn);
          await sleep(CFG.cooldownMs);
          continue;
        }
        if (!btn && round % 12 === 1) {
          // 已是最后一节 → 回头补刷有剩余任务点的节
          if (round % 6 === 0) await redoPass(page);
        }
        await sleep(CFG.poll);
        continue;
      }
      const waited = Date.now() - sectionEnterAt;
      // 用户规则（2026-10-13）：测验没做完就不翻节！留在本节等题库热更新后重试，
      // 全部命中并提交成功才走（「完成了再下一节」）
      // ⚠ 不设 15 分钟时限——凌晨就是被这个时限放行，跳过刚点开的测验直接翻节，
      //   导致 2.4 之后所有测验没交（只有视频完成）。submitTry<3 已经足够防死循环。
      const quizPendingHere = !quizSubmitted.has(curSectionKey)
        && !quizManual.has(curSectionKey)   // 📝 v7.10：填空/简答节已标记人工 → 不死等，放行翻节
        && !abandon.has(curSectionKey)      // 🏳 v7.10b：已放弃的节 → 不死等，放行翻节
        && (q.total > 0 || chipClicked.has(curSectionKey + '|测验'))   // 测验标签点开但题目还没渲染也算未完成
        && (submitTry.get(curSectionKey) || 0) < 3;
      if (quizPendingHere) {
        if (q.unknown > 0 && round % 15 === 1) {
          log(`⏸ 本节测验还有 ${q.unknown} 题未命中 → 不翻节，留在本节等题库更新后重试`);
        }
        await sleep(CFG.poll);
        continue;
      }
      // 📝 v7.10：本节是人工/AI 测验（填空题）→ 翻节时留个记录，别让用户以为刷完了
      if (CFG.autoNext && quizManual.has(curSectionKey) && round % 20 === 1) {
        log('📝 本节含填空题/简答题（已标记人工）→ 任务点待 AI 答案，先继续后面的节');
      }
      if (CFG.autoNext && !quizPendingHere && waited > CFG.skipWaitMs && Date.now() - lastNextAt > CFG.cooldownMs) {
        // 🧯 熔断：连续 3 次「下一节」点击无效（多半是反爬/弹窗拦截）→ 停 90 秒，别再喂风控
        if (Date.now() < skipNextBlockUntil) {
          if (round % 20 === 1) log('🧯 「下一节」连点熔断中（剩余 ' + Math.ceil((skipNextBlockUntil - Date.now()) / 1000) + 's）→ 暂停翻节');
          await sleep(CFG.poll);
          continue;
        }
        const btn = await findNextBtn(page);
        if (btn) {
          // 🎯 v7.8g（2026-10-16 0:20 实锤）：翻节前最后一道兜底！
          //   1.2 节漏刷：剩的 1 个任务点是【同页文档卡片】，既不是媒体也没渲染成测验
          //   → 旧逻辑直接"跳过并翻节"，任务点永远没人碰。
          //   ⇒ 目录还有未完成 → 先点未知页签 + 滚动记阅文档卡片；拿下就留下继续，别急着跳。
          //   （每节每轮只试一次，dwellTried/unknownTried 限频，不会拖慢正常节）
          const catX = await readCatalog(page);
          const meX = catX && catX.find(x => x.cid === curSectionKey);
          if (meX && meX.inc > 0 && (await tryUnknownThenDwell(page, curSectionKey))) {
            lastNextAt = Date.now();
            await sleep(2000);
            continue;   // 重新走主循环：inc 可能已下降 → 测验/翻节正常流程
          }
          log(`⏭ 本节无视频任务点，已停留 ${Math.round(waited / 1000)}s → 跳过并翻节`);
          // 🏳 v7.10b：无视频节停留后仍做不完（需及格分的测验）→ 标记放弃，避免 redoPass 死循环拉回
          // 🚧 v7.14：但若【页面压根没渲染出媒体模块】（懒加载没触发）→ 不是"做不完"而是"没给够时间渲染"
          //   → 这种节绝不标放弃（否则一次误判就永久跳过），只翻节，留给 redoPass 下次带足时间回来
          const pageWasReady = (await readJobIcons(page)) !== null
            && page.frames().some(f => /ananas\/modules\/(video|audio)/i.test(f.url()));
          if (!abandon.has(curSectionKey) && pageWasReady) {
            abandon.add(curSectionKey); saveAbandon();
            log('🏳 本节无视频但仍有任务点无法自动完成 → 已标记放弃自动完成（后续人工补）');
          } else if (!pageWasReady) {
            log('⏳ 本节页面始终没渲染出媒体模块（懒加载未触发）→ 不标放弃，下次带足时间重试');
          }
          // 🔄 v7.9：同样先回头清旧账（前面还有没清完的节就跳回去，别一直往前走）
          if (await redoPass(page, curSectionKey)) { lastNextAt = Date.now(); await sleep(CFG.cooldownMs); continue; }
          // 只有「没测验」或「测验已全部命中提交」才记为本节处理完；
          // 测验题还没答案入库 → 不记，留给 redoPass 之后带答案回来补交
          const quizPending = chipClicked.has(curSectionKey + '|测验') && q.total === 0;
          if (q.unknown === 0 && !quizPending && !videoDone.has(curSectionKey)) { videoDone.add(curSectionKey); saveDone(); }
          lastNextAt = Date.now();
          const urlBefore = page.url();
          await safeClick(btn);
          await sleep(CFG.cooldownMs);
          if (page.url() === urlBefore) {
            skipNextFails++;
            if (skipNextFails >= 3) {
              skipNextFails = 0;
              skipNextBlockUntil = Date.now() + 90000;
              log('🧯 连续 3 次「下一节」点击无效 → 熔断 90 秒（防触发反爬验证码）');
            }
          } else skipNextFails = 0;
          continue;
        }
        if (round % 12 === 1) log('本节找不到「下一节」按钮，可能已到课程末尾');
        if (round % 6 === 0) await redoPass(page);   // 到课程末尾 → 回头补刷
      } else if (round % 12 === 1) {
        log(`本节无媒体任务点，等待自动翻节（${Math.max(0, Math.ceil((CFG.skipWaitMs - waited) / 1000))}s 后跳过）`);
      }
      await sleep(CFG.poll);
    } catch (e) {
      log('轮询异常（忽略继续）: ' + String(e.message).slice(0, 80));
      await sleep(3000);
    }
  }
})().catch(e => {
  const msg = new Date().toISOString().slice(11, 19) + ' FATAL: ' + e.message + '\n' + (e.stack || '').slice(0, 500);
  console.error(msg);
  try { fs.appendFileSync(LOG_FILE, msg + '\n', 'utf8'); } catch (e2) {}
  process.exit(1);
});
