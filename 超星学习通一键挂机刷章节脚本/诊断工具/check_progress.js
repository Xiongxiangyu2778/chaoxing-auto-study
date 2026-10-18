/* 诊断：读取学习通当前章节的页面真实状态（只读，不改任何数据）
   输出：目录各节完成情况 / 是否有"任务点已完成" / 是否有视频弹题 / 章节测验数量 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = process.env.CHX_PROFILE || path.join(require('os').homedir(), 'edge-quiz-profile');
const HOME_DIR = path.resolve(__dirname, '..', '..');   // 学习通作业助手 根目录
const OUT = path.join(HOME_DIR, '题库', '诊断_页面状态.json');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true,
    viewport: { width: 1380, height: 860 },
    args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
           '--disable-features=CalculateNativeWinOcclusion']
  });
  const out = {};
  let st = {};
  try { st = JSON.parse(fs.readFileSync(path.join(HOME_DIR, '.course_state.json'), 'utf8')); } catch (e) {}
  const p = ctx.pages()[0] || await ctx.newPage();
  out.openUrl = st.lastUrl || '';
  try { await p.goto(st.lastUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { out.gotoErr = e.message; }
  await new Promise(r => setTimeout(r, 10000));
  out.url = p.url();
  out.frames = p.frames().map(f => f.url().slice(0, 130));

  const evalAll = async (fn) => {
    const res = [];
    for (const f of p.frames()) {
      try { const r = await f.evaluate(fn); if (r && (!Array.isArray(r) || r.length)) res.push({ frame: f.url().slice(0, 90), r }); } catch (e) {}
    }
    return res;
  };

  // 目录树
  out.catalog = await evalAll(() => {
    const a = [];
    document.querySelectorAll('.posCatalog_select[id^="cur"]').forEach(d => {
      const cid = (d.id || '').replace(/^cur/, '');
      const li = d.closest('li') || d.parentElement;
      const txt = ((li && li.innerText) || d.innerText || '').replace(/\s+/g, ' ').trim();
      const m = txt.match(/(\d+)\s*$/);
      a.push({ cid, txt: txt.slice(0, 60), tailNum: m ? m[1] : null });
    });
    return a;
  });

  // 完成标记/文字
  out.doneTexts = await evalAll(() => {
    const hits = [];
    document.querySelectorAll('*').forEach(el => {
      const s = (el.innerText || '').trim();
      if (/任务点已完成|已完成|已观看|未完成/.test(s) && s.length < 50 && el.children.length <= 1 && el.offsetWidth > 0) hits.push(s);
    });
    return [...new Set(hits)].slice(0, 25);
  });

  // 弹题 / 测验 / 视频
  out.probe = await evalAll(() => {
    const c = s => document.querySelectorAll(s).length;
    const v = s => [...document.querySelectorAll(s)].filter(e => e.offsetWidth > 0 && e.offsetHeight > 0).length;
    return {
      videoquiz: c('.ans-videoquiz'), videoquizVis: v('.ans-videoquiz'),
      TiMu: c('.TiMu'), TiMuVis: v('.TiMu'),
      videos: [...document.querySelectorAll('video')].map(x => ({ cur: x.currentTime, dur: x.duration, paused: x.paused, ended: x.ended, rate: x.playbackRate, cls: String(x.className).slice(0, 40) })),
      bodyHead: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400)
    };
  });

  // 右侧目录里每节的完成图标（学习通用 img 或 class 表示）
  out.catalogIcons = await evalAll(() => {
    const a = [];
    document.querySelectorAll('li').forEach(li => {
      const t = (li.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 60 && li.querySelector('.posCatalog_select[id^="cur"]')) {
        const imgs = [...li.querySelectorAll('img')].map(i => ({ src: (i.src || '').split('/').pop().slice(0, 40), cls: i.className, vis: i.offsetWidth > 0 }));
        const spans = [...li.querySelectorAll('span,i,em')].map(s => String(s.className).slice(0, 30)).slice(0, 6);
        a.push({ txt: t.slice(0, 40), imgs, spans });
      }
    });
    return a.slice(0, 40);
  });

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  await p.screenshot({ path: path.join(HOME_DIR, '题库', '当前页面.png') }).catch(() => {});
  console.log('诊断已写出 -> ' + OUT);
  console.log(JSON.stringify({ url: out.url, frames: out.frames.length, catalogRows: (out.catalog[0] && out.catalog[0].r.length) || 0 }, null, 1));
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
