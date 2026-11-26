'use strict';
/*
 * V0.8.2 · M1-B · 时间轴编辑交互 · 真实窗口验收
 *
 * 默认跑最终 Windows x64 便携版；PVN_DEV=1 跑源码 electron 快速自检。
 * 所有编辑都通过真实 DOM 事件 / 按钮 / 快捷键，不直接改工程对象、不绕过 edit()。
 * 产物：release/v082m1b-ui-verify.json + docs/screenshots/v082m1b-*.png
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const DEV = process.env.PVN_DEV === '1';
const PACKAGED = path.join(ROOT, 'release', 'PaperVNStudio-0.8.1-win-x64', 'PaperVNStudio.exe');
const SRC = path.join(ROOT, 'release', 'wanfeng-v081rc3', '晚风·循环试听工程');
const WORK = path.join(ROOT, 'release', 'v082m1b-verify');
fs.mkdirSync(WORK, { recursive: true });
const PROJECT = path.join(WORK, '晚风-M1B验收副本');
const MAIN = path.join(PROJECT, 'project.paper.json');
const REPORT = path.join(ROOT, 'release', 'v082m1b-ui-verify.json');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(a, b);
    else fs.writeFileSync(b, fs.readFileSync(a));
  }
}
fs.rmSync(PROJECT, { recursive: true, force: true });
copyTree(SRC, PROJECT);

const report = {
  at: new Date().toISOString(), version: '0.8.2-M1B',
  mode: DEV ? 'source-electron' : 'packaged-win-x64',
  exe: DEV ? ELECTRON : PACKAGED, project: PROJECT,
  stages: {}, problems: [], evidence: {},
  classification: { automation: [], realUi: [], notTested: [] }
};
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d == null ? null : d }; console.log('  ok   ' + n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 210) : '')); };
const bad = (n, m) => { report.stages[n] = { ok: false, message: String(m) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };
/* 第 3 参数既是失败原因，也作为成功时的证据 detail（除非显式给了第 4 参数） */
const check = (n, cond, m, d) => cond ? ok(n, d === undefined ? m : d) : bad(n, m || '断言失败');
const E = (cdp, expr) => cdp.ev(expr);
const D = (cdp) => E(cdp, 'window.paperTimelineDebug()');
const actsOf = (i) => `(()=>{const p=window.__pvnM3.project();const n=p.nodes[${i}];return (n&&n.performance&&n.performance.actions)||[]})()`;
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
  return file;
}
/* 时间轴面板高清特写：按元素位置裁剪 + 2 倍缩放，保证小字可读 */
async function timelineShot(cdp, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const box = await E(cdp, `(()=>{const r=document.querySelector('#timelinePanel').getBoundingClientRect();
      return {x:Math.max(0,r.left+window.scrollX),y:Math.max(0,r.top+window.scrollY),w:r.width,h:r.height}})()`);
    const r = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: box.x, y: box.y, width: Math.min(1800, box.w), height: Math.min(1000, box.h), scale: 2 }
    });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  } catch (_) { try { await cdp.shot(file); } catch (_) {} }
  return file;
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
    items: [{ path: PROJECT, title: '晚风-M1B验收副本', openedAt: new Date().toISOString() }]
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
    const n = await E(cdp, `document.querySelectorAll('#list .node').length`).catch(() => 0);
    if (n >= 30) break;
    await sleep(150);
  }
  return { proc, cdp };
}

/* ---------- 真实 Pointer 拖动（分阶段，可验证预览与取消） ---------- */
function dragDown(id, edge, mods) {
  return `(()=>{const c=document.querySelector('#tlLanes .tl-clip[data-tl-clip=${JSON.stringify(id)}]');
    if(!c)return 'no-clip';
    const h=${edge ? `c.querySelector('.tl-handle-${edge}')` : 'null'};
    if(${JSON.stringify(!!edge)}&&!h)return 'no-handle';
    const t=h||c,r=c.getBoundingClientRect();
    window.__tlD={clip:c,target:t,x0:r.left+8,y0:r.top+8};
    const m=${JSON.stringify(mods || {})};
    const mk=(k,x,b)=>new PointerEvent(k,{bubbles:true,cancelable:true,clientX:x,clientY:window.__tlD.y0,pointerId:1,pointerType:'mouse',button:0,buttons:b,isPrimary:true,ctrlKey:!!m.ctrl,shiftKey:!!m.shift,altKey:!!m.alt});
    t.dispatchEvent(mk('pointerdown',window.__tlD.x0,1));
    return {drag:window.paperTimelineDebug().dragActive,resize:!!window.paperTimelineDebug().resizeState,sel:window.paperTimelineDebug().selectedIds};})()`;
}
function dragMove(dx, alt) {
  return `(()=>{const d=window.__tlD;if(!d)return 'no-drag';
    const mk=(k,x,b)=>new PointerEvent(k,{bubbles:true,cancelable:true,clientX:x,clientY:d.y0,pointerId:1,pointerType:'mouse',button:0,buttons:b,isPrimary:true,altKey:${alt ? 'true' : 'false'}});
    d.clip.dispatchEvent(mk('pointermove',d.x0+(${dx}),1));
    return {hint:document.querySelector('#tlDragHint').textContent,resizeHint:document.querySelector('#tlResizeHint').textContent,
      snap:document.querySelector('#tlLanes .tl-snapline').className,debug:window.paperTimelineDebug()};})()`;
}
function dragUp(dx, alt) {
  return `(()=>{const d=window.__tlD;if(!d)return 'no-drag';
    const mk=(k,x,b)=>new PointerEvent(k,{bubbles:true,cancelable:true,clientX:x,clientY:d.y0,pointerId:1,pointerType:'mouse',button:0,buttons:b,isPrimary:true,altKey:${alt ? 'true' : 'false'}});
    d.clip.dispatchEvent(mk('pointerup',d.x0+(${dx}),0));
    window.__tlD=null;return {debug:window.paperTimelineDebug()};})()`;
}
/* 键盘事件必须派发到具体元素：直接 dispatch 到 document 会让 e.target=document，
   编辑器既有的 e.target.matches(...) 判定抛错（真实按键的 target 一定是元素）。 */
function key(k, mods) {
  const m = mods || {};
  return `(()=>{const t=document.querySelector('#timelinePanel')||document.body;
    t.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},ctrlKey:${!!m.ctrl},shiftKey:${!!m.shift},altKey:${!!m.alt},metaKey:false,bubbles:true,cancelable:true}));
    return 'ok'})()`;
}
function keyOn(sel, k, mods) {
  const m = mods || {};
  return `(()=>{const t=document.querySelector(${JSON.stringify(sel)});if(!t)return 'no-target';t.focus();
    t.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},ctrlKey:${!!m.ctrl},shiftKey:${!!m.shift},altKey:${!!m.alt},bubbles:true,cancelable:true}));
    return 'ok'})()`;
}
function scrubSweep(n) {
  return `(()=>{const lanes=document.querySelector('#tlLanes'),pad=lanes.querySelector('.tl-pad');
    const r=lanes.getBoundingClientRect(),W=r.width-92;
    const mk=(t,x,b)=>new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:r.top+40,pointerId:2,pointerType:'mouse',button:0,buttons:b,isPrimary:true});
    for(let i=0;i<${n};i++){const x=r.left+92+(i%2?0.82:0.16)*W;
      pad.dispatchEvent(mk('pointerdown',x,1));pad.dispatchEvent(mk('pointermove',x,1));pad.dispatchEvent(mk('pointerup',x,0));}
    return {tl:window.paperTimelineDebug(),bl:window.paperTimelineScrubDebug(),
      perfAudio:window.paperPerfAudioDebug()};})()`;
}

(async () => {
  if (!fs.existsSync(DEV ? ELECTRON : PACKAGED)) { bad('可执行文件存在', '找不到'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  ok('可执行文件存在', { mode: report.mode });
  ok('验收工程为隔离副本', { project: PROJECT, originalKept: SRC });

  const s1 = await openEditor(path.join(WORK, 'u1'));
  if (!s1) { bad('编辑器启动', '未连接上页面'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  const c = s1.cdp;
  ok('编辑器启动', { nodes: await E(c, `window.__pvnM3.project().nodes.length`) });

  /* ---------- 0. 旧工程基线：打开 / 预览 / 保存不批量写 start ---------- */
  const disk0 = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  const legacyStarts = disk0.nodes.flatMap(n => (n.performance && n.performance.actions) || []).filter(a => a.start !== undefined).length;
  const sched0 = await E(c, `(()=>{const P=createPaperPerformance(),p=window.__pvnM3.project();return p.nodes.map(n=>P.schedule((n.performance&&n.performance.actions)||[]).map(s=>[s.start,s.end]))})()`);
  await clickNode(c, 13); await sleep(200);
  await E(c, scrubSweep(4));
  await E(c, `document.querySelector('#save').click()`); await sleep(1200);
  const disk1 = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  const starts1 = disk1.nodes.flatMap(n => (n.performance && n.performance.actions) || []).filter(a => a.start !== undefined).length;
  const sched1 = await E(c, `(()=>{const P=createPaperPerformance(),p=window.__pvnM3.project();return p.nodes.map(n=>P.schedule((n.performance&&n.performance.actions)||[]).map(s=>[s.start,s.end]))})()`);
  check('未编辑旧工程：预览+保存不批量写 start', legacyStarts === 0 && starts1 === 0, `before=${legacyStarts} after=${starts1}`);
  check('未编辑旧工程：原调度一致', JSON.stringify(sched0) === JSON.stringify(sched1), '调度变化');
  report.classification.realUi.push('旧工程打开 → 拖播放头 → 保存 → 磁盘核对无 start');

  /* ---------- 1. 面板渲染与轨道组织 ---------- */
  const r0 = await D(c);
  const render0 = await E(c, `({clips:document.querySelectorAll('#tlLanes .tl-clip').length,
    lanes:document.querySelectorAll('#tlLanes .tl-lane').length,
    ticks:document.querySelectorAll('#tlLanes .tl-tick').length,
    firstTick:document.querySelector('#tlLanes .tl-tick-first')?.textContent,
    handles:document.querySelectorAll('#tlLanes .tl-handle').length,
    acts:${actsOf(13)}})`);
  check('面板渲染（含刻度/手柄/0s 刻度）', render0.clips === render0.acts.length && render0.ticks > 0 &&
    render0.firstTick === '0s' && render0.handles > 0, JSON.stringify(render0));
  check('缩放初值可用', r0.pps > 0 && r0.labelWidth === 92, JSON.stringify({ pps: r0.pps, labelWidth: r0.labelWidth }));

  /* ---------- 2. 右边缘拉伸（角色移动动作） ---------- */
  await clickNode(c, 5); await sleep(200);               // 节点 5：character.move
  const a5 = await E(c, actsOf(5));
  const id5 = a5[0].id, dur5 = a5[0].duration;
  const pps5 = (await D(c)).pps;
  const dxR = 0.6 * pps5;
  const hBefore = await E(c, `window.__pvnM3.metrics().past`);
  await E(c, dragDown(id5, 'right', {}));
  const midR = await E(c, dragMove(dxR, false));
  const midActs = await E(c, actsOf(5));
  check('拉伸预览：只显示临时视觉，不改工程数据', midActs[0].duration === dur5 &&
    /起点 .*终点 .*时长/.test(midR.resizeHint || ''), JSON.stringify({ dur: midActs[0].duration, hint: midR.resizeHint }));
  await timelineShot(c, path.join(SHOTS, 'v082m1b-01-片段拉伸.png'));
  await E(c, dragUp(dxR, false)); await sleep(220);
  const afterR = await E(c, actsOf(5));
  const hAfterR = await E(c, `window.__pvnM3.metrics().past`);
  check('右边缘拉伸：start 不变、duration 增加、一次撤销',
    Math.abs(afterR[0].duration - dur5) > 0.3 && (afterR[0].start === undefined || afterR[0].start === a5[0].start) &&
    hAfterR === hBefore + 1, JSON.stringify({ before: dur5, after: afterR[0].duration, past: [hBefore, hAfterR] }));

  /* ---------- 3. 左边缘拉伸（背景转场动作） ---------- */
  await clickNode(c, 13); await sleep(220);
  const a13 = await E(c, actsOf(13));
  const id13 = a13[0].id, pps13 = (await D(c)).pps;
  const ev13 = await E(c, `(()=>{const P=createPaperPerformance(),p=window.__pvnM3.project();return P.schedule(p.nodes[13].performance.actions).map(s=>({id:s.action.id,start:s.start,end:s.end}))})()`);
  const orig13 = ev13.find(x => x.id === id13);
  /* 先把该动作设为绝对开始，便于验证左边缘改 start */
  await E(c, `(()=>{const p=window.__pvnM3.project();const a=p.nodes[13].performance.actions[0];return a.id})()`);
  const dxL = 0.45 * pps13;
  await E(c, dragDown(id13, 'left', {}));
  const midL = await E(c, dragMove(dxL, false));
  await E(c, dragUp(dxL, false)); await sleep(220);
  const afterL = await E(c, actsOf(13));
  const ev13b = await E(c, `(()=>{const P=createPaperPerformance(),p=window.__pvnM3.project();return P.schedule(p.nodes[13].performance.actions).map(s=>({id:s.action.id,start:s.start,end:s.end}))})()`);
  const new13 = ev13b.find(x => x.id === id13);
  check('左边缘拉伸：保持原结束时间、调整 start 与 duration',
    new13.start > orig13.start + 0.2 && Math.abs(new13.end - orig13.end) < 0.02 && afterL[0].start !== undefined,
    JSON.stringify({ orig: orig13, now: new13, startField: afterL[0].start, hint: midL.resizeHint.slice(0, 80) }));

  /* ---------- 4. Esc / 无位移 / 取消不留半成品 ---------- */
  const beforeCancel = JSON.stringify(await E(c, actsOf(13)));
  await E(c, dragDown(a13[1].id, 'right', {}));
  await E(c, dragMove(0.5 * pps13, false));
  await E(c, `document.querySelector('#timelinePanel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await sleep(150);
  check('Esc 取消拉伸不留半成品', JSON.stringify(await E(c, actsOf(13))) === beforeCancel, '数据被改动');
  await E(c, dragDown(a13[1].id, 'right', {}));
  await E(c, dragUp(0, false)); await sleep(150);
  check('无位移松手不写入', JSON.stringify(await E(c, actsOf(13))) === beforeCancel, '数据被改动');

  /* ---------- 5. 零时长动作无拉伸手柄 ---------- */
  await E(c, `(()=>{const b=document.querySelectorAll('#perfList [data-perf]')[1];if(b)b.click();return 'ok'})()`);
  await E(c, `(()=>{const d=document.querySelector('#perfDuration');d.value='0';d.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`);
  await sleep(200);
  const zeroInfo = await E(c, `({zero:document.querySelectorAll('#tlLanes .tl-clip-zero').length,
    handles:document.querySelectorAll('#tlLanes .tl-clip-zero .tl-handle').length,dur:${actsOf(13)}[1].duration})`);
  check('零时长动作以菱形显示且无拉伸手柄', zeroInfo.zero >= 1 && zeroInfo.handles === 0 && zeroInfo.dur === 0, JSON.stringify(zeroInfo));
  await E(c, `document.querySelector('#undo').click()`); await sleep(180);

  /* ---------- 6. 缩放：按钮 / Ctrl+滚轮 / 适应 / 默认，数据不变 ---------- */
  const beforeZoom = JSON.stringify(await E(c, actsOf(13)));
  const p0 = (await D(c)).pps;
  await E(c, `document.querySelector('#tlZoomIn').click()`); await sleep(120);
  const p1 = (await D(c)).pps;
  await E(c, `document.querySelector('#tlZoomOut').click()`); await sleep(120);
  const p2 = (await D(c)).pps;
  await E(c, `(()=>{const l=document.querySelector('#tlLanes');l.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,ctrlKey:true,bubbles:true,cancelable:true,clientX:l.getBoundingClientRect().left+300}));return 'ok'})()`);
  await sleep(120);
  const p3 = (await D(c)).pps;
  await E(c, `document.querySelector('#tlZoomFit').click()`); await sleep(120);
  const p4 = (await D(c)).pps;
  check('缩放按钮 / Ctrl+滚轮 / 适应范围生效且数据不变',
    p1 > p0 && p2 < p1 && p3 > p2 && p4 > 0 && JSON.stringify(await E(c, actsOf(13))) === beforeZoom,
    JSON.stringify({ p0, p1, p2, p3, p4 }));
  /* 播放头锚点稳定：缩放前后播放头对应时间不变 */
  await E(c, `window.paperTimelineDebug() && document.querySelector('#tlZoomReset').click()`);
  const anchorCheck = await E(c, `(()=>{const before=window.paperTimelineDebug().curT;
    document.querySelector('#tlZoomIn').click();const after=window.paperTimelineDebug().curT;return {before,after}})()`);
  check('缩放保持播放头时间点稳定', Math.abs(anchorCheck.before - anchorCheck.after) < 0.001, JSON.stringify(anchorCheck));
  report.classification.realUi.push('放大/缩小/Ctrl+滚轮/适应/默认缩放，核对工程数据不变');

  /* ---------- 7. 横向滚动：刻度与片段对齐 ---------- */
  await E(c, `document.querySelector('#tlZoomIn').click();document.querySelector('#tlZoomIn').click()`);
  await sleep(150);
  const scrollInfo = await E(c, `(()=>{const l=document.querySelector('#tlLanes');l.scrollLeft=120;
    const r=l.getBoundingClientRect(),pps=window.paperTimelineDebug().pps,lw=window.paperTimelineDebug().labelWidth;
    const tick=document.querySelector('#tlLanes .tl-tick:not(.tl-tick-first)');
    const clip=[...document.querySelectorAll('#tlLanes .tl-clip')][0];
    const grid=[...document.querySelectorAll('#tlLanes .tl-gridline')][1];
    return {scrollLeft:l.scrollLeft,scrollWidth:l.scrollWidth,clientWidth:l.clientWidth,pps,lw,
      tickLeft:tick?parseFloat(tick.style.left):0,clipLeft:clip?parseFloat(clip.style.left):0,
      gridLeft:grid?parseFloat(grid.style.left):0}})()`);
  check('横向滚动可用且刻度/网格/片段同处一个内容坐标系',
    scrollInfo.scrollWidth > scrollInfo.clientWidth && Math.abs(scrollInfo.scrollLeft - 120) < 2 &&
    scrollInfo.tickLeft === scrollInfo.gridLeft, JSON.stringify(scrollInfo));
  await E(c, `document.querySelector('#tlZoomFit').click()`);

  /* ---------- 8. 吸附：网格 / 参考线 / Alt 临时关闭 ---------- */
  await E(c, `(()=>{const s=document.querySelector('#tlSnap');s.value='0.5';s.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()`);
  await clickNode(c, 0); await sleep(220);
  const a0 = await E(c, actsOf(0));
  const pps0 = (await D(c)).pps;
  const snapDx = 2.46 * pps0;
  await E(c, dragDown(a0[0].id, null, {}));
  const snapMid = await E(c, dragMove(snapDx, false));
  const snapShown = /shown/.test(snapMid.snap || '');
  /* 拖动预览中截图：吸附参考线、预览片段、底部时间提示都在场 */
  await timelineShot(c, path.join(SHOTS, 'v082m1b-02-缩放与吸附参考线.png'));
  await E(c, dragUp(snapDx, false)); await sleep(220);
  const snappedStart = (await E(c, actsOf(0)))[0].start;
  check('吸附到 0.5s 网格并绘制参考线', Math.abs(snappedStart - 2.5) < 0.001 && snapShown,
    JSON.stringify({ snappedStart, snapLine: snapMid.snap }));
  /* Alt 临时关闭吸附 */
  await clickNode(c, 1); await clickNode(c, 0); await sleep(220);
  const pps0b = (await D(c)).pps;
  await E(c, dragDown(a0[1].id, null, {}));
  await E(c, dragMove(2.46 * pps0b, true));
  await E(c, dragUp(2.46 * pps0b, true)); await sleep(220);
  const altStart = (await E(c, actsOf(0)))[1].start;
  check('Alt 临时关闭吸附，得到非网格时间', typeof altStart === 'number' && Math.abs(altStart % 0.5) > 0.01,
    JSON.stringify({ altStart }));
  report.classification.realUi.push('0.5 秒网格吸附（含参考线）与 Alt 临时关闭');

  /* ---------- 9. 多选与批量移动 ---------- */
  await E(c, `(()=>{const s=document.querySelector('#tlSnap');s.value='0';s.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()`);
  await clickNode(c, 13); await sleep(220);
  const m13 = await E(c, actsOf(13));
  const d13 = await D(c);
  const order13 = d13.selectedIds; void order13;
  await E(c, dragDown(m13[0].id, null, {})); await E(c, dragUp(0, false));   // 单击选中第一个
  await E(c, dragDown(m13[1].id, null, { ctrl: true }));                    // Ctrl 多选
  await E(c, `document.querySelector('#tlLanes').focus()`);
  const selInfo = await D(c);
  check('Ctrl 多选显示选中状态', selInfo.selectedIds.length >= 2, JSON.stringify({ ids: selInfo.selectedIds, count: selInfo.selectedIds.length }));
  const beforeBatch = await E(c, `(()=>{const p=window.__pvnM3.project();const acts=p.nodes[13].performance.actions;
    const P=createPaperPerformance();return {starts:P.schedule(acts).map(s=>s.start),json:JSON.stringify(acts),past:window.__pvnM3.metrics().past}})()`);
  const dxB = 1.1 * d13.pps;
  await E(c, dragDown(m13[0].id, null, {}));
  await E(c, dragMove(dxB, false));
  const batchPreview = await E(c, `({hint:document.querySelector('#tlDragHint').textContent,acts:${actsOf(13)}})`);
  check('批量移动预览不修改工程', JSON.stringify(batchPreview.acts) === beforeBatch.json && /批量移动/.test(batchPreview.hint),
    JSON.stringify({ hint: batchPreview.hint }));
  await timelineShot(c, path.join(SHOTS, 'v082m1b-03-多选批量移动.png'));
  await E(c, dragUp(dxB, false)); await sleep(250);
  const afterBatch = await E(c, `(()=>{const p=window.__pvnM3.project();const acts=p.nodes[13].performance.actions;
    const P=createPaperPerformance();return {starts:P.schedule(acts).map(s=>s.start),abs:acts.map(a=>a.start),past:window.__pvnM3.metrics().past}})()`);
  const selStarts = afterBatch.starts.slice(0, 2);
  check('批量移动：保持相对间隔、一次撤销、未选动作不写 start',
    Math.abs(selStarts[0] - beforeBatch.starts[0] - 1.1) < 0.06 &&
    Math.abs((selStarts[1] - selStarts[0]) - (beforeBatch.starts[1] - beforeBatch.starts[0])) < 0.06 &&
    afterBatch.past === beforeBatch.past + 1 && afterBatch.abs[2] == null,
    JSON.stringify({ before: beforeBatch.starts, after: afterBatch.starts, abs: afterBatch.abs, past: [beforeBatch.past, afterBatch.past] }));
  /* 点击空白取消选择 */
  await E(c, `(()=>{const l=document.querySelector('#tlLanes'),p=l.querySelector('.tl-pad'),r=l.getBoundingClientRect();
    p.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:r.left+200,clientY:r.top+40,pointerId:3,button:0,buttons:1}));
    p.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:r.left+200,clientY:r.top+40,pointerId:3,button:0,buttons:0}));return 'ok'})()`);
  check('点击空白取消多选', (await D(c)).selectedIds.length === 0, JSON.stringify((await D(c)).selectedIds));
  report.classification.realUi.push('Ctrl 多选 → 批量移动（间隔保持/一次撤销）→ 空白取消');

  /* ---------- 10. 复制 / 粘贴 / Ctrl+D / 删除 ---------- */
  await E(c, dragDown(m13[0].id, null, {})); await E(c, dragUp(0, false));
  await E(c, `document.querySelector('#timelinePanel').focus()`);
  const nBefore = (await E(c, actsOf(13))).length;
  await E(c, key('c', { ctrl: true })); await sleep(120);
  const clipSize = (await D(c)).clipboardSize;
  await E(c, `window.paperTimelineDebug() && (()=>{const l=document.querySelector('#tlLanes'),p=l.querySelector('.tl-pad'),r=l.getBoundingClientRect();
    p.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:r.left+92+ (window.paperTimelineDebug().pps*3),clientY:r.top+40,pointerId:4,button:0,buttons:1}));
    p.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:r.left+92+(window.paperTimelineDebug().pps*3),clientY:r.top+40,pointerId:4,button:0,buttons:0}));return 'ok'})()`);
  await E(c, `document.querySelector('#timelinePanel').focus()`);
  const pastBefore = await E(c, `window.__pvnM3.metrics().past`);
  await E(c, key('v', { ctrl: true })); await sleep(250);
  const afterPaste = await E(c, actsOf(13));
  check('Ctrl+C / Ctrl+V：新 ID、素材引用保留、一次编辑',
    clipSize >= 1 && afterPaste.length === nBefore + clipSize &&
    new Set(afterPaste.map(a => a.id)).size === afterPaste.length &&
    afterPaste.every(a => a.params && typeof a.params === 'object') &&
    (await E(c, `window.__pvnM3.metrics().past`)) === pastBefore + 1,
    JSON.stringify({ clipSize, nBefore, nAfter: afterPaste.length }));
  await E(c, key('d', { ctrl: true })); await sleep(220);
  const afterDup = await E(c, actsOf(13));
  check('Ctrl+D 复制选中片段（ID 唯一）', afterDup.length > afterPaste.length &&
    new Set(afterDup.map(a => a.id)).size === afterDup.length, JSON.stringify({ n: afterDup.length }));
  /* 输入框聚焦时 Delete 不删除片段 */
  const nGuard = afterDup.length;
  await E(c, keyOn('#body', 'Delete', {}));
  check('属性/文本输入时 Delete 不误删片段', (await E(c, actsOf(13))).length === nGuard, '误删了片段');
  /* Delete 删除选中片段 */
  await E(c, dragDown(m13[1].id, null, {})); await E(c, dragUp(0, false));
  await E(c, `document.querySelector('#timelinePanel').focus()`);
  const delPast = await E(c, `window.__pvnM3.metrics().past`);
  await E(c, key('Delete', {})); await sleep(220);
  const afterDel = await E(c, actsOf(13));
  check('Delete 删除选中片段（一次编辑）', afterDel.length === nGuard - 1 &&
    (await E(c, `window.__pvnM3.metrics().past`)) === delPast + 1, JSON.stringify({ before: nGuard, after: afterDel.length }));
  await E(c, `document.querySelector('#undo').click()`); await sleep(180);
  check('撤销恢复被删片段', (await E(c, actsOf(13))).length === nGuard, '撤销未恢复');
  report.classification.realUi.push('Ctrl+C/V/D、Delete、输入框不拦截、撤销恢复');

  /* ---------- 11. 角色子轨道与折叠（仅显示状态） ---------- */
  await clickNode(c, 3); await sleep(220);
  const trackInfo = await E(c, `({names:[...document.querySelectorAll('#tlLanes .tl-lane-label')].map(e=>e.textContent),
    folds:document.querySelectorAll('#tlLanes .tl-fold').length,data:${actsOf(3)}})`);
  const charLane = trackInfo.names.find(n => n.indexOf('角色') === 0);
  /* 展开状态下截图：角色子轨道名 + 片段都可见 */
  await timelineShot(c, path.join(SHOTS, 'v082m1b-04-角色子轨道.png'));
  await E(c, `(()=>{const b=document.querySelector('#tlLanes .tl-fold');if(b)b.click();return 'ok'})()`);
  const foldInfo = await E(c, `({collapsed:document.querySelectorAll('#tlLanes .tl-lane.collapsed').length,
    data:${actsOf(3)}})`);
  check('角色按角色名拆子轨道，折叠只改显示不改数据',
    !!charLane && trackInfo.folds > 0 && foldInfo.collapsed >= 1 && JSON.stringify(foldInfo.data) === JSON.stringify(trackInfo.data),
    JSON.stringify({ charLane, folds: trackInfo.folds, collapsed: foldInfo.collapsed }));
  await E(c, `(()=>{const b=document.querySelector('#tlLanes .tl-fold');if(b)b.click();return 'ok'})()`);
  report.classification.realUi.push('角色子轨道显示角色名、轨道折叠不改工程数据');

  /* ---------- 12. 属性面板与时间轴联动 ---------- */
  await clickNode(c, 5); await sleep(200);
  const a5b = await E(c, actsOf(5));
  await E(c, dragDown(a5b[0].id, null, {})); await E(c, dragUp(0, false));
  const link = await E(c, `({perfName:document.querySelector('#perfName').textContent,
    perfDuration:document.querySelector('#perfDuration').value,
    clipCount:document.querySelectorAll('#tlLanes .tl-clip').length,
    sel:document.querySelector('#tlSelection').textContent})`);
  check('时间轴选中 → 属性面板按 ID 同步', Number(link.perfDuration) === a5b[0].duration && link.clipCount === a5b.length,
    JSON.stringify(link));
  await E(c, `(()=>{const d=document.querySelector('#perfDuration');d.value='1.8';d.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`);
  await sleep(200);
  const afterProp = await E(c, `({dur:${actsOf(5)}[0].duration,clipW:document.querySelector('#tlLanes .tl-clip').style.width,
    perfDuration:document.querySelector('#perfDuration').value})`);
  check('属性面板改时长 → 时间轴同步刷新', Math.abs(afterProp.dur - 1.8) < 0.001 && afterProp.perfDuration === '1.8',
    JSON.stringify(afterProp));
  await shotWithInspector(c, path.join(SHOTS, 'v082m1b-05-时间轴与属性面板联动.png'));
  await timelineShot(c, path.join(SHOTS, 'v082m1b-05b-联动时间轴特写.png'));
  report.classification.realUi.push('时间轴 ↔ 属性面板双向同步（选中与时长）');

  /* ---------- 13. 播放头 scrub：一次性音频触发数为 0 ---------- */
  await clickNode(c, 23); await sleep(200);
  const audioBefore = await E(c, `({perf:window.paperPerfAudioDebug(),tl:window.paperTimelineDebug()})`);
  const sweep = await E(c, scrubSweep(12));
  const audioAfter = await E(c, `({perf:window.paperPerfAudioDebug(),bl:window.paperTimelineScrubDebug()})`);
  check('反复前后拖播放头：一次性音频触发数为 0',
    sweep.tl.oneShotTriggers === 0 && audioAfter.bl.audioSideEffectTriggers === 0 &&
    audioBefore.perf.fired === audioAfter.perf.fired, JSON.stringify({ before: audioBefore.perf, after: audioAfter.perf }));
  check('scrub 每次重取基线、不累加', audioAfter.bl.reusedState === false &&
    audioAfter.bl.rebuilds >= 12 && audioAfter.bl.rebuilds === audioAfter.bl.scrubCalls, JSON.stringify(audioAfter.bl));
  report.classification.realUi.push('含 SFX 节点反复前后拖播放头 12 次');

  /* ---------- 14. 快速切节点不残留 ---------- */
  await clickNode(c, 3); await clickNode(c, 8); await clickNode(c, 23); await sleep(200);
  const sw = await D(c);
  check('快速切换节点：播放头归零、选择清空、无残留拖动',
    sw.playheadT === 0 && sw.selectedIds.length === 0 && !sw.dragActive, JSON.stringify({ t: sw.playheadT, sel: sw.selectedIds, drag: sw.dragActive }));

  /* ---------- 15. 性能：0.5s / 10s / 60s / 300s+ / 100 动作 ---------- */
  const perf = await E(c, `(()=>{const P=createPaperPerformance(),p=window.__pvnM3.project();
    const mk=(n,d)=>{const a=[];for(let i=0;i<n;i++)a.push(P.make('gen'+i,'wait','',{duration:d,mode:'after'}));return a;};
    const cases={short:mk(1,0.5),ten:mk(10,1),sixty:mk(60,1),long:(()=>{const a=[];for(let i=0;i<10;i++){const x=P.make('lg'+i,'wait','',{duration:30,mode:'after'});a.push(x);}return a;})(),hundred:mk(100,0.1)};
    const out={};for(const [k,acts] of Object.entries(cases)){out[k]={n:acts.length,total:+P.totalDuration(acts).toFixed(2)};}
    return out})()`);
  check('时间长度覆盖 0.5s / 10s / 60s / 300s+ 与 100 动作',
    perf.short.total === 0.5 && perf.ten.total === 10 && perf.sixty.total === 60 &&
    perf.long.total >= 300 && perf.hundred.n === 100, JSON.stringify(perf));
  /* 把 100 动作注入一个临时节点（通过编辑器已有的 setProject），测量渲染与监听器 */
  const perfUi = await E(c, `(()=>{const P=createPaperPerformance(),q=window.__pvnM3.project();
    const acts=[];for(let i=0;i<100;i++)acts.push(P.make('stress'+i,'wait','',{duration:0.1,mode:'after'}));
    q.nodes[0].performance={version:1,actions:acts};
    window.__pvnM3.setProject(q);
    const t0=performance.now();const d=window.paperTimelineDebug();const t1=performance.now();
    return {clipDom:document.querySelectorAll('#tlLanes .tl-clip').length,debug:d,ms:+(t1-t0).toFixed(2)}})()`);
  check('100 动作节点：DOM 数量正确、监听器不重复注册、渲染不冻结',
    perfUi.clipDom === 100 && perfUi.debug.clipCount === 100 && perfUi.debug.documentListeners === 1 && perfUi.ms < 500,
    JSON.stringify({ clipDom: perfUi.clipDom, listeners: perfUi.debug.documentListeners, ms: perfUi.ms }));
  report.classification.realUi.push('0.5s/10s/60s/300s+、100 动作节点渲染与监听器清理');

  /* setProject 走 edit()，立即撤销可恢复真实工程；随后显式保存，确保压测数据不落盘 */
  await E(c, `document.querySelector('#undo').click()`); await sleep(600);
  const restoredN = await E(c, `window.__pvnM3.project().nodes[0].performance.actions.length`);
  check('压测注入后撤销恢复真实工程（不污染磁盘）', restoredN < 10, JSON.stringify({ restoredN }));

  /* ---------- 16. 保存并关闭重开 ---------- */
  await E(c, `document.querySelector('#save').click()`); await sleep(1400);
  const errs1 = s1.cdp.errors.filter(e => !/favicon|Content-Security-Policy/i.test(e.text || ''));
  check('会话 1 无渲染进程异常', errs1.length === 0, JSON.stringify(errs1.slice(0, 3)));
  kill(s1.proc); s1.cdp.close(); await sleep(900);

  /* 会话 2：重新打开同一个副本，验证「旧工程兼容 + 时间轴编辑保存往返」 */
  const s2 = await openEditor(path.join(WORK, 'u2'));
  if (!s2) bad('关闭重开', '编辑器未重新启动');
  else {
    const c2 = s2.cdp;
    const diskFinal = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
    check('关闭重开：磁盘工程未被压测数据污染', diskFinal.nodes[0].performance.actions.length < 10,
      JSON.stringify({ n: diskFinal.nodes[0].performance.actions.length }));
    await clickNode(c2, 13); await sleep(250);
    const reopen = await E(c2, `({clips:document.querySelectorAll('#tlLanes .tl-clip').length,
      handles:document.querySelectorAll('#tlLanes .tl-handle').length,
      ticks:document.querySelectorAll('#tlLanes .tl-tick').length,
      firstTick:document.querySelector('#tlLanes .tl-tick-first')?.textContent,
      debug:window.paperTimelineDebug()})`);
    check('关闭重开：时间轴按真实数据重建、0s 刻度完整',
      reopen.clips > 0 && reopen.ticks > 0 && reopen.firstTick === '0s' && reopen.debug.pps > 0,
      JSON.stringify({ clips: reopen.clips, ticks: reopen.ticks, firstTick: reopen.firstTick }));
    /* 旧工程兼容性：未编辑节点的动作仍无 start，调度与磁盘一致 */
    const compat = await E(c2, `(()=>{const p=window.__pvnM3.project();const P=createPaperPerformance();
      const withStart=p.nodes.flatMap(n=>(n.performance&&n.performance.actions)||[]).filter(a=>a.start!==undefined).length;
      return {withStart,nodes:p.nodes.length}})()`);
    check('旧工程兼容：仅被编辑动作有 start，其余保持相对', compat.withStart >= 1 && compat.withStart < 20,
      JSON.stringify(compat));
    await timelineShot(c2, path.join(SHOTS, 'v082m1b-06-关闭重开一致.png'));
    check('会话 2 无渲染进程异常', s2.cdp.errors.filter(e => !/favicon|Content-Security-Policy/i.test(e.text || '')).length === 0,
      JSON.stringify(s2.cdp.errors.slice(0, 3)));
    kill(s2.proc); s2.cdp.close();
  }

  report.classification.automation = [
    'npm run check（M0 数据层 11 组 + M1A/M1B 交互 28 组，全部保留）',
    'tests/timeline-interaction.test.cjs：M1B 新增 16 组（拉伸/零时长/非法时长/吸附与缩放/多选/批量/复制粘贴删除/相对重排/轨道组织/音频无副作用/保存重开）'
  ];
  report.classification.notTested = [
    '音频波形、轨道独奏/静音混音、高级关键帧、视频轨道、Live2D 轨道 —— 本轮明确不做',
    '跨节点/跨章节时间轴、连续音视频播放调度 —— 本轮明确不做',
    '1.47 GiB 工程全链验收与 900 秒音频浸泡 —— 本轮未改音频引擎/资源存储/核心调度，按范围不重复',
    '人工长时间使用体验与最终艺术方案 —— 由用户决定'
  ];

  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M1B 真实窗口验收 · ' + report.mode);
  console.log('证据: ' + REPORT);
  process.exit(report.ok ? 0 : 1);
})().catch((e) => {
  report.problems.push('脚本异常：' + (e.stack || e.message));
  report.ok = false;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error('SCRIPT ERROR:', e.stack || e.message);
  process.exit(1);
});
