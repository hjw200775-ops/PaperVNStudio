'use strict';
/*
 * V0.8.0 · 大型工程（1 GiB+）演出性能回归。
 *
 * 目的：确认 V0.8 的舞台演出没有把 V0.7.6-M3 的流式素材体系拖慢。
 * 口径与 V0.7.6 一致，便于横向比较：
 *   主进程 = ProcessMetric.type === 'browser'，渲染进程 = 'tab'，单位 KB → 字节；
 *   打开耗时 = 进程启动 → 工程节点渲染完成；
 *   FPS = 页面 rAF 计数 / 真实经过时间，最差帧 = 相邻两帧最大间隔。
 *
 * 用目录联接（junction）把 1 GiB 素材挂进 release/bench-project：
 * 只写一份 project.paper.json，既不复制 1.5 GB，也不改原工程。
 *
 * 用法：node scripts/performance-benchmark.cjs [工程目录]
 * 产物：release/performance-benchmark.json
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SRC = path.resolve(process.argv[2] || process.env.PVN_LARGE || 'F:/pvn-1gib-m3');
const OUT = path.join(ROOT, 'release', 'performance-benchmark.json');
const BENCH = path.join(ROOT, 'release', 'bench-project');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
  at: new Date().toISOString(), version: '0.8.0', machine: { platform: process.platform, arch: process.arch, cpus: require('node:os').cpus().length, totalMemBytes: require('node:os').totalmem() },
  source: SRC, ok: true, stages: {}, problems: []
};
const bad = (m) => { report.ok = false; report.problems.push(m); console.log('  FAIL ' + m); };
const ok = (m, d) => { console.log('  ok  ' + m); report.stages[m] = Object.assign({ ok: true }, d || {}); };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function httpJson(url, ms = 1500) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await (await fetch(url, { signal: ctl.signal })).json(); } finally { clearTimeout(t); }
}
async function waitPage(port, match, timeout = 120000) {
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
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } const s = pending.get(m.id); if (!s) return; pending.delete(m.id); m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result && r.result.value; };
  return { send, ev, close: () => { try { ws.close(); } catch {} } };
}
function dirSize(dir) {
  let total = 0, files = 0;
  const walk = (d) => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { try { total += fs.statSync(f).size; files++; } catch {} }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

/* ---------- 基准工程：JSON 用副本，素材用硬链接 ----------
 * 不能用目录联接（junction）：工程仓库有「指向目录外的链接一律拒绝」的安全校验，
 * 而硬链接是同一卷上的独立目录项，realpath 仍在工程内，不会削弱那条校验。
 * 硬链接不复制字节，1.5 GB 素材准备时间在秒级。 */
function prepareBenchProject() {
  const json = path.join(SRC, 'project.paper.json');
  if (!fs.existsSync(json)) throw new Error('找不到大型工程：' + json);
  const srcAssets = path.join(SRC, 'assets');
  if (!fs.existsSync(srcAssets)) throw new Error('大型工程缺少 assets 目录：' + srcAssets);
  fs.mkdirSync(BENCH, { recursive: true });
  fs.copyFileSync(json, path.join(BENCH, 'project.paper.json'));
  let linked = 0, copied = 0;
  for (const kind of ['images', 'audio']) {
    const from = path.join(srcAssets, kind);
    if (!fs.existsSync(from)) continue;
    const to = path.join(BENCH, 'assets', kind);
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const src = path.join(from, name), dst = path.join(to, name);
      try { fs.lstatSync(dst); continue; } catch {}
      try { fs.linkSync(src, dst); linked++; }
      catch { fs.copyFileSync(src, dst); copied++; }
    }
  }
  fs.mkdirSync(path.join(BENCH, 'backups'), { recursive: true });
  /* 清掉上一次自动保存的草稿：否则编辑器会提示「已恢复未保存修改」，
     把上一轮加过的演出动作带进来，导致这次又叠加一遍。 */
  const autosave = path.join(BENCH, 'backups', 'autosave');
  if (fs.existsSync(autosave)) fs.rmSync(autosave, { recursive: true, force: true });
  report.benchProject = { dir: path.relative(ROOT, BENCH).replace(/\\/g, '/'), linkedFiles: linked, copiedFiles: copied };
  return JSON.parse(fs.readFileSync(json, 'utf8'));
}

const MEMMAP = `(async () => {
  if (!window.PaperHost || !window.PaperHost.metrics) return null;
  const m = await window.PaperHost.metrics();
  return m && m.metrics ? m.metrics.map(x => ({ type: x.type, ws: x.workingSetSize, peak: x.peakWorkingSetSize })) : null;
})()`;
const KB = 1024;

(async () => {
  console.log('[1/5] 准备基准工程（junction 挂载素材）');
  const proj = prepareBenchProject();
  const size = dirSize(SRC);
  report.project = { nodes: proj.nodes.length, assets: proj.assets.length, chapters: (proj.chapters || []).length, bytes: size.bytes, files: size.files };
  ok('基准工程', { nodes: proj.nodes.length, assets: proj.assets.length, gb: +(size.bytes / 1073741824).toFixed(2) });

  const work = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pvn-bench-'));
  const userData = path.join(work, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: BENCH, items: [{ path: BENCH, title: proj.title || '基准工程', openedAt: new Date().toISOString() }]
  }));

  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now();
  const proc = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData], { cwd: ROOT, stdio: 'ignore', env });
  let editor = null;
  const samples = [];
  let sampling = true;
  let currentStage = '启动';
  const sampleOnce = async (stage) => {
    try {
      const list = await editor.ev(MEMMAP);
      if (!Array.isArray(list) || !list.length) return null;
      const main = list.filter((x) => x.type === 'browser').reduce((s, x) => s + x.ws, 0) * KB;
      const renderer = list.filter((x) => x.type === 'tab').reduce((s, x) => s + x.ws, 0) * KB;
      const total = list.reduce((s, x) => s + x.ws, 0) * KB;
      const rec = { at: Date.now(), stage, main, renderer, total, processes: list.length };
      samples.push(rec);
      return rec;
    } catch { return null; }
  };
  const timer = setInterval(() => { if (sampling && editor) sampleOnce(currentStage); }, 250);
  timer.unref();

  try {
    const page = await waitPage(port, (u) => u.startsWith('paper://app/'));
    if (!page) throw new Error('编辑器窗口未出现');
    editor = await connect(page.webSocketDebuggerUrl);
    let opened = false, ready = null;
    for (let i = 0; i < 800; i++) {
      /* 用运行时指标判定「打开完成」：节点列表是虚拟滚动的，DOM 里的行数不等于工程节点数。 */
      ready = await editor.ev(`(() => { const M = window.__pvnM3; return M ? M.metrics() : null; })()`).catch(() => null);
      if (ready && ready.assets >= proj.assets.length && ready.nodes >= proj.nodes.length) { opened = true; break; }
      await sleep(150);
    }
    const openMs = Date.now() - t0;
    if (!opened) throw new Error('工程没有在 120 秒内打开完成：' + JSON.stringify(ready));
    await sleep(1200);
    report.openMs = openMs;
    ok('打开工程', { ms: openMs, nodes: ready.nodes, assets: ready.assets });

    /* FPS 采样器：记录帧数与最差帧间隔 */
    const startFps = () => editor.ev(`(() => { window.__fps = { n: 0, worst: 0, last: performance.now() };
      window.__fps.loop = () => { const now = performance.now(); const dt = now - window.__fps.last; window.__fps.last = now;
        if (dt > window.__fps.worst) window.__fps.worst = dt; window.__fps.n++; window.__fps.raf = requestAnimationFrame(window.__fps.loop); };
      window.__fps.raf = requestAnimationFrame(window.__fps.loop); return true; })()`);
    const stopFps = () => editor.ev(`(() => { const f = window.__fps || { n: 0, worst: 0 }; if (f.raf) cancelAnimationFrame(f.raf);
      return { frames: f.n, worstMs: Math.round(f.worst) }; })()`);

    /* 1) 空白待机内存 */
    currentStage = '待机';
    await sampleOnce('待机');
    await sleep(1500);
    ok('待机内存', { snapshot: samples[samples.length - 1] });

    /* 2) 试玩并播放演出：给当前句加 3 个动作，再从头试玩 */
    currentStage = '播放演出';
    await editor.ev(`window.__pvnM3.select(p.nodes[0].id)`);
    await sleep(300);
    for (const preset of ['charEnterFade', 'sceneFade', 'softShake']) {
      const hit = await editor.ev(`(() => { const b = document.querySelector('#perfPresets [data-perf-preset="${preset}"]'); if (!b) return false; b.click(); return true; })()`);
      if (!hit) console.log('    （预设按钮缺失：' + preset + '）');
      await sleep(200);
    }
    const perfCount = await editor.ev(`window.__pvnM3.perfCount()`);
    await startFps();
    const tPlay = Date.now();
    await editor.ev(`window.__pvnM3.play()`);
    await sleep(2500);
    /* 推进两句，让演出跨句继续跑 */
    for (let i = 0; i < 3; i++) { await editor.ev(`window.__pvnM3.advance()`); await sleep(900); }
    const fps = await stopFps();
    const playPeak = samples.filter((s) => s.stage === '播放演出').reduce((m, s) => Math.max(m, s.total), 0);
    const playElapsed = Date.now() - tPlay;
    ok('播放演出', { actions: perfCount, frames: fps.frames, elapsedMs: playElapsed, fps: +(fps.frames / (playElapsed / 1000)).toFixed(1), worstFrameMs: fps.worstMs, peakTotalBytes: playPeak });

    /* 3) 切章：跳到最后一章并渲染 */
    currentStage = '切章';
    const chapterInfo = await editor.ev(`(() => { const cs = [...document.querySelectorAll('[data-chapter]')]; return { count: cs.length }; })()`);
    const tCh = Date.now();
    const chapterHit = await editor.ev(`(() => { const cs = [...document.querySelectorAll('[data-chapter]')]; if (cs.length < 2) return false;
      cs[cs.length - 1].click(); return true; })()`);
    await sleep(1200);
    const chapterMs = Date.now() - tCh;
    const afterChapter = await sampleOnce('切章');
    ok('切章', { chapters: chapterInfo.count, clicked: chapterHit, ms: chapterMs, snapshot: afterChapter });

    /* 4) 跳过演出（连续点击 5 次，每次都要求立即结算） */
    currentStage = '跳过演出';
    await editor.ev(`window.__pvnM3.stop()`);
    await sleep(400);
    await editor.ev(`window.__pvnM3.play()`);
    await sleep(500);
    const tSkip = Date.now();
    for (let i = 0; i < 5; i++) { await editor.ev(`window.__pvnM3.advance()`); await sleep(120); }
    ok('跳过演出', { ms: Date.now() - tSkip, snapshot: await sampleOnce('跳过演出') });

    /* 5) 连续播放：来回切 10 句，观察内存是否单调上升 */
    currentStage = '连续播放';
    const before = await sampleOnce('连续播放');
    for (let i = 0; i < 10; i++) { await editor.ev(`window.__pvnM3.advance()`); await sleep(260); }
    const after = await sampleOnce('连续播放');
    await editor.ev(`window.__pvnM3.stop()`);
    ok('连续播放', { beforeTotal: before && before.total, afterTotal: after && after.total, deltaBytes: (before && after) ? after.total - before.total : null });

    /* 6) GC 后回落：强制回收，确认演出运行时不持有大对象 */
    currentStage = 'GC 回落';
    try { await editor.send('HeapProfiler.enable'); await editor.send('HeapProfiler.collectGarbage'); } catch {}
    await sleep(1200);
    const gc = await sampleOnce('GC 回落');
    ok('GC 回落', { snapshot: gc });
  } catch (e) {
    bad(e.message);
  } finally {
    sampling = false;
    clearInterval(timer);
    if (editor) editor.close();
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}

    /* 汇总 */
    const byStage = {};
    for (const s of samples) {
      const b = byStage[s.stage] || (byStage[s.stage] = { count: 0, mainPeak: 0, rendererPeak: 0, totalPeak: 0, totalMin: Infinity });
      b.count++;
      b.mainPeak = Math.max(b.mainPeak, s.main);
      b.rendererPeak = Math.max(b.rendererPeak, s.renderer);
      b.totalPeak = Math.max(b.totalPeak, s.total);
      b.totalMin = Math.min(b.totalMin, s.total);
    }
    for (const b of Object.values(byStage)) if (!Number.isFinite(b.totalMin)) b.totalMin = null;
    report.memory = { stages: byStage, samples: samples.length };
    report.baseline = (() => {
      try {
        const prev = JSON.parse(fs.readFileSync(path.join(ROOT, 'release', 'memory-profile.json'), 'utf8'));
        const m = prev.measured || {};
        return {
          source: 'release/memory-profile.json', version: prev.version || 'V0.7.6-M3',
          mainPeakBytes: m.mainPeakBytes || null, rendererPeakBytes: m.rendererPeakBytes || null,
          totalPeakBytes: m.allElectronProcessesPeakBytes || null
        };
      } catch { return null; }
    })();
    const peakTotal = samples.reduce((m, s) => Math.max(m, s.total), 0);
    report.peakTotalBytes = peakTotal;
    report.verdict = (() => {
      const base = report.baseline && report.baseline.totalPeakBytes;
      if (!base) return { compared: false, note: '没有 V0.7.6 基线数值，只记录本次实测' };
      const ratio = peakTotal / base;
      return {
        compared: true, baselineBytes: base, ratio: +ratio.toFixed(3),
        deltaPercent: +((ratio - 1) * 100).toFixed(1), worse: ratio > 1.15,
        note: 'V0.7.6 基线包含 1.5 GB 素材导入阶段（全流程最重），本次只覆盖打开/演出/切章/跳过/连续播放，口径不同，差值不代表优化或退化；判定只看是否出现数量级退化。'
      };
    })();
    if (report.verdict.compared && report.verdict.worse) bad('内存峰值比 V0.7.6 高出 ' + report.verdict.deltaPercent + '%，需要先优化');
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' — 报告：release/performance-benchmark.json');
    if (report.problems.length) console.log(report.problems.join('\n'));
    process.exit(report.ok ? 0 : 1);
  }
})();
