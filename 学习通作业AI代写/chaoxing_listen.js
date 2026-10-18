// 听力题音频提取器（2026-10-18）
// 用法：node chaoxing_listen.js
// 作用：找到作答页里所有「听力题」，把每题的音频下载到本地：
//     听力题<题号>_<序号>.mp3
// 并打印每题的挖空句子（供转写后人工/AI 对空）。
// 原理：音频在 audioplay.html?objectid=xxx 的 iframe 里（与作业页同源），
//       播放器 <audio> 的 src 就是带签名的 cldisk 直链，直接抓。
const path = require('path');
const fs = require('fs');

const PORT = process.env.CHX_PORT || '9222';
const log = (m) => console.log(new Date().toTimeString().slice(0, 8) + ' ' + m);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const pw = require('playwright-core');
  const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find(p => /(dowork|doHomeWork|work\/doWork|work\/answer)/i.test(p.url()));
  if (!page) {
    for (const p of ctx.pages()) {
      const n = await p.$$eval('div.questionLi', els => els.length).catch(() => 0);
      if (n > 0) { page = p; break; }
    }
  }
  if (!page) { log('✗ 没找到作答页（请先打开作业页再运行）'); process.exit(2); }

  const questions = await page.evaluate(() => {
    return [...document.querySelectorAll('div.questionLi')]
      .filter(el => /听力/.test(el.getAttribute('typename') || ''))
      .map(el => ({
        num: (el.querySelector('h3')?.innerText || '').trim().split('.')[0],
        text: el.innerText.replace(/\s+/g, ' ').slice(0, 600),
        audioObjectIds: [...el.querySelectorAll('iframe.ans-insertaudio-module')]
          .map(f => f.getAttribute('data') || (f.src.match(/objectid=([0-9a-f]+)/) || [])[1])
          .filter(Boolean),
      }));
  });
  if (!questions.length) { log('本页没有听力题'); process.exit(0); }
  log(`共 ${questions.length} 道听力题`);

  const results = [];
  for (const qq of questions) {
    for (let k = 0; k < qq.audioObjectIds.length; k++) {
      const oid = qq.audioObjectIds[k];
      const dest = path.join(__dirname, `听力题${qq.num}_${k + 1}.mp3`);
      try {
        // 进同源的播放器 iframe 拿直链
        const frame = page.frames().find(f => f.url().includes('objectid=' + oid));
        let url = null;
        if (frame) {
          url = await frame.evaluate(() => {
            const a = document.querySelector('audio, source');
            return a ? (a.src || a.currentSrc) : (document.documentElement.outerHTML.match(/https?:\/\/[^"' ]+\.mp3[^"' ]*/) || [null])[0];
          });
        }
        if (!url) { log(`✗ 题${qq.num} 音频${k + 1}：播放器 iframe 未加载（点一下播放再重跑即可）`); continue; }
        const resp = await page.request.get(url);
        if (!resp.ok()) { log(`✗ 下载失败 HTTP ${resp.status()}`); continue; }
        fs.writeFileSync(dest, await resp.body());
        log(`✓ 题${qq.num} 音频${k + 1} → ${path.basename(dest)}（${Math.round(resp.body().length / 1024)} KB）`);
        results.push({ question: qq.num, file: dest, text: qq.text });
      } catch (e) {
        log(`✗ 题${qq.num} 异常：${String(e.message).slice(0, 80)}`);
      }
    }
  }

  // 写一份转写工作单，方便下一步「转写 → 对空 → 填 blank 数组」
  fs.writeFileSync(path.join(__dirname, '听力工作单.json'),
    JSON.stringify(results.map(r => ({
      题号: r.question,
      音频: path.basename(r.file),
      挖空原文: r.text,
      转写结果: '',       // ← 用 ASR 工具转写后粘到这里
      空答案: [],        // ← 按顺序填：["was not poisonous", ...]
    })), null, 2), 'utf-8');
  log(`听力工作单已写入 → 听力工作单.json（转写后把空答案并入 answers.json 的 blank 数组）`);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
