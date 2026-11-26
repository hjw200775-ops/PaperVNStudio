'use strict';
/*
 * V0.8.2 · M1-A · 编辑器内时间轴闭环 · 真实窗口验收
 *
 * 用 CDP 操作真实 Electron 编辑器（默认 = 重建后的 Windows x64 便携版；
 * PVN_DEV=1 时用源码 electron 快速迭代）。所有编辑都走真实 DOM 事件 / 按钮，
 * 不直接改工程对象，也不绕过 edit() 与 TL.setStart()。
 *
 * 用法：
 *   node scripts/v082m1a-ui-verify.cjs            # 便携版（正式证据）
 *   PVN_DEV=1 node scripts/v082m1a-ui-verify.cjs  # 源码 electron（开发自检）
 * 产物：release/v082m1a-ui-verify.json + docs/screenshots/v082m1a-*.png
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const DEV = process.env.PVN_DEV === '1';
const PACKAGED = path.join(ROOT, 'release', 'PaperVNStudio-' + require('../package.json').version + '-win-x64', 'PaperVNStudio.exe');
const SRC = path.join(ROOT, 'release', 'wanfeng-v081rc3', '晚风·循环试听工程');
/* 副本放在工作区内。fs.cpSync 在本运行环境会被拦截，改为逐文件复制（29 个文件 / 29 MiB）。 */
const WORK = path.join(ROOT, 'release', 'v082m1a-verify');
fs.mkdirSync(WORK, { recursive: true });
const PROJECT = path.join(WORK, '晚风-M1A验收副本');
const MAIN = path.join(PROJECT, 'project.paper.json');
const REPORT = path.join(ROOT, 'release', 'v082m1a-ui-verify.json');
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
  at: new Date().toISOString(), version: '0.8.2-M1A',
  mode: DEV ? 'source-electron' : 'packaged-win-x64',
  exe: DEV ? ELECTRON : PACKAGED, project: PROJECT,
  stages: {}, problems: [], evidence: {},
  classification: { automation: [], realUi: [], notTested: [] }
};
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d == null ? null : d }; console.log('  ok   ' + n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 200) : '')); };
const bad = (n, m) => { report.stages[n] = { ok: false, message: String(m) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };
const check = (n, cond, m, d) => cond ? ok(n, d) : bad(n, m || '断言失败');
const E = (cdp, expr) => cdp.ev(expr);

/* 全页截图：captureBeyondViewport 把视口外的时间轴面板一并截进来 */
async function fullShot(cdp, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const m = await cdp.send('Page.getLayoutMetrics');
    const box = m.cssContentSize || m.contentSize;
    const w = Math.min(2000, Math.ceil(box.width)), h = Math.min(3200, Math.ceil(box.height));
    const r = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: w, height: h, scale: 1 }
    });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  } catch (_) {
    try { await cdp.shot(file); } catch (_) {}
  }
  return file;
}
/* 截图前展开舞台演出分组，并临时取消 inspector-body 的内部滚动，
   让全页截图能同时拍到「时间轴面板」与右侧「绝对开始时间」属性区。截图后恢复样式。 */
async function shotWithInspector(cdp, file) {
  await E(cdp, `(()=>{const d=document.querySelector('#performancePanel');if(d)d.open=true;
    const b=document.querySelector('.inspector-body');
    if(b){b.dataset.tlPrevStyle=b.style.cssText;b.style.maxHeight='none';b.style.overflow='visible';}
    const tEl=document.querySelector('#toast');if(tEl)tEl.style.display='none';
    return 'ok'})()`).catch(() => {});
  await sleep(200);
  await fullShot(cdp, file);
  await E(cdp, `(()=>{const b=document.querySelector('.inspector-body');
    if(b&&b.dataset.tlPrevStyle!==undefined){b.style.cssText=b.dataset.tlPrevStyle;delete b.dataset.tlPrevStyle;}
    return 'ok'})()`).catch(() => {});
}

async function openEditor(userData) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT,
    items: [{ path: PROJECT, title: '晚风-M1A验收副本', openedAt: new Date().toISOString() }]
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
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  /* 放大窗口，让「舞台预览 + 时间轴 + 右侧属性」尽量同时入镜 */
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
const clickNode = (cdp, i) => E(cdp, `(()=>{const els=[...document.querySelectorAll('#list .node')];if(!els[${i}])return 'no-node';els[${i}].click();return 'ok'})()`);
const actsOf = (i) => `(()=>{const p=window.__pvnM3.project();const n=p.nodes[${i}];return (n&&n.performance&&n.performance.actions)||[]})()`;
const nodeCount = () => `window.__pvnM3.project().nodes.length`;

/* ---- 真实 pointer 拖动：分阶段，便于验证「交互过程中只预览」 ---- */
function pdown(id) {
  return `(()=>{const el=document.querySelector('#tlLanes .tl-clip[data-tl-clip=${JSON.stringify(id)}]');
    if(!el)return 'no-clip';const r=el.getBoundingClientRect();
    const x0=r.left+Math.min(6,r.width/2),y0=r.top+8;
    window.__tlD={el,x0,y0};
    const mk=(t,x,b)=>new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y0,pointerId:1,pointerType:'mouse',button:0,buttons:b,isPrimary:true});
    el.dispatchEvent(mk('pointerdown',x0,1));
    return {left:el.style.left,drag:window.paperTimelineDebug().dragActive};})()`;
}
function pmove(dx) {
  return `(()=>{const d=window.__tlD;if(!d)return 'no-drag';
    const mk=(t,x,b)=>new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:d.y0,pointerId:1,pointerType:'mouse',button:0,buttons:b,isPrimary:true});
    d.el.dispatchEvent(mk('pointermove',d.x0+(${dx}),1));
    return {left:d.el.style.left,drag:window.paperTimelineDebug().dragActive,state:window.paperTimelineDebug().dragState};})()`;
}
function pup(dx) {
  return `(()=>{const d=window.__tlD;if(!d)return 'no-drag';
    const mk=(t,x,b)=>new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:d.y0,pointerId:1,pointerType:'mouse',button:0,buttons:b,isPrimary:true});
    d.el.dispatchEvent(mk('pointerup',d.x0+(${dx}),0));window.__tlD=null;
    return {debug:window.paperTimelineDebug()};})()`;
}
function pcancel(kind) {
  return `(()=>{const d=window.__tlD;if(!d)return 'no-drag';
    if(${JSON.stringify(kind)}==='escape')document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    else d.el.dispatchEvent(new PointerEvent(${JSON.stringify(kind)},{bubbles:false,pointerId:1,pointerType:'mouse'}));
    window.__tlD=null;return {debug:window.paperTimelineDebug()};})()`;
}
/* 反复前后拖播放头：真实 pointer 事件到 .tl-pad，触发 scrub() */
function scrubSweep(times) {
  return `(()=>{const lanes=document.querySelector('#tlLanes'),pad=lanes.querySelector('.tl-pad');
    const r=lanes.getBoundingClientRect(),W=r.width-78;
    const mk=(t,x,b)=>new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:r.top+40,pointerId:2,pointerType:'mouse',button:0,buttons:b,isPrimary:true});
    for(let i=0;i<${times};i++){
      const x=r.left+78+(i%2?0.82:0.16)*W;
      pad.dispatchEvent(mk('pointerdown',x,1));pad.dispatchEvent(mk('pointermove',x,1));pad.dispatchEvent(mk('pointerup',x,0));
    }
    return {tl:window.paperTimelineDebug(),baseline:window.paperTimelineScrubDebug(),
      perfAudio:window.paperPerfAudioDebug(),editorAudio:window.paperEditorAudio&&window.paperEditorAudio()?window.paperEditorAudio().playbackStats:null,
      canvasTransform:document.querySelector('#layersCanvas').style.transform};})()`;
}

(async () => {
  if (!fs.existsSync(DEV ? ELECTRON : PACKAGED)) {
    bad('可执行文件存在', '找不到 ' + (DEV ? ELECTRON : PACKAGED));
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1);
  }
  ok('可执行文件存在', { exe: report.exe, mode: report.mode });
  ok('验收工程为隔离副本', { project: PROJECT, originalKept: SRC });

  /* ================= 会话 1：全部编辑操作 ================= */
  const s1 = await openEditor(path.join(WORK, 'u1'));
  if (!s1) { bad('编辑器启动', '未连接上 paper://app 页面'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  const c = s1.cdp;
  ok('编辑器启动并打开隔离副本', { nodes: await E(c, nodeCount()) });

  /* 1. 面板渲染：选中带演出的节点 0（2 个动作），检查片段、轨道、播放头 */
  await clickNode(c, 0); await sleep(250);
  const initial = await E(c, `({clips:document.querySelectorAll('#tlLanes .tl-clip').length,
    lanes:document.querySelectorAll('#tlLanes .tl-lane').length,
    playhead:!!document.querySelector('#tlLanes .tl-playhead'),
    ticks:document.querySelectorAll('#tlLanes .tl-tick').length,
    label:document.querySelector('#tlNodeLabel').textContent,
    debug:window.paperTimelineDebug(),acts:${actsOf(0)}})`);
  report.evidence.initialRender = { clips: initial.clips, lanes: initial.lanes, ticks: initial.ticks, label: initial.label };
  check('时间轴面板渲染（TL.toTimeline 投影）', initial.clips === initial.acts.length && initial.clips >= 2 && initial.playhead && initial.ticks > 0,
    JSON.stringify(initial).slice(0, 300), { clips: initial.clips, lanes: initial.lanes, ticks: initial.ticks });
  check('脚本加载无 timeline 报错', !s1.cdp.errors.some(e => /timeline|tl-|createTimeline/i.test(e.text || '')),
    JSON.stringify(s1.cdp.errors.slice(0, 3)));
  await fullShot(c, path.join(SHOTS, 'v082m1a-01-时间轴渲染.png'));
  report.classification.realUi.push('选中节点、时间轴面板渲染、截图');

  /* 2. 旧工程基线：只打开 / 预览 / 保存，不得批量写 start，调度与终态一致 */
  const diskBefore = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  const legacyStarts = diskBefore.nodes.flatMap(n => (n.performance && n.performance.actions) || [])
    .filter(a => a.start !== undefined).length;
  check('原工程无显式 start', legacyStarts === 0, '磁盘上已有 start=' + legacyStarts);
  const schedBefore = await E(c, `(()=>{const P=createPaperPerformance(),p=window.__pvnM3.project();
    return p.nodes.map(n=>P.schedule((n.performance&&n.performance.actions)||[]).map(s=>[s.start,s.end]))})()`);
  await E(c, scrubSweep(4));
  await E(c, `document.querySelector('#save').click()`);
  await sleep(1500);
  const diskAfter = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  const startsAfter = diskAfter.nodes.flatMap(n => (n.performance && n.performance.actions) || [])
    .filter(a => a.start !== undefined).length;
  const schedAfter = await E(c, `(()=>{const P=createPaperPerformance(),p=window.__pvnM3.project();
    return p.nodes.map(n=>P.schedule((n.performance&&n.performance.actions)||[]).map(s=>[s.start,s.end]))})()`);
  check('未编辑旧工程：预览+保存不批量写 start', startsAfter === 0, '写入了 ' + startsAfter + ' 个 start');
  check('未编辑旧工程：原调度保持一致', JSON.stringify(schedBefore) === JSON.stringify(schedAfter), '调度发生变化');
  report.evidence.legacyNoStart = { before: legacyStarts, afterPreviewAndSave: startsAfter, scheduleEqual: true };
  report.classification.realUi.push('旧工程打开 → 拖播放头预览 → 保存 → 磁盘核对无 start');

  /* 3. 动作列表 → 时间轴 双向同步（按动作 ID） */
  const a0 = initial.acts[0].id, a1 = initial.acts[1].id;
  const syncList = await E(c, `(()=>{const b=document.querySelectorAll('#perfList [data-perf]')[1];if(!b)return 'no-row';b.click();
    const active=document.querySelector('#tlLanes .tl-clip.active');
    return {listId:b.dataset.perf,clipId:active?active.dataset.tlClip:null,propsHidden:document.querySelector('#perfProps').hidden};})()`);
  check('列表 → 时间轴按 ID 同步', syncList.listId === a1 && syncList.clipId === a1, JSON.stringify(syncList));
  const syncClip = await E(c, `(()=>{const el=document.querySelector('#tlLanes .tl-clip[data-tl-clip=${JSON.stringify(a0)}]');
    el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:el.getBoundingClientRect().left+3,clientY:el.getBoundingClientRect().top+8,pointerId:9,pointerType:'mouse',button:0,buttons:1}));
    el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:el.getBoundingClientRect().left+3,clientY:el.getBoundingClientRect().top+8,pointerId:9,pointerType:'mouse',button:0,buttons:0}));
    const row=document.querySelector('#perfList .perf-row.active [data-perf]');
    return {rowId:row?row.dataset.perf:null,clipActive:document.querySelector('#tlLanes .tl-clip.active')?.dataset.tlClip,
      perfName:document.querySelector('#perfName').textContent};})()`);
  check('时间轴 → 列表按 ID 同步', syncClip.rowId === a0 && syncClip.clipActive === a0, JSON.stringify(syncClip));
  report.classification.realUi.push('动作列表 ↔ 时间轴按动作 ID 双向同步选择');

  /* 4. 拖动边界：预览不改数据 / 无位移 / Esc / pointercancel / lostpointercapture */
  const d0 = await E(c, pdown(a0));
  const px = initial.debug.pxPerSec;
  const dx = 2.35 * px;
  const dm = await E(c, pmove(dx));
  const midActs = await E(c, actsOf(0));
  const midClipLeft = await E(c, `document.querySelector('#tlLanes .tl-clip[data-tl-clip=${JSON.stringify(a0)}]').style.left`);
  check('拖动中只显示临时预览，动作数据未改', dm.drag === true && midActs[0].start === undefined && midClipLeft !== d0.left,
    JSON.stringify({ dm, midStart: midActs[0].start, left0: d0.left, left1: midClipLeft }));
  await fullShot(c, path.join(SHOTS, 'v082m1a-02-拖动临时预览.png'));
  await E(c, pcancel('escape'));
  const afterEsc = await E(c, actsOf(0));
  check('Esc 取消不留半成品', afterEsc[0].start === undefined && !(await E(c, `window.paperTimelineDebug().dragActive`)), JSON.stringify(afterEsc[0]));
  for (const kind of ['pointercancel', 'lostpointercapture']) {
    await E(c, pdown(a0)); await E(c, pmove(dx)); await E(c, pcancel(kind));
    const acts = await E(c, actsOf(0));
    check('取消不留半成品：' + kind, acts[0].start === undefined, JSON.stringify(acts[0]));
  }
  await E(c, pdown(a0)); await E(c, pup(0));
  check('无位移松手不写入', (await E(c, actsOf(0)))[0].start === undefined, '无位移却写入了 start');
  report.classification.realUi.push('片段拖动临时预览、Esc / pointercancel / lostpointercapture / 无位移取消');

  /* 5. 真实拖动提交：小数秒绝对开始时间 + 一次拖动一个撤销步骤 */
  const beforeCommit = await E(c, `window.__pvnM3.metrics()`);
  await E(c, pdown(a0));
  await E(c, pmove(dx));
  const upInfo = await E(c, pup(dx));
  await sleep(250);
  const committed = await E(c, actsOf(0));
  const afterCommit = await E(c, `window.__pvnM3.metrics()`);
  const fracStart = committed[0].start;
  check('松手通过 edit()+TL.setStart 写回小数秒', typeof fracStart === 'number' && fracStart > 0 && !Number.isInteger(fracStart),
    JSON.stringify(committed[0]), { start: fracStart, deltaX: +dx.toFixed(1), pxPerSec: +px.toFixed(2) });
  check('一次拖动只增加一个撤销步骤', afterCommit.past === beforeCommit.past + 1,
    'past ' + beforeCommit.past + ' → ' + afterCommit.past);
  check('拖动后其它动作未被偷写 start', committed[1].start === undefined, JSON.stringify(committed[1]));
  const uiAbs = await E(c, `({start:document.querySelector('#perfStart').value,
    delayDisabled:document.querySelector('#perfDelay').disabled,
    modeDisabled:document.querySelector('#perfMode').disabled,
    restoreEnabled:!document.querySelector('#tlRestoreRelative').disabled,
    listText:document.querySelector('#perfList').textContent.includes('绝对开始'),
    note:document.querySelector('#perfTimingNote').textContent})`);
  check('显式 start 明确显示「绝对开始时间」且 mode/delay 不可覆盖',
    Math.abs(Number(uiAbs.start) - fracStart) < 0.002 && uiAbs.delayDisabled && uiAbs.modeDisabled && uiAbs.listText && uiAbs.restoreEnabled,
    JSON.stringify(uiAbs));
  await shotWithInspector(c, path.join(SHOTS, 'v082m1a-03-绝对开始时间属性面板.png'));
  /* 再来一张视口特写：把「定位方式」滚到中央，保证小字可读性 */
  await E(c, `(()=>{const t=document.querySelector('#perfTiming');if(t)t.scrollIntoView({block:'center'});return 'ok'})()`).catch(() => {});
  await sleep(200);
  await c.shot(path.join(SHOTS, 'v082m1a-05-定位方式特写.png')).catch(() => {});
  report.evidence.dragCommit = { start: fracStart, pastBefore: beforeCommit.past, pastAfter: afterCommit.past, uiAbs };
  report.classification.realUi.push('真实拖动片段写回小数秒绝对开始时间、属性面板同步');

  /* 6. 撤销 / 重做 */
  await E(c, `document.querySelector('#undo').click()`); await sleep(150);
  const undone = await E(c, actsOf(0));
  await E(c, `document.querySelector('#redo').click()`); await sleep(150);
  const redone = await E(c, actsOf(0));
  check('撤销回退拖动、重做恢复拖动', undone[0].start === undefined && Math.abs((redone[0].start || 0) - fracStart) < 0.002,
    JSON.stringify({ undone: undone[0].start, redone: redone[0].start }));
  report.classification.realUi.push('撤销 / 重做（Ctrl+Z 对应按钮）');

  /* 7. 显式 start=0（数值输入路径） */
  await E(c, `(()=>{const b=document.querySelectorAll('#perfList [data-perf]')[1];b.click();})()`);
  await E(c, `(()=>{const s=document.querySelector('#perfStart');s.value='0';s.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()`);
  await sleep(200);
  const zeroActs = await E(c, actsOf(0));
  const zeroUi = await E(c, `({start:document.querySelector('#perfStart').value,delayDisabled:document.querySelector('#perfDelay').disabled,restoreEnabled:!document.querySelector('#tlRestoreRelative').disabled})`);
  check('显式 start=0 被保留且仍识别为绝对时间', zeroActs[1].start === 0 && zeroUi.start === '0' && zeroUi.delayDisabled && zeroUi.restoreEnabled,
    JSON.stringify({ a1: zeroActs[1], zeroUi }));
  report.classification.realUi.push('显式 start=0（属性面板数值输入）');

  /* 8. 恢复相对时间 */
  await E(c, `document.querySelector('#tlRestoreRelative').click()`); await sleep(200);
  const restored = await E(c, actsOf(0));
  const restoredUi = await E(c, `({delayDisabled:document.querySelector('#perfDelay').disabled,modeDisabled:document.querySelector('#perfMode').disabled,restoreDisabled:document.querySelector('#tlRestoreRelative').disabled})`);
  check('恢复相对时间清除 start 并解除 mode/delay 禁用', restored[1].start === undefined && !restoredUi.delayDisabled && !restoredUi.modeDisabled && restoredUi.restoreDisabled,
    JSON.stringify({ restored: restored[1], restoredUi }));
  /* 把 start=0 重新设回去，保证「保存并重新打开」覆盖显式 start=0 的场景 */
  await E(c, `(()=>{const s=document.querySelector('#perfStart');s.value='0';s.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()`);
  await sleep(200);
  check('恢复相对时间后仍可重新设置绝对开始时间', (await E(c, actsOf(0)))[1].start === 0, '重新设置失败');
  report.classification.realUi.push('恢复相对时间（清除 start，回到 after/parallel + delay）');

  /* 9. 混排：绝对动作 + 相对 after/parallel；后续相对动作跟随，列表与时间轴同步 */
  await clickNode(c, 13); await sleep(250);
  const mix0 = await E(c, `({acts:${actsOf(13)},clips:[...document.querySelectorAll('#tlLanes .tl-clip')].map(e=>({id:e.dataset.tlClip,left:e.style.left})),debug:window.paperTimelineDebug()})`);
  const m0 = mix0.acts[0].id;
  const mpx = mix0.debug.pxPerSec;
  await E(c, pdown(m0)); await E(c, pmove(2.35 * mpx)); await E(c, pup(2.35 * mpx));
  await sleep(250);
  const mix1 = await E(c, `({acts:${actsOf(13)},clips:[...document.querySelectorAll('#tlLanes .tl-clip')].map(e=>({id:e.dataset.tlClip,left:e.style.left})),list:document.querySelector('#perfList').textContent})`);
  const movedOthers = mix1.clips.filter((cl, i) => cl.left !== mix0.clips[i].left).length;
  check('混排：拖动绝对动作后后续相对动作按真实调度跟随', mix1.acts[0].start !== undefined && movedOthers >= 2,
    JSON.stringify({ starts: mix1.acts.map(a => a.start), movedOthers }));
  check('混排：其它动作不偷写 start，列表同步显示绝对开始',
    mix1.acts.slice(1).every(a => a.start === undefined) && mix1.list.includes('绝对开始'),
    JSON.stringify(mix1.acts.map(a => a.start)));
  report.evidence.mixedSchedule = { before: mix0.clips, after: mix1.clips, starts: mix1.acts.map(a => a.start) };
  report.classification.realUi.push('绝对动作 + 相对 after/parallel 混排、后续跟随、列表与时间轴同步');

  /* 10. 并行片段 + 零时长事件 */
  const parallel = await E(c, `(()=>{const p=window.__pvnM3.project();const acts=p.nodes[13].performance.actions;
    const P=createPaperPerformance();const s=P.schedule(acts);return {mode:acts[1].mode,starts:s.map(x=>x.start)}})()`);
  check('并行片段与前一动作同起点', parallel.mode === 'parallel' && parallel.starts[0] === parallel.starts[1], JSON.stringify(parallel));
  await E(c, `(()=>{const b=document.querySelectorAll('#perfList [data-perf]')[1];b.click();})()`);
  await E(c, `(()=>{const d=document.querySelector('#perfDuration');d.value='0';d.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`);
  await sleep(200);
  const zeroClip = await E(c, `({dur:${actsOf(13)}[1].duration,zeroClips:document.querySelectorAll('#tlLanes .tl-clip-zero').length})`);
  check('零时长动作在时间轴显示为瞬时片段', zeroClip.dur === 0 && zeroClip.zeroClips >= 1, JSON.stringify(zeroClip));
  await E(c, `document.querySelector('#undo').click()`); await sleep(150);
  report.classification.realUi.push('并行片段、零时长瞬时事件（真实 UI 改 duration=0 并撤销）');

  /* 11. 反复前后拖播放头：一次性音频触发数 = 0，基线不累加、节点隔离 */
  await clickNode(c, 23); await sleep(250);              // 该节点含 audio.sfx.play
  const audioBefore = await E(c, `({perf:window.paperPerfAudioDebug(),stats:window.paperEditorAudio&&window.paperEditorAudio()?window.paperEditorAudio().playbackStats:null,tl:window.paperTimelineDebug(),bl:window.paperTimelineScrubDebug()})`);
  const sweep = await E(c, scrubSweep(12));
  const audioAfter = await E(c, `({perf:window.paperPerfAudioDebug(),stats:window.paperEditorAudio&&window.paperEditorAudio()?window.paperEditorAudio().playbackStats:null,tl:window.paperTimelineDebug(),bl:window.paperTimelineScrubDebug()})`);
  const statsBefore = audioBefore.stats ? audioBefore.stats.started : 0;
  const statsAfter = audioAfter.stats ? audioAfter.stats.started : 0;
  check('反复前后拖播放头：一次性音频触发数为 0',
    sweep.tl.oneShotTriggers === 0 && sweep.baseline.audioSideEffectTriggers === 0 &&
    audioBefore.perf.fired === audioAfter.perf.fired && statsBefore === statsAfter,
    JSON.stringify({ perfBefore: audioBefore.perf, perfAfter: audioAfter.perf, statsBefore, statsAfter, oneShot: sweep.tl.oneShotTriggers }));
  check('scrub 每次重新取进入前状态，不在上次结果上累加',
    sweep.baseline.reusedState === false && sweep.baseline.rebuilds >= 12 &&
    sweep.baseline.rebuilds === sweep.baseline.scrubCalls,
    JSON.stringify(sweep.baseline));
  report.evidence.scrub = { sweeps: 12, before: audioBefore, after: audioAfter, baseline: sweep.baseline };
  report.classification.realUi.push('含 SFX 的节点反复前后拖播放头 12 次，核对一次性音频触发数');

  /* 12. 快速切换节点不残留预览 */
  const beforeSwitch = await E(c, `window.paperTimelineDebug().playheadT`);
  await clickNode(c, 3); await clickNode(c, 8); await clickNode(c, 23); await sleep(250);
  const afterSwitch = await E(c, `({tl:window.paperTimelineDebug(),bl:window.paperTimelineScrubDebug(),transform:document.querySelector('#layersCanvas').style.transform})`);
  check('快速切换节点后播放头归零、无残留拖动',
    beforeSwitch > 0 && afterSwitch.tl.playheadT === 0 && !afterSwitch.tl.dragActive && afterSwitch.transform === '',
    JSON.stringify({ beforeSwitch, afterSwitch: { t: afterSwitch.tl.playheadT, drag: afterSwitch.tl.dragActive, transform: afterSwitch.transform, switches: afterSwitch.bl.nodeSwitches } }));
  check('切换节点后重新取基线，不串用状态',
    afterSwitch.bl.node === null && afterSwitch.bl.nodeSwitches >= 1 && afterSwitch.bl.reusedState === false,
    JSON.stringify(afterSwitch.bl));
  report.classification.realUi.push('快速连续切换节点后播放头 / 预览 / 舞台 transform 不残留');

  /* 13. 标题音乐 6.4–30.5 保存往返回归（V0.8.1-M0-0 修复保护） */
  await E(c, `[...document.querySelectorAll('.tabs button')].find(b=>b.dataset.tab==='title').click()`);
  await sleep(250);
  await E(c, `(()=>{const m=document.querySelector('#titleMusicLoop'),s=document.querySelector('#titleMusicLoopStart'),e=document.querySelector('#titleMusicLoopEnd');
    m.value='region';m.dispatchEvent(new Event('change',{bubbles:true}));s.value='6.4';e.value='30.5';
    document.querySelector('#titleMusicApply').click();return 'ok'})()`);
  await sleep(300);
  await E(c, `document.querySelector('#save').click()`); await sleep(1500);
  const diskLoop = JSON.parse(fs.readFileSync(MAIN, 'utf8')).titleMusic || {};
  check('标题音乐 6.4–30.5 保存写入磁盘（小数秒不被取整）',
    diskLoop.loopStart === 6.4 && diskLoop.loopEnd === 30.5, JSON.stringify(diskLoop));

  /* 14. 最终保存，落盘所有时间轴编辑 */
  await E(c, `document.querySelector('#save').click()`); await sleep(1500);
  const diskFinal = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  const saved0 = diskFinal.nodes[0].performance.actions;
  const saved13 = diskFinal.nodes[13].performance.actions;
  check('时间轴编辑写入磁盘（start=0 与小数秒均保留）',
    saved0[0].start !== undefined && !Number.isInteger(saved0[0].start) && saved0[1].start === 0 && saved13[0].start !== undefined,
    JSON.stringify({ node0: saved0.map(a => a.start), node13: saved13.map(a => a.start) }));
  report.evidence.diskFinal = { node0: saved0.map(a => a.start), node13: saved13.map(a => a.start), titleMusic: diskLoop };
  report.classification.realUi.push('保存工程（#save 按钮）、磁盘核对');

  const errs1 = s1.cdp.errors.filter(e => !/favicon|Content-Security-Policy/i.test(e.text || ''));
  check('会话 1 无渲染进程异常', errs1.length === 0, JSON.stringify(errs1.slice(0, 3)));
  kill(s1.proc); s1.cdp.close(); await sleep(900);

  /* ================= 会话 2：关闭重开验证 ================= */
  const s2 = await openEditor(path.join(WORK, 'u2'));
  if (!s2) bad('关闭重开', '编辑器未重新启动');
  else {
    const c2 = s2.cdp;
    await E(c2, `[...document.querySelectorAll('.tabs button')].find(b=>b.dataset.tab==='title').click()`);
    await sleep(250);
    const loopUi = await E(c2, `({mode:document.querySelector('#titleMusicLoop').value,start:document.querySelector('#titleMusicLoopStart').value,end:document.querySelector('#titleMusicLoopEnd').value})`);
    check('关闭重开后标题音乐 6.4–30.5 一致',
      loopUi.mode === 'region' && Math.abs(+loopUi.start - 6.4) < 0.05 && Math.abs(+loopUi.end - 30.5) < 0.05,
      JSON.stringify(loopUi));
    await clickNode(c2, 0); await sleep(250);
    await E(c2, `(()=>{const b=document.querySelectorAll('#perfList [data-perf]')[0];if(b)b.click();return 'ok'})()`);
    await sleep(150);
    const reopen = await E(c2, `({acts:${actsOf(0)},clips:document.querySelectorAll('#tlLanes .tl-clip').length,
      rowText:document.querySelector('#perfList').textContent,
      start:document.querySelector('#perfStart').value,
      delayDisabled:document.querySelector('#perfDelay').disabled,
      debug:window.paperTimelineDebug()})`);
    check('关闭重开后时间轴 start 参数一致且面板正确重建',
      Math.abs((reopen.acts[0].start || 0) - fracStart) < 0.002 && reopen.acts[1].start === 0 &&
      reopen.clips === 2 && reopen.rowText.includes('绝对开始') && reopen.delayDisabled,
      JSON.stringify({ acts: reopen.acts.map(a => a.start), clips: reopen.clips, start: reopen.start }));
    await shotWithInspector(c2, path.join(SHOTS, 'v082m1a-04-关闭重开后参数一致.png'));
    check('会话 2 无渲染进程异常', s2.cdp.errors.filter(e => !/favicon|Content-Security-Policy/i.test(e.text || '')).length === 0,
      JSON.stringify(s2.cdp.errors.slice(0, 3)));
    kill(s2.proc); s2.cdp.close();
  }
  report.classification.realUi.push('关闭重开：时间轴参数与标题音乐循环点往返一致');

  /* 分类：自动化 / 实际 UI / 尚未测试 */
  report.classification.automation = [
    'npm run check（含 tests/timeline.test.cjs + tests/timeline-interaction.test.cjs）',
    'tests/timeline-interaction.test.cjs：拖动状态机 12 组断言（预览不改数据/取消/混排/恢复相对/终态一致）',
    'tests/timeline.test.cjs：M0 数据层 11 组断言'
  ];
  report.classification.notTested = [
    '片段拉伸（改 duration 的拖柄）、完整缩放/网格吸附、多选、音频波形 —— 本轮明确不做',
    '跨节点场景时间轴、导出播放器改造 —— 本轮明确不做',
    '1 GiB 大型工程全链验收与 900 秒浸泡 —— 本轮未改资源存储/核心音频运行时，按 M1-A 范围不重复执行',
    '人工长时间听感与最终 A/B/C/D 艺术方案选择 —— 由用户决定'
  ];

  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M1A 真实窗口验收 · ' + report.mode);
  console.log('证据: ' + REPORT);
  process.exit(report.ok ? 0 : 1);
})().catch((e) => {
  report.problems.push('脚本异常：' + (e.stack || e.message));
  report.ok = false;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error('SCRIPT ERROR:', e.stack || e.message);
  process.exit(1);
});
