'use strict';
/*
 * V0.8.2 · M3-A · 音画同步精度实测（av-sync benchmark）
 * 在真实 Electron 窗口里构建「可识别同步测试节点」（同一时刻切换视觉标志 + 触发短促 PCM 音效），
 * 分层采集并报告：
 *   L1 计划动作触发时间（driver.sync.planned）
 *   L2 JavaScript 实际派发时间（driver.sync.driftMs = dispatched - expected，主指标 P95）
 *   L3 AudioContext 排程时间（precise BGM 的 startedAt / ctx.currentTime 排程）
 *   L4 在线音频图实际起音（AnalyserNode 时域 RMS 非零，证明真实发声）
 * 明确：不采集操作系统扬声器/声卡回环输出，测量仅覆盖「在线音频图 + 渲染层」。
 * 覆盖：正常前台热态（主指标）、冷缓存首次、30FPS 受限（CPU throttling）、短时掉帧（忙循环）。
 * 产物：release/av-sync-benchmark.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const DEV = process.env.PVN_DEV === '1';
const PACKAGED = path.join(ROOT, 'release', 'PaperVNStudio-0.8.1-win-x64', 'PaperVNStudio.exe');
const SRC = path.join(ROOT, 'release', 'wanfeng-v081rc3', '晚风·循环试听工程');
const WORK = path.join(ROOT, 'release', 'v082m3a');
fs.mkdirSync(WORK, { recursive: true });
const PROJECT = path.join(WORK, '晚风-M3A同步测试副本');
const REPORT = path.join(ROOT, 'release', 'av-sync-benchmark.json');

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(a, b); else fs.writeFileSync(b, fs.readFileSync(a));
  }
}
fs.rmSync(PROJECT, { recursive: true, force: true });
copyTree(SRC, PROJECT);

const report = {
  at: new Date().toISOString(), version: '0.8.2-M3A',
  mode: DEV ? 'source-electron' : 'packaged-win-x64',
  scope: '在线音频图 + 渲染层（不含扬声器/声卡回环输出）',
  project: PROJECT, stages: {}, problems: [], evidence: {},
  goal: { hotP95Ms: 50 }
};
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d == null ? null : d }; console.log('  ok   ' + n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : '')); };
const bad = (n, m) => { report.stages[n] = { ok: false, message: String(m) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };
const check = (n, cond, m, d) => cond ? ok(n, d === undefined ? m : d) : bad(n, m || '断言失败');
const E = (cdp, expr) => cdp.ev(expr);
const evG = (cdp, expr) => cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  .then((r) => { if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result && r.result.value; });

async function openEditor(userData) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT, items: [{ path: PROJECT, title: '晚风-M3A同步测试副本', openedAt: new Date().toISOString() }]
  }));
  const port = await freePort();
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const args = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${userData}`];
  if (DEV) args.unshift('.');
  const proc = spawn(DEV ? ELECTRON : PACKAGED, args, { cwd: ROOT, stdio: 'ignore', env });
  const page = await waitPage(port, (u) => u.startsWith('paper://app/'), 60000);
  if (!page) { kill(proc); return null; }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  try {
    const w = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { width: 1500, height: 1150 } });
  } catch (_) {}
  for (let i = 0; i < 200; i++) {
    if ((await E(cdp, `document.querySelectorAll('#list .node').length`).catch(() => 0)) >= 30) break;
    await sleep(150);
  }
  return { proc, cdp };
}

/* 同步测试节点：12 组「视觉标志 + 短促 SFX」同刻触发，间隔 0.6s，覆盖约 7.2s。
   用 12 个不同 key 的 SFX，每个都独立可检测（不互相替换）。 */
const BUILD_SYNC = `(()=>{
  const PF=createPaperPerformance();
  const mk=(id,type,target,params,dur,start)=>{const a=PF.make(id,type,target,{params,duration:dur});a.start=start;return a;};
  const acts=[];
  acts.push(mk('s_bgm','audio.bgm.play','',{audioId:'bgm_ost_02_morning',volume:70,fadeIn:0.4,loopMode:'all',loopStart:0,loopEnd:0},0.4,0));
  for(let i=0;i<12;i++){
    const t=+(0.6+i*0.6).toFixed(2);
    acts.push(mk('s_zoom'+i,'camera.zoom','',{scale:110+i*2},0.25,t));        /* 视觉标志 */
    acts.push(mk('s_sfx'+i,'audio.sfx.play','',{audioId:'sfx_chime',volume:85,key:'sync'+i},0.2,t)); /* 短促 PCM 音效 */
  }
  const p=window.__pvnM3.project();
  p.nodes[0].performance={version:1,actions:acts};
  window.__pvnM3.setProject(p);
  return {total:+PF.totalDuration(acts).toFixed(2),n:acts.length,sfx:12};
})()`;

const audioEvidence = `(()=>{const a=window.paperEditorAudio();const d=window.paperTimelineAudioDriver();const p=window.paperTimelinePreview();const t=window.__pvnAudioTap();
  return {bgm:a.bgm,instances:a.instances,dualBgm:a.dualBgm,mode:a.mode,stats:a.playbackStats,
    driver:d,preview:{state:p.state,curT:p.curT,loopCount:p.loopCount},tap:t};})()`;

const stageDom = `(()=>{const c=document.querySelector('#layersCanvas');if(!c)return null;return {t:c.style.transform,dim:(c.parentElement.querySelector('.pf-dim')||{}).style?((c.parentElement.querySelector('.pf-dim')||{}).style.opacity):null}})()`;

async function fullShot(cdp, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const m = await cdp.send('Page.getLayoutMetrics');
    const box = m.cssContentSize || m.contentSize;
    const w = Math.min(2000, Math.ceil(box.width)), h = Math.min(3200, Math.ceil(box.height));
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  } catch (_) { try { await cdp.shot(file); } catch (_) {} }
}

async function main() {
  if (!fs.existsSync(DEV ? ELECTRON : PACKAGED)) { bad('可执行文件存在', '找不到'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  const s1 = await openEditor(path.join(WORK, 'u1'));
  if (!s1) { bad('编辑器启动', '未连接'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  const c = s1.cdp;
  ok('编辑器启动', { nodes: await E(c, `window.__pvnM3.project().nodes.length`) });

  const unlocked = await evG(c, `window.__pvnM3.unlockAudio()`).catch(() => ({ ok: false }));
  check('启用声音（真实用户手势）', unlocked && unlocked.ok === true, JSON.stringify(unlocked));
  await sleep(400);

  const scene = await E(c, BUILD_SYNC);
  check('同步测试节点已注入（12 组视觉标志 + 短促 SFX）', scene.sfx === 12 && scene.n >= 25, JSON.stringify(scene));
  await E(c, `document.querySelector('#timelinePanel').focus()`); await sleep(300);

  /* ---------- 冷态首次播放（冷缓存） ---------- */
  await E(c, `document.querySelector('#tlReplay').click()`);
  const coldStart = Date.now();
  const coldSamples = [];
  for (let i = 0; i < 5; i++) { await sleep(1400); coldSamples.push(await E(c, audioEvidence)); }
  await E(c, `document.querySelector('#tlStop').click()`); await sleep(500);
  const coldDrv = coldSamples[coldSamples.length - 1].driver;
  const coldSync = coldDrv.sync;
  report.evidence.cold = { elapsedMs: Date.now() - coldStart, sync: coldSync, fired: coldDrv.fired, skippedStale: coldDrv.skippedStale,
    rms: coldSamples.map((s) => s.tap && s.tap.rms).filter((v) => Number.isFinite(v)) };
  check('冷态首次播放：音频事件按时间轴触发（SFX 样本充足）',
    coldDrv.fired >= 8, JSON.stringify({ fired: coldDrv.fired, sync: coldSync }));
  ok('冷态同步偏差（单独统计，不混入热态）', coldSync);

  /* ---------- 热态正常：区间循环反复触发，采集 ≥30 个同步样本 ---------- */
  await E(c, `(()=>{const a=document.querySelector('#tlRangeStart'),b=document.querySelector('#tlRangeEnd');
    a.value='0.4';b.value='7.2';document.querySelector('#tlRangeApply').click();
    const l=document.querySelector('#tlLoop');l.checked=true;l.dispatchEvent(new Event('change'));return 'ok'})()`);
  await E(c, `document.querySelector('#tlReplay').click()`);
  const hotStart = Date.now();
  /* 每次循环 ~6.8s，触发 12 SFX + 1 BGM ≈ 13 音频事件；循环 3 次 ≈ 39 样本 */
  const hotSamples = [];
  for (let i = 0; i < 14; i++) { await sleep(1500); hotSamples.push(await E(c, audioEvidence)); }
  await fullShot(c, path.join(ROOT, 'docs', 'screenshots', 'v082m3a-01-同步测试节点播放.png'));
  await E(c, `document.querySelector('#tlStop').click()`); await sleep(500);
  const hotDrv = hotSamples[hotSamples.length - 1].driver;
  const hotSync = hotDrv.sync;
  const hotDual = hotSamples.some((s) => s.dualBgm);
  const hotFailed = hotSamples.some((s) => s.stats.failed > 0);
  const hotRms = hotSamples.map((s) => s.tap && s.tap.rms).filter((v) => Number.isFinite(v));
  report.evidence.hot = { elapsedMs: Date.now() - hotStart, sync: hotSync, fired: hotDrv.fired, oneShots: hotDrv.oneShots,
    skippedStale: hotDrv.skippedStale, loopCount: hotSamples[hotSamples.length - 1].preview.loopCount,
    rms: hotRms.map((v) => +v.toFixed(4)), dualBgm: hotDual, failed: hotFailed };
  check('热态正常：音频事件持续按时间轴触发（≥30 样本、无失败、无双 BGM）',
    hotSync.count >= 30 && !hotFailed && !hotDual,
    JSON.stringify({ count: hotSync.count, failed: hotFailed, dualBgm: hotDual, fired: hotDrv.fired }));
  check('热态正常音画同步 P95 ≤ 50ms（主指标）',
    hotSync.p95Ms <= 50, JSON.stringify({ p95: hotSync.p95Ms, p50: hotSync.p50Ms, mean: hotSync.meanMs, max: hotSync.maxMs, n: hotSync.count }));
  check('在线音频图持续有输出（RMS 非零采样点，真实发声）',
    hotRms.some((v) => v > 0.001), JSON.stringify({ rmsSamples: hotRms.slice(0, 8).map((v) => +v.toFixed(4)) }));
  await E(c, `(()=>{document.querySelector('#tlRangeClear').click();const l=document.querySelector('#tlLoop');l.checked=false;l.dispatchEvent(new Event('change'));return 'ok'})()`);

  /* ---------- 短时掉帧：播放中注入忙循环，观察补触发与过期跳过 ---------- */
  await E(c, `document.querySelector('#tlReplay').click()`);
  await sleep(1500);
  const beforeDrop = await E(c, `window.paperTimelineAudioDriver().fired`);
  await E(c, `(()=>{const t0=performance.now();while(performance.now()-t0<350){}return 'drop'})()`);   /* 阻塞 ~350ms 制造掉帧 */
  await sleep(1200);
  const afterDrop = await E(c, audioEvidence);
  const dropSync = afterDrop.driver.sync;
  report.evidence.drop = { beforeFired: beforeDrop, fired: afterDrop.driver.fired, skippedStale: afterDrop.driver.skippedStale,
    sync: dropSync, recent: afterDrop.driver.recent.slice(-6) };
  check('短时掉帧后：渲染恢复、事件不静默遗漏（补触发或明确记录跳过）',
    afterDrop.driver.fired > beforeDrop || afterDrop.driver.skippedStale > 0,
    JSON.stringify({ before: beforeDrop, after: afterDrop.driver.fired, skipped: afterDrop.driver.skippedStale }));
  ok('短时掉帧同步偏差（单独统计）', dropSync);
  await E(c, `document.querySelector('#tlStop').click()`); await sleep(400);

  /* ---------- 受限环境（CPU throttling 模拟低帧率） ---------- */
  let throttleOk = false, throttleSync = null;
  try {
    await c.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    throttleOk = true;
  } catch (e) { throttleOk = false; }
  await E(c, `document.querySelector('#tlReplay').click()`);
  const thSamples = [];
  for (let i = 0; i < 10; i++) { await sleep(1500); thSamples.push(await E(c, audioEvidence)); }
  await E(c, `document.querySelector('#tlStop').click()`); await sleep(400);
  if (throttleOk) { try { await c.send('Emulation.setCPUThrottlingRate', { rate: 1 }); } catch (_) {} }
  const thDrv = thSamples[thSamples.length - 1].driver;
  throttleSync = thDrv.sync;
  report.evidence.throttled = { throttled: throttleOk, sync: throttleSync, fired: thDrv.fired, skippedStale: thDrv.skippedStale };
  ok('受限环境（CPU throttling×4）同步偏差（单独统计，不混入热态）', { throttled: throttleOk, ...throttleSync });

  /* ---------- 分层证据：AudioContext 排程 + 在线 RMS 起音 ---------- */
  const layered = await E(c, `(()=>{const a=window.paperEditorAudio();return {mode:a.mode,graph:a.graph,preciseReason:a.preciseReason};})()`);
  report.evidence.layers = {
    l1_plan: 'driver.sync.planned（时间轴计划秒）',
    l2_dispatch: 'driver.sync.driftMs（performance.now() 派发 − 预期墙钟）',
    l3_audioContext: layered.mode === 'precise' ? 'AudioContext 排程（AudioBufferSourceNode.start(when, offset)）' : '流式 HTMLAudioElement（无采样级排程）',
    l4_onlineRms: 'AnalyserNode 时域 RMS（总线后/master 前）',
    graph: layered.graph, mode: layered.mode, preciseReason: layered.preciseReason
  };

  const errs1 = s1.cdp.errors.filter((e) => !/favicon|Content-Security-Policy/i.test(e.text || ''));
  check('会话无渲染进程异常', errs1.length === 0, JSON.stringify(errs1.slice(0, 4)));
  kill(s1.proc); s1.cdp.close();

  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M3A 音画同步精度实测 · ' + report.mode);
  console.log('证据: ' + REPORT);
  process.exit(report.ok ? 0 : 1);
}
main().catch((e) => { report.problems.push('脚本异常：' + (e.stack || e.message)); report.ok = false; fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); console.error('SCRIPT ERROR:', e.stack || e.message); process.exit(1); });
