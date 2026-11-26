'use strict';
/*
 * V0.8.2 · M3-B · 发布载体音画同步实测（M3B-5）
 *
 * 复用 M3A 的分层测量思路，但明确区分口径、不把「JS 派发漂移」冒充「音画偏差」：
 *   L1 计划时间   —— PF.schedule(actions) 得到的每个音频槽 start（秒）
 *   L2 实际派发   —— audio.snapshot().events 里 play-requested 的 at（Date.now）
 *   L3 在线起音   —— play-started 的 at；AudioContext graph.state 可读时一并记录
 *   L4 视觉变化   —— MutationObserver 采集的舞台 style.transform / opacity 变化（performance.now）
 *
 * 时钟换算：页面注入时记录 offset = Date.now() - performance.now()，
 *   把事件 at 换算到 performance.now 基准后再与 DOM 变化时间比较。
 *   这是同一会话内两个单调毫秒时钟的基准对齐，不是伪造数据；
 *   仍不含操作系统扬声器 / 声卡回环输出（AudioContext 排程 ≠ 扬声器发声）。
 *
 * 载体：A 编辑器时间轴预览 / C 单文件 HTML / E Windows 独立游戏 EXE
 * 冷启动与热态分别采集；热态另注入一次 350ms 忙循环做掉帧环境单独报告。
 * 产出：release/v082m3b-avsync.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, spawnShell, kill } = require('./rc2-cdp.cjs');
const PF = require('../dist/performance.js')();

const DEV = process.env.PVN_DEV === '1';
const WORK = path.join(ROOT, 'release', 'v082m3b');
const PROJECT = path.join(WORK, '晚风-M3B发布验收副本');
const VERIFY = path.join(ROOT, 'release', 'v082m3b-release-verify.json');
const HTML = path.join(WORK, 'exports', '晚风-M3B单文件试玩版.html');
const REPORT = path.join(ROOT, 'release', 'v082m3b-avsync.json');
const EDITOR = DEV ? ELECTRON : path.join(ROOT, 'release', 'PaperVNStudio-' + require('../package.json').version + '-win-x64', 'PaperVNStudio.exe');

/* 从主验收报告里找目录版 EXE，找不到就扫描导出目录 */
function findExe() {
  try {
    const dir = path.join(WORK, 'exports');
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) { const r = walk(f); if (r) return r; }
        else if (/\.exe$/i.test(e.name) && !/elevate/i.test(e.name)) return f;
      }
      return null;
    };
    const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
    dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const d of dirs) { const x = walk(d); if (x) return x; }
  } catch (_) {}
  return null;
}

/* 只有这些动作会产生真实起音（play-started）；stop / volume / loop / bus / ducking
   是状态命令，不产生起音事件，不能计入「漏触发」的期望值。 */
const EXPECT_START = new Set(['audio.bgm.play', 'audio.bgm.crossfade', 'audio.sfx.play', 'audio.voice.play']);
function plannedSlots() {
  const p = JSON.parse(fs.readFileSync(path.join(PROJECT, 'project.paper.json'), 'utf8'));
  const acts = p.nodes[0].performance.actions;
  return PF.schedule(acts).filter(s => PF.isAudioType(s.action.type))
    .map(s => ({ id: s.action.id, type: s.action.type, planned: +s.start.toFixed(3),
      audioId: (s.action.params || {}).audioId || null, expectsStart: EXPECT_START.has(s.action.type) }));
}

/* 页面内探针：统一时钟 + 真实 DOM 变化 + 真实音频事件（只读，不改播放器代码） */
const PROBE = `(()=>{
  if(window.__m3bSync)return 'already';
  const off=Date.now()-performance.now();
  const S={offset:off,t0:performance.now(),visual:[],audio:[],seen:{},timer:null,observer:null};
  window.__m3bSync=S;
  const root=document.querySelector('#layers')||document.querySelector('#layersCanvas')||document.body;
  S.observer=new MutationObserver(ms=>{for(const m of ms){
    if(m.type!=='attributes'||m.attributeName!=='style')continue;
    const st=m.target.style||{};
    const v=st.transform||st.opacity||'';
    if(!v)continue;
    const last=S.visual[S.visual.length-1];
    if(last&&last.v===v&&S.t0+0)continue;
    S.visual.push({at:performance.now(),v:String(v).slice(0,90)});
  }});
  S.observer.observe(root,{attributes:true,subtree:true,attributeFilter:['style']});
  S.timer=setInterval(()=>{
    try{
      let snap=null;
      if(typeof window.paperGameState==='function'){const s=window.paperGameState();snap=s&&s.audioPerf;}
      else if(typeof window.paperEditorAudio==='function')snap=window.paperEditorAudio();
      const ev=(snap&&snap.events)||[];
      for(const e of ev){
        const k=e.kind+'|'+(e.audioId||'')+'|'+e.at;
        if(S.seen[k])continue;S.seen[k]=1;
        /* crossfade / precise-crossfade 的目标素材在 e.to 里，必须一并保留，
           否则 BGM 交叉淡化会被误算成「漏触发」。 */
        S.audio.push({at:e.at-off,rawAt:e.at,kind:e.kind,audioId:e.audioId||null,to:e.to||null,cat:e.cat||null});
      }
    }catch(_){}
  },40);
  return 'ok';
})()`;
const COLLECT = `(()=>{const S=window.__m3bSync;if(!S)return null;
  if(S.timer)clearInterval(S.timer);
  let graph=null,mode=null,stats=null;
  try{const s=typeof window.paperGameState==='function'?window.paperGameState():null;
    const a=(s&&s.audioPerf)||(typeof window.paperEditorAudio==='function'?window.paperEditorAudio():null);
    if(a){graph=a.graph||null;mode=a.mode||null;stats=a.playbackStats||null;}}catch(_){}
  let drv=null;try{drv=window.paperTimelineAudioDriver?window.paperTimelineAudioDriver():null}catch(_){}
  return {offset:S.offset,t0:S.t0,visual:S.visual,audio:S.audio,graph,mode,stats,driver:drv&&drv.sync?drv.sync:null};
})()`;

function stats(arr) {
  if (!arr.length) return { count: 0, p50: null, p95: null, max: null, mean: null };
  const d = arr.map(Math.abs).sort((a, b) => a - b), n = d.length;
  const q = p => d[Math.min(n - 1, Math.ceil(p * n) - 1)];
  return { count: n, mean: +(d.reduce((s, v) => s + v, 0) / n).toFixed(2),
    p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +d[n - 1].toFixed(2) };
}
/* 同刻配对：音频起音 vs 最近的舞台视觉变化（窗口 250ms） */
function analyse(raw, label, phase, perfIds, expectedStarts) {
  if (!raw) return { carrier: label, phase, status: 'NOT_RUN', reason: '页面探针未返回数据' };
  /* 起音证据：stream 的一次性音频用 play-started；precise 的 BGM 交叉淡化用
     crossfade / precise-crossfade（目标素材在 to）。只认演出动作引用的素材，标题音乐不计入。 */
  const START_KINDS = /^(play-started|crossfade|precise-crossfade)$/;
  const starts = (raw.audio || []).filter(e => START_KINDS.test(e.kind) && perfIds.has(e.audioId || e.to));
  const requests = (raw.audio || []).filter(e => e.kind === 'play-requested');
  const vis = (raw.visual || []).slice();
  const pairs = [], unpaired = [];
  for (const s of starts) {
    let best = null, bestD = Infinity;
    for (const v of vis) { const d = Math.abs(v.at - s.at); if (d < bestD) { bestD = d; best = v; } }
    const sid = s.audioId || s.to;
    if (best && bestD <= 250) pairs.push({ audioAt: +s.at.toFixed(1), visualAt: +best.at.toFixed(1),
      deltaMs: +bestD.toFixed(2), kind: s.kind, audioId: sid, visual: best.v });
    else unpaired.push({ audioAt: +s.at.toFixed(1), kind: s.kind, audioId: sid, nearestMs: Number.isFinite(bestD) ? +bestD.toFixed(1) : null });
  }
  const diffs = pairs.map(p => p.deltaMs);
  /* 派发漂移：play-requested 相对「计划时刻」的偏移（与 M3A 的 driver.sync 口径不同，单独报告） */
  const dispatch = (raw.driver && raw.driver.syncSamples) ? raw.driver.syncSamples.map(s => Math.abs(s.driftMs)) : [];
  /* 漏触发 / 重复触发：按 audioId 在 100ms 窗口内的聚簇判定 */
  const byId = {};
  for (const s of starts) { const id = s.audioId || s.to || '?'; (byId[id] = byId[id] || []).push(s.at); }
  let duplicateTriggers = 0;
  for (const arr of Object.values(byId)) {
    arr.sort((a, b) => a - b);
    for (let i = 1; i < arr.length; i++) if (arr[i] - arr[i - 1] < 100) duplicateTriggers++;
  }
  return {
    carrier: label, phase, status: 'MEASURED',
    samples: starts.length, visualChanges: vis.length,
    plannedTime: 'PF.schedule(node[0].performance.actions) 的音频槽 start（见 plannedSlots）',
    actualDispatch: requests.length,
    onlineAttackTime: starts.length ? 'play-started / crossfade / precise-crossfade（换算到 performance.now 基准）' : '不可采集',
    visualChangeTime: vis.length ? 'MutationObserver / performance.now' : '不可采集',
    audioVisualDelta: stats(diffs),
    dispatchDriftM3A: raw.driver || null,
    pairs: pairs.slice(0, 12), unpaired: unpaired.slice(0, 8),
    missingTriggers: Math.max(0, expectedStarts - starts.length),
    expectedStarts,
    duplicateTriggers,
    graph: raw.graph, mode: raw.mode, playbackStats: raw.stats,
    note: '不含扬声器/声卡回环；stream 模式下 play-started 为 HTMLAudioElement.play() 成功，非采样级排程'
  };
}

function userData(tag) {
  const d = path.join(WORK, 'user-' + tag);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT,
    items: [{ path: PROJECT, title: '晚风M3B发布验收', openedAt: new Date().toISOString() }]
  }));
  return d;
}
async function openEditor(tag) {
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const args = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${userData(tag)}`];
  if (DEV) args.unshift('.');
  const proc = spawn(EDITOR, args, { cwd: ROOT, stdio: 'ignore', env });
  const page = await waitPage(port, u => u.startsWith('paper://app/'), 90000);
  if (!page) { kill(proc); return null; }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  for (let i = 0; i < 200; i++) { if (await cdp.ev(`window.__pvnM3?window.__pvnM3.metrics().nodes:0`).catch(() => 0) >= 40) break; await sleep(200); }
  return { proc, cdp };
}
async function launchHtml(file, tag) {
  const shell = spawnShell(file, { shellDir: path.join(WORK, 'shell-' + tag) });
  const s = await shell.spawnCdp();
  await s.cdp.send('Runtime.enable');
  for (let i = 0; i < 120; i++) { if (await s.cdp.ev(`typeof window.paperGameState==='function'`).catch(() => false)) break; await sleep(200); }
  return s;
}
async function launchExe(exe) {
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const proc = spawn(exe, ['--remote-debugging-port=' + port, '--remote-allow-origins=*', '--disable-background-timer-throttling'],
    { cwd: path.dirname(exe), env, stdio: 'ignore' });
  const page = await waitPage(port, u => u.startsWith('papergame://game/'), 90000);
  if (!page) { kill(proc); return null; }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  for (let i = 0; i < 150; i++) { if (await cdp.ev(`typeof window.paperGameState==='function'`).catch(() => false)) break; await sleep(200); }
  return { proc, cdp };
}
async function gesture(cdp, expr) {
  await cdp.send('Runtime.evaluate', { expression: expr, userGesture: true, returnByValue: true }).catch(() => null);
}
async function runCarrier(cdp, kind, phase, totalSec, dropFrame) {
  /* 冷/热/掉帧各自独立重载页面：避免上一轮的音频事件与 DOM 变化污染下一轮样本 */
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: phase === 'cold' });
  await sleep(1200);
  for (let i = 0; i < 120; i++) {
    const r = await cdp.ev(kind === 'editor'
      ? `window.__pvnM3?window.__pvnM3.metrics().nodes:0`
      : `typeof window.paperGameState==='function'?1:0`).catch(() => 0);
    if (kind === 'editor' ? r >= 40 : r === 1) break;
    await sleep(150);
  }
  await cdp.ev(PROBE);
  if (kind === 'editor') {
    await gesture(cdp, `window.__pvnM3.unlockAudio()`); await sleep(300);
    await cdp.ev(`document.querySelector('#timelinePanel').focus()`);
    await cdp.ev(`document.querySelector('#tlReplay').click()`);
  } else {
    await gesture(cdp, `document.getElementById('startGame').click()`); await sleep(250);
    await gesture(cdp, `(()=>{const b=document.getElementById('enableSound');if(b)b.click();return true})()`);
    await sleep(250);
    /* 每轮已独立重载：冷态 ignoreCache=true，热态复用磁盘/解码缓存，掉帧轮注入忙循环 */
  }
  if (dropFrame) {
    await sleep(1500);
    await cdp.ev(`(()=>{const t=performance.now();while(performance.now()-t<350){}return 'drop'})()`).catch(() => null);
  }
  await sleep(Math.min(totalSec * 1000 + 1200, 17000));
  const raw = await cdp.ev(COLLECT).catch(() => null);
  if (kind === 'editor') await cdp.ev(`document.querySelector('#tlStop').click()`).catch(() => {});
  return raw;
}

(async () => {
  const plan = plannedSlots();
  const PERF_IDS = new Set(plan.filter(s => s.audioId).map(s => s.audioId));
  const expectedStarts = plan.filter(s => s.expectsStart && s.audioId).length;
  const report = {
    at: new Date().toISOString(), version: 'V0.8.2-M3B',
    method: '在线音频起音事件（Date.now → performance.now 基准对齐）vs 舞台 DOM 变化时间；'
      + 'M3A 的 driver.sync 派发漂移单独列出，不与音画偏差混算',
    scope: '在线音频图 + 渲染层，不含操作系统扬声器/声卡回环输出',
    goal: { hotAudioVisualP95Ms: 50 }, plannedSlots: plan, carriers: {}, problems: [], ok: true
  };
  const totalSec = Math.max(...plan.map(s => s.planned)) + 2;
  const EXE = findExe();
  const carriers = [
    { key: 'A-editor-timeline', kind: 'editor', start: () => openEditor('avsync'), label: '编辑器时间轴预览' },
    { key: 'C-single-html', kind: 'game', start: () => fs.existsSync(HTML) ? launchHtml(HTML, 'avsync-html') : null, label: '单文件 HTML' },
    { key: 'E-independent-exe', kind: 'game', start: () => EXE ? launchExe(EXE) : null, label: 'Windows 独立游戏 EXE' }
  ];
  for (const c of carriers) {
    let sess = null;
    try {
      sess = await c.start();
      if (!sess) { report.carriers[c.key] = { label: c.label, status: 'NOT_RUN', reason: '载体不存在或未启动' }; console.log('  NOT_RUN ' + c.key); continue; }
      const cold = analyse(await runCarrier(sess.cdp, c.kind, 'cold', totalSec, false), c.key, '冷启动首次播放', PERF_IDS, expectedStarts);
      const hot = analyse(await runCarrier(sess.cdp, c.kind, 'hot', totalSec, false), c.key, '前台热态正常', PERF_IDS, expectedStarts);
      const drop = analyse(await runCarrier(sess.cdp, c.kind, 'drop', totalSec, true), c.key, '掉帧环境（注入 350ms 忙循环）', PERF_IDS, expectedStarts);
      for (const r of [cold, hot, drop]) {
        if (r.status === 'MEASURED' && r.playbackStats && r.playbackStats.failed > 0) {
          report.problems.push(c.key + ' ' + r.phase + ' 真实播放失败 ' + r.playbackStats.failed);
        }
      }
      report.carriers[c.key] = { label: c.label, cold, hot, drop,
        hotP95Ms: hot.audioVisualDelta && hot.audioVisualDelta.p95,
        hotMeetsGoal: !!(hot.audioVisualDelta && hot.audioVisualDelta.p95 != null && hot.audioVisualDelta.p95 <= 50) };
      console.log('  ' + c.key + ' hot P95=' + (hot.audioVisualDelta && hot.audioVisualDelta.p95)
        + ' 冷=' + (cold.audioVisualDelta && cold.audioVisualDelta.p95)
        + ' 掉帧=' + (drop.audioVisualDelta && drop.audioVisualDelta.p95)
        + ' samples(hot)=' + (hot.samples || 0));
    } catch (e) {
      report.carriers[c.key] = { label: c.label, status: 'FAIL', message: String(e.stack || e.message) };
      report.problems.push(c.key + '：' + e.message); console.log('  FAIL ' + c.key + ' — ' + e.message);
    } finally {
      if (sess) { try { sess.cdp.close(); } catch (_) {} kill(sess.proc); }
    }
  }
  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M3B 发布载体音画同步实测 · ' + REPORT);
  process.exit(report.ok ? 0 : 1);
})().catch(e => {
  fs.writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), ok: false, error: String(e.stack || e.message) }, null, 2));
  console.error('SCRIPT ERROR:', e.stack || e.message); process.exit(1);
});
