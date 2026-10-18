// 验证新的 readCatalog 逻辑（jobUnfinishCount）+ readJobTabs（cardid 任务点）
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) {
  ({ chromium } = require('C:/Users/Public/.workbuddy/binaries/node/workspace/node_modules/playwright-core'));
}
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 8000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => /studentstudy/i.test(p.url())) || ctx.pages()[0];

  for (const f of page.frames()) {
    const rows = await f.evaluate(() => {
      const out = [];
      document.querySelectorAll('.posCatalog_select[id^="cur"]').forEach(d => {
        const cid = (d.id || '').replace(/^cur/, '');
        const nameEl = d.querySelector('.posCatalog_name');
        const label = ((nameEl && nameEl.innerText) || d.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        let inc = null, src = '';
        const hid = d.querySelector('input.jobUnfinishCount');
        if (hid && hid.value !== '' && !isNaN(Number(hid.value))) { inc = Number(hid.value); src = 'input'; }
        if (inc === null && d.querySelector('.icon_Completed')) { inc = 0; src = 'greenTick'; }
        if (inc === null) { const m = label.match(/(\d+)\s*$/); if (m) { inc = parseInt(m[1], 10); src = 'tail'; } }
        out.push({ cid, label, inc, src });
      });
      return out;
    }).catch(() => null);
    if (rows && rows.length) {
      const unknown = rows.filter(r => r.inc === null).length;
      console.log(`[目录] frame=${f.url().slice(0, 60)} 共 ${rows.length} 行，读不到 inc 的: ${unknown}`);
      console.log('前 5 行:', JSON.stringify(rows.slice(0, 5)));
      console.log('7 章附近:', JSON.stringify(rows.filter(r => /^7\.|^8\.|^9\./.test(r.label)).slice(0, 6)));
      console.log('尾部:', JSON.stringify(rows.slice(-4)));
    }
    const tabs = await f.evaluate(() => {
      const out = [];
      document.querySelectorAll('li[cardid][id^="dct"]').forEach(el => {
        out.push({ id: el.id, text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 16) });
      });
      return out;
    }).catch(() => null);
    if (tabs && tabs.length) console.log('[当前节任务点 tabs]', JSON.stringify(tabs));
  }
  process.exit(0);
})();
