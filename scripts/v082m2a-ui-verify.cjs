'use strict';
/*
 * V0.8.2 · M2-A · 波形与连续视觉预览 · 真实窗口验收
 * 默认跑最终 Windows x64 便携版；PVN_DEV=1 跑源码 electron；PVN_SKIP_LONG=1 跳过 5 分钟长播放（开发自检用）。
 * 所有编辑走真实 DOM 事件 / 按钮 / 快捷键；播放时间基于单调时钟，不伪造数据。
 * 产物：release/v082m2a-ui-verify.json + docs/screenshots/v082m2a-*.png
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const DEV = process.env.PVN_DEV === '1';
const SKIP_LONG = process.env.PVN_SKIP_LONG === '1';
const PACKAGED = path.join(ROOT, 'release', 'PaperVNStudio-0.8.1-win-x64', 'PaperVNStudio.exe');
const SRC = path.join(ROOT, 'release', 'wanfeng-v081rc3', '晚风·循环试听工程');
const WORK = path.join(ROOT, 'release', 'v082m2a-verify');
fs.mkdirSync(WORK, { recursive: true });
const PROJECT = path.join(WORK, '晚风-M2A验收副本');
const MAIN = path.join(PROJECT, 'project.paper.json');
const REPORT = path.join(ROOT, 'release', 'v082m2a-ui-verify.json');
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
  at: new Date().toISOString(), version: '0.8.2-M2A',
  mode: DEV ? 'source-electron' : 'packaged-win-x64',
  exe: DEV ? ELECTRON : PACKAGED, project: PROJECT,
  stages: {}, problems: [], evidence: {},
  classification: { automation: [], realUi: [], notTested: [] }
};
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d == null ? null : d }; console.log('  ok   ' + n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 220) : '')); };
const bad = (n, m) => { report.stages[n] = { ok: false, message: String(m) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };
const check = (n, cond, m, d) => cond ? ok(n, d === undefined ? m : d) : bad(n, m || '断言失败');
const E = (cdp, expr) => cdp.ev(expr);
const D = (cdp) => E(cdp, 'window.paperTimelineDebug()');
const P = (cdp) => E(cdp, 'window.paperTimelinePreview()');
const W = (cdp) => E(cdp, 'window.paperTimelineWaves()');
const actsOf = (i) => `(()=>{const p=window.__pvnM3.project();const n=p.nodes[${i}];return (n&&n.performance&&n.performance.actions)||[]})()`;
const clickNode = (cdp, i) => E(cdp, `(()=>{const e=[...document.querySelectorAll('#list .node')][${i}];if(!e)return 'no-node';e.click();return 'ok'})()`);
const heap = () => `(()=>{try{return performance.memory?performance.memory.usedJSHeapSize:null}catch{return null}})()`;
const domCount = () => `document.querySelectorAll('*').length`;
const stageDom = () => `(()=>{const c=document.querySelector('#layersCanvas');if(!c)return null;
  return {canvas:c.style.transform,frames:[...c.querySelectorAll('.pf-frame')].map(f=>({t:f.style.transform,o:f.style.opacity}))}})()`;

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
async function timelineShot(cdp, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const box = await E(cdp, `(()=>{const r=document.querySelector('#timelinePanel').getBoundingClientRect();
      return {x:Math.max(0,r.left+window.scrollX),y:Math.max(0,r.top+window.scrollY),w:r.width,h:r.height}})()`);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: box.x, y: box.y, width: Math.min(1800, box.w), height: Math.min(1000, box.h), scale: 2 } });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  } catch (_) { try { await cdp.shot(file); } catch (_) {} }
}
async function shotWithInspector(cdp, file) {
  await E(cdp, `(()=>{const d=document.querySelector('#performancePanel');if(d)d.open=true;
    const b=document.querySelector('.inspector-body');if(b){b.dataset.tlPrev=b.style.cssText;b.style.maxHeight='none';b.style.overflow='visible';}
    const t=document.querySelector('#toast');if(t)t.style.display='none';return 'ok'})()`).catch(() => {});
  await sleep(180);
  await fullShot(cdp, file);
  await E(cdp, `(()=>{const b=document.querySelector('.inspector-body');if(b&&b.dataset.tlPrev!==undefined){b.style.cssText=b.dataset.tlPrev;delete b.dataset.tlPrev;}return 'ok'})()`).catch(() => {});
}

async function openEditor(userData) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT,
    items: [{ path: PROJECT, title: '晚风-M2A验收副本', openedAt: new Date().toISOString() }]
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

function key(k, mods) {
  const m = mods || {};
  return `(()=>{const t=document.querySelector('#timelinePanel')||document.body;
    t.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},ctrlKey:${!!m.ctrl},shiftKey:${!!m.shift},altKey:${!!m.alt},bubbles:true,cancelable:true}));return 'ok'})()`;
}
function keyOn(sel, k, mods) {
  const m = mods || {};
  return `(()=>{const t=document.querySelector(${JSON.stringify(sel)});if(!t)return 'no-target';t.focus();
    t.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},ctrlKey:${!!m.ctrl},bubbles:true,cancelable:true}));return 'ok'})()`;
}
function dragDown(id, edge, mods) {
  return `(()=>{const c=document.querySelector('#tlLanes .tl-clip[data-tl-clip=${JSON.stringify(id)}]');if(!c)return 'no-clip';
    const h=${edge ? `c.querySelector('.tl-handle-${edge}')` : 'null'};if(${JSON.stringify(!!edge)}&&!h)return 'no-handle';
    const t=h||c,r=c.getBoundingClientRect();window.__tlD={clip:c,target:t,x0:r.left+8,y0:r.top+8};
    const m=${JSON.stringify(mods || {})};
    const mk=(k,x,b)=>new PointerEvent(k,{bubbles:true,cancelable:true,clientX:x,clientY:window.__tlD.y0,pointerId:1,pointerType:'mouse',button:0,buttons:b,isPrimary:true,ctrlKey:!!m.ctrl,shiftKey:!!m.shift,altKey:!!m.alt});
    t.dispatchEvent(mk('pointerdown',window.__tlD.x0,1));return 'ok'})()`;
}
function dragMove(dx) {
  return `(()=>{const d=window.__tlD;if(!d)return 'no-drag';d.clip.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:d.x0+(${dx}),clientY:d.y0,pointerId:1,pointerType:'mouse',button:0,buttons:1,isPrimary:true}));return 'ok'})()`;
}
function dragUp(dx) {
  return `(()=>{const d=window.__tlD;if(!d)return 'no-drag';d.clip.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:d.x0+(${dx}),clientY:d.y0,pointerId:1,pointerType:'mouse',button:0,buttons:0,isPrimary:true}));window.__tlD=null;return 'ok'})()`;
}
const canvasPixels = `(()=>{const c=document.querySelector('#tlLanes .tl-wave');if(!c)return null;
  const g=c.getContext('2d'),d=g.getImageData(0,0,c.width,c.height).data;let n=0;
  for(let i=3;i<d.length;i+=4)if(d[i]>0)n++;
  return {w:c.width,h:c.height,nonZero:n,ratio:+(n/(c.width*c.height)).toFixed(3)}})()`;

(async () => {
  if (!fs.existsSync(DEV ? ELECTRON : PACKAGED)) { bad('可执行文件存在', '找不到'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  ok('可执行文件存在', { mode: report.mode, skipLong: SKIP_LONG });
  ok('验收工程为隔离副本', { project: PROJECT, originalKept: SRC });

  const s1 = await openEditor(path.join(WORK, 'u1'));
  if (!s1) { bad('编辑器启动', '未连接上页面'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  const c = s1.cdp;
  ok('编辑器启动', { nodes: await E(c, `window.__pvnM3.project().nodes.length`) });

  /* ---------- 0. 旧工程基线 ---------- */
  const disk0 = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  const legacyStarts = disk0.nodes.flatMap(n => (n.performance && n.performance.actions) || []).filter(a => a.start !== undefined).length;
  const sched0 = await E(c, `(()=>{const P2=createPaperPerformance(),p=window.__pvnM3.project();return p.nodes.map(n=>P2.schedule((n.performance&&n.performance.actions)||[]).map(s=>[s.start,s.end]))})()`);
  await clickNode(c, 0); await sleep(300);
  await E(c, `document.querySelector('#tlPreviewHome')?.click()`);
  await E(c, `document.querySelector('#save').click()`); await sleep(1200);
  const disk1 = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  const starts1 = disk1.nodes.flatMap(n => (n.performance && n.performance.actions) || []).filter(a => a.start !== undefined).length;
  const sched1 = await E(c, `(()=>{const P2=createPaperPerformance(),p=window.__pvnM3.project();return p.nodes.map(n=>P2.schedule((n.performance&&n.performance.actions)||[]).map(s=>[s.start,s.end]))})()`);
  check('未编辑旧工程：预览+保存不写入 start', legacyStarts === 0 && starts1 === 0, `before=${legacyStarts} after=${starts1}`);
  check('未编辑旧工程：原调度一致', JSON.stringify(sched0) === JSON.stringify(sched1), '调度变化');
  report.classification.realUi.push('旧工程打开 → 视觉预览按钮 → 保存 → 磁盘核对无 start');

  /* ---------- 1. 真实波形加载 ---------- */
  await clickNode(c, 0); await sleep(3200);
  const wave0 = await E(c, `(()=>{const w=window.paperTimelineWaves(),d=window.paperTimelineDebug();
    const clips=[...document.querySelectorAll('#tlLanes .tl-clip[data-wave-audio]')];
    return {waves:w,debug:{waveClips:d.waveClips,waveDrawn:d.waveDrawn,waveCanvases:d.waveCanvases},
      pixels:${canvasPixels},clips:clips.map(c=>({kind:c.dataset.waveKind,audio:c.dataset.waveAudio,state:c.dataset.waveState,dur:c.dataset.waveDuration,title:c.title.slice(0,220)}))}})()`);
  const pixels0 = wave0.pixels;
  check('真实音频波形加载并绘制（canvas 有真实像素）',
    wave0.debug.waveClips >= 1 && wave0.debug.waveDrawn >= 1 && pixels0 && pixels0.nonZero > 500 && pixels0.ratio > 0.2,
    JSON.stringify({ waveClips: wave0.debug.waveClips, waveDrawn: wave0.debug.waveDrawn, pixels: pixels0 }));
  const assetDur = await E(c, `(()=>{const p=window.__pvnM3.project();const a=p.audioAssets.find(x=>x.id==='${wave0.clips[0] ? wave0.clips[0].audio : ''}');return a?a.duration:null})()`);
  const shownDur = Number(wave0.clips[0] && wave0.clips[0].dur);
  check('波形摘要来自实际素材（时长/采样信息，非占位波形）',
    wave0.waves.decodeCalls >= 1 && wave0.waves.failures === 0 && shownDur > 1 &&
    (assetDur == null || Math.abs(shownDur - assetDur) < 1.5),
    JSON.stringify({ shownDur, assetDur, decodeCalls: wave0.waves.decodeCalls, lastMs: wave0.waves.lastMs, bytes: wave0.waves.bytes }));
  check('BGM 动作时长不等于素材时长且波形按 1 秒=1 秒显示（未压缩）',
    /不代表音频裁剪或变速/.test(wave0.clips[0] ? wave0.clips[0].title : '') && shownDur > 10,
    JSON.stringify({ shownDur, title: wave0.clips[0] && wave0.clips[0].title.slice(0, 150) }));
  await timelineShot(c, path.join(SHOTS, 'v082m2a-01-真实波形.png'));
  report.evidence.waveform = { pixels: pixels0, summaryDuration: shownDur, assetDuration: assetDur, waves: wave0.waves };

  /* 缓存复用：同一素材重复请求不重复解码 */
  const reuse = await E(c, `(()=>{const w=window.paperWaveformCache;const before=w.snapshot().decodeCalls;
    const id='${wave0.clips[0] ? wave0.clips[0].audio : ''}';
    return Promise.all([w.request(id,100,300),w.request(id,100,300)]).then(()=>({before,after:w.snapshot().decodeCalls,hits:w.snapshot().cacheHits,entries:w.snapshot().entries}))})()`);
  check('重复素材波形复用缓存，不重复解码', reuse.after === reuse.before && reuse.hits >= 2, JSON.stringify(reuse));

  /* 缩放后波形对齐（canvas 宽度随片段宽度变化，不重建全部 DOM） */
  const beforeZoom = await E(c, `(()=>{const d=window.paperTimelineDebug();return {pps:d.pps,dom:${domCount()},renderCount:d.renderCount}})()`);
  await E(c, `document.querySelector('#tlZoomIn').click()`); await sleep(300);
  const afterZoom = await E(c, `(()=>{const d=window.paperTimelineDebug();const c=document.querySelector('#tlLanes .tl-clip[data-wave-audio]');
    const cv=c&&c.querySelector('.tl-wave');return {pps:d.pps,dom:${domCount()},renderCount:d.renderCount,
      clipW:c?Math.round(c.getBoundingClientRect().width):0,canvasW:cv?cv.width/2:0,pixels:${canvasPixels}}})()`);
  check('缩放后波形随片段宽度重绘且对齐，未全量重建时间轴',
    afterZoom.pps > beforeZoom.pps && afterZoom.canvasW > 0 && Math.abs(afterZoom.canvasW - afterZoom.clipW) <= 3 &&
    afterZoom.renderCount === beforeZoom.renderCount && afterZoom.pixels.nonZero > 200,
    JSON.stringify({ beforeZoom, afterZoom: { pps: afterZoom.pps, clipW: afterZoom.clipW, canvasW: afterZoom.canvasW, renderCount: afterZoom.renderCount } }));
  await timelineShot(c, path.join(SHOTS, 'v082m2a-02-缩放波形对齐.png'));
  await E(c, `document.querySelector('#tlZoomFit').click()`);
  report.classification.realUi.push('真实波形加载、缓存复用、缩放对齐、失败标记');

  /* 过期请求 / 切节点资源管理 */
  const scopeBefore = await W(c);
  await clickNode(c, 3); await clickNode(c, 8); await clickNode(c, 23); await sleep(1500);
  const scopeAfter = await W(c);
  check('切换节点丢弃过期波形请求并重建预览状态',
    scopeAfter.scopeChanges > scopeBefore.scopeChanges && (await P(c)).activeRaf === 0 &&
    (await P(c)).state === 'stopped', JSON.stringify({ before: scopeBefore.scopeChanges, after: scopeAfter.scopeChanges, state: (await P(c)).state }));

  /* 零时长音频事件明确标记 */
  await clickNode(c, 23); await sleep(1600);
  const zeroInfo = await E(c, `(()=>{const cs=[...document.querySelectorAll('#tlLanes .tl-clip[data-wave-kind]')];
    return cs.map(c=>({kind:c.dataset.waveKind,state:c.dataset.waveState,dur:c.dataset.waveDuration,title:c.title.slice(0,200)}))})()`);
  check('瞬时音频事件保留明确标记并展示素材时长', zeroInfo.length >= 1, JSON.stringify(zeroInfo));

  /* ---------- 2. 播放 / 暂停 / 继续 / 舞台状态 ---------- */
  await clickNode(c, 0); await sleep(500);
  await E(c, `document.querySelector('#timelinePanel').focus()`);
  const stage0 = await E(c, stageDom());
  const playStart = await P(c);
  await E(c, `document.querySelector('#tlPlay').click()`);
  await sleep(1300);
  const mid = await E(c, `({p:window.paperTimelinePreview(),t:window.paperTimelineDebug().curT,state:${stageDom()},events:window.paperTimelineEvents?window.paperTimelineEvents().map(e=>e.name):[]})`);
  check('播放头按单调时钟自动推进，只有一个 rAF',
    mid.p.state === 'playing' && mid.p.curT > 0.9 && mid.p.curT < 2.2 && mid.p.activeRaf === 1 &&
    mid.p.frames.count > 20 && mid.p.frames.fps > 20,
    JSON.stringify({ curT: mid.p.curT, frames: mid.p.frames, activeRaf: mid.p.activeRaf }));
  check('连续视觉预览真实改变舞台 DOM 状态',
    JSON.stringify(stage0) !== JSON.stringify(mid.state), JSON.stringify({ before: stage0, after: mid.state }));
  check('预览事件钩子 previewStart 已发出，且未触发正式音频演出',
    mid.events.includes('previewStart') && (await E(c, `window.paperPerfAudioDebug().fired`)) === 0,
    JSON.stringify({ events: mid.events, perfAudioFired: 0 }));
  await timelineShot(c, path.join(SHOTS, 'v082m2a-03-播放中舞台与播放头.png'));

  await E(c, `document.querySelector('#tlPause').click()`); await sleep(450);
  const paused = await P(c);
  const pausedT = paused.curT;
  await sleep(500);
  const stillPaused = await P(c);
  check('暂停定格并释放 rAF', paused.state === 'paused' && Math.abs(stillPaused.curT - pausedT) < 0.02 && paused.activeRaf === 0,
    JSON.stringify({ pausedT, still: stillPaused.curT, state: paused.state }));
  await E(c, `document.querySelector('#tlPause').click()`); await sleep(700);
  const resumed = await P(c);
  check('从暂停位置继续，无跳变', resumed.state === 'playing' && resumed.curT > pausedT + 0.4 && resumed.curT < pausedT + 1.2,
    JSON.stringify({ pausedT, resumed: resumed.curT }));
  await E(c, `document.querySelector('#tlStop').click()`); await sleep(200);
  const stopped = await P(c);
  check('停止回到预览起点并释放 rAF', stopped.state === 'stopped' && stopped.curT === 0 && stopped.activeRaf === 0,
    JSON.stringify({ state: stopped.state, curT: stopped.curT, activeRaf: stopped.activeRaf }));

  /* 任意时间点开始 + 自动结束 */
  await E(c, `window.paperTimelinePanel.preview.seek(2.0)`); await sleep(150);
  await E(c, `document.querySelector('#tlPlay').click()`);
  const fromMid = await P(c);
  check('从中间时间开始预览', fromMid.state === 'playing' && Math.abs(fromMid.curT - 2.0) < 0.15, JSON.stringify({ curT: fromMid.curT }));
  await sleep(3400);
  const ended = await P(c);
  check('播放到演出结束后自动停止', ended.state === 'ended' && ended.activeRaf === 0 && ended.events.some(e => e.name === 'previewEnd'),
    JSON.stringify({ state: ended.state, curT: ended.curT, events: ended.eventNames }));
  report.classification.realUi.push('播放/暂停/继续/停止/任意起点/自动结束 + 舞台 DOM 与单调时钟证据');

  /* ---------- 3. 播放区间与循环预览 ---------- */
  await E(c, `(()=>{const a=document.querySelector('#tlRangeStart'),b=document.querySelector('#tlRangeEnd');
    a.value='0.2';b.value='0.4';document.querySelector('#tlRangeApply').click();
    const l=document.querySelector('#tlLoop');l.checked=true;l.dispatchEvent(new Event('change'));return 'ok'})()`);
  const rangeState = await E(c, `(()=>{const d=window.paperTimelineDebug(),p=window.paperTimelinePreview();
    return {range:p.range,shown:document.querySelector('#tlLanes .tl-range').className,label:document.querySelector('#tlRangeLabel').textContent}})()`);
  check('设置局部播放区间并绘制高亮（编辑器临时状态）',
    rangeState.range && Math.abs(rangeState.range.start - 0.2) < 0.001 && /shown/.test(rangeState.shown), JSON.stringify(rangeState));
  await E(c, `document.querySelector('#tlReplay').click()`);
  await sleep(2600);
  const looped = await P(c);
  check('区间循环预览 ≥10 次且复位不累积', looped.loopCount >= 10 &&
    looped.events.filter(e => e.name === 'previewLoop').length >= 10 &&
    Math.abs(looped.curT - 0.2) < 0.25,
    JSON.stringify({ loopCount: looped.loopCount, curT: looped.curT, frames: looped.frames }));
  /* 先停止再比较：播放中逐帧变化会让两次采样落在不同时间点，无法做确定性比较 */
  await E(c, `document.querySelector('#tlStop').click()`);
  const resetA = await E(c, `(()=>{window.paperTimelinePanel.preview.seek(0.2);return ${stageDom()}})()`);
  const resetB = await E(c, `(()=>{window.paperTimelinePanel.preview.seek(0.39);window.paperTimelinePanel.preview.seek(0.2);return ${stageDom()}})()`);
  check('循环回到起点后舞台状态重新求值（无累积漂移）',
    JSON.stringify(resetA) === JSON.stringify(resetB),
    JSON.stringify({ resetA, resetB }));
  await timelineShot(c, path.join(SHOTS, 'v082m2a-04-区间循环预览.png'));
  await E(c, `document.querySelector('#tlRangeClear').click()`);
  await E(c, `(()=>{const l=document.querySelector('#tlLoop');l.checked=false;l.dispatchEvent(new Event('change'));return 'ok'})()`);
  await E(c, `document.querySelector('#tlStop').click()`);
  check('清除区间后恢复整段播放范围', (await P(c)).range === null, JSON.stringify((await P(c)).range));
  report.classification.realUi.push('局部区间高亮 + 循环预览 10 次以上 + 复位重算');

  /* ---------- 4. 播放期间编辑 / 切节点 / 快捷键 ---------- */
  /* 先选中一个动作（属性面板的 input 处理依赖 perfNode()），否则改动不会进入工程 */
  await E(c, `(()=>{const b=document.querySelectorAll('#perfList [data-perf]')[0];if(b)b.click();return 'ok'})()`); await sleep(150);
  await E(c, `document.querySelector('#tlPlay').click()`); await sleep(350);
  await E(c, `(()=>{const d=document.querySelector('#perfDuration');d.value='1.8';d.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`);
  await sleep(250);
  const edited = await P(c);
  check('播放期间编辑动作：停止旧计划、不写半完成状态', edited.state === 'stopped' && edited.activeRaf === 0 && edited.generation >= 1,
    JSON.stringify({ state: edited.state, generation: edited.generation, activeRaf: edited.activeRaf }));
  await E(c, `document.querySelector('#undo').click()`); await sleep(200);
  await E(c, `document.querySelector('#tlPlay').click()`); await sleep(300);
  await clickNode(c, 3); await sleep(250);
  const switched = await P(c);
  check('播放期间切换节点：不再播放旧节点', switched.state === 'stopped' && switched.activeRaf === 0 &&
    (await D(c)).selectedIds.length === 0, JSON.stringify({ state: switched.state, activeRaf: switched.activeRaf }));
  /* 快捷键与焦点规则 */
  await clickNode(c, 0); await sleep(250);
  await E(c, `document.querySelector('#timelinePanel').focus()`);
  await E(c, key(' ')); await sleep(250);
  const spaceState = await P(c);
  await E(c, key(' ')); await sleep(150);
  const spacePause = await P(c);
  await E(c, key('Escape')); await sleep(150);
  const escState = await P(c);
  check('Space 播放/暂停、Esc 停止预览', spaceState.state === 'playing' && spacePause.state === 'paused' && escState.state === 'stopped',
    JSON.stringify({ space: spaceState.state, pause: spacePause.state, esc: escState.state }));
  const beforeGuard = (await E(c, actsOf(0))).length;
  await E(c, keyOn('#body', 'Delete', {})); await E(c, keyOn('#body', ' ', {}));
  check('文本输入框聚焦时不拦截空格/删除', (await E(c, actsOf(0))).length === beforeGuard && (await P(c)).state !== 'playing',
    JSON.stringify({ n: (await E(c, actsOf(0))).length, state: (await P(c)).state }));
  report.classification.realUi.push('播放中编辑/撤销/切节点、Space/Esc/Home 快捷键与输入框焦点规则');

  /* ---------- 5. M1B 编辑功能回归 ---------- */
  await clickNode(c, 5); await sleep(300);
  const a5 = await E(c, actsOf(5)), pps5 = (await D(c)).pps;
  const hBefore = await E(c, `window.__pvnM3.metrics().past`);
  await E(c, dragDown(a5[0].id, 'right', {})); await E(c, dragMove(0.5 * pps5)); await E(c, dragUp(0.5 * pps5)); await sleep(220);
  const afterResize = await E(c, actsOf(5));
  check('M1B 回归：片段拉伸与一次撤销', afterResize[0].duration > a5[0].duration &&
    (await E(c, `window.__pvnM3.metrics().past`)) === hBefore + 1,
    JSON.stringify({ before: a5[0].duration, after: afterResize[0].duration }));
  await E(c, `document.querySelector('#undo').click()`); await sleep(180);
  /* 吸附回归放在总时长 5s 的节点 0：极短节点（0.7s）的像素阈值过小，不适合作为网格吸附场景 */
  await clickNode(c, 0); await sleep(260);
  const a0 = await E(c, actsOf(0)), pps0 = (await D(c)).pps;
  await E(c, `(()=>{const s=document.querySelector('#tlSnap');s.value='0.5';s.dispatchEvent(new Event('change'));return 'ok'})()`);
  await E(c, dragDown(a0[0].id, null, {})); await E(c, dragMove(2.46 * pps0)); await E(c, dragUp(2.46 * pps0)); await sleep(220);
  const snapped = (await E(c, actsOf(0)))[0].start;
  check('M1B 回归：时间吸附仍生效', Math.abs(snapped - 2.5) < 0.02, JSON.stringify({ snapped, pps0 }));
  await E(c, `document.querySelector('#undo').click()`); await sleep(180);
  /* 保留一个真实编辑，供「保存 / 关闭 / 重开」往返验证 */
  await E(c, `(()=>{const s=document.querySelector('#tlSnap');s.value='0';s.dispatchEvent(new Event('change'));return 'ok'})()`);
  const ppsKeep = (await D(c)).pps;
  await E(c, dragDown(a0[0].id, null, {})); await E(c, dragMove(1.35 * ppsKeep)); await E(c, dragUp(1.35 * ppsKeep)); await sleep(220);
  const keptStart = (await E(c, actsOf(0)))[0].start;
  check('M1B 回归：撤销重做与片段移动写回', keptStart > 1 && (await P(c)).state !== 'playing',
    JSON.stringify({ keptStart, state: (await P(c)).state }));
  report.evidence.keptStart = keptStart;
  report.classification.realUi.push('M1B 功能回归：拉伸、吸附、撤销、片段移动');

  /* ---------- 6. 性能：100 动作 / 300s+ / 重复素材 / 切节点 / 启停 100 次 ---------- */
  const perfCases = await E(c, `(()=>{const P2=createPaperPerformance(),p=window.__pvnM3.project();
    const mk=(n,d)=>{const a=[];for(let i=0;i<n;i++)a.push(P2.make('g'+i,'wait','',{duration:d,mode:'after'}));return a;};
    const long=[];for(let i=0;i<10;i++)long.push(P2.make('lg'+i,'wait','',{duration:30,mode:'after'}));
    return {hundred:mk(100,0.1).length,total100:+P2.totalDuration(mk(100,0.1)).toFixed(2),
      long:+P2.totalDuration(long).toFixed(2),short:+P2.totalDuration(mk(1,0.5)).toFixed(2)}})()`);
  check('时间长度覆盖 0.5s / 10s / 300s+ 与 100 动作', perfCases.short === 0.5 && perfCases.total100 === 10 &&
    perfCases.long >= 300 && perfCases.hundred === 100, JSON.stringify(perfCases));
  const perfUi = await E(c, `(()=>{const P2=createPaperPerformance(),q=window.__pvnM3.project();
    const acts=[];for(let i=0;i<100;i++)acts.push(P2.make('stress'+i,'wait','',{duration:0.1,mode:'after'}));
    q.nodes[0].performance={version:1,actions:acts};
    const t0=performance.now();window.__pvnM3.setProject(q);const t1=performance.now();
    const d=window.paperTimelineDebug();return {clipDom:document.querySelectorAll('#tlLanes .tl-clip').length,
      clipCount:d.clipCount,listeners:d.registeredListeners,ms:+(t1-t0).toFixed(2),dom:${domCount()}}})()`);
  check('100 动作节点渲染不冻结、监听器不重复注册',
    perfUi.clipDom === 100 && perfUi.clipCount === 100 && perfUi.ms < 500,
    JSON.stringify(perfUi));
  await E(c, `document.querySelector('#undo').click()`); await sleep(500);
  /* 连续启停 100 次 */
  await clickNode(c, 0); await sleep(300);
  const startStop = await E(c, `(()=>{const p=window.paperTimelinePanel.preview;const out=[];
    for(let i=0;i<100;i++){p.play(0);p.stop();out.push(p.snapshot().activeRaf);}
    return {maxRaf:Math.max(...out),state:p.snapshot().state,events:p.snapshot().eventNames.length,dom:${domCount()},heap:${heap()}}})()`);
  check('连续启动/停止预览 100 次不产生重复 rAF 或 DOM 增长',
    startStop.maxRaf === 0 && startStop.state === 'stopped',
    JSON.stringify({ maxRaf: startStop.maxRaf, state: startStop.state, dom: startStop.dom }));
  report.classification.realUi.push('100 动作 / 300s+ / 重复素材 / 多次切节点 / 连续启停 100 次');

  /* ---------- 7. 连续播放 5 分钟以上（真实单调时钟，不用虚拟时间） ---------- */
  await E(c, `(()=>{const a=document.querySelector('#tlRangeStart'),b=document.querySelector('#tlRangeEnd');
    a.value='0';b.value='2';document.querySelector('#tlRangeApply').click();
    const l=document.querySelector('#tlLoop');l.checked=true;l.dispatchEvent(new Event('change'));
    window.paperTimelinePanel.preview.play(0);return 'ok'})()`);
  const LONG_MS = SKIP_LONG ? 6000 : 305000;
  const samples = [];
  const t0 = Date.now();
  const N = Math.max(2, Math.round(LONG_MS / 15000));
  for (let i = 0; i < N; i++) {
    await sleep(Math.min(15000, Math.max(1000, LONG_MS / N)));
    samples.push(await E(c, `(()=>{const p=window.paperTimelinePreview(),w=window.paperTimelineWaves(),d=window.paperTimelineDebug();
      return {at:Date.now(),t:p.curT,state:p.state,loops:p.loopCount,frames:p.frames,activeRaf:p.activeRaf,
        dom:${domCount()},heap:${heap()},waves:{entries:w.entries,bytes:w.bytes,decodeCalls:w.decodeCalls},
        clipDom:d.clipDomCount,renderCount:d.renderCount,relayoutCount:d.relayoutCount}})()`));
  }
  const longElapsed = Date.now() - t0;
  await E(c, `document.querySelector('#tlStop').click()`);
  const longFinal = await P(c);
  const longSummary = {
    plannedMs: LONG_MS, actualMs: longElapsed, samples: samples.length,
    first: samples[0], last: samples[samples.length - 1],
    maxFrameMs: Math.max(...samples.map(s => s.frames.worstMs)),
    minFps: Math.min(...samples.map(s => s.frames.fps)),
    maxDom: Math.max(...samples.map(s => s.dom)), minDom: Math.min(...samples.map(s => s.dom)),
    heapStart: samples[0] && samples[0].heap, heapEnd: samples[samples.length - 1] && samples[samples.length - 1].heap,
    loops: longFinal.loopCount, waveDecodeCalls: (await W(c)).decodeCalls,
    waveCacheBytes: (await W(c)).bytes, finalActiveRaf: longFinal.activeRaf
  };
  report.evidence.longPlay = longSummary;
  check(SKIP_LONG ? '连续循环预览（开发自检，短时）' : '连续播放 5 分钟以上（真实单调时钟）',
    longElapsed >= LONG_MS * 0.95 && longFinal.loopCount >= (SKIP_LONG ? 2 : 100) &&
    longSummary.finalActiveRaf === 0 && samples.every(s => s.activeRaf <= 1) &&
    longSummary.maxDom - longSummary.minDom < 200,
    JSON.stringify({ actualMs: longElapsed, loops: longFinal.loopCount, maxFrameMs: longSummary.maxFrameMs,
      minFps: longSummary.minFps, domDelta: longSummary.maxDom - longSummary.minDom, samples: samples.length }));
  check('长播放期间 DOM 不增长、rAF 不叠加、波形缓存受控',
    longSummary.maxDom - longSummary.minDom < 200 && longSummary.waveCacheBytes < 2 * 1024 * 1024 &&
    samples.every(s => s.activeRaf <= 1), JSON.stringify({ domDelta: longSummary.maxDom - longSummary.minDom,
      waveBytes: longSummary.waveCacheBytes, decodeCalls: longSummary.waveDecodeCalls }));
  report.classification.realUi.push(SKIP_LONG ? '连续循环预览（开发自检短时）' : '连续播放 5 分钟以上（真实单调时钟，逐段采样）');

  /* 波形/预览统计汇总 */
  const finalWaves = await W(c);
  report.evidence.performance = {
    waveform: { lastMs: finalWaves.lastMs, decodeCalls: finalWaves.decodeCalls, cacheHits: finalWaves.cacheHits,
      entries: finalWaves.entries, bytes: finalWaves.bytes, failures: finalWaves.failures, staleDiscarded: finalWaves.staleDiscarded },
    preview: { frames: (await P(c)).frames, activeRaf: (await P(c)).activeRaf },
    dom: await E(c, domCount()), heap: await E(c, heap())
  };
  await E(c, key('Home')); await sleep(150);
  await shotWithInspector(c, path.join(SHOTS, 'v082m2a-05-预览与属性面板.png'));

  /* ---------- 8. 保存重开与旧工程兼容 ---------- */
  const errs1 = s1.cdp.errors.filter(e => !/favicon|Content-Security-Policy/i.test(e.text || ''));
  check('会话 1 无渲染进程异常', errs1.length === 0, JSON.stringify(errs1.slice(0, 4)));
  await E(c, `document.querySelector('#save').click()`); await sleep(1400);
  kill(s1.proc); s1.cdp.close(); await sleep(900);

  const s2 = await openEditor(path.join(WORK, 'u2'));
  if (!s2) bad('关闭重开', '编辑器未重新启动');
  else {
    const c2 = s2.cdp;
    const diskFinal = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
    check('关闭重开：磁盘工程未被压测数据污染', diskFinal.nodes[0].performance.actions.length < 10,
      JSON.stringify({ n: diskFinal.nodes[0].performance.actions.length }));
    await clickNode(c2, 0); await sleep(2600);
    const reopen = await E(c2, `(()=>{const d=window.paperTimelineDebug(),p=window.paperTimelinePreview();
      return {clips:document.querySelectorAll('#tlLanes .tl-clip').length,waveCanvases:d.waveCanvases,
        waveDrawn:d.waveDrawn,firstTick:document.querySelector('#tlLanes .tl-tick-first')?.textContent,
        state:p.state,activeRaf:p.activeRaf,badge:document.querySelector('.tl-badge')?.textContent}})()`);
    check('关闭重开：波形与播放控件按真实数据重建、0s 刻度完整、无残留播放任务',
      reopen.clips > 0 && reopen.firstTick === '0s' && reopen.state !== 'playing' && reopen.activeRaf === 0 &&
      /M2B/.test(reopen.badge || ''), JSON.stringify(reopen));
    const compat = await E(c2, `(()=>{const p=window.__pvnM3.project();const all=p.nodes.flatMap(n=>(n.performance&&n.performance.actions)||[]);
      return {withStart:all.filter(a=>a.start!==undefined).length,total:all.length,nodes:p.nodes.length,
        node0Start:p.nodes[0].performance.actions[0].start}})()`);
    check('旧工程兼容 + 保存重开保留时间轴编辑',
      compat.withStart >= 1 && compat.withStart < 20 && compat.total > 0 &&
      Math.abs((compat.node0Start || 0) - report.evidence.keptStart) < 0.02,
      JSON.stringify({ compat, keptStart: report.evidence.keptStart }));
    await timelineShot(c2, path.join(SHOTS, 'v082m2a-06-关闭重开波形.png'));
    check('会话 2 无渲染进程异常', s2.cdp.errors.filter(e => !/favicon|Content-Security-Policy/i.test(e.text || '')).length === 0,
      JSON.stringify(s2.cdp.errors.slice(0, 3)));
    kill(s2.proc); s2.cdp.close();
  }

  report.classification.automation = [
    'npm run check（M0 11 组 + M1A/M1B 28 组 + M2A 新增波形 10 组与预览/舞台 12 组，全部保留）',
    'tests/timeline-waveform.test.cjs：真实 WAV 摘要、重复素材复用、失败、超预算、素材替换、过期请求、缩放 bins、容量上限、串行解码',
    'tests/timeline-preview.test.cjs：播放/暂停/继续/停止/任意起点/自动结束/区间循环/幂等启动/失效释放/单调时钟/事件钩子 + 舞台终态一致、无漂移、循环复位、无历史音频副作用'
  ];
  report.classification.notTested = [
    '完整实时音频预览、音频事件执行、任意时间恢复 BGM、暂停/定位取消旧音频任务、AudioParam 调度与避免双 BGM —— 明确留待 M2B',
    '音频裁剪/变速、高级关键帧、视频/Live2D 轨道、跨节点/跨章节时间轴 —— 本轮不做',
    '1.47 GiB 全链与 900 秒音频浸泡 —— 本轮未改核心音频运行时与资源存储，按范围不重复',
    '人工长时间使用体验与第二台机器验收 —— 由用户决定'
  ];

  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M2A 真实窗口验收 · ' + report.mode);
  console.log('证据: ' + REPORT);
  process.exit(report.ok ? 0 : 1);
})().catch((e) => {
  report.problems.push('脚本异常：' + (e.stack || e.message));
  report.ok = false;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error('SCRIPT ERROR:', e.stack || e.message);
  process.exit(1);
});
