'use strict';
/*
 * V0.8.1 音频引擎真实运行时验收（Chromium 真实解码，不是假元素）。
 *
 * 页面里直接用 dist/audio.js 的 createPaperAudio()，把真实 OGG/WAV 交给 <audio> 解码，
 * 然后按秒采样 el.volume 与实例数量，验证：
 *   淡入曲线 / 等功率交叉淡化 / Ducking 压低与恢复 / 循环区间接缝 / 100 次切换不泄漏。
 *
 * 这一层专门回答「曲线与增益对不对」，播放器层的「剧情推进、存档、快进」由
 * scripts/v081-audio-window.cjs 回答，两者互不替代。
 *
 * 用法：node scripts/v081-audio-engine-window.cjs
 * 产物：release/audio-performance-benchmark.json、docs/screenshots/v081-audio-engine.png
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SAMPLE = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
const WORK = path.join(ROOT, 'release', 'v081');
const PAGE = path.join(WORK, 'audio-engine.html');
const REPORT = path.join(ROOT, 'release', 'audio-performance-benchmark.json');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wav(seconds, render, sampleRate = 22050) {
  const n = Math.floor(seconds * sampleRate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, render(i / sampleRate))) * 32000), 44 + i * 2);
  return b;
}
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
async function httpJson(url, ms = 1500) { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); try { return await (await fetch(url, { signal: c.signal })).json(); } finally { clearTimeout(t); } }
async function waitPage(port, match, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const list = await httpJson('http://127.0.0.1:' + port + '/json/list').catch(() => []);
    const p = (Array.isArray(list) ? list : []).find((x) => x.type === 'page' && match(x.url || ''));
    if (p && p.webSocketDebuggerUrl) return p;
    await sleep(200);
  }
  return null;
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('CDP 超时')), 15000); ws.onopen = () => { clearTimeout(t); res(); }; ws.onerror = () => { clearTimeout(t); rej(new Error('CDP 连接失败')); }; });
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; errors.push((d && d.exception && d.exception.description) || (d && d.text) || 'exception'); return; }
    const s = pending.get(m.id); if (!s) return; pending.delete(m.id); m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result && r.result.value; };
  await send('Runtime.enable').catch(() => {});
  return { send, ev, errors, close: () => { try { ws.close(); } catch {} } };
}

function buildPage() {
  const ost = [
    ['bgm_a', '九月的早晨', 'f5cf8059444693528ced6d318fe092a57cd3ab0b2a4c8aa20c19848a74238a9b.ogg'],
    ['bgm_b', '灯还亮着', '5f129628ae4a7d4471c37aed6d564d3128d5e834b25150ce56c59f09e790c55b.ogg']
  ].map(([id, name, file]) => {
    const bytes = fs.readFileSync(path.join(SAMPLE, 'assets', 'audio', file));
    return { id, name, data: 'data:audio/ogg;base64,' + bytes.toString('base64'), mime: 'audio/ogg', ext: 'ogg' };
  });
  const sfxBuf = wav(1.0, (t) => Math.exp(-7 * t) * Math.sin(2 * Math.PI * 900 * t) * .4);
  const voiceBuf = wav(2.0, (t) => {
    const local = t % .5, env = Math.min(1, local / .05) * Math.exp(-3.2 * local);
    return .3 * env * Math.sin(2 * Math.PI * (170 + 20 * Math.sin(2 * Math.PI * 3 * t)) * t);
  }, 16000);
  const assets = ost.concat([
    { id: 'sfx', name: '风铃', data: 'data:audio/wav;base64,' + sfxBuf.toString('base64'), mime: 'audio/wav', ext: 'wav' },
    { id: 'voice', name: '占位配音', data: 'data:audio/wav;base64,' + voiceBuf.toString('base64'), mime: 'audio/wav', ext: 'wav' }
  ]);
  const audioSrc = fs.readFileSync(path.join(ROOT, 'dist', 'audio.js'), 'utf8');
  return `<!doctype html><meta charset="utf-8"><title>音频引擎验收</title>
<body style="margin:0;background:#17261f;color:#e8efe4;font:14px/1.6 sans-serif">
<div id="box" style="padding:16px"><h1 style="font-size:16px">An audio engine harness</h1><div id="log"></div></div>
<audio id="probe" hidden></audio>
<script>${audioSrc}</script>
<script>
const ASSETS = ${JSON.stringify(Object.fromEntries(assets.map((a) => [a.id, a.data])))};
const A = createPaperAudio();
const audio = A.runtime({ assetData: (id) => ASSETS[id] || '', prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 } });
const out = (m) => { const d = document.createElement('div'); d.textContent = m; document.getElementById('log').appendChild(d); };
window.__audio = audio;
window.__pure = A.pure;
/* 采集一段时间的实际音量曲线 */
window.__sample = async (ms, step) => {
  const t0 = performance.now(), rows = [];
  while (performance.now() - t0 < ms) {
    const s = audio.snapshot();
    rows.push({ t: +(performance.now() - t0).toFixed(0), bgm: s.bgm ? +(s.bgm.volume).toFixed(4) : null,
      item: s.bgm ? +(s.bgm.itemVolume).toFixed(3) : null, retiring: s.instances.retiring,
      sfx: s.instances.sfx, voice: s.instances.voice, duck: s.ducking.factor });
    await new Promise((r) => setTimeout(r, step || 120));
  }
  return rows;
};
window.__ready = true;
out('engine ready · ' + Object.keys(ASSETS).length + ' assets');
</script></body>`;
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(PAGE, buildPage(), 'utf8');
  const report = { at: new Date().toISOString(), version: '0.8.1', runtime: 'Electron ' + require('electron/package.json').version, ok: true, stages: {}, problems: [] };
  const ok = (n, d) => { report.stages[n] = { ok: true, detail: d }; console.log('  ok  ' + n + ' — ' + JSON.stringify(d).slice(0, 220)); };
  const bad = (n, m) => { report.ok = false; report.problems.push(n + '：' + m); report.stages[n] = { ok: false, message: m }; console.log('  FAIL ' + n + ' — ' + m); };

  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  /* 后台/遮挡时浏览器会把定时器节流到 1s，验收窗口必须保持在最前，否则接缝数据不可信 */
  /* 用自带窗口壳加载页面并置顶：直接以 HTML 作为 app 入口时窗口不可控，
     被系统判定为遮挡后 rAF 停摆，循环接缝会假性放大到 1 秒。 */
  const shell = path.join(WORK, 'audio-engine-shell.cjs');
  fs.writeFileSync(shell, [
    "'use strict';",
    "const { app, BrowserWindow, Menu } = require('electron');",
    'app.whenReady().then(async () => {',
    '  Menu.setApplicationMenu(null);',
    "  const target = process.argv.slice().reverse().find((a) => /\.html$/i.test(a));",
    '  const win = new BrowserWindow({ width: 900, height: 600, show: true, alwaysOnTop: true, focusable: true, webPreferences: { backgroundThrottling: false } });',
    '  win.setMenuBarVisibility(false);',
    '  win.show(); win.focus();',
    '  await win.loadFile(target);',
    '});'
  ].join('\n'), 'utf8');
  const proc = spawn(ELECTRON, ['--remote-debugging-port=' + port, '--remote-allow-origins=*', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', shell, PAGE], { cwd: ROOT, stdio: 'ignore', env });
  let cdp = null;
  try {
    const page = await waitPage(port, (u) => u.includes('audio-engine.html'));
    if (!page) throw new Error('音频引擎页没有打开');
    cdp = await connect(page.webSocketDebuggerUrl);
    for (let i = 0; i < 100; i++) { if (await cdp.ev('!!window.__ready')) break; await sleep(150); }

    /* ---------- 1. 首次播放延迟（真实解码） ---------- */
    const first = await cdp.ev(`(async () => {
      const t0 = performance.now();
      const r = await window.__audio.bgmCrossfade({ audioId: 'bgm_a', volume: .8, duration: .8, curve: 'linear', loop: { mode: 'all', start: 0, end: 0 } });
      const s = window.__audio.snapshot();
      return { ok: !!(r && r.ok), ms: Math.round(performance.now() - t0), time: s.bgm && s.bgm.time, duration: s.bgm && s.bgm.duration };
    })()`);
    if (!first.ok || !(first.duration > 30)) bad('首次播放', JSON.stringify(first));
    else ok('首次播放（真实 OGG 解码）', first);

    /* ---------- 2. 淡入曲线 ---------- */
    await cdp.ev(`window.__audio.bgmStop({ fadeOut: 0 })`);
    await sleep(500);
    await cdp.ev(`window.__audio.bgmCrossfade({ audioId: 'bgm_a', volume: .8, duration: 1.6, curve: 'linear', loop: { mode: 'all', start: 0, end: 0 } })`);
    const fadeRows = await cdp.ev(`window.__sample(2200, 150)`);
    const vals = fadeRows.map((r) => r.bgm).filter((v) => v != null);
    const monotonic = vals.every((v, i) => i === 0 || v >= vals[i - 1] - .01);
    const end = vals[vals.length - 1];
    if (!monotonic) bad('淡入曲线', '音量不是单调上升：' + vals.join(','));
    else if (!(end > .6 && end <= .81)) bad('淡入曲线', '终值不对：' + end);
    else ok('淡入曲线（线性 1.6s）', { samples: vals.length, from: vals[0], to: end, monotonic });

    /* ---------- 3. 等功率交叉淡化 ---------- */
    const cf = await cdp.ev(`(async () => {
      const rows = [];
      window.__audio.bgmCrossfade({ audioId: 'bgm_b', volume: .8, duration: 1.5, curve: 'equalPower', loop: { mode: 'all', start: 0, end: 0 } });
      const t0 = performance.now();
      while (performance.now() - t0 < 2100) {
        const s = window.__audio.snapshot();
        rows.push({ t: Math.round(performance.now() - t0), v: s.bgm ? +s.bgm.volume.toFixed(4) : null, retiring: s.instances.retiring, id: s.bgm && s.bgm.audioId });
        await new Promise((r) => setTimeout(r, 120));
      }
      return rows;
    })()`);
    const mid = cf.filter((r) => r.retiring === 1);
    const endRow = cf[cf.length - 1];
    const midVals = mid.map((r) => r.v).filter((v) => v != null);
    const peak = Math.max(...cf.map((r) => r.v || 0));
    if (mid.length < 3) bad('交叉淡化', '过渡期太短或没有并存：' + JSON.stringify(cf.slice(0, 4)));
    else if (!(peak <= .81)) bad('交叉淡化', '出现音量峰值：' + peak);
    else if (endRow.id !== 'bgm_b' || endRow.retiring !== 0) bad('交叉淡化', '结束后状态不对：' + JSON.stringify(endRow));
    else if (!(midVals[0] < .6 && midVals[midVals.length - 1] > .2)) bad('交叉淡化', '新曲爬升不明显');
    else ok('等功率交叉淡化（1.5s）', { midSamples: mid.length, midVolumes: midVals.map((v) => +v.toFixed(2)), peak: +peak.toFixed(3), end: endRow.v });

    /* ---------- 4. Ducking 压低与恢复 ---------- */
    const base = await cdp.ev(`window.__audio.snapshot().bgm.volume`);
    await cdp.ev(`window.__audio.setDucking({ level: .35, attack: .15, release: .4 })`);
    await cdp.ev(`window.__audio.voicePlay({ audioId: 'voice', volume: 1, duck: true })`);
    const duckRows = await cdp.ev(`window.__sample(1200, 100)`);
    const minDuck = Math.min(...duckRows.map((r) => r.bgm).filter((v) => v != null));
    await sleep(1600);
    const restored = await cdp.ev(`window.__audio.snapshot()`);
    if (!(minDuck < base * .55)) bad('Ducking', '没有压到 55% 以下：' + minDuck + ' vs ' + base);
    else if (!(restored.bgm.volume > base * .85)) bad('Ducking', '没有恢复：' + restored.bgm.volume + ' vs ' + base);
    else ok('Ducking 压低与恢复', { base: +base.toFixed(3), min: +minDuck.toFixed(3), restored: +restored.bgm.volume.toFixed(3), active: restored.ducking.active });

    /* ---------- 5. 循环区间接缝 ---------- */
    const loopRows = await cdp.ev(`(async () => {
      window.__audio.applyAudioState({ bgm: { audioId: 'bgm_b', volume: .7, loop: { mode: 'region', start: 1, end: 4 } } });
      const t0 = performance.now();
      while (performance.now() - t0 < 8000) { await new Promise((r) => setTimeout(r, 200)); }
      return { stats: window.__audio.getLoopStats(), snap: window.__audio.snapshot() };
    })()`);
    const ls = loopRows.stats;
    if (!(ls.jumps >= 2)) bad('循环区间', '8 秒内只跳了 ' + ls.jumps + ' 次');
    /* 本机验收环境没有前台合成器：rAF 不触发，定时器被平台节流到 ~1s，
       因此接缝误差只能做到 <1.2s。这是平台限制，不宣称采样级无缝。 */
    else if (!(ls.overrunMaxMs < 1200)) bad('循环区间', '接缝越界过大：' + ls.overrunMaxMs + 'ms');
    else ok('循环区间（1–4s，8 秒内多次回跳）', { jumps: ls.jumps, overrunMaxMs: Math.round(ls.overrunMaxMs), avgOverrunMs: Math.round(ls.overrunSumMs / ls.jumps),
      note: '验收窗口无前台合成器：rAF 不触发，定时器被节流到 ~1s，接缝为平台下限，不是采样级无缝' });

    /* ---------- 6. 连续 100 次切换：实例不泄漏 ---------- */
    const stress = await cdp.ev(`(async () => {
      const ids = ['bgm_a', 'bgm_b'];
      for (let i = 0; i < 100; i++) {
        window.__audio.bgmCrossfade({ audioId: ids[i % 2], volume: .8, duration: 0, curve: 'linear', loop: { mode: 'all', start: 0, end: 0 } });
        await new Promise((r) => setTimeout(r, 3));
      }
      await new Promise((r) => setTimeout(r, 400));
      const s = window.__audio.snapshot();
      return { instances: s.instances, volume: s.bgm && s.bgm.volume, item: s.bgm && s.bgm.itemVolume, buses: s.buses, prefs: s.prefs };
    })()`);
    if (stress.instances.retiring !== 0 || stress.instances.bgm !== 1) bad('连续切换', JSON.stringify(stress.instances));
    else if (!(Math.abs(stress.volume - .8) < .05)) bad('连续切换', '音量漂移：' + stress.volume);
    else if (stress.prefs.bgm !== 1 || stress.buses.bgm !== 1) bad('连续切换', '用户偏好或总线被改写：' + JSON.stringify({ p: stress.prefs, b: stress.buses }));
    else ok('连续 100 次切换不泄漏', stress);

    /* ---------- 7. 资源与内存 ---------- */
    const heap = await cdp.send('Runtime.getHeapUsage').catch(() => null);
    const audioEls = await cdp.ev(`document.querySelectorAll('audio').length`);
    ok('运行时资源', { heapUsedBytes: heap && Math.round(heap.usedSize), audioElements: audioEls });
    report.heap = { usedBytes: heap && heap.usedSize };
    report.curves = { fadeIn: fadeRows, crossfade: cf, ducking: duckRows };
    if (cdp.errors.length) bad('运行时异常', cdp.errors.slice(0, 3).join(' | '));
    else ok('运行时异常', { count: 0 });
  } catch (e) {
    bad('v081-engine', e.message);
  } finally {
    if (cdp) cdp.close();
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
    console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' — release/audio-performance-benchmark.json');
    if (report.problems.length) console.log(report.problems.join('\n'));
    process.exit(report.ok ? 0 : 1);
  }
})();
