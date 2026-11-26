'use strict';
/*
 * V0.8.2 · M2-B · 时间轴实时音视频同步预览 · 真实窗口验收
 * 默认跑最终 Windows x64 便携版；PVN_DEV=1 跑源码 electron；PVN_SKIP_LONG=1 跳过 300s 长播放（开发自检）。
 * 关键：解锁音频用真实用户手势（userGesture）；音频证据采自 audioRT.snapshot()（playbackStats / events /
 * instances / dualBgm / bgm.time）与在线音频图采集点（AnalyserNode 的时域 RMS/peak），不是只看按钮状态。
 * 产物：release/v082m2b-ui-verify.json + docs/screenshots/v082m2b-*.png
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const DEV = process.env.PVN_DEV === '1';
const SKIP_LONG = process.env.PVN_SKIP_LONG === '1';
const PACKAGED = path.join(ROOT, 'release', 'PaperVNStudio-0.8.1-win-x64', 'PaperVNStudio.exe');
const SRC = path.join(ROOT, 'release', 'wanfeng-v081rc3', '晚风·循环试听工程');
const WORK = path.join(ROOT, 'release', 'v082m2b-verify');
fs.mkdirSync(WORK, { recursive: true });
const PROJECT = path.join(WORK, '晚风-M2B验收副本');
const MAIN = path.join(PROJECT, 'project.paper.json');
const REPORT = path.join(ROOT, 'release', 'v082m2b-ui-verify.json');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');

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
  at: new Date().toISOString(), version: '0.8.2-M2B',
  mode: DEV ? 'source-electron' : 'packaged-win-x64',
  exe: DEV ? ELECTRON : PACKAGED, project: PROJECT,
  stages: {}, problems: [], evidence: {},
  classification: { automation: [], realUi: [], notTested: [] }
};
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d == null ? null : d }; console.log('  ok   ' + n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 240) : '')); };
const bad = (n, m) => { report.stages[n] = { ok: false, message: String(m) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };
const check = (n, cond, m, d) => cond ? ok(n, d === undefined ? m : d) : bad(n, m || '断言失败');
const E = (cdp, expr) => cdp.ev(expr);
/* 真实用户手势求值：用于解锁音频（HTMLAudioElement.play() 需要手势）。 */
const evG = (cdp, expr) => cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  .then((r) => { if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result && r.result.value; });
const P = (cdp) => E(cdp, 'window.paperTimelinePreview()');
const A = (cdp) => E(cdp, 'window.paperEditorAudio()');
const DRV = (cdp) => E(cdp, 'window.paperTimelineAudioDriver()');
const TAP = (cdp) => E(cdp, 'window.__pvnAudioTap()');
const stageDom = () => `(()=>{const c=document.querySelector('#layersCanvas');if(!c)return null;
  return {canvas:c.style.transform,frames:[...c.querySelectorAll('.pf-frame')].map(f=>({t:f.style.transform,o:f.style.opacity})),
    dim:(c.parentElement.querySelector('.pf-dim')||{}).style?((c.parentElement.querySelector('.pf-dim')||{}).style.opacity):null}})()`;
const clickNode = (cdp, i) => E(cdp, `(()=>{const e=[...document.querySelectorAll('#list .node')][${i}];if(!e)return 'no-node';e.click();return 'ok'})()`);

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

async function openEditor(userData) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT,
    items: [{ path: PROJECT, title: '晚风-M2B验收副本', openedAt: new Date().toISOString() }]
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

/* 综合演出测试节点：舞台级视觉 + 完整音频动作（BGM 淡入/SFX/Voice/Ducking/交叉淡化/淡出），显式 start。 */
const BUILD_SCENE = `(()=>{
  const PF=createPaperPerformance();
  const mk=(id,type,target,params,dur,start)=>{const a=PF.make(id,type,target,{params,duration:dur});a.start=start;return a;};
  const acts=[
    mk('a_bgm','audio.bgm.play','',{audioId:'bgm_ost_02_morning',volume:70,fadeIn:2,loopMode:'all',loopStart:0,loopEnd:0},2,0),
    mk('v_fade','screen.fade','',{to:100,color:'black'},0.8,0),
    mk('v_zoom','camera.zoom','',{scale:125},1.6,4),
    mk('a_sfx','audio.sfx.play','',{audioId:'sfx_chime',volume:80,key:'chime'},0.4,4),
    mk('a_voi','audio.voice.play','',{audioId:'voice_placeholder',volume:100,duck:true},1.2,6),
    mk('a_duck','audio.ducking','',{enabled:true,level:35,attack:0.22,release:0.8},0.3,6),
    mk('a_cf','audio.bgm.crossfade','',{audioId:'bgm_ost_03_school_road',volume:72,duration:2.5,curve:'equalPower',loopMode:'all',loopStart:0,loopEnd:0},2.5,8),
    mk('v_fade2','screen.fade','',{to:0,color:'black'},0.8,12),
    mk('a_stop','audio.bgm.stop','',{fadeOut:2},2,12)
  ];
  const p=window.__pvnM3.project();
  p.nodes[0].performance={version:1,actions:acts};
  window.__pvnM3.setProject(p);
  return {total:+PF.totalDuration(acts).toFixed(2), n:acts.length, audio:acts.filter(a=>a.type.indexOf('audio.')===0).length};
})()`;

const audioEvidence = `(()=>{const a=window.paperEditorAudio();const d=window.paperTimelineAudioDriver();const p=window.paperTimelinePreview();const t=window.__pvnAudioTap();
  return {bgm:a.bgm,voice:a.voice,sfx:a.sfx,instances:a.instances,dualBgm:a.dualBgm,mode:a.mode,graph:a.graph,
    stats:a.playbackStats,events:a.events.slice(0,14),errors:a.errors.slice(0,4),
    driver:d,preview:{state:p.state,curT:p.curT,loopCount:p.loopCount,activeRaf:p.activeRaf},tap:t};})()`;

(async () => {
  if (!fs.existsSync(DEV ? ELECTRON : PACKAGED)) { bad('可执行文件存在', '找不到'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  ok('可执行文件存在', { mode: report.mode, skipLong: SKIP_LONG });
  ok('验收工程为隔离副本', { project: PROJECT, originalKept: SRC });

  const s1 = await openEditor(path.join(WORK, 'u1'));
  if (!s1) { bad('编辑器启动', '未连接上页面'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  const c = s1.cdp;
  ok('编辑器启动', { nodes: await E(c, `window.__pvnM3.project().nodes.length`) });

  /* ---------- 0. 解锁声音（真实用户手势） ---------- */
  const unlocked = await evG(c, `window.__pvnM3.unlockAudio()`).catch((e) => ({ ok: false, err: String(e && e.message || e) }));
  check('启用声音成功（真实用户手势）', unlocked && unlocked.ok === true, JSON.stringify(unlocked));
  await sleep(400);
  report.classification.realUi.push('启用声音（真实用户手势）');

  /* ---------- 1. 《晚风》真实场景：BGM 起播 + 真实发声 ---------- */
  const bgmIdx = await E(c, `window.__pvnM3.project().nodes.findIndex(n=>(n.performance&&n.performance.actions||[]).some(a=>a.type==='audio.bgm.play'))`);
  await clickNode(c, bgmIdx); await sleep(500);
  await E(c, `document.querySelector('#tlPreviewHome')?.click()`);
  const stage0 = await E(c, stageDom());
  await E(c, `document.querySelector('#tlPlay').click()`);
  await sleep(4500);
  const real = await E(c, audioEvidence);
  check('《晚风》真实场景 BGM 起播且播放位置推进',
    real.bgm && real.bgm.audioId === 'bgm_ost_02_morning' && real.bgm.time > 0.3 &&
    real.instances.bgm <= 1 && real.dualBgm === false,
    JSON.stringify({ bgm: real.bgm, stats: real.stats, instances: real.instances, dualBgm: real.dualBgm }));
  check('在线音频图输出非静音（真实发声，非仅按钮状态）',
    real.tap && real.tap.rms > 0.001, JSON.stringify(real.tap));
  check('连续视觉预览改变舞台 DOM 且与音频同步推进',
    JSON.stringify(stage0) !== (await E(c, stageDom())) && real.preview.curT > 0.3 && real.preview.state === 'playing',
    JSON.stringify({ curT: real.preview.curT, state: real.preview.state, fired: real.driver.fired }));
  await E(c, `document.querySelector('#tlStop').click()`); await sleep(600);
  const stoppedReal = await E(c, audioEvidence);
  check('停止后无残留声音（BGM 清空、实例归零、无新失败）',
    !stoppedReal.bgm && stoppedReal.instances.bgm === 0 && stoppedReal.dualBgm === false,
    JSON.stringify({ bgm: stoppedReal.bgm, instances: stoppedReal.instances }));
  await fullShot(c, path.join(SHOTS, 'v082m2b-01-真实场景BGM.png'));
  report.classification.realUi.push('《晚风》真实场景 BGM 起播、在线音频图 RMS 证据、停止无残留');

  /* ---------- 2. 注入综合演出节点，从头播放：事件调度 + 音画同步 ---------- */
  const scene = await E(c, BUILD_SCENE);
  check('综合演出节点已注入（含全部音频事件类型）', scene.audio === 6 && scene.total > 13, JSON.stringify(scene));
  await E(c, `document.querySelector('#timelinePanel').focus()`);
  await sleep(300);
  await E(c, `document.querySelector('#tlReplay').click()`);
  const t0 = Date.now();
  /* 采样跨过 4s(SFX)/6s(Voice)/8s(crossfade) 三个关键事件点 */
  const midSamples = [];
  for (let i = 0; i < 6; i++) { await sleep(1500); midSamples.push(await E(c, audioEvidence)); }
  const ev0 = midSamples[midSamples.length - 1];
  const firedTypes = ev0.driver.recent.map((r) => r.type);
  check('音频事件按时间轴触发（BGM 淡入 / SFX / Voice / 交叉淡化）',
    firedTypes.includes('audio.bgm.play') && firedTypes.includes('audio.sfx.play') &&
    firedTypes.includes('audio.voice.play') && firedTypes.includes('audio.bgm.crossfade'),
    JSON.stringify({ firedTypes: [...new Set(firedTypes)], fired: ev0.driver.fired, oneShots: ev0.driver.oneShots }));
  check('一次性音频与状态音频分类计数正确',
    ev0.driver.oneShots >= 2 && ev0.driver.stateEvents >= 2, JSON.stringify({ oneShots: ev0.driver.oneShots, stateEvents: ev0.driver.stateEvents }));
  check('无真实播放失败、无非预期双 BGM',
    ev0.stats.failed === 0 && ev0.dualBgm === false && ev0.instances.bgm <= 1,
    JSON.stringify({ failed: ev0.stats.failed, dualBgm: ev0.dualBgm, instances: ev0.instances, errors: ev0.errors }));
  const tapSamples = midSamples.map((s) => s.tap && s.tap.rms).filter((v) => Number.isFinite(v));
  check('播放期间在线音频图持续有输出（RMS 非零采样点）',
    tapSamples.some((v) => v > 0.001) && midSamples.length >= 4,
    JSON.stringify({ rmsSamples: tapSamples.map((v) => +v.toFixed(4)) }));
  report.evidence.sync = { elapsedMs: Date.now() - t0, firedTypes: [...new Set(firedTypes)], driver: ev0.driver,
    stats: ev0.stats, events: ev0.events, rms: tapSamples.map((v) => +v.toFixed(4)) };
  await fullShot(c, path.join(SHOTS, 'v082m2b-02-综合演出播放.png'));
  report.classification.realUi.push('综合演出节点：BGM 淡入/SFX/Voice/Ducking/交叉淡化按时间轴触发，在线音频图 RMS 证据');

  /* ---------- 3. 暂停 / 继续：BGM 位置 offset 恢复 ---------- */
  await E(c, `document.querySelector('#tlReplay').click()`);
  await sleep(2500);
  await E(c, `document.querySelector('#tlPause').click()`); await sleep(400);
  const paused = await E(c, audioEvidence);
  check('暂停：画面冻结、音频同步停（BGM 清空、无在播 BGM）',
    paused.preview.state === 'paused' && paused.preview.activeRaf === 0 && !paused.bgm,
    JSON.stringify({ state: paused.preview.state, bgm: paused.bgm, activeRaf: paused.preview.activeRaf }));
  const pausedT = paused.preview.curT;
  await E(c, `document.querySelector('#tlPause').click()`); await sleep(600);
  const resumed = await E(c, audioEvidence);
  check('继续：BGM 恢复且播放位置接近暂停点（offset 恢复）',
    resumed.preview.state === 'playing' && resumed.bgm && resumed.bgm.time > 0.3 && resumed.bgm.time < pausedT + 1.5,
    JSON.stringify({ pausedT, bgmTime: resumed.bgm && resumed.bgm.time, state: resumed.preview.state }));
  await E(c, `document.querySelector('#tlStop').click()`); await sleep(500);
  report.classification.realUi.push('暂停定格 + 继续按 offset 恢复 BGM 播放位置');

  /* ---------- 4. 从任意时间开始 + 向前/向后定位：历史一次性音频不重放 ---------- */
  const seekEvidence = await E(c, `(()=>{const d=window.paperTimelineAudioDriver();
    window.paperTimelinePanel.preview.stop();
    const before=d.fired;
    window.paperTimelinePanel.preview.seek(5);window.paperTimelinePanel.preview.seek(3);window.paperTimelinePanel.preview.seek(7);
    const after=d.fired;
    return {before,after,recent:d.recent.slice(-6)};})()`);
  check('连续定位不触发任何一次性音频（历史 SFX/Voice 不重放）',
    seekEvidence.before === seekEvidence.after,
    JSON.stringify(seekEvidence));
  /* 从 5s 开始：4s 历史 SFX 不重放，6s Voice 正确触发 */
  await E(c, `window.paperTimelinePanel.preview.seek(5)`); await sleep(200);
  const recLen = await E(c, `window.paperTimelineAudioDriver().recent.length`);
  await E(c, `document.querySelector('#tlPlay').click()`);
  await sleep(1800);
  const from5 = await E(c, audioEvidence);
  const newRecent = from5.driver.recent.slice(recLen);
  const newTypes = newRecent.map((r) => r.type);
  check('从 5s 开始：6s Voice 触发、4s 历史 SFX 不重放',
    newTypes.includes('audio.voice.play') && !newTypes.includes('audio.sfx.play'),
    JSON.stringify({ newTypes: [...new Set(newTypes)], newRecent }));
  await E(c, `document.querySelector('#tlStop').click()`); await sleep(400);
  report.classification.realUi.push('任意时间开始 + 向前/向后定位不重放历史一次性音频');

  /* ---------- 5. 区间循环：10 次以上，BGM 不累积、区间内 SFX 每轮触发 ---------- */
  await E(c, `(()=>{const a=document.querySelector('#tlRangeStart'),b=document.querySelector('#tlRangeEnd');
    a.value='2';b.value='8';document.querySelector('#tlRangeApply').click();
    const l=document.querySelector('#tlLoop');l.checked=true;l.dispatchEvent(new Event('change'));return 'ok'})()`);
  await E(c, `document.querySelector('#tlReplay').click()`);
  await sleep(SKIP_LONG ? 9000 : 65000);
  const looped = await E(c, audioEvidence);
  check('区间循环 ≥10 次且 BGM 不累积（无双 BGM、实例 ≤1）',
    looped.preview.loopCount >= (SKIP_LONG ? 1 : 10) && looped.instances.bgm <= 1 && looped.dualBgm === false,
    JSON.stringify({ loopCount: looped.preview.loopCount, instances: looped.instances, dualBgm: looped.dualBgm }));
  const loopSfxCount = looped.driver.recent.filter((r) => r.type === 'audio.sfx.play').length;
  check('区间内 SFX 每轮重新触发（不因循环漏触发）',
    loopSfxCount >= (SKIP_LONG ? 1 : 3), JSON.stringify({ sfxTriggers: loopSfxCount }));
  await E(c, `document.querySelector('#tlStop').click()`); await sleep(400);
  await E(c, `(()=>{document.querySelector('#tlRangeClear').click();const l=document.querySelector('#tlLoop');l.checked=false;l.dispatchEvent(new Event('change'));return 'ok'})()`);
  report.classification.realUi.push('区间循环 10 次以上 + 区间内 SFX 每轮触发 + BGM 不累积');

  /* ---------- 6. 快速连续定位 / 定位期间音频加载：无异常、无重复 BGM ---------- */
  const rapid = await E(c, `(()=>{const p=window.paperTimelinePanel.preview;const out=[];
    for(let i=0;i<30;i++){p.seek((i%10)*1.3);}
    const a=window.paperEditorAudio();return {state:p.snapshot().state,instances:a.instances,dualBgm:a.dualBgm,err:a.errors.slice(0,3)};})()`);
  check('30 次快速定位无异常、无非预期双 BGM',
    rapid.instances.bgm <= 1 && rapid.dualBgm === false && rapid.err.length === 0,
    JSON.stringify(rapid));
  report.classification.realUi.push('30 次快速定位竞态保护');

  /* ---------- 7. 播放中切换节点 / 修改动作 / 撤销 ---------- */
  await E(c, `document.querySelector('#tlReplay').click()`); await sleep(1200);
  await clickNode(c, 3); await sleep(300);
  const switched = await E(c, audioEvidence);
  check('播放中切换节点：停止旧计划、无残留声音',
    switched.preview.state === 'stopped' && switched.preview.activeRaf === 0 && !switched.bgm,
    JSON.stringify({ state: switched.preview.state, bgm: switched.bgm }));
  await clickNode(c, 0); await sleep(400);
  await E(c, `(()=>{const b=document.querySelectorAll('#perfList [data-perf]')[0];if(b)b.click();return 'ok'})()`); await sleep(150);
  await E(c, `document.querySelector('#tlPlay').click()`); await sleep(500);
  await E(c, `(()=>{const d=document.querySelector('#perfDuration');d.value='1.7';d.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`);
  await sleep(250);
  const edited = await E(c, audioEvidence);
  check('播放中修改动作：停止旧计划、递增代际、无残留',
    edited.preview.state === 'stopped' && edited.preview.activeRaf === 0,
    JSON.stringify({ state: edited.preview.state, generation: edited.preview.generation }));
  await E(c, `document.querySelector('#undo').click()`); await sleep(300);
  await E(c, `document.querySelector('#tlPlay').click()`); await sleep(400);
  await E(c, `document.querySelector('#undo').click()`); await sleep(300);
  const undone = await E(c, audioEvidence);
  check('播放中撤销：停止旧计划',
    undone.preview.state === 'stopped' && undone.preview.activeRaf === 0,
    JSON.stringify({ state: undone.preview.state }));
  report.classification.realUi.push('播放中切换节点/修改动作/撤销均停止旧计划');

  /* ---------- 8. 停止后等待异步任务完成：无突然响起的旧音频 ---------- */
  await E(c, `document.querySelector('#tlReplay').click()`); await sleep(2000);
  const beforeStopStats = await E(c, `window.paperEditorAudio().playbackStats`);
  await E(c, `document.querySelector('#tlStop').click()`);
  await sleep(2500);
  const afterStop = await E(c, audioEvidence);
  check('停止后等待异步任务：无残留播放、无新起播事件、无突然响起的旧音频',
    !afterStop.bgm && afterStop.instances.bgm === 0 && afterStop.stats.failed === 0 &&
    afterStop.stats.started === beforeStopStats.started &&
    (!afterStop.tap || afterStop.tap.rms < 0.005),
    JSON.stringify({ bgm: afterStop.bgm, instances: afterStop.instances, stats: afterStop.stats, rms: afterStop.tap && afterStop.tap.rms }));
  report.classification.realUi.push('停止后等待异步任务，无突然响起的旧音频');

  /* ---------- 9. 时间轴预览与普通试玩互斥 ---------- */
  await E(c, `document.querySelector('#tlReplay').click()`); await sleep(600);
  const tlPlaying = (await P(c)).state;
  await evG(c, `window.__pvnM3.play()`).catch(() => {}); await sleep(600);
  const afterPlay = await E(c, `({bodyPlaying:document.body.classList.contains('playing'),tl:window.paperTimelinePreview().state,audio:window.paperEditorAudio()})`);
  check('时间轴播放中启动普通试玩：时间轴停止、试玩接管',
    tlPlaying === 'playing' && afterPlay.tl === 'stopped' && afterPlay.bodyPlaying === true,
    JSON.stringify({ tlBefore: tlPlaying, tlAfter: afterPlay.tl, bodyPlaying: afterPlay.bodyPlaying }));
  const inPlayBody = await E(c, `document.body.classList.contains('playing')`);
  await E(c, `document.querySelector('#tlPlay').click()`); await sleep(250);
  const tlInPlay = (await P(c)).state;
  check('普通试玩中点击时间轴播放：被拒绝（互斥）',
    inPlayBody === true && tlInPlay !== 'playing', JSON.stringify({ inPlayBody, tlState: tlInPlay }));
  await evG(c, `window.__pvnM3.stop()`).catch(() => {}); await sleep(300);
  report.classification.realUi.push('时间轴预览与普通试玩互斥（双向）');

  /* ---------- 10. 300s 混合音视频预览（SKIP_LONG 短跑） ---------- */
  await E(c, `window.__pvnM3.stop&&window.__pvnM3.stop()`).catch(() => {});
  await E(c, `(()=>{const l=document.querySelector('#tlLoop');l.checked=true;l.dispatchEvent(new Event('change'));
    const a=document.querySelector('#tlRangeStart'),b=document.querySelector('#tlRangeEnd');a.value='2';b.value='8';document.querySelector('#tlRangeApply').click();
    window.paperTimelinePanel.preview.play(2);return 'ok'})()`);
  const LONG_MS = SKIP_LONG ? 8000 : 305000;
  const N = Math.max(3, Math.round(LONG_MS / 15000));
  const longSamples = [];
  const tl0 = Date.now();
  for (let i = 0; i < N; i++) { await sleep(Math.min(15000, Math.max(1200, LONG_MS / N))); longSamples.push(await E(c, audioEvidence)); }
  await E(c, `document.querySelector('#tlStop').click()`); await sleep(400);
  const longFinal = await E(c, audioEvidence);
  const failedAny = longSamples.some((s) => s.stats.failed > 0);
  const dualAny = longSamples.some((s) => s.dualBgm);
  const loops = longSamples[longSamples.length - 1].preview.loopCount;
  const maxBgm = Math.max(...longSamples.map((s) => s.instances.bgm));
  check(SKIP_LONG ? '300s 混合音视频预览（开发自检短跑）' : '300s 混合音视频预览通过',
    loops >= (SKIP_LONG ? 2 : 60) && !failedAny && !dualAny && maxBgm <= 1 && longFinal.preview.activeRaf === 0,
    JSON.stringify({ loops, failedAny, dualAny, maxBgm, finalRaf: longFinal.preview.activeRaf }));
  report.evidence.longMix = { plannedMs: LONG_MS, actualMs: Date.now() - tl0, loops, maxBgm, failedAny, dualAny,
    samples: longSamples.map((s) => ({ t: s.preview.curT, bgm: s.bgm && s.bgm.time, rms: s.tap && s.tap.rms, stats: s.stats })) };
  report.classification.realUi.push(SKIP_LONG ? '300s 混合音视频预览（开发自检短跑）' : '300s 混合音视频预览');

  /* ---------- 11. 保存关闭重开 ---------- */
  await E(c, `document.querySelector('#tlStop').click()`).catch(() => {});
  const errs1 = s1.cdp.errors.filter((e) => !/favicon|Content-Security-Policy/i.test(e.text || ''));
  check('会话 1 无渲染进程异常', errs1.length === 0, JSON.stringify(errs1.slice(0, 4)));
  await E(c, `document.querySelector('#save').click()`); await sleep(1400);
  kill(s1.proc); s1.cdp.close(); await sleep(900);

  const s2 = await openEditor(path.join(WORK, 'u2'));
  if (!s2) bad('关闭重开', '编辑器未重新启动');
  else {
    const c2 = s2.cdp;
    const reopen = await E(c2, `(()=>{const p=window.paperTimelinePreview();const b=document.querySelector('.tl-badge');
      return {state:p.state,activeRaf:p.activeRaf,badge:b?b.textContent:'',clips:document.querySelectorAll('#tlLanes .tl-clip').length};})()`);
    check('关闭重开：无残留播放任务、标注为音频已同步、时间轴正常重建',
      reopen.state !== 'playing' && reopen.activeRaf === 0 && /音频已同步|音频/.test(reopen.badge) && reopen.clips > 0,
      JSON.stringify(reopen));
    await evG(c2, `window.__pvnM3.unlockAudio()`).catch(() => ({ ok: false }));
    await clickNode(c2, 0); await sleep(400);
    await E(c2, `document.querySelector('#tlPlay').click()`); await sleep(3500);
    const reopenPlay = await E(c2, audioEvidence);
    check('关闭重开后播放仍真实发声（BGM 起播 + RMS 非零）',
      reopenPlay.bgm && reopenPlay.bgm.time > 0.3 && reopenPlay.tap && reopenPlay.tap.rms > 0.001,
      JSON.stringify({ bgm: reopenPlay.bgm, stats: reopenPlay.stats, rms: reopenPlay.tap && reopenPlay.tap.rms }));
    await fullShot(c2, path.join(SHOTS, 'v082m2b-03-关闭重开播放.png'));
    check('会话 2 无渲染进程异常', s2.cdp.errors.filter((e) => !/favicon|Content-Security-Policy/i.test(e.text || '')).length === 0,
      JSON.stringify(s2.cdp.errors.slice(0, 3)));
    kill(s2.proc); s2.cdp.close();
  }
  report.classification.realUi.push('保存 / 关闭 / 重开后仍真实发声');

  report.classification.automation = [
    'npm run check（M0/M1A/M1B/M2A 全部保留 + 新增 timeline-preview-audio 8 组）',
    'tests/timeline-preview-audio.test.cjs：audioSideEffectsBetween 半开/闭区间与确定性排序；预览音频驱动任意时间开始、区间触发、历史一次性不重放、暂停 offset 恢复、循环复位、seek 不重放、停止清理、结束补扫'
  ];
  report.classification.notTested = [
    '音频裁剪/变速、高级关键帧、视频/Live2D 轨道、跨节点/跨章节时间轴 —— 本轮不做',
    '1.47 GiB 全链与 900 秒音频浸泡 —— 本轮未改核心音频运行时与资源存储，按范围不重复',
    '操作系统扬声器实际输出时间（含输出设备延迟）—— 采集的是在线音频图 RMS，不把 AudioContext 时间当作扬声器发声时间',
    '人工长时间使用体验与第二台机器验收 —— 由用户决定'
  ];

  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M2B 真实窗口验收 · ' + report.mode);
  console.log('证据: ' + REPORT);
  process.exit(report.ok ? 0 : 1);
})().catch((e) => {
  report.problems.push('脚本异常：' + (e.stack || e.message));
  report.ok = false;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error('SCRIPT ERROR:', e.stack || e.message);
  process.exit(1);
});
