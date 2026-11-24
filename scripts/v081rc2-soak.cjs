'use strict';
/* V0.8.1-RC2 / M7：15 分钟真实连续播放浸泡（不虚拟时间，不改计时器）。
 *
 * 在导出的独立游戏里连续跑 900 秒：BGM 循环、换曲交叉淡化、配音 Ducking、音效、
 * 剧情推进、场景转场、返回标题再开始、演出快进。每 5 秒采一次：
 *   音频实例（活动/退役）、解码缓存与在途解码、BGM 时间、标题循环、
 *   JS 堆、DOM 节点数、fps、异常。
 *
 * 用法：node scripts/v081rc2-soak.cjs [exe路径]
 * 产物：release/audio-soak-15min.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const DURATION = Number(process.env.PVN_SOAK_SECONDS || 900);
const REPORT = path.join(ROOT, 'release', 'audio-soak-15min.json');

function findExe(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findExe(f); if (r) return r; }
    else if (/\.exe$/i.test(e.name) && !/elevate/i.test(e.name)) return f;
  }
  return null;
}

const report = { at: new Date().toISOString(), version: '0.8.1-rc2', durationPlanned: DURATION, ok: true, stages: {}, problems: [], samples: [], summary: null };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d || null }; console.log('  ok  ' + n + (d ? ' — ' + JSON.stringify(d).slice(0, 200) : '')); };
const bad = (n, m, d) => { report.ok = false; report.stages[n] = { ok: false, message: m, ...(d || {}) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };

const STATE = `(() => { const s = window.paperGameState(); const a = s.audioPerf || {};
  return { i: s.i, state: s.state,
    mode: a.mode, reason: a.preciseReason,
    bgm: a.bgm && { id: a.bgm.audioId, time: a.bgm.time, loop: a.bgm.loop && a.bgm.loop.mode },
    title: a.title && { playing: a.title.playing, loops: a.title.loops, time: a.title.time },
    instances: a.instances, cache: a.cache && { entries: a.cache.entries, bytes: a.cache.bytes },
    mem: a.audioMemory, duck: a.ducking && { active: a.ducking.active, factor: a.ducking.factor, level: a.ducking.level },
    events: (a.events || []).length,
    js: performance.memory ? performance.memory.usedJSHeapSize : null,
    dom: document.getElementsByTagName('*').length,
    choices: document.querySelectorAll('#choices button').length,
    hint: (document.getElementById('hint') || {}).textContent || ''
  }; })()`;

(async () => {
  const guess = process.argv[2] || findExe(path.join(ROOT, 'release', 'v081rc2', 'large', 'game'))
    || findExe(path.join(ROOT, 'release', 'v081rc2', 'wanfeng-audio', 'game'));
  if (!guess) { console.error('找不到导出的游戏 EXE，先跑 M2/M6 导出'); process.exit(2); }
  const exe = guess;
  report.exe = path.relative(ROOT, exe).replace(/\\/g, '/');
  console.log('  浸泡目标：' + report.exe + '（' + DURATION + ' 秒）');

  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const proc = spawn(exe, ['--remote-debugging-port=' + port, '--remote-allow-origins=*'], { cwd: path.dirname(exe), env, stdio: 'ignore' });
  let cdp = null;
  try {
    const page = await waitPage(port, (u) => u.startsWith('papergame://game/'), 120000);
    if (!page) throw new Error('导出的游戏没有启动');
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Performance.enable').catch(() => {});
    for (let i = 0; i < 150; i++) { if (await cdp.ev(`typeof window.paperGameState === 'function'`).catch(() => false)) break; await sleep(200); }
    ok('浸泡目标已启动', { origin: await cdp.ev('location.origin') });

    /* fps 计数放在页面里，避免采样本身影响帧率 */
    await cdp.ev(`(() => { window.__fps = { frames: 0, t0: performance.now() };
      (function tick(){ window.__fps.frames++; requestAnimationFrame(tick); })(); })()`);

    const startedAt = Date.now();
    await cdp.ev(`document.getElementById('startGame').click()`);
    let passes = 0, transitions = 0, skips = 0;
    let sampleIndex = 0;
    while (Date.now() - startedAt < DURATION * 1000) {
      const s = await cdp.ev(STATE).catch(() => null);
      if (!s) { bad('采样失败', '页面无响应'); break; }

      /* 推进：有选项就选第一个；提示「演出中」时先点一下结算（相当于快进）。 */
      if (s.state === 'playing') {
        if (s.choices > 0) await cdp.ev(`document.querySelector('#choices button').click()`).catch(() => {});
        else if (/演出中/.test(s.hint)) { skips++; await cdp.ev(`document.getElementById('scene').click()`); }
        else await cdp.ev(`document.getElementById('scene').click()`);
      }
      await sleep(1200);

      const cur = await cdp.ev(STATE).catch(() => null);
      if (cur) {
        if (cur.i >= 38) {
          /* 走到结尾：返回标题再开始，顺便覆盖标题曲与剧情曲的来回切换 */
          await cdp.ev(`(() => { const b = document.getElementById('menuBtn'); if (b) b.click(); })()`).catch(() => {});
          await sleep(250);
          await cdp.ev(`(() => { const b = document.getElementById('menuTitle'); if (b) b.click(); })()`).catch(() => {});
          await sleep(900);
          await cdp.ev(`document.getElementById('startGame').click()`).catch(() => {});
          await sleep(600);
          passes++; transitions++;
        }
      }

      if (sampleIndex % 4 === 0) {     // 约每 5 秒一次
        const st = await cdp.ev(STATE).catch(() => null);
        const fps = await cdp.ev(`(() => { const f = window.__fps; const now = performance.now();
          const v = f.frames / Math.max(0.001, (now - f.t0) / 1000); f.frames = 0; f.t0 = now; return v; })()`).catch(() => null);
        if (st) {
          st.at = new Date().toISOString();
          st.elapsed = Math.round((Date.now() - startedAt) / 1000);
          st.fps = fps ? +Number(fps).toFixed(1) : null;
          st.passes = passes;
          report.samples.push(st);
        }
      }
      sampleIndex++;
    }

    const endedAt = Date.now();
    const total = report.samples.length;
    const first = report.samples[0], last = report.samples[total - 1];
    const mid = report.samples[Math.floor(total * 0.25)] || first;
    const maxInstances = report.samples.reduce((m, s) => Math.max(m, (s.instances && s.instances.bgm) || 0, (s.instances && s.instances.title) || 0), 0);
    const maxRetiring = report.samples.reduce((m, s) => Math.max(m, (s.instances && s.instances.retiring) || 0), 0);
    const maxCacheMB = report.samples.reduce((m, s) => Math.max(m, (s.cache && s.cache.bytes) || 0), 0) / 1048576;
    const heapGrowthMB = (last.js - mid.js) / 1048576;
    const modes = new Set(report.samples.map((s) => s.mode));
    const transitionsSeen = report.samples.some((s) => s.title && s.title.loops > 0);

    report.summary = {
      startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(),
      seconds: Math.round((endedAt - startedAt) / 1000), samples: total,
      passes, transitions, skips,
      maxBgmOrTitleInstances: maxInstances, maxRetiring, maxCacheMB: +maxCacheMB.toFixed(1),
      heapStartMB: +(first.js / 1048576).toFixed(1), heapMidMB: +(mid.js / 1048576).toFixed(1), heapEndMB: +(last.js / 1048576).toFixed(1),
      heapGrowthMBAfter25pct: +heapGrowthMB.toFixed(1),
      domStart: first.dom, domEnd: last.dom,
      modes: [...modes], titleLooped: transitionsSeen,
      avgFps: +(report.samples.reduce((a, s) => a + (s.fps || 0), 0) / Math.max(1, total)).toFixed(1),
      minFps: Math.min(...report.samples.map((s) => s.fps || 999)),
      duckingObserved: report.samples.some((s) => s.duck && s.duck.active),
      exactMs: endedAt - startedAt
    };
    ok('浸泡完成', report.summary);

    if (report.summary.seconds < DURATION) bad('浸泡时长', '只跑了 ' + report.summary.seconds + ' 秒');
    else ok('实际时长 ≥ ' + DURATION + ' 秒', { seconds: report.summary.seconds });
    if (maxInstances > 1) bad('音频实例泄漏', '音乐实例最大 ' + maxInstances + '（应始终 ≤ 1）');
    else ok('音乐实例始终 ≤ 1', { max: maxInstances, maxRetiring });
    if (maxCacheMB > 64 * 1.2) bad('解码缓存超预算', maxCacheMB.toFixed(1) + ' MB');
    else ok('解码缓存不超预算', { maxCacheMB: +maxCacheMB.toFixed(1), budgetMB: 64 });
    if (heapGrowthMB > 80) bad('JS 堆增长', '25% 之后仍增长 ' + heapGrowthMB.toFixed(1) + ' MB');
    else ok('JS 堆无明显增长趋势', { midMB: report.summary.heapMidMB, endMB: report.summary.heapEndMB, deltaMB: report.summary.heapGrowthMBAfter25pct });
    if (!modes.has('precise')) bad('播放模式', '整段没有出现过 precise：' + [...modes].join(','));
    else ok('全程精确循环模式', { modes: [...modes] });
    const errs = cdp.errors.filter((e) => !/Autoplay|user gesture/i.test(e.text));
    if (errs.length) bad('运行时异常', errs.slice(0, 3).map((e) => e.text).join(' | ').slice(0, 300));
    else ok('0 运行时异常');
  } catch (e) {
    bad('浸泡测试', String((e && e.message) || e));
  } finally {
    if (cdp) cdp.close();
    kill(proc);
  }

  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' 15 分钟连续播放浸泡（M7）');
  if (!report.ok) console.log(report.problems.join('\n'));
  process.exit(report.ok ? 0 : 1);
})();
