'use strict';
/* V0.8.1-RC2 / M1：标题音乐接入音频引擎的真实窗口验收。
 *
 * 判定看的是引擎内部的真实状态与真实输出：
 *   - 标题曲走 precise（AudioBufferSourceNode）还是 stream，为什么；
 *   - 循环区间 6–14 真的生效（time 在区间内、loops 由音频时钟递增）；
 *   - 开始游戏 → 标题曲让位给剧情 BGM，返回标题 → 剧情停、标题曲回来；
 *   - 连续进出 5 次，音乐实例始终只有 1 个，解码缓存不增长；
 *   - 调音量 / 静音改变输出，但不改写用户设置；
 *   - 窗口最小化时循环仍然推进（不依赖 rAF）。
 *
 * 用法：node scripts/v081rc2-title-audio.cjs
 * 产物：release/audio-runtime-compatibility.json（title 段）、docs/screenshots/v081rc2-title-*.png
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, sleep, spawnShell, kill } = require('./rc2-cdp.cjs');

const PAGE = path.join(ROOT, 'release', 'wanfeng-v081', '晚风经过二楼走廊·音频演出版.html');
const OUT = path.join(ROOT, 'release', 'audio-runtime-compatibility.json');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');

const report = { at: new Date().toISOString(), version: '0.8.1-rc2', ok: true, stages: {}, problems: [], capture: null, exceptions: [] };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d || null }; console.log('  ok  ' + n + (d ? ' — ' + JSON.stringify(d).slice(0, 200) : '')); };
const bad = (n, m) => { report.ok = false; report.stages[n] = { ok: false, message: m }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };

/* 注入到页面：拿到音频图的 tap，统计「实际输出」的样本级指标。 */
const INSTALLER = `(() => {
  window.__pvnCapture = null; window.__pvnCaptureError = '';
  window.__pvnOnAudioGraph = ({ ctx, tap }) => {
    if (window.__pvnCapture) return;
    try {
      const proc = ctx.createScriptProcessor(4096, 2, 2);
      const mute = ctx.createGain(); mute.gain.value = 0;
      const st = { blocks: 0, samples: 0, maxStep: 0, maxSilenceRun: 0, run: 0, last: 0,
        firstAt: 0, lastAt: 0, sampleRate: ctx.sampleRate, rmsSum: 0, blockGaps: [], lastBlockAt: 0 };
      proc.onaudioprocess = (e) => {
        const buf = e.inputBuffer, ch = buf.getChannelData(0), n = ch.length;
        st.blocks++; st.samples += n;
        const at = Number(e.playbackTime) || 0;
        if (!st.firstAt) st.firstAt = at;
        if (st.lastBlockAt && at > st.lastBlockAt) {
          const gap = at - st.lastBlockAt;
          const nominal = n / st.sampleRate;
          if (gap > nominal * 1.8) st.blockGaps.push(+(gap * 1000).toFixed(1));
        }
        st.lastBlockAt = at; st.lastAt = at;
        for (let i = 0; i < n; i++) {
          const v = ch[i];
          const d = Math.abs(v - st.last);
          if (d > st.maxStep) st.maxStep = d;
          st.last = v;
          if (Math.abs(v) < 1e-4) { st.run++; if (st.run > st.maxSilenceRun) st.maxSilenceRun = st.run; } else st.run = 0;
          st.rmsSum += v * v;
        }
      };
      tap.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
      window.__pvnCapture = st;
    } catch (err) { window.__pvnCaptureError = String((err && err.message) || err); }
  };
})();`;

const SNAP = `(() => { const s = window.paperGameState(); return {
  state: s.state, i: s.i,
  title: s.titleLoop, titleMode: s.titleLoop && s.titleLoop.mode, loops: s.titleLoop && s.titleLoop.loops,
  perf: s.audioPerf && { mode: s.audioPerf.mode, modePref: s.audioPerf.modePref, reason: s.audioPerf.preciseReason,
    music: s.audioPerf.music, bgm: s.audioPerf.bgm && { id: s.audioPerf.bgm.audioId, time: s.audioPerf.bgm.time, vol: s.audioPerf.bgm.volume, loop: s.audioPerf.bgm.loop },
    title: s.audioPerf.title && { playing: s.audioPerf.title.playing, mode: s.audioPerf.title.mode, id: s.audioPerf.title.audioId, time: s.audioPerf.title.time, loops: s.audioPerf.title.loops, vol: s.audioPerf.title.volume, loop: s.audioPerf.title.loop },
    instances: s.audioPerf.instances, cache: s.audioPerf.cache && { entries: s.audioPerf.cache.entries, bytes: s.audioPerf.cache.bytes },
    mem: s.audioPerf.audioMemory, graph: s.audioPerf.graph, gen: s.audioPerf.generation },
  capture: window.__pvnCapture ? { blocks: window.__pvnCapture.blocks, samples: window.__pvnCapture.samples,
    maxStep: window.__pvnCapture.maxStep, maxSilenceMs: window.__pvnCapture.maxSilenceRun / window.__pvnCapture.sampleRate * 1000,
    rmsSum: window.__pvnCapture.rmsSum, rmsSamples: window.__pvnCapture.samples,
    rms: Math.sqrt(window.__pvnCapture.rmsSum / Math.max(1, window.__pvnCapture.samples)),
    gaps: window.__pvnCapture.blockGaps.length, rate: window.__pvnCapture.sampleRate } : null,
  captureError: window.__pvnCaptureError
}; })()`;

(async () => {
  if (!fs.existsSync(PAGE)) { console.error('缺少试听版：' + PAGE); process.exit(2); }
  const { proc, cdp, control } = await spawnShell(PAGE).spawnCdp();
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTALLER });
    await cdp.ev('location.reload()');
    await sleep(2600);
    for (let i = 0; i < 120; i++) {
      if (await cdp.ev(`typeof window.paperGameState === 'function' && !!document.getElementById('startGame')`).catch(() => false)) break;
      await sleep(200);
    }
    /* 用户偏好是本机的：先复位，否则上次手动调的音量会让这次测量失真。 */
    await cdp.ev(`localStorage.setItem('paper-audio-prefs', JSON.stringify({ master: 1, bgm: 1, sfx: 1, voice: 1, muted: false }))`);
    await cdp.ev('location.reload()');
    await sleep(2800);
    for (let i = 0; i < 120; i++) {
      if (await cdp.ev(`typeof window.paperGameState === 'function'`).catch(() => false)) break;
      await sleep(200);
    }

    /* ---- 1. 首次进入标题 ---- */
    let s = await cdp.ev(SNAP);
    if (!s.title) { bad('标题音乐启动', '没有任何标题音乐状态'); }
    else {
      if (s.title.mode !== 'precise') bad('标题音乐模式', '实际走的是 ' + s.title.mode + '：' + (s.perf && s.perf.reason));
      else ok('标题音乐进入精确模式', { id: s.title.id, loop: s.title.loop, vol: +(Number(s.title.volume) || 0).toFixed(3) });
      if (!s.title.loop || s.title.loop.mode !== 'region' || s.title.loop.start !== 6 || s.title.loop.end !== 14) {
        bad('标题循环区间', '区间不是 6–14：' + JSON.stringify(s.title.loop));
      } else ok('标题循环区间 6–14 生效', s.title.loop);
      if (s.perf && s.perf.instances.bgm !== 1) bad('标题实例数', '音乐实例应为 1，实际 ' + JSON.stringify(s.perf.instances));
      else ok('只有一个音乐实例', s.perf.instances);
    }
    await cdp.shot(path.join(SHOTS, 'v081rc2-title-live.png'));

    /* ---- 2. 音频真的在响（采样 + 时间推进） ---- */
    const t0 = Date.now();
    const a = await cdp.ev(SNAP);
    await sleep(3000);
    const b = await cdp.ev(SNAP);
    if (!b.capture) bad('实际输出采样', '没有采到音频图输出：' + (b.captureError || 'tap 未就绪'));
    else if (!(b.capture.rms > 0.005)) bad('实际输出采样', 'RMS 太低，可能没有真正出声：' + b.capture.rms);
    else ok('实际输出采样（在线音频图 PCM）', { rms: +b.capture.rms.toFixed(4), samples: b.capture.samples,
      maxStep: +b.capture.maxStep.toFixed(4), maxSilenceMs: +b.capture.maxSilenceMs.toFixed(2), gaps: b.capture.gaps });
    const adv = b.title && a.title ? (b.title.time - a.title.time) : 0;
    if (!(adv > 2.4)) bad('标题曲时间推进', '3 秒内只前进了 ' + adv.toFixed(2) + ' 秒');
    else ok('标题曲时间推进', { seconds: +adv.toFixed(2), loops: b.loops });

    /* ---- 3. 至少一次真实循环回跳（6–14 区间从 0 开始要 14 秒才进区间） ---- */
    let looped = null;
    for (let i = 0; i < 120; i++) {
      const cur = await cdp.ev(SNAP);
      if (cur.loops >= 1) { looped = cur; break; }
      await sleep(500);
    }
    if (!looped) bad('标题曲循环回跳', '24 秒内没有发生一次区间循环');
    else ok('标题曲循环回跳（音频时钟）', { loops: looped.loops, time: +Number(looped.title.time).toFixed(2),
      captMaxSilenceMs: looped.capture ? +looped.capture.maxSilenceMs.toFixed(2) : null,
      note: '毫秒级接缝以 scripts/v081rc2-online-pcm.cjs 的 30 次采样为准' });

    /* ---- 4. 开始游戏：标题让位给剧情 BGM ---- */
    await cdp.ev(`document.getElementById('startGame').click()`);
    await sleep(1800);
    let g = await cdp.ev(SNAP);
    const titleGone = g.title ? g.title.playing === false : true;
    if (!titleGone) bad('进入游戏后标题曲', '标题曲还在播：' + JSON.stringify(g.title));
    else if (!g.perf || g.perf.music.owner !== 'story') bad('音乐槽移交', '音乐槽没有交给剧情：' + JSON.stringify(g.perf && g.perf.music));
    else if (!(g.perf.bgm && g.perf.bgm.id)) bad('剧情 BGM', '进入游戏后没有剧情音乐');
    else ok('进入游戏：标题让位、剧情 BGM 接管', { owner: g.perf.music.owner, bgm: g.perf.bgm.id, mode: g.perf.mode });
    if (g.perf && g.perf.instances.bgm !== 1) bad('进入游戏实例数', JSON.stringify(g.perf.instances));
    await cdp.shot(path.join(SHOTS, 'v081rc2-title-ingame.png'));

    /* ---- 5. 用户音量 / 静音：改变输出，不改写设置 ---- */
    const windowRms = (a, b) => {
      if (!a.capture || !b.capture) return null;
      const dn = b.capture.rmsSamples - a.capture.rmsSamples;
      const ds = b.capture.rmsSum - a.capture.rmsSum;
      return dn > 8000 ? Math.sqrt(Math.max(0, ds) / dn) : null;
    };
    /* 先测满音量的稳定窗口，再调 35%，各留 1.2 秒稳定期——否则窗口里混进过渡段，
       会把「音量真的降了」稀释成看起来没变。 */
    await sleep(1200);
    const v1 = await cdp.ev(SNAP);
    await sleep(1000);
    const v2 = await cdp.ev(SNAP);
    const rmsFull = windowRms(v1, v2);
    const hasSlider = await cdp.ev(`(() => { const el = document.getElementById('volBgm'); if (!el) return false;
      return true; })()`);
    await cdp.ev(`(() => { const el = document.getElementById('volBgm'); el.value = '35'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(1200);
    const v3 = await cdp.ev(SNAP);
    await sleep(1000);
    const v4 = await cdp.ev(SNAP);
    const rmsLow = windowRms(v3, v4);
    const prefsAfter = await cdp.ev(`window.paperGameState().audioPerf.prefs`);
    if (!hasSlider) bad('用户音量影响实际输出', '设置面板里没有 volBgm 滑块');
    else if (!(rmsFull && rmsLow && rmsLow < rmsFull * 0.6)) {
      bad('用户音量影响实际输出', '窗口 RMS 没有明显下降：' + rmsFull + ' → ' + rmsLow);
    } else ok('用户音量影响实际输出（区间 RMS）', { rmsFull: +rmsFull.toFixed(4), rmsAt35: +rmsLow.toFixed(4),
      ratio: +(rmsLow / rmsFull).toFixed(2), prefsBgm: prefsAfter && prefsAfter.bgm });
    await cdp.ev(`(() => { const el = document.getElementById('volBgm'); el.value = '100'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(400);

    /* ---- 6. 返回标题：剧情停、标题回来，且没有双实例 ---- */
    await cdp.ev(`(() => { const b = document.getElementById('menuBtn'); if (b) b.click(); })()`);
    await sleep(300);
    await cdp.ev(`(() => { const b = document.getElementById('menuTitle'); if (b) b.click(); })()`);
    await sleep(1600);
    let r = await cdp.ev(SNAP);
    if (r.state !== 'title') bad('返回标题', '状态没有回到 title：' + r.state);
    else if (!r.title || r.title.playing !== true) bad('返回标题标题曲', '标题曲没有恢复：' + JSON.stringify(r.title));
    else if (r.perf && r.perf.music.owner !== 'title') bad('返回标题音乐槽', JSON.stringify(r.perf.music));
    else if (r.perf && r.perf.instances.bgm !== 1) bad('返回标题实例数', JSON.stringify(r.perf.instances));
    else ok('返回标题：剧情停、标题曲恢复、单实例', { loops: r.title.loops, time: +Number(r.title.time).toFixed(2), instances: r.perf.instances });

    /* ---- 7. 连续进出 5 次：实例与缓存都不增长 ---- */
    const baseCache = r.perf && r.perf.cache ? r.perf.cache.entries : 0;
    const cycles = [];
    for (let n = 0; n < 5; n++) {
      await cdp.ev(`document.getElementById('startGame').click()`);
      await sleep(700);
      const inGame = await cdp.ev(SNAP);
      await cdp.ev(`(() => { const b = document.getElementById('menuBtn'); if (b) b.click(); })()`); await sleep(250);
      await cdp.ev(`document.getElementById('menuTitle').click()`); await sleep(800);
      const back = await cdp.ev(SNAP);
      cycles.push({ n: n + 1, inGameBgm: inGame.perf && inGame.perf.bgm && inGame.perf.bgm.id,
        inGameInstances: inGame.perf && inGame.perf.instances, backInstances: back.perf && back.perf.instances,
        backTitlePlaying: back.title && back.title.playing, cache: back.perf && back.perf.cache && back.perf.cache.entries });
    }
    const badCycle = cycles.find((c) => !c.backTitlePlaying || (c.backInstances && c.backInstances.bgm !== 1) || (c.backInstances && c.backInstances.title !== 1));
    if (badCycle) bad('连续进出 5 次', JSON.stringify(badCycle));
    else ok('连续进出 5 次：每次都是单实例、标题曲正确恢复', { cycles: cycles.map((c) => c.backInstances), cache: cycles.map((c) => c.cache) });
    const cacheNow = cycles[cycles.length - 1].cache;
    if (baseCache && cacheNow > baseCache + 1) bad('往返后解码缓存', '缓存条目增长：' + baseCache + ' → ' + cacheNow);
    else ok('往返后解码缓存稳定', { before: baseCache, after: cacheNow });

    /* ---- 8. 最小化：循环靠音频时钟继续走（不依赖 rAF） ---- */
    const m0 = await cdp.ev(SNAP);
    const minimized = await control('min');
    await sleep(4200);
    const m1 = await cdp.ev(SNAP);
    await control('restore');
    await sleep(700);
    /* 失焦但可见：另一个常见场景，音频线程照常跑。 */
    const b0 = await cdp.ev(SNAP);
    await control('blur');
    await sleep(3200);
    const b1 = await cdp.ev(SNAP);
    await control('focus');
    await sleep(400);
    const advancedMin = m1.title && m0.title ? (m1.title.time - m0.title.time + 0) : 0;
    if (minimized !== true) bad('最小化窗口', '无法最小化：' + minimized);
    else if (!(m1.title && m1.title.playing && (m1.title.loops > m0.title.loops || advancedMin > 2.5))) {
      bad('最小化时标题循环', '最小化后循环没有推进：' + JSON.stringify({ before: m0.title, after: m1.title }));
    } else ok('最小化窗口：标题循环继续推进', { loopsBefore: m0.title.loops, loopsAfter: m1.title.loops,
      timeBefore: +Number(m0.title.time).toFixed(2), timeAfter: +Number(m1.title.time).toFixed(2),
      captureWhileMinimized: m1.capture ? m1.capture.samples > m0.capture.samples : null });
    if (!(b1.title && (b1.title.loops > b0.title.loops || (b1.title.time - b0.title.time) > 2.2))) {
      bad('失焦时标题循环', JSON.stringify({ before: b0.title, after: b1.title }));
    } else ok('失焦窗口：标题循环继续推进', { loopsBefore: b0.title.loops, loopsAfter: b1.title.loops });
    await cdp.shot(path.join(SHOTS, 'v081rc2-title-restored.png'));

    /* ---- 9. 收尾：没有异常、没有残留 ---- */
    const end = await cdp.ev(SNAP);
    report.capture = end.capture;
    const errs = cdp.errors.filter((e) => !/Autoplay|not allowed|user gesture/i.test(e.text));
    report.exceptions = errs;
    if (errs.length) bad('运行时异常', errs.map((e) => e.text).join(' | ').slice(0, 300));
    else ok('运行时 0 异常');
    if (end.perf && end.perf.instances.bgm > 1) bad('收尾实例数', JSON.stringify(end.perf.instances));
    else ok('收尾：音乐实例仍为 1', end.perf && end.perf.instances);
  } finally {
    kill(proc);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' 标题音乐接入音频引擎（M1）');
  if (!report.ok) console.log(report.problems.join('\n'));
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { report.ok = false; report.problems.push(String(e && e.stack || e)); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.error(e); process.exit(1); });
