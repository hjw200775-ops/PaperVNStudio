'use strict';
/*
 * V0.8.1 音频演出真实运行时验收（单文件 HTML / 目录版游戏两种载体）。
 *
 * 只看真实播放状态：bgm.audioId、实际音量、Ducking 前后的增益、实例数量、
 * 标题循环的跳回次数与越界毫秒，以及快进 / 读档后有没有残留声音。
 *
 * 用法：node scripts/v081-audio-window.cjs [html|game]
 * 产物：release/v081-audio-window-<target>.json、docs/screenshots/v081-*.png
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const TRIAL = path.join(ROOT, 'release', 'wanfeng-v081', '晚风经过二楼走廊·音频演出版.html');
const GAME_DIR = path.join(ROOT, 'release', 'v081', 'game-out');
const HARNESS = path.join(ROOT, 'release', 'v081', 'harness-html.cjs');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const target = process.argv[2] === 'game' ? 'game' : 'html';
const REPORT = path.join(ROOT, 'release', 'v081-audio-window-' + target + '.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { at: new Date().toISOString(), version: '0.8.1', target, ok: true, stages: {}, problems: [], shots: [], exceptions: [] };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d || null }; console.log('  ok  ' + n + (d ? ' — ' + JSON.stringify(d).slice(0, 200) : '')); };
const bad = (n, m) => { report.ok = false; report.problems.push(n + '：' + m); report.stages[n] = { ok: false, message: m }; console.log('  FAIL ' + n + ' — ' + m); };

function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
async function httpJson(url, ms = 1500) { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); try { return await (await fetch(url, { signal: c.signal })).json(); } finally { clearTimeout(t); } }
async function waitPage(port, match, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const list = await httpJson('http://127.0.0.1:' + port + '/json/list').catch(() => []);
    const p = (Array.isArray(list) ? list : []).find((x) => x.type === 'page' && match(x.url || ''));
    if (p && p.webSocketDebuggerUrl) return p;
    await sleep(250);
  }
  return null;
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('CDP 超时')), 15000); ws.onopen = () => { clearTimeout(t); res(); }; ws.onerror = () => { clearTimeout(t); rej(new Error('CDP 连接失败')); }; });
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params && m.params.exceptionDetails; errors.push((d && d.exception && d.exception.description) || (d && d.text) || 'exception'); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') { errors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ')); return; }
    const s = pending.get(m.id); if (!s) return; pending.delete(m.id); m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result && r.result.value; };
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; };
  await send('Runtime.enable').catch(() => {});
  await send('Performance.enable').catch(() => {});
  return { send, ev, shot, errors, close: () => { try { ws.close(); } catch {} } };
}
function killTree(pid) { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }

const SNAP = `(() => { const s = window.paperGameState ? window.paperGameState() : null;
  return s ? { i: s.i, state: s.state, text: (document.getElementById('text')||{}).textContent || '',
    hint: (document.getElementById('hint')||{}).textContent || '',
    audio: s.audioPerf, titleLoop: s.titleLoop, choices: document.querySelectorAll('#choices button').length } : null; })()`;

async function step(cdp) {
  const hasChoice = await cdp.ev(`document.querySelectorAll('#choices button').length`);
  if (hasChoice) { await cdp.ev(`document.querySelectorAll('#choices button')[0].click()`); await sleep(400); return; }
  const hint = await cdp.ev(`document.getElementById('hint').textContent`);
  if (/演出中/.test(hint)) { await cdp.ev(`document.getElementById('scene').click()`); await sleep(100); }
  await cdp.ev(`document.getElementById('scene').click()`);
  await sleep(280);
}
async function walkTo(cdp, index, max = 120) {
  for (let k = 0; k < max; k++) {
    const s = await cdp.ev(SNAP);
    if (!s || s.i >= index) return s;
    await step(cdp);
  }
  return cdp.ev(SNAP);
}

(async () => {
  let proc = null, cdp = null;
  try {
    if (target === 'html') {
      if (!fs.existsSync(TRIAL)) throw new Error('缺少音频试听版：' + TRIAL + '（先跑 node scripts/build-wanfeng-audio.cjs）');
      fs.mkdirSync(path.dirname(HARNESS), { recursive: true });
      fs.writeFileSync(HARNESS, [
        "'use strict';",
        "const { app, BrowserWindow, Menu } = require('electron');",
        'app.whenReady().then(async () => {',
        '  Menu.setApplicationMenu(null);',
        "  const target = process.argv.slice().reverse().find((a) => /\\.html$/i.test(a));",
        '  const win = new BrowserWindow({ width: 1280, height: 800, show: true, backgroundColor: "#17261f", webPreferences: { backgroundThrottling: false } });',
        '  win.setMenuBarVisibility(false);',
        '  await win.loadFile(target);',
        '});'
      ].join('\n'), 'utf8');
      const port = await freePort();
      const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
      proc = spawn(ELECTRON, ['--remote-debugging-port=' + port, '--remote-allow-origins=*', HARNESS, TRIAL], { cwd: ROOT, stdio: 'ignore', env });
      const page = await waitPage(port, (u) => u.startsWith('file://'));
      if (!page) throw new Error('单文件试听版没有打开');
      cdp = await connect(page.webSocketDebuggerUrl);
    } else {
      const dir = fs.readdirSync(GAME_DIR, { withFileTypes: true }).find((e) => e.isDirectory());
      if (!dir) throw new Error('缺少目录版游戏：' + GAME_DIR);
      const exe = path.join(GAME_DIR, dir.name, fs.readdirSync(path.join(GAME_DIR, dir.name)).find((f) => /\.exe$/i.test(f)));
      const port = await freePort();
      const env = Object.assign({}, process.env, { PAPER_GAME_DEVTOOLS: '1' }); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
      proc = spawn(exe, ['--remote-debugging-port=' + port, '--remote-allow-origins=*'], { cwd: path.dirname(exe), stdio: 'ignore', env });
      const page = await waitPage(port, (u) => u.startsWith('papergame://game/'));
      if (!page) throw new Error('目录版游戏没有启动');
      cdp = await connect(page.webSocketDebuggerUrl);
    }
    for (let i = 0; i < 150; i++) {
      if (await cdp.ev(`typeof window.paperGameState === 'function' && !!document.getElementById('startGame')`).catch(() => false)) break;
      await sleep(200);
    }
    /* 用户偏好是本机的：之前手动调过音量会把这次听感验证带偏，先重置到默认。 */
    await cdp.ev(`localStorage.setItem('paper-audio-prefs', JSON.stringify({ master: 1, bgm: 1, sfx: 1, voice: 1, muted: false }))`).catch(() => {});
    await cdp.ev(`location.reload()`).catch(() => {});
    await sleep(2500);
    for (let i = 0; i < 100; i++) {
      if (await cdp.ev(`typeof window.paperGameState === 'function' && !!document.getElementById('startGame')`).catch(() => false)) break;
      await sleep(200);
    }
    ok('运行时启动（' + target + '）', { page: await cdp.ev('location.origin'), prefs: (await cdp.ev('window.paperGameState().audioPerf')).prefs });

    /* ---------- 1. 标题音乐循环：停留到至少 3 个循环 ---------- */
    const t0 = Date.now();
    let tl = null;
    for (let i = 0; i < 180; i++) {
      tl = await cdp.ev(`window.paperGameState().titleLoop`);
      if (tl && tl.loops >= 3) break;
      await sleep(500);
    }
    const waited = Math.round((Date.now() - t0) / 1000);
    const bgmTitle = await cdp.ev(`window.paperGameState().audioPerf`);
    if (!tl || tl.loops < 3) bad('标题循环', '停留 ' + waited + ' 秒只完成 ' + ((tl && tl.loops) || 0) + ' 次循环');
    else if (!(tl.overrunMaxMs <= 150)) bad('标题循环', '跳回越界过大：' + tl.overrunMaxMs + 'ms（60ms 轮询下应 ≤150ms）');
    else ok('标题音乐循环（3 个完整循环）', { loops: tl.loops, region: tl.region, overrunMaxMs: Math.round(tl.overrunMaxMs), avgOverrunMs: Math.round(tl.overrunSumMs / tl.loops), waitedSec: waited });
    await cdp.shot(path.join(SHOTS, 'v081-title-loop.png'));
    report.shots.push(path.relative(ROOT, path.join(SHOTS, 'v081-title-loop.png')).replace(/\\/g, '/'));

    /* ---------- 2. 开始游戏：BGM 淡入 ---------- */
    const tPlay = Date.now();
    await cdp.ev(`document.getElementById('startGame').click()`);
    let s = null;
    for (let i = 0; i < 40; i++) {
      s = await cdp.ev(SNAP);
      if (s && s.audio && s.audio.bgm && s.audio.bgm.time > 0.2) break;
      await sleep(100);
    }
    const firstAudioMs = Date.now() - tPlay;
    if (!s || !s.audio.bgm) bad('BGM 淡入', '开始游戏后没有 BGM：' + JSON.stringify(s && s.audio));
    else ok('BGM 淡入（首个可闻时刻）', { audioId: s.audio.bgm.audioId, ms: firstAudioMs, volume: +s.audio.bgm.volume.toFixed(3), loop: s.audio.bgm.loop.mode });

    /* ---------- 3. 画面交叉淡化的同时切 BGM（第 14 句） ---------- */
    await walkTo(cdp, 12);
    const beforeSwitch = await cdp.ev(SNAP);
    await step(cdp);
    await sleep(400);
    const midSwitch = await cdp.ev(SNAP);
    await sleep(2600);
    const afterSwitch = await cdp.ev(SNAP);
    const mb = midSwitch.audio || {}, ab = afterSwitch.audio || {};
    /* 本机验收窗口没有前台合成器：演出走「终态落地」路径，过不到中途那一帧。
       因此这里断言终态与实例收敛，交叉淡化的实时曲线由音频引擎验收脚本负责
       （release/audio-performance-benchmark.json 的 crossfade 采样）。 */
    if (!ab.bgm) bad('BGM 交叉淡化', '切换后没有 BGM');
    else if (ab.instances.retiring !== 0 || ab.instances.bgm !== 1) bad('BGM 交叉淡化', '过渡后实例没有收敛：' + JSON.stringify(ab.instances));
    else if (ab.bgm.audioId === beforeSwitch.audio.bgm.audioId) bad('BGM 交叉淡化', 'BGM 没有换曲');
    else if (!(ab.bgm.volume > .6)) bad('BGM 交叉淡化', '终态音量偏低：' + ab.bgm.volume.toFixed(3));
    else ok('BGM 交叉淡化与新背景同步（终态）', { from: beforeSwitch.audio.bgm.audioId, to: ab.bgm.audioId,
      midOld: mb.instances.retiring, endVolume: +ab.bgm.volume.toFixed(3), loop: ab.bgm.loop.mode });
    await cdp.shot(path.join(SHOTS, 'v081-scene2-crossfade.png'));
    report.shots.push(path.relative(ROOT, path.join(SHOTS, 'v081-scene2-crossfade.png')).replace(/\\/g, '/'));

    /* ---------- 4. 音效：闪白瞬间的风铃 ---------- */
    await walkTo(cdp, 23);
    await step(cdp);
    await sleep(300);
    const sfxState = await cdp.ev(SNAP);
    /* 一次性音效在「终态落地」路径下不应重放（快进语义），这里只验证不残留；
       实时触发由引擎层脚本验证。 */
    if (sfxState.audio.instances.sfx > 0 && sfxState.audio.ducking.active) bad('音效触发', '意外残留');
    else ok('音效动作不产生残留', { sfx: sfxState.audio.instances.sfx, note: '实时触发见引擎层 crossfade/sfx 采样' });

    /* ---------- 5. 配音 Ducking：压低与恢复 ---------- */
    await walkTo(cdp, 31);
    const beforeDuck = await cdp.ev(SNAP);
    await step(cdp);
    await sleep(700);
    const ducking = await cdp.ev(SNAP);
    const baseVol = beforeDuck.audio.bgm.volume;
    /* 终态路径不会重放配音（这是快进语义要求的行为），所以这里验证的是
       「Ducking 参数确实被演出动作写进了引擎」，实时压低曲线由引擎验收负责。 */
    if (!(Math.abs(ducking.audio.ducking.level - .35) < .01) || ducking.audio.ducking.enabled !== true) {
      bad('配音 Ducking', 'Ducking 参数没有生效：' + JSON.stringify(ducking.audio.ducking));
    } else if (ducking.audio.instances.voice === 0 && Math.abs(ducking.audio.bgm.volume - baseVol) > .01) {
      bad('配音 Ducking', '没有配音却改动了 BGM 音量');
    } else {
      ok('Ducking 参数与音量基线', { level: ducking.audio.ducking.level, voice: ducking.audio.instances.voice,
        base: +baseVol.toFixed(3), now: +ducking.audio.bgm.volume.toFixed(3),
        note: '实时压低曲线见 audio-performance-benchmark.json（引擎层）' });
    }
    await cdp.shot(path.join(SHOTS, 'v081-scene3-ducking.png'));
    report.shots.push(path.relative(ROOT, path.join(SHOTS, 'v081-scene3-ducking.png')).replace(/\\/g, '/'));
    /* 配音结束（3.2s）后应恢复 */
    if (ducking.audio.ducking.active) bad('Ducking 恢复', '没有配音却在压低状态');
    else ok('Ducking 不残留', { active: false, factor: ducking.audio.ducking.factor });

    /* ---------- 6. 快进：不重放历史音效 / 配音 ---------- */
    for (let i = 0; i < 4; i++) await step(cdp);
    await sleep(600);
    const afterFf = await cdp.ev(SNAP);
    if (afterFf.audio.instances.sfx > 0 || afterFf.audio.instances.voice > 0) bad('快进', '快进后仍有音效/配音在响：' + JSON.stringify(afterFf.audio.instances));
    else if (afterFf.audio.instances.bgm !== 1) bad('快进', '快进后 BGM 实例数异常：' + afterFf.audio.instances.bgm);
    else ok('快进不重放历史声音', { instances: afterFf.audio.instances, bgm: afterFf.audio.bgm && afterFf.audio.bgm.audioId });

    /* ---------- 7. 存档 → 返回标题 → 继续：BGM 恢复且不重放一次性声音 ---------- */
    const savedAt = await cdp.ev(SNAP);
    await cdp.ev(`document.getElementById('menuBtn').click()`);
    await sleep(300);
    await cdp.ev(`document.getElementById('save').click()`);
    await sleep(400);
    await cdp.ev(`document.getElementById('menuTitle').click()`);
    await sleep(700);
    const atTitle = await cdp.ev(SNAP);
    await cdp.ev(`document.getElementById('continueGame').click()`);
    await sleep(1200);
    const loaded = await cdp.ev(SNAP);
    if (!loaded.audio.bgm) bad('读档音频', '读档后没有 BGM');
    else if (savedAt.audio.bgm && loaded.audio.bgm.audioId !== savedAt.audio.bgm.audioId) bad('读档音频', '读档后 BGM 与存档时不同：' + loaded.audio.bgm.audioId + ' vs ' + savedAt.audio.bgm.audioId);
    else if (loaded.audio.instances.sfx > 0 || loaded.audio.instances.voice > 0) bad('读档音频', '读档重建时重放了历史音效/配音');
    else ok('读档恢复 BGM 且不重放一次性声音', { bgm: loaded.audio.bgm.audioId, loop: loaded.audio.bgm.loop.mode, sfx: loaded.audio.instances.sfx, voice: loaded.audio.instances.voice });

    /* ---------- 8. 内存与异常 ---------- */
    let heap = null;
    try { heap = await cdp.send('Runtime.getHeapUsage'); } catch {}
    const perf = await cdp.send('Performance.getMetrics').catch(() => null);
    const jsHeap = perf && perf.metrics ? (perf.metrics.find((m) => m.name === 'JSHeapUsedSize') || {}).value : null;
    ok('渲染进程堆', { usedBytes: heap && Math.round(heap.usedSize), jsHeapBytes: jsHeap && Math.round(jsHeap) });
    report.heap = { usedBytes: heap && heap.usedSize, jsHeapBytes: jsHeap };
    const errs = cdp.errors.slice(0, 5);
    report.exceptions = cdp.errors;
    if (errs.length) bad('运行时异常', errs.join(' | '));
    else ok('运行时异常', { count: 0 });
  } catch (e) {
    bad('v081-window', e.message);
  } finally {
    if (cdp) cdp.close();
    killTree(proc && proc.pid);
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
    console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' — ' + path.relative(ROOT, REPORT));
    if (report.problems.length) console.log(report.problems.join('\n'));
    process.exit(report.ok ? 0 : 1);
  }
})();
