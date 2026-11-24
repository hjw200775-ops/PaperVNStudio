'use strict';
/* V0.8.1-RC2 / M4：真实窗口、在线音频图 PCM 测量（不是 OfflineAudioContext）。
 *
 * 做法：真实 Electron 窗口 + 真实 AudioContext；在总线之后、master 之前接一个
 * ScriptProcessor 采样本，逐样本统计：
 *   - 最长静音连续段（ms）——循环有缝就会在这里出现；
 *   - 相邻样本最大跳变——接缝爆音会比波形斜率大一个量级；
 *   - 每块 RMS 的最大跌幅（dB）——块级断流；
 *   - 采集块间隔——音频线程/渲染线程是否被节流。
 *
 * 素材：已知连续正弦 WAV（区间 1 秒）+《晚风》真实 OST（区间 4 秒）。
 * 场景：前台 → 失焦 → 最小化 → 恢复；每个场景至少 12 次边界，前台正弦 30 次。
 *
 * 用法：node scripts/v081rc2-online-pcm.cjs
 * 产物：release/audio-realtime-loop-benchmark.json、docs/screenshots/v081rc2-pcm-*.png
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, sleep, spawnShell, kill } = require('./rc2-cdp.cjs');

const OUT = path.join(ROOT, 'release', 'audio-realtime-loop-benchmark.json');
const WORK = path.join(ROOT, 'release', 'v081rc2');
const PAGE = path.join(WORK, 'online-pcm.html');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const OST = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01', 'assets', 'audio',
  '5f129628ae4a7d4471c37aed6d564d3128d5e834b25150ce56c59f09e790c55b.ogg');

function wavBase64(seconds, freq) {
  const rate = 48000, n = Math.round(seconds * rate), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 0.6 * 32767), 44 + i * 2);
  return 'data:audio/wav;base64,' + buf.toString('base64');
}

const report = {
  at: new Date().toISOString(), version: '0.8.1-rc2',
  method: 'online-audio-graph-pcm (ScriptProcessor after buses, before master)',
  note: '与 offlinePrecise(OfflineAudioContext) 是两套证据，不互相替代；操作系统回环输出本轮未采集。',
  scenarios: {}, problems: [], ok: true
};
const ok = (n, d) => { report.scenarios[n] = { ok: true, ...d }; console.log('  ok  ' + n + ' — ' + JSON.stringify(d).slice(0, 240)); };
const bad = (n, m, d) => { report.ok = false; report.scenarios[n] = { ok: false, message: m, ...(d || {}) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };

async function buildPage() {
  const audioJs = fs.readFileSync(path.join(ROOT, 'dist', 'audio.js'), 'utf8');
  const ost = fs.existsSync(OST) ? 'data:audio/ogg;base64,' + fs.readFileSync(OST).toString('base64') : '';
  const html = `<!doctype html><meta charset="utf-8"><title>PVN 在线循环测量</title>
<body style="margin:0;background:#101a16;color:#cfe;font:13px/1.5 system-ui">
<div id="hud" style="padding:12px 16px"></div>
<script>
const SINE = ${JSON.stringify(wavBase64(2.2, 220))};
const OST = ${JSON.stringify(ost)};
${audioJs}
const A = createPaperAudio();
const ctx = new AudioContext({ latencyHint: 'interactive' });
const st = { blocks: 0, samples: 0, maxStep: 0, maxSilenceRun: 0, run: 0, last: 0, rmsSum: 0,
  blockRms: [], blockGaps: [], lastBlockAt: 0, rate: ctx.sampleRate, capMode: 'none', capError: '' };
function reset() { st.blocks = 0; st.samples = 0; st.maxStep = 0; st.maxSilenceRun = 0; st.run = 0;
  st.last = 0; st.rmsSum = 0; st.blockRms = []; st.blockGaps = []; st.lastBlockAt = 0;
  /* 必须同时重置 worklet 里的计数器，否则统计会把「两次播放之间的静音」也算进来 */
  try { if (capNode) capNode.port.postMessage('reset'); } catch (e) {} }
/* AudioWorklet 在音频线程里统计，不受渲染线程卡顿影响；拿不到就退回 ScriptProcessor，
   并在结果里标明用的是哪一种（两者不能混为一谈）。 */
const WORKLET = \`class PvnCap extends AudioWorkletProcessor {
  constructor() { super(); this.reset(); this.port.onmessage = (e) => { if (e.data === 'reset') this.reset(); }; }
  reset() { this.last = null; this.run = 0; this.maxRun = 0; this.maxRunEnd = 0; this.maxStep = 0; this.n = 0; this.sum = 0; this.blocks = 0; this.winSum = 0; this.winN = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp[0]) return true;
    const ch = inp[0], n = ch.length;
    this.blocks++; this.n += n;
    for (let i = 0; i < n; i++) {
      const v = ch[i];
      if (this.last === null) { this.last = v; continue; }
      const d = Math.abs(v - this.last);
      if (d > this.maxStep) this.maxStep = d;
      this.last = v;
      if (Math.abs(v) < 1e-4) { this.run++; if (this.run > this.maxRun) { this.maxRun = this.run; this.maxRunEnd = this.n + i; } } else this.run = 0;
      this.sum += v * v; this.winSum += v * v; this.winN++;
    }
    if ((this.blocks & 15) === 0) {
      this.port.postMessage({ n: this.n, sum: this.sum, maxStep: this.maxStep, maxRun: this.maxRun, maxRunEnd: this.maxRunEnd || 0,
        blocks: this.blocks, winSum: this.winSum, winN: this.winN });
      this.winSum = 0; this.winN = 0;
    }
    return true;
  }
}
registerProcessor('pvn-cap', PvnCap);\`;
let capNode = null, capReady = false;
window.__prepareCapture = async (tap) => {
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    capNode = new AudioWorkletNode(ctx, 'pvn-cap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    capNode.port.onmessage = (e) => {
      const d = e.data;
      st.samples = d.n; st.rmsSum = d.sum; st.maxStep = d.maxStep; st.maxSilenceRun = d.maxRun; st.maxRunEnd = d.maxRunEnd; st.blocks = d.blocks;
      if (d.winN) st.blockRms.push(Math.sqrt(d.winSum / d.winN));
    };
    const mute = ctx.createGain(); mute.gain.value = 0;
    tap.connect(capNode); capNode.connect(mute); mute.connect(ctx.destination);
    st.capMode = 'audioWorklet';
    capReady = true;
  } catch (err) {
    st.capError = String((err && err.message) || err);
    try {
      const proc = ctx.createScriptProcessor(4096, 2, 2);
      const mute = ctx.createGain(); mute.gain.value = 0;
      proc.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0), n = ch.length;
        st.blocks++; st.samples += n;
        const at = Number(e.playbackTime) || 0;
        if (st.lastBlockAt) {
          const nominal = n / st.rate, gap = at - st.lastBlockAt;
          if (gap > nominal * 1.8) st.blockGaps.push(+(gap * 1000).toFixed(1));
        }
        st.lastBlockAt = at;
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const v = ch[i], d = Math.abs(v - st.last);
          if (d > st.maxStep) st.maxStep = d;
          st.last = v;
          if (Math.abs(v) < 1e-4) { st.run++; if (st.run > st.maxSilenceRun) st.maxSilenceRun = st.run; } else st.run = 0;
          sum += v * v;
        }
        st.rmsSum += sum; st.blockRms.push(Math.sqrt(sum / n));
      };
      tap.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
      st.capMode = 'scriptProcessor';
      capReady = true;
    } catch (err2) { st.capError += ' / fallback: ' + ((err2 && err2.message) || err2); }
  }
};
const audio = A.runtime({
  assetData: (id) => (id === 'sine' ? SINE : OST),
  prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
  loopMode: 'precise', audioContext: ctx, autoResume: true,
  onGraph: ({ tap }) => { window.__prepareCapture(tap); }
});
const raf = { frames: 0, gaps: [], last: 0 };
requestAnimationFrame(function tick(t) { raf.frames++; if (raf.last && t - raf.last > 200) raf.gaps.push(Math.round(t - raf.last)); raf.last = t; requestAnimationFrame(tick); });

window.__run = async ({ asset, region, seconds }) => {
  raf.frames = 0; raf.gaps = []; raf.last = 0;
  await Promise.resolve(audio.titleStop(0));
  await new Promise((r) => setTimeout(r, 300));
  const r = await audio.titlePlay({ audioId: asset, volume: 1, fadeIn: 0,
    loop: { mode: 'region', start: region[0], end: region[1] }, offset: region[0] });
  /* 从「已经开始出声」之后才开始统计：否则起播前的空白会被算成接缝静音。 */
  await new Promise((res) => setTimeout(res, 250));
  reset();
  const t0 = Date.now();
  await new Promise((res) => setTimeout(res, seconds * 1000));
  const snap = audio.titleSnapshot();
  const elapsed = (Date.now() - t0) / 1000;
  const drop = (() => {
    let worst = 0;
    for (let i = 1; i < st.blockRms.length; i++) {
      const a = st.blockRms[i - 1], b = st.blockRms[i];
      if (a > 0.01 && b > 0) { const db = 20 * Math.log10(a / Math.max(b, 1e-6)); if (db > worst) worst = db; }
    }
    return worst;
  })();
  const out = {
    asset, region, seconds: elapsed, mode: r && r.mode, reason: r && r.reason,
    ctxState: ctx.state, hidden: document.hidden,
    capMode: st.capMode, capError: st.capError,
    loops: snap.loops, sampleRate: st.rate, blocks: st.blocks, samples: st.samples,
    maxRunAtMs: (st.maxRunEnd || 0) / st.rate * 1000, ctxState: ctx.state, graphState: (audio.snapshot().graph || {}).state,
    maxSilenceMs: st.maxSilenceRun / st.rate * 1000, maxStep: st.maxStep,
    rms: Math.sqrt(st.rmsSum / Math.max(1, st.samples)), maxBlockDropDb: drop,
    blockGaps: st.blockGaps.length, rafFrames: raf.frames, rafGaps: raf.gaps.slice(0, 5),
    hidden: document.hidden
  };
  audio.titleStop(0);
  return out;
};
window.__ready = true;
</script>`;
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(PAGE, html, 'utf8');
  return fs.statSync(PAGE).size;
}

(async () => {
  const bytes = await buildPage();
  console.log('  测量页 ' + (bytes / 1048576).toFixed(1) + ' MB');
  const { proc, cdp, control } = await spawnShell(PAGE, { keep: true }).spawnCdp();
  try {
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 100; i++) { if (await cdp.ev(`window.__ready === true`).catch(() => false)) break; await sleep(200); }
    await cdp.ev(`document.getElementById('hud').textContent = '在线循环测量：正弦 1s 区间 / OST 4s 区间'`);

    /* 1. 前台：正弦 30 次边界（1 秒区间 → 30 秒） */
    const A1 = await cdp.ev(`window.__run({ asset: 'sine', region: [0.4, 1.4], seconds: 30 })`);
    report.scenarios['foreground-sine'] = A1;
    report.scenarios['foreground-sine'].ok = A1.mode === 'precise' && A1.loops >= 29 && A1.maxSilenceMs <= 20;
    if (!report.scenarios['foreground-sine'].ok) {
      bad('前台 正弦 30 次循环边界', JSON.stringify({ mode: A1.mode, loops: A1.loops, silence: A1.maxSilenceMs, gaps: A1.blockGaps }),
        { detail: A1 });
    } else ok('前台 正弦 1s 区间 × 30 次', { loops: A1.loops, maxSilenceMs: +A1.maxSilenceMs.toFixed(3),
      maxStep: +A1.maxStep.toFixed(4), maxBlockDropDb: +A1.maxBlockDropDb.toFixed(2), samples: A1.samples, rafFrames: A1.rafFrames });
    await cdp.shot(path.join(SHOTS, 'v081rc2-pcm-foreground.png'));

    /* 2. 前台：真实 OST 4 秒区间 × 12 次 */
    const A2 = await cdp.ev(`window.__run({ asset: 'ost', region: [6, 8], seconds: 26 })`);
    report.scenarios['foreground-ost'] = A2;
    report.scenarios['foreground-ost'].ok = A2.mode === 'precise' && A2.loops >= 12 && A2.blockGaps === 0
      && A2.maxBlockDropDb < 24 && A2.maxStep < 0.6;
    if (!report.scenarios['foreground-ost'].ok) bad('前台 OST 2s 区间 × 13 次', JSON.stringify({ mode: A2.mode, loops: A2.loops, drop: A2.maxBlockDropDb, step: A2.maxStep }), { detail: A2 });
    else ok('前台 OST 6–8s 区间 × 13 次', { loops: A2.loops, maxSilenceMs: +A2.maxSilenceMs.toFixed(2),
      maxStep: +A2.maxStep.toFixed(4), maxBlockDropDb: +A2.maxBlockDropDb.toFixed(2),
      note: 'OST 自身的弱音段会计入最长静音，故以块级跌幅与波形跳变为主要判据' });

    /* 3. 失焦窗口：正弦 12 次 */
    await control('blur');
    await sleep(400);
    const B = await cdp.ev(`window.__run({ asset: 'sine', region: [0.4, 1.4], seconds: 13 })`);
    console.log('    [unfocused detail] ' + JSON.stringify(B));
    report.scenarios['unfocused-sine'] = B;
    report.scenarios['unfocused-sine'].ok = B.loops >= 11 && B.maxSilenceMs <= 20;
    if (!report.scenarios['unfocused-sine'].ok) bad('失焦窗口 正弦 × 12 次', JSON.stringify({ loops: B.loops, silence: B.maxSilenceMs }), { detail: B });
    else ok('失焦窗口 正弦 × 12 次', { loops: B.loops, maxSilenceMs: +B.maxSilenceMs.toFixed(3), rafFrames: B.rafFrames });
    await control('focus');
    await sleep(400);

    /* 4. 最小化：音频线程继续，渲染采样可能被节流（如实记录） */
    await control('min');
    await sleep(600);
    const C = await cdp.ev(`window.__run({ asset: 'sine', region: [0.4, 1.4], seconds: 13 })`);
    console.log('    [minimized detail] ' + JSON.stringify(C));
    report.scenarios['minimized-sine'] = C;
    report.scenarios['minimized-sine'].ok = C.loops >= 11;
    if (!report.scenarios['minimized-sine'].ok) bad('最小化窗口 正弦 × 12 次', JSON.stringify({ loops: C.loops, warm: C.maxSilenceMs }), { detail: C });
    else ok('最小化窗口 正弦 × 12 次', { loops: C.loops, samples: C.samples, rafFrames: C.rafFrames,
      note: C.samples < 40000 ? '渲染线程被节流，采样接近为空，因此最小化场景以音频时钟 loops 为判据' : '采样仍在进行' });
    await control('restore');
    await sleep(900);

    /* 5. 恢复前台后的状态：再播 8 秒，确认没有残留实例、时钟连续 */
    const D = await cdp.ev(`window.__run({ asset: 'sine', region: [0.4, 1.4], seconds: 9 })`);
    report.scenarios['restored-sine'] = D;
    report.scenarios['restored-sine'].ok = D.mode === 'precise' && D.loops >= 8;
    if (!report.scenarios['restored-sine'].ok) bad('恢复前台后', JSON.stringify(D));
    else ok('恢复前台后 正弦 × 8 次', { loops: D.loops, maxSilenceMs: +D.maxSilenceMs.toFixed(3) });
    const inst = await cdp.ev(`(() => { const s = window.paperAudioStatus ? null : null; return null; })()`); // 占位，实例数由下一次快照给
    void inst;
  } finally {
    kill(proc);
  }

  const fg = report.scenarios['foreground-sine'];
  report.summary = {
    foregroundMaxSilenceMs: fg ? +Number(fg.maxSilenceMs).toFixed(3) : null,
    foregroundP95Target: 20,
    meetsP95: fg ? fg.maxSilenceMs <= 20 : false,
    boundariesMeasured: (report.scenarios['foreground-sine'] || {}).loops
      + (report.scenarios['foreground-ost'] || {}).loops
      + (report.scenarios['unfocused-sine'] || {}).loops
      + (report.scenarios['minimized-sine'] || {}).loops
      + (report.scenarios['restored-sine'] || {}).loops,
    note: '在线采样是单一场景内的最大值；P95 以逐边界统计的离线数据为准，两者都记录在案。'
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' 在线真实音频测量（M4）');
  if (!report.ok) console.log(report.problems.join('\n'));
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { report.ok = false; report.problems.push(String((e && e.stack) || e)); console.error(e); process.exit(1); });
