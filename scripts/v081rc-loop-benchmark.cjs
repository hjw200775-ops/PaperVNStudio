'use strict';
/*
 * V0.8.1-RC · 音频循环接缝测量（M1 诊断 + M3 验收共用）
 *
 * 关键点：**不听 currentTime，听实际输出采样**。
 *   页面里用 AudioWorklet 把真正渲染出去的 PCM 抓下来（音频线程，不受 rAF/定时器节流影响），
 *   再按「连续静音样本数」找接缝，按「相邻样本跳变」找波形断点。
 *
 * 场景：前台聚焦 / 失去焦点 / 被遮挡 / 最小化 / 恢复。
 * 每个场景独立采集，输出 P50 / P95 / 最大值与 rAF、定时器、currentTime 跳转记录。
 *
 * 用法：node scripts/v081rc-loop-benchmark.cjs [stream|precise|both]
 * 产物：release/audio-loop-benchmark.json、release/v081rc/loop-page.html
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = path.join(ROOT, 'release', 'v081rc');
const SAMPLE = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
const OUT = path.join(ROOT, 'release', 'audio-loop-benchmark.json');
const modeArg = (process.argv[2] || 'both').toLowerCase();

/* ---------- 测试素材：连续正弦 + 已知循环区间 ---------- */
function sineWav(seconds, freq, sampleRate = 48000) {
  const n = Math.floor(seconds * sampleRate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    /* 振幅 0.5 的连续正弦；loop 边界取整数周期时本应完全无缝 */
    b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * (i / sampleRate)) * 16000), 44 + i * 2);
  }
  return b;
}

function buildPage(mode) {
  const ostFile = '5f129628ae4a7d4471c37aed6d564d3128d5e834b25150ce56c59f09e790c55b.ogg';
  const ost = fs.readFileSync(path.join(SAMPLE, 'assets', 'audio', ostFile));
  /* 44.1k 素材统一重采样到 48k 由浏览器负责；循环区间 1.0–3.0s 恰好 2 秒 = 440Hz 的整数周期 */
  const sine = sineWav(6, 440, 48000);
  const audioJs = fs.readFileSync(path.join(ROOT, 'dist', 'audio.js'), 'utf8');
  return `<!doctype html><meta charset="utf-8"><title>loop bench</title>
<body style="margin:0;background:#101a16;color:#dfe9df;font:13px/1.5 monospace">
<div id="log" style="padding:12px"></div>
<script>${audioJs}</script>
<script>
const ASSETS = {
  sine: ${JSON.stringify('data:audio/wav;base64,' + sine.toString('base64'))},
  ost: ${JSON.stringify('data:audio/ogg;base64,' + ost.toString('base64'))}
};
const A = createPaperAudio();
const log = (m) => { const d = document.createElement('div'); d.textContent = m; document.getElementById('log').appendChild(d); };

/* ---------- AudioWorklet：抓总线真实输出 ---------- */
const WORKLET = `
class Meter extends AudioWorkletProcessor {
  constructor(){ super(); this.on = false; this.port.onmessage = (e) => { if (e.data === 'start') this.on = true; if (e.data === 'stop') this.on = false; }; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if (!this.on || !ch) return true;
    const copy = new Float32Array(ch.length);
    copy.set(ch);
    this.port.postMessage(copy, [copy.buffer]);
    return true;
  }
}
registerProcessor('meter', Meter);
`;
const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
let meter = null, capture = [];
const mute = ctx.createGain();

const audio = A.runtime({
  assetData: (id) => ASSETS[id] || '',
  prefs: { master: 0, bgm: 1, sfx: 1, voice: 1 },
  loopMode: window.__mode,
  elementFactory: () => {
    const el = new Audio();
    document.body.appendChild(el);
    try { const src = ctx.createMediaElementSource(el); src.connect(meter); } catch (e) {}
    return el;
  },
  onGraph: ({ tap }) => { try { tap.connect(meter); } catch (e) {} }
});
window.__audio = audio;

window.__prepare = async () => {
 try {
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  meter = new AudioWorkletNode(ctx, 'meter', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  meter.port.onmessage = (e) => { if (capture) capture.push(e.data); };
  mute.gain.value = 0;
  meter.connect(mute); mute.connect(ctx.destination);
  if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) {} }
  return { ok: true, ctx: ctx.state, sampleRate: ctx.sampleRate, mode: window.__mode };
 } catch (e) {
  return { ok: false, error: String((e && e.stack) || e), state: ctx.state };
 }
};

window.__run = async (opts) => {
  const o = Object.assign({ asset: 'sine', loopStart: 1, loopEnd: 3, seconds: 5 }, opts);
  capture = [];
  window.__audio.bgmStop({ fadeOut: 0 });
  await new Promise((r) => setTimeout(r, 120));
  if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) {} }
  meter.port.postMessage('start');
  const t0 = performance.now();
  let raf = 0, timer = 0;
  const rafLoop = () => { raf++; rafId = requestAnimationFrame(rafLoop); };
  let rafId = requestAnimationFrame(rafLoop);
  const iv = setInterval(() => { timer++; }, 10);
  const startedAt = performance.now();
  const result = await window.__audio.bgmCrossfade({ audioId: o.asset, volume: .8, duration: 0.05, curve: 'linear',
    loop: { mode: 'region', start: o.loopStart, end: o.loopEnd } });
  /* 记录引擎自报的播放位置跳变（只作旁证，结论以采样为准） */
  const jumps = [];
  let last = 0;
  const poll = setInterval(() => {
    const s = window.__audio.snapshot();
    const t = s.bgm ? s.bgm.time : 0;
    if (t + .05 < last) jumps.push({ at: Math.round(performance.now() - startedAt), from: +last.toFixed(3), to: +t.toFixed(3) });
    last = t;
  }, 25);
  const el = document.querySelector('audio');
  await new Promise((r) => setTimeout(r, o.seconds * 1000));
  meter.port.postMessage('stop');
  clearInterval(iv); clearInterval(poll); cancelAnimationFrame(rafId);
  const elapsed = (performance.now() - t0) / 1000;
  window.__audio.bgmStop({ fadeOut: 0 });
  await new Promise((r) => setTimeout(r, 150));

  let total = 0; for (const c of capture) total += c.length;
  const pcm = new Float32Array(total);
  let at = 0; for (const c of capture) { pcm.set(c, at); at += c.length; }
  const rate = ctx.sampleRate;
  const threshold = 0.004;
  let runStart = -1, maxRun = 0, maxRunAt = 0, silenceTotal = 0;
  const gaps = [];
  for (let i = 0; i < pcm.length; i++) {
    const silent = Math.abs(pcm[i]) < threshold;
    if (silent) {
      if (runStart < 0) runStart = i;
      silenceTotal++;
      const run = i - runStart + 1;
      if (run > maxRun) { maxRun = run; maxRunAt = runStart; }
    } else if (runStart >= 0) {
      const ms = (i - runStart) / rate * 1000;
      if (ms >= 1.5) gaps.push(+ms.toFixed(2));
      runStart = -1;
    }
  }
  /* 周期边界统计：正弦 440Hz 时相邻样本差理论上限 ~0.058；超过 0.15 视为断裂 */
  let maxStep = 0, stepAt = 0;
  const steps = [];
  for (let i = 1; i < pcm.length; i++) {
    const d = Math.abs(pcm[i] - pcm[i - 1]);
    if (d > maxStep) { maxStep = d; stepAt = i; }
    if (d > 0.15) steps.push({ atMs: Math.round(i / rate * 1000), d: +d.toFixed(3) });
  }
  const win = Math.floor(rate * 0.5);
  const rms = [];
  for (let i = 0; i + win <= pcm.length; i += win) {
    let sum = 0; for (let k = 0; k < win; k++) sum += pcm[i + k] * pcm[i + k];
    rms.push(+Math.sqrt(sum / win).toFixed(4));
  }
  return {
    mode: (result && result.mode) || 'stream', fallback: (result && result.fallback) || '',
    asset: o.asset, seconds: o.seconds, loop: [o.loopStart, o.loopEnd],
    sampleRate: rate, samples: pcm.length,
    rafHz: +(raf / elapsed).toFixed(1), timerHz: +(timer / elapsed).toFixed(1),
    currentTimeJumps: jumps.slice(0, 10),
    silence: { maxRunMs: +(maxRun / rate * 1000).toFixed(2), atMs: Math.round(maxRunAt / rate * 1000), gapCount: gaps.length, gaps: gaps.slice(0, 12), ratio: +(silenceTotal / Math.max(1, pcm.length)).toFixed(4) },
    discontinuity: { maxStep: +maxStep.toFixed(3), atMs: Math.round(stepAt / rate * 1000), count: steps.length },
    rmsWindows: rms.slice(0, 14),
    engine: window.__audio.snapshot().mode,
    cache: window.__audio.snapshot().cache
  };
};
window.__ready = true;
log('loop bench ready · mode=' + window.__mode);
</script></body>`;
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const modes = modeArg === 'both' ? ['stream', 'precise'] : [modeArg];
  const pageFile = path.join(WORK, 'loop-page.html');
  fs.writeFileSync(pageFile, buildPage('stream'), 'utf8');

  const shell = path.join(__dirname, 'v081rc-loop-shell.cjs');

  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const code = await new Promise((resolve) => {
    const p = spawn(ELECTRON, [shell, pageFile, OUT, modes.join(',')], { cwd: ROOT, stdio: 'inherit', env });
    p.on('exit', resolve);
  });
  if (!fs.existsSync(OUT)) { console.error('没有产出报告，退出码 ' + code); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  for (const r of data.results) {
    console.log([r.mode, r.scenario].join(' / ') + '  samples ' + (r.samples || 0) + '  engine ' + (r.engine || '?') +
      '  silence ' + (r.silence ? r.silence.maxRunMs : '?') + 'ms  step ' + (r.discontinuity ? r.discontinuity.maxStep : '?') +
      '  jumps ' + ((r.currentTimeJumps || []).length) + (r.error ? '  ERR ' + r.error : ''));
  }
  console.log('→ ' + path.relative(ROOT, OUT));
})();
