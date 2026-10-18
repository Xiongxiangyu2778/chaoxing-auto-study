// 🎯 倍速按时长自动匹配 —— 离线单元测试
// 运行：node test_speed_match.js
// 规则：学习通视频任务点完成 = 累计【真实播放秒数】≥ 总时长 × 0.9
//       真实播放秒数 = Σ(进度增量 ÷ 倍速) → 一遍从 cur 播到 dur 能攒 (dur-cur)/S 秒
//       要"这一遍播完就达标"：acc + (dur-cur)/S ≥ target → S ≤ (dur-cur)/(target-acc)

const SPEED_STEPS = [1, 1.1, 1.25, 1.5, 2, 2.5, 3];
const completeRatio = 0.9, bankBuffer = 0;
const bankTarget = dur => dur * (completeRatio + bankBuffer);

function matchSpeedByDuration(dur, cur, acc, cap) {
  if (!(dur > 0)) return cap;
  const need = bankTarget(dur) - acc;
  if (need <= 1) return cap;
  const remPos = Math.max(dur - Math.max(cur, 0), 3);
  const fit = remPos / need;
  const want = Math.min(cap, fit);
  let pick = SPEED_STEPS[0];
  for (const s of SPEED_STEPS) if (s <= want + 1e-9) pick = s;
  return pick;
}

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = Math.abs(got - want) < 1e-9;
  ok ? pass++ : fail++;
  console.log((ok ? '✅' : '❌') + ' ' + name + ' → ' + got + 'x' + (ok ? '' : '（期望 ' + want + 'x）'));
};
const chk = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : '')); };

console.log('── 场景 1：全新视频（上限 speed=1.5）──');
t('20 分钟的全新视频', matchSpeedByDuration(1200, 0, 0, 1.5), 1.1);   // 1/0.9≈1.11 → 吸附 1.1（一遍过）
t('5 分钟的全新视频', matchSpeedByDuration(300, 0, 0, 1.5), 1.1);     // 与时长无关，比例恒定
t('上限只有 1.0x', matchSpeedByDuration(1200, 0, 0, 1), 1);

console.log('\n── 场景 2：已累计过真实时长 → 允许更快 ──');
t('已攒 30%', matchSpeedByDuration(1200, 0, 360, 1.5), 1.5);   // 还差 720 秒，1.5x 一遍攒 800 ✓
t('已攒 50%', matchSpeedByDuration(1200, 0, 600, 1.5), 1.5);   // 还差 480 秒，1.5x 一遍攒 800 ✓
t('已攒 50%（上限放到 3x）', matchSpeedByDuration(1200, 0, 600, 3), 2.5);  // fit=2.5 → 正好 2.5x 一遍攒够 480 秒
t('已攒 85%', matchSpeedByDuration(1200, 0, 1020, 3), 3);      // 还差 60 秒 → 直接拉满
t('已攒够（≥90%）', matchSpeedByDuration(1200, 0, 1080, 1.5), 1.5);      // 只求播完，用上限

console.log('\n── 场景 3：看到一半（进度已推进）──');
t('20 分钟看到 10 分钟、没攒过时长', matchSpeedByDuration(1200, 600, 0, 1.5), 1);   // 剩 600 秒进度要攒 1080 秒 → 只能 1x
t('20 分钟看到 10 分钟、已攒 40%', matchSpeedByDuration(1200, 600, 480, 1.5), 1);   // 剩 600 秒进度、还差 600 秒 → 1x 刚好

console.log('\n── 场景 4：边界 ──');
t('读不到时长 → 用上限', matchSpeedByDuration(0, 0, 0, 1.5), 1.5);
t('刚开头 1 秒', matchSpeedByDuration(1200, 1, 0, 1.5), 1.1);
chk('目标值 = 时长 × 0.9', Math.abs(bankTarget(1200) - 1080) < 1e-9);

console.log('\n── 场景 5：完整模拟（含"提前停播"与"补第二遍"的收敛性）──');
// 模拟逻辑跟脚本一致：每轮按时长匹配倍速；攒够真实时长【且进度≥90%】就提前停播去核验；
// 播到结尾若还没攒够 → 自然重载从头再播一遍，直到达标。
// 断言：① 最多 2 遍 ②总墙钟时间 ≈ 0.9×时长（物理下限，倍速改不了）
let worstRounds = 0, worstWall = 0;
for (const dur of [180, 600, 1200, 2400]) {
  for (const cap of [1, 1.1, 1.25, 1.5, 3]) {
    let acc = 0, cur = 0, rounds = 0, wall = 0;
    for (let guard = 0; guard < 8 && acc < bankTarget(dur) - 1; guard++) {
      rounds++;
      const s = matchSpeedByDuration(dur, cur, acc, cap);
      const remPos = dur - cur;
      const needNow = bankTarget(dur) - acc;
      const posAtTarget = needNow * s;                      // 攒够时所在的位置
      if (posAtTarget <= remPos && (cur + posAtTarget) >= 0.9 * dur) {
        // 提前停播（脚本里的"真实时长已攒够 + 进度≥90%"）
        acc += needNow; wall += needNow; cur = cur + posAtTarget;
      } else {
        const gained = remPos / s;                          // 播到结尾能攒的真实秒数
        acc += gained; wall += gained; cur = dur;
        if (acc < bankTarget(dur) - 1) cur = 0;             // 没攒够 → 重载从头再播
      }
      if (cur >= dur - 0.5) cur = 0;
    }
    worstRounds = Math.max(worstRounds, rounds);
    worstWall = Math.max(worstWall, Math.abs(wall - bankTarget(dur)));
    if (rounds > 2) console.log(`   ⚠ dur=${dur} cap=${cap} → 需要 ${rounds} 遍`);
  }
}
chk('任何时长/上限组合下，最多 2 遍就能达标（不会无限重看）', worstRounds <= 2, `（实测最多 ${worstRounds} 遍）`);
chk('总墙钟时间 ≈ 0.9 × 时长（物理下限，与倍速无关）', worstWall < 2, `（最大偏差 ${worstWall.toFixed(2)} 秒）`);

console.log('\n════ 结果：' + pass + ' 项通过 / ' + fail + ' 项失败 ════');
process.exit(fail ? 1 : 0);
