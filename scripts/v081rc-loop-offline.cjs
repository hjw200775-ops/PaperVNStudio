'use strict';
/*
 * V0.8.1-RC · 精确循环离线验收（M3）
 *
 * 用 OfflineAudioContext 渲染引擎的真实图：不依赖窗口、rAF、定时器，
 * 因此可以确定性地测量「循环接缝」本身，而不是测量调度器的心情。
 *
 * 每次迭代：给定 loopStart/loopEnd 渲染 N 秒 → 分析 PCM：
 *   - 最长静音段（ms）        —— 接缝处有没有空隙
 *   - 最大相邻样本跳变        —— 波形有没有断裂/爆音
 *   - 循环次数与时长          —— 位置有没有漂移
 *
 * 用法：node scripts/v081rc-loop-offline.cjs [iterations]
 * 产物：release/audio-loop-benchmark.json（与在线结果合并写在同一份报告里）
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = path.join(ROOT, 'release', 'v081rc');
const ITER = Math.max(5, Number(process.argv[2]) || 30);
const OUT = path.join(ROOT, 'release', 'audio-loop-benchmark.json');

function sineWav(seconds, freq, sampleRate = 48000) {
  const n = Math.floor(seconds * sampleRate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * (i / sampleRate)) * 16000), 44 + i * 2);
  return b;
}

function buildPage(iterations) {
  const sine = sineWav(8, 440, 48000);
  const audioJs = fs.readFileSync(path.join(ROOT, 'dist', 'audio.js'), 'utf8');
  return `<!doctype html><meta charset="utf-8"><title>offline loop bench</title>
<body style="margin:0;background:#0e1714;color:#dfe9df;font:13px monospace"><div id="log" style="padding:12px"></div>
<script>${audioJs}</script>
<script>
const ASSET = ${JSON.stringify('data:audio/wav;base64,' + sine.toString('base64'))};
const OST = ${JSON.stringify('data:audio/ogg;base64,' + fs.readFileSync(path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01', 'assets', 'audio', '5f129628ae4a7d4471c37aed6d564d3128d5e834b25150ce56c59f09e790c55b.ogg')).toString('base64'))};
const ITER = ${iterations};
const log = (m) => { const d = document.createElement('div'); d.textContent = m; document.getElementById('log').appendChild(d); };

/* 一次渲染：返回接缝统计。纯离线，无窗口/定时器参与。 */
async function once(loopStart, loopEnd, seconds, opts) {
  const o = Object.assign({ asset: 'sine', mode: 'region' }, opts || {});
  const rate = 48000;
  const ctx = new OfflineAudioContext(1, Math.round(rate * seconds), rate);
  const A = createPaperAudio();
  const audio = A.runtime({ assetData: (id) => (id === 'ost' ? OST : ASSET), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
    loopMode: 'precise', audioContext: ctx, autoResume: false });
  const loop = o.mode === 'all' ? { mode: 'all', start: 0, end: 0 } : { mode: 'region', start: loopStart, end: loopEnd };
  const r = await audio.bgmCrossfade({ audioId: o.asset, volume: 1, duration: .01, curve: 'linear', loop });
  if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'crossfade-failed' };
  const buf = await ctx.startRendering();
  const pcm = buf.getChannelData(0);

  /* 跳过开头的淡入与前 1 秒，只统计稳态；
     阈值取 0.002（正弦振幅 0.5，音乐最弱段也不会低于这个幅度太多）。 */
  const skip = rate * 1;
  const thr = 0.002;
  let runStart = -1, maxRun = 0, maxRunAt = 0, silent = 0;
  const gaps = [];
  for (let i = skip; i < pcm.length; i++) {
    if (Math.abs(pcm[i]) < thr) {
      if (runStart < 0) runStart = i;
      silent++;
      if (i - runStart + 1 > maxRun) { maxRun = i - runStart + 1; maxRunAt = runStart; }
    } else if (runStart >= 0) {
      const ms = (i - runStart) / rate * 1000;
      if (ms >= 1) gaps.push({ atMs: Math.round(runStart / rate * 1000), ms: +ms.toFixed(2) });
      runStart = -1;
    }
  }
  /* 只关心「循环边界附近」的静音：把每个预期的边界前后 40ms 的最长静音单独算出来 */
  const bufDur = o.asset === 'ost' ? 38.059 : 8;
  const boundaries = [];
  const span = o.mode === 'all' ? bufDur : (loopEnd - loopStart);
  const first = o.mode === 'all' ? bufDur : loopEnd;
  for (let t = first; t < seconds - 0.2; t += span) boundaries.push(t);
  let boundarySilence = 0, boundaryAt = 0;
  for (const t of boundaries) {
    const from = Math.max(skip, Math.round((t - 0.04) * rate)), to = Math.min(pcm.length, Math.round((t + 0.04) * rate));
    let run = -1, best = 0, at = 0;
    for (let i = from; i < to; i++) {
      if (Math.abs(pcm[i]) < thr) { if (run < 0) run = i; if (i - run + 1 > best) { best = i - run + 1; at = run; } }
      else run = -1;
    }
    if (best / rate * 1000 > boundarySilence) { boundarySilence = best / rate * 1000; boundaryAt = at; }
  }
  /* 相位断裂：440Hz 相邻样本差理论上限 ≈ 2π·440/48000·0.5 ≈ 0.029 */
  let maxStep = 0, stepAt = 0;
  for (let i = 1; i < pcm.length; i++) {
    const d = Math.abs(pcm[i] - pcm[i - 1]);
    if (d > maxStep) { maxStep = d; stepAt = i; }
  }
  /* 循环次数：理论 (seconds - loopEnd) / (loopEnd - loopStart) 四舍五入 */
  const expected = Math.max(0, Math.round((seconds - loopEnd) / (loopEnd - loopStart)));
  return { ok: true, asset: o.asset, mode: o.mode, loopStart, loopEnd, seconds,
    maxSilenceMs: +(maxRun / rate * 1000).toFixed(2), maxSilenceAtMs: Math.round(maxRunAt / rate * 1000),
    boundarySilenceMs: +boundarySilence.toFixed(2), boundaryAtMs: Math.round(boundaryAt / rate * 1000),
    boundaryCount: boundaries.length,
    silenceRatio: +(silent / pcm.length).toFixed(5), gapCount: gaps.length, gaps: gaps.slice(0, 6),
    maxStep: +maxStep.toFixed(4), maxStepAtMs: Math.round(stepAt / rate * 1000), expectedLoops: expected };
}

window.__runAll = async () => {
  const rows = [];
  /* 30 个不同的循环区间：覆盖整曲、长区间、短区间与相位不连续的情况 */
  const spans = [];
  for (let i = 0; i < ITER; i++) {
    const span = 0.5 + (i % 10) * 0.35;          // 0.5s ~ 3.65s
    const start = 0.25 + (i % 7) * 0.4;          // 0.25s ~ 2.65s
    spans.push([+start.toFixed(3), +(start + span).toFixed(3)]);
  }
  for (const [s, e] of spans) rows.push(await once(s, e, 6));
  /* 真实素材（OGG）：区间循环 10 次 + 整曲循环 10 次 */
  for (let i = 0; i < 10; i++) rows.push(await once(4, 4 + 8 + i % 3, 8, { asset: 'ost', mode: 'region' }));
  for (let i = 0; i < 10; i++) rows.push(await once(0, 0, 8, { asset: 'ost', mode: 'all' }));
  return rows;
};
window.__ready = true;
log('offline bench ready · ' + ITER + ' iterations');
</script></body>`;
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const page = path.join(WORK, 'loop-offline.html');
  fs.writeFileSync(page, buildPage(ITER), 'utf8');
  const shell = path.join(WORK, 'loop-offline-shell.cjs');
  fs.writeFileSync(shell, [
    "'use strict';",
    "const { app, BrowserWindow } = require('electron');",
    "const fs = require('node:fs');",
    'app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");',
    'app.whenReady().then(async () => {',
    '  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });',
    '  await win.loadFile(process.argv[2]);',
    '  for (let i = 0; i < 100; i++) { if (await win.webContents.executeJavaScript("!!window.__ready").catch(() => false)) break; await new Promise((r) => setTimeout(r, 100)); }',
    '  const rows = await win.webContents.executeJavaScript("window.__runAll()", true);',
    '  fs.writeFileSync(process.argv[3], JSON.stringify({ at: new Date().toISOString(), iterations: rows.length, rows }, null, 2), "utf8");',
    '  app.exit(0);',
    '});'
  ].join('\n'), 'utf8');

  const tmp = path.join(WORK, 'loop-offline-result.json');
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  await new Promise((resolve) => {
    const p = spawn(ELECTRON, [shell, page, tmp], { cwd: ROOT, stdio: 'inherit', env });
    p.on('exit', resolve);
  });
  if (!fs.existsSync(tmp)) { console.error('离线渲染没有产出结果'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  const ok = data.rows.filter((r) => r.ok);
  const failures = data.rows.filter((r) => !r.ok);
  const silences = ok.map((r) => r.maxSilenceMs).sort((a, b) => a - b);
  const steps = ok.map((r) => r.maxStep).sort((a, b) => a - b);
  const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;

  const groupOf = (r) => r.asset === 'ost' ? ('ost-' + r.mode) : ('sine-' + r.mode);
  const groups = {};
  for (const r of ok) {
    const k = groupOf(r);
    const g = groups[k] || (groups[k] = { count: 0, silences: [], steps: [], gapTotal: 0, atMs: [] });
    g.count++; g.silences.push(r.boundarySilenceMs); g.steps.push(r.maxStep); g.gapTotal += r.gapCount || 0; g.atMs.push(r.boundaryAtMs);
  }
  for (const g of Object.values(groups)) {
    g.silences.sort((a, b) => a - b); g.steps.sort((a, b) => a - b);
    g.silenceP95 = pct(g.silences, .95); g.silenceMax = g.silences[g.silences.length - 1];
    g.stepMax = g.steps[g.steps.length - 1];
    delete g.silences; delete g.steps;
  }
  const summary = {
    at: new Date().toISOString(),
    mode: 'precise-offline',
    groups,
    iterations: data.iterations,
    passed: ok.length,
    failed: failures.length,
    failures: failures.slice(0, 5),
    maxSilenceMs: { p50: pct(silences, .5), p95: pct(silences, .95), max: silences[silences.length - 1] },
    maxStep: { p50: pct(steps, .5), p95: pct(steps, .95), max: steps[steps.length - 1] },
    target: { silenceP95Ms: 20, stepLimit: 0.08 },
    meets: null,
    rows: ok.map((r) => ({ asset: r.asset, mode: r.mode, loop: [r.loopStart, r.loopEnd], maxSilenceMs: r.maxSilenceMs, maxStep: r.maxStep, gaps: r.gapCount, expectedLoops: r.expectedLoops }))
  };
  summary.meets = summary.maxSilenceMs.p95 <= 20 && summary.maxStep.max <= 0.08;

  /* 合并进总报告（保留已有的在线结果） */
  let merged = { at: new Date().toISOString(), version: '0.8.1-rc' };
  if (fs.existsSync(OUT)) {
    try { merged = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  }
  merged.offlinePrecise = summary;
  fs.writeFileSync(OUT, JSON.stringify(merged, null, 2), 'utf8');

  console.log('precise/offline  ' + ok.length + '/' + data.iterations + ' 通过  ' +
    '接缝 P50 ' + summary.maxSilenceMs.p50 + 'ms  P95 ' + summary.maxSilenceMs.p95 + 'ms  最大 ' + summary.maxSilenceMs.max + 'ms  ' +
    '跳变最大 ' + summary.maxStep.max + '  → ' + (summary.meets ? '达标' : '未达标'));
  if (failures.length) console.log('失败样例：' + JSON.stringify(failures.slice(0, 2)));
  process.exit(summary.meets ? 0 : 1);
})();
