'use strict';
/*
 * V0.8.1-RC3 · 音乐循环素材分析（M1/M2）
 *
 * 用真实 Chromium 解码 OST 到 PCM，做「有音乐依据」的分析，而不是只看波形零交叉：
 *   - 每 10ms RMS 能量包络（响度轮廓）
 *   - 起始点强度包络（onset envelope，用于找节拍/乐句边界）
 *   - 节拍网格（自相关 + 峰值间距）
 *   - 低能量/静音段（乐句间隙、呼吸点）
 *   - 自相似度（找整曲循环的尾→头衔接自然度）
 * 输出 release/audio-loop-audit.json，供试听页与报告消费。
 *
 * 用法：node scripts/v081rc3-audio-analysis.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = path.join(ROOT, 'release', 'v081rc3');
const OUT = path.join(ROOT, 'release', 'audio-loop-audit.json');

const AUDIO_DIR = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01', 'assets', 'audio');
const FILES = {
  title: '2217366c9255ecbddcbbf811f23c79e8fd5a15bb24e2cb530789aaaf9563e7ae.ogg', // 晚风经过二楼走廊 37.794s
  morning: 'f5cf8059444693528ced6d318fe092a57cd3ab0b2a4c8aa20c19848a74238a9b.ogg', // 九月的早晨 41.4s
  school_road: 'c7427899ec2e27fb2413b97dff938988a459fa971fddf8cb93abe3587a0b3092.ogg', // 桂花香的小路 39.942s
  playful: 'de47a782a9b1cf14f3d3eddb422b1b482dce3e9b18a08acc15cd1c67f8c6bfd6.ogg', // 才没有在等你 39.052s
  after_school: '5adba3a346e519d3e293d7f53bb43f50b81fca053618c28aaf8c8745e8507123.ogg', // 放学后的走廊 36.068s
  night: '5f129628ae4a7d4471c37aed6d564d3128d5e834b25150ce56c59f09e790c55b.ogg' // 灯还亮着 38.059s
};

function buildPage() {
  const assets = {};
  for (const [k, f] of Object.entries(FILES)) {
    assets[k] = 'data:audio/ogg;base64,' + fs.readFileSync(path.join(AUDIO_DIR, f)).toString('base64');
  }
  return `<!doctype html><meta charset="utf-8"><title>audio analysis</title>
<body style="margin:0"><div id="log"></div>
<script>
const ASSETS = ${JSON.stringify(assets)};
const log = (m) => { const d = document.createElement('div'); d.textContent = m; document.getElementById('log').appendChild(d); };

/* —— 简单但可靠的分析（不依赖 FFT 库）——
 * 1. RMS 包络：10ms 窗，反映响度轮廓。
 * 2. onset 包络：对能量差分做半波整流 + 平滑，反映「新音符/重音」出现的位置。
 * 3. 节拍：onset 包络的自相关，找主周期。
 * 4. 乐句间隙：RMS 持续低于阈值的时间段。
 * 5. 自相似：把开头 0.5s 与全曲做滑动相关，找「尾接首」的自然循环点。 */

function rmsEnvelope(ch, rate, hopSec) {
  const hop = Math.round(rate * hopSec);
  const win = hop;
  const out = [];
  for (let s = 0; s + win <= ch.length; s += hop) {
    let sum = 0;
    for (let i = s; i < s + win; i++) { const v = ch[i]; sum += v * v; }
    out.push(Math.sqrt(sum / win));
  }
  return { hopSec, values: out };
}
function onsetEnvelope(rms) {
  const out = new Array(rms.values.length).fill(0);
  for (let i = 1; i < rms.values.length; i++) {
    const d = rms.values[i] - rms.values[i - 1];
    out[i] = d > 0 ? d : 0;
  }
  // 平滑（3 点均值）
  const sm = new Array(out.length).fill(0);
  for (let i = 1; i < out.length - 1; i++) sm[i] = (out[i - 1] + out[i] + out[i + 1]) / 3;
  return sm;
}
function autocorrPeaks(env, minSec, maxSec, hopSec) {
  const minLag = Math.round(minSec / hopSec), maxLag = Math.round(maxSec / hopSec);
  const n = env.length;
  let best = 0, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < n - lag; i++) corr += env[i] * env[i + lag];
    if (corr > best) { best = corr; bestLag = lag; }
  }
  return { lagSec: +(bestLag * hopSec).toFixed(3), strength: best };
}
function lowEnergySegments(rms, thrRatio, minSec, hopSec) {
  const vals = rms.values;
  let peak = 0; for (const v of vals) peak = Math.max(peak, v);
  const thr = peak * thrRatio;
  const minHop = Math.round(minSec / hopSec);
  const segs = [];
  let start = -1;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] < thr) { if (start < 0) start = i; }
    else if (start >= 0) { if (i - start >= minHop) segs.push([+(start * hopSec).toFixed(3), +(i * hopSec).toFixed(3), +(i - start) * hopSec]); start = -1; }
  }
  if (start >= 0 && vals.length - start >= minHop) segs.push([+(start * hopSec).toFixed(3), +(vals.length * hopSec).toFixed(3), +(vals.length - start) * hopSec]);
  return segs;
}
function onsetPeaks(onset, hopSec, minSec, topN) {
  const minHop = Math.round(minSec / hopSec);
  const peaks = [];
  let last = -1e9;
  for (let i = 1; i < onset.length - 1; i++) {
    if (onset[i] > onset[i - 1] && onset[i] >= onset[i + 1]) {
      if (i - last >= minHop) { peaks.push({ atSec: +(i * hopSec).toFixed(3), v: onset[i] }); last = i; }
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  return peaks.slice(0, topN).sort((a, b) => a.atSec - b.atSec);
}
/* 尾→头衔接自相似：把末段与全曲滑动相关，返回相关性最高的几处偏移。
   用于回答「整曲循环的结尾接到开头是否自然」。 */
function tailHeadCorrelation(ch, rate, tailSec) {
  const tail = Math.round(rate * tailSec);
  const head = tail;
  if (ch.length < tail + head) return { corr: 0, note: 'too-short' };
  const tailStart = ch.length - tail;
  let sum = 0, n = 0;
  for (let i = 0; i < tail; i++) { sum += ch[tailStart + i] * ch[i]; n++; }
  // 归一化（相对各自能量）
  let e1 = 0, e2 = 0;
  for (let i = 0; i < tail; i++) { e1 += ch[tailStart + i] * ch[tailStart + i]; e2 += ch[i] * ch[i]; }
  const corr = n && e1 > 0 && e2 > 0 ? sum / Math.sqrt(e1 * e2) : 0;
  return { corr: +corr.toFixed(4), tailSec, tailStartSec: +((ch.length - tail) / rate).toFixed(3) };
}
/* 找「能量/音色轮廓最接近」的候选循环段：
   对每一对 (start, end)，比较 start 前 0.5s 与 end 前 0.5s 的 RMS 轮廓相似度，
   高分说明 loopStart 与 loopEnd 的「进入感」一致，回跳更自然。 */
function loopCandidates(rms, hopSec, minSpan, maxSpan, topN) {
  const vals = rms.values;
  const win = Math.round(0.5 / hopSec);
  const cands = [];
  for (let s = win + 1; s < vals.length - win; s += 1) {
    const spanMin = Math.round(minSpan / hopSec), spanMax = Math.round(maxSpan / hopSec);
    for (let e = s + spanMin; e <= Math.min(vals.length - 1, s + spanMax); e += 4) {
      // start 前 0.5s 与 end 前 0.5s 的轮廓相关
      let num = 0, d1 = 0, d2 = 0;
      for (let k = 0; k < win; k++) {
        const a = vals[s - win + k], b = vals[e - win + k];
        num += a * b; d1 += a * a; d2 += b * b;
      }
      const corr = d1 > 0 && d2 > 0 ? num / Math.sqrt(d1 * d2) : 0;
      const span = (e - s) * hopSec;
      cands.push({ start: +(s * hopSec).toFixed(3), end: +(e * hopSec).toFixed(3), span: +span.toFixed(3), corr: +corr.toFixed(4) });
    }
  }
  cands.sort((a, b) => b.corr - a.corr);
  return cands.slice(0, topN);
}

window.__analyze = async () => {
  const out = {};
  const ctx = new AudioContext();
  for (const [key, src] of Object.entries(ASSETS)) {
    try {
      const buf = await ctx.decodeAudioData((await (await fetch(src)).arrayBuffer()).slice(0));
      const ch = buf.getChannelData(0);
      const rate = buf.sampleRate;
      const dur = buf.duration;
      const hopSec = 0.01;
      const rms = rmsEnvelope(ch, rate, hopSec);
      const onset = onsetEnvelope(rms);
      const tempo = autocorrPeaks(onset, 0.3, 1.5, hopSec);
      const low = lowEnergySegments(rms, 0.12, 0.25, hopSec);
      const peaks = onsetPeaks(onset, hopSec, 0.25, 24);
      const tail = tailHeadCorrelation(ch, rate, 1.0);
      const cands = loopCandidates(rms, hopSec, 4, 24, 12);
      // 峰值摘要（用于试听页画波形，降采样到 ~200 点）
      const summary = [];
      const step = Math.max(1, Math.floor(rms.values.length / 240));
      for (let i = 0; i < rms.values.length; i += step) summary.push(+rms.values[i].toFixed(5));
      out[key] = { duration: +dur.toFixed(3), sampleRate: rate, channels: buf.numberOfChannels,
        tempo: tempo.lagSec, lowEnergy: low, onsetPeaks: peaks, tailHead: tail, loopCandidates: cands, waveform: summary };
      log(key + '  done  dur=' + dur.toFixed(2) + 's  tempo≈' + tempo.lagSec + 's  tailHeadCorr=' + tail.corr);
    } catch (e) { out[key] = { error: String(e && e.message || e) }; log(key + '  ERROR ' + out[key].error); }
  }
  return out;
};
window.__ready = true;
</script></body>`;
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const page = path.join(WORK, 'analysis.html');
  fs.writeFileSync(page, buildPage(), 'utf8');
  const shell = path.join(WORK, 'analysis-shell.cjs');
  fs.writeFileSync(shell, [
    "'use strict';",
    "const { app, BrowserWindow } = require('electron');",
    "const fs = require('node:fs');",
    "app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');",
    'app.whenReady().then(async () => {',
    '  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });',
    '  await win.loadFile(process.argv[2]);',
    '  for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript("!!window.__ready").catch(() => false)) break; await new Promise((r) => setTimeout(r, 100)); }',
    '  const result = await win.webContents.executeJavaScript("window.__analyze()", true);',
    '  fs.writeFileSync(process.argv[3], JSON.stringify({ at: new Date().toISOString(), assets: result }, null, 2), "utf8");',
    '  app.exit(0);',
    '});'
  ].join('\n'), 'utf8');

  const tmp = path.join(WORK, 'analysis-result.json');
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  await new Promise((resolve) => {
    const p = spawn(ELECTRON, [shell, page, tmp], { cwd: ROOT, stdio: 'inherit', env });
    p.on('exit', resolve);
  });
  if (!fs.existsSync(tmp)) { console.error('分析没有产出结果'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8');
  const t = data.assets && data.assets.title;
  console.log('分析完成 → release/audio-loop-audit.json');
  if (t) {
    console.log('标题曲 时长=' + t.duration + 's  tempo≈' + t.tempo + 's  tailHeadCorr=' + (t.tailHead && t.tailHead.corr));
    console.log('低能量段：' + JSON.stringify(t.lowEnergy));
    console.log('候选循环段 top：' + JSON.stringify((t.loopCandidates || []).slice(0, 6)));
  }
  process.exit(0);
})();
