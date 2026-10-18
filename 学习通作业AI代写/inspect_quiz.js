/* 侦察：等待用户进入作答页，导出所有框架的结构信息 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) {
  try { ({ chromium } = require(path.join(__dirname, 'node_modules', 'playwright-core'))); }
  catch (e2) { ({ chromium } = require(path.join(__dirname, '..', '刷章节', 'node_modules', 'playwright-core'))); }
}
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => { try { return fs.existsSync(p); } catch (e) { return false; } })
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = fs.existsSync(path.join(os.homedir(), 'edge-quiz-profile'))
  ? path.join(os.homedir(), 'edge-quiz-profile')
  : path.join(__dirname, '..', 'edge-profile');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(new Date().toISOString().slice(11,19), m);

(async () => {
  const browser = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: false, viewport: null,
    args: ['--no-first-run', '--window-size=1400,900']
  });
  const ctx = browser;
  let page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://mooc1.chaoxing.com/mooc2/work/list?courseId=266392777&classId=152782739', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
  log('等待进入作答页（最多8分钟）...');
  let target = null;
  for (let i = 0; i < 160; i++) {
    for (const p of ctx.pages()) {
      if (p.url().includes('dowork')) { target = p; break; }
    }
    if (target) break;
    await sleep(3000);
  }
  if (!target) { log('超时'); await browser.close(); process.exit(1); }
  log('作答页URL:', target.url());
  await target.waitForTimeout(5000);
  fs.mkdirSync(__dirname + '/quizdump', { recursive: true });
  fs.writeFileSync(__dirname + '/quizdump/url.txt', target.url());
  fs.writeFileSync(__dirname + '/quizdump/title.txt', await target.title());
  let fi = 0;
  for (const f of target.frames()) {
    try {
      const html = await f.evaluate(() => document.documentElement.outerHTML);
      fs.writeFileSync(__dirname + `/quizdump/frame_${fi}.html`, html);
      log(`frame[${fi}] url=${f.url().slice(0,60)} html长度=${html.length}`);
      fi++;
    } catch (e) { log(`frame[${fi}] 读取失败: ` + e.message.slice(0,50)); }
  }
  log('导出完成，浏览器保持打开。60秒后退出。');
  await sleep(60000);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
