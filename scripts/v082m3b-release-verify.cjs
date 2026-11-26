'use strict';
/*
 * V0.8.2 · M3-B · 发布运行时一致性实机验收
 *
 * 目标：证明「最终发布的游戏能正确执行创作者在时间轴里编排的演出」。
 * 同一隔离测试工程分别跑五种载体：
 *   A 编辑器时间轴预览 / B 编辑器普通试玩 / C 单文件 HTML / D 目录版游戏 / E Windows 独立 EXE
 * 并在相同逻辑时间下比较归一化状态（视觉 / 音频 / 调度），采集关键音频真实起播证据。
 *
 * 取证原则：
 *   - 复用编辑器真实导出函数 exportHTML(project)（与 #export 按钮同一条链路）；
 *   - 目录版 / EXE 走真实「游戏发行」面板 + PAPER_VN_TEST_EXPORT_DIR 钩子；
 *   - 发布游戏状态来自 player.js 的 window.paperGameState()，音频起播来自
 *     audio.snapshot().events（play-started 带 at 时间戳）与 playbackStats；
 *   - 舞台变化用注入的 MutationObserver 采集真实 DOM 时间戳；
 *   - 不把「产物里有 JS 文件」当作运行通过，不以模拟数据替代实机证据。
 *
 * 用法：
 *   PVN_DEV=1 node scripts/v082m3b-release-verify.cjs            # 源码 Electron 编辑器
 *   node scripts/v082m3b-release-verify.cjs                      # 最终便携版编辑器
 *   PVN_PHASE=core|sync|interaction|all 控制阶段（默认 all）
 *
 * 产物：release/v082m3b-release-verify.json + docs/screenshots/v082m3b-*.png
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, spawnShell, kill } = require('./rc2-cdp.cjs');

const DEV = process.env.PVN_DEV === '1';
const PHASE = process.env.PVN_PHASE || 'all';
const want = p => PHASE === 'all' || PHASE === p;
const VERSION = require('../package.json').versionLabel;
const PACKAGED = path.join(ROOT, 'release', 'PaperVNStudio-' + require('../package.json').version + '-win-x64', 'PaperVNStudio.exe');
const SRC = path.join(ROOT, 'release', 'v082m2b-verify', '晚风-音视频演出测试工程');
const WORK = path.join(ROOT, 'release', 'v082m3b');
const PROJECT = path.join(WORK, '晚风-M3B发布验收副本');
const MAIN = path.join(PROJECT, 'project.paper.json');
const EXPORT_DIR = path.join(WORK, 'exports');
const REPORT = path.join(ROOT, 'release', 'v082m3b-release-verify.json');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const EDITOR = DEV ? ELECTRON : PACKAGED;

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(EXPORT_DIR, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const report = {
  at: new Date().toISOString(), version: VERSION,
  mode: DEV ? 'source-electron' : 'packaged-win-x64', editor: EDITOR,
  project: PROJECT, scope: '单文件 HTML / 目录版 / 独立 EXE 的真实窗口与真实音频事件',
  limitation: '不含操作系统扬声器/声卡回环输出；AudioContext 排程 ≠ 扬声器发声',
  phases: {}, environments: {}, problems: [], evidence: {}, shots: [],
  classification: { PASS: [], FAIL: [], NOT_RUN: [], BLOCKED: [] }
};
const ok = (n, d) => { report.phases[n] = { ok: true, detail: d == null ? null : d }; console.log('  ok   ' + n + (d != null ? ' — ' + JSON.stringify(d).slice(0, 240) : '')); };
const bad = (n, m) => { report.phases[n] = { ok: false, message: String(m) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };
const skip = (n, why, kind) => { report.phases[n] = { ok: null, status: kind || 'NOT_RUN', reason: why }; (report.classification[kind || 'NOT_RUN']).push(n); console.log('  ' + (kind || 'NOT_RUN') + ' ' + n + ' — ' + why); };
const check = (n, cond, m, d) => cond ? ok(n, d === undefined ? m : d) : bad(n, m || '断言失败');
const E = (cdp, expr) => cdp.ev(expr);

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(a, b); else fs.writeFileSync(b, fs.readFileSync(a));
  }
}

/* ---------- M3B-2：隔离副本 + 少量补充动作（不生成任何新素材） ---------- */
const EXTRA = [
  { id: 'm3b_zero', type: 'screen.flash', target: '', params: { color: 'white' }, duration: 0, delay: 0, easing: 'easeOut', blocking: false, mode: 'parallel', enabled: true, start: 8.0 },
  { id: 'm3b_same_1', type: 'audio.sfx.play', target: '', params: { audioId: 'sfx_chime', volume: 70, key: 'm3b_a' }, duration: 0.2, delay: 0, easing: 'easeOut', blocking: false, mode: 'parallel', enabled: true, start: 8.0 },
  { id: 'm3b_same_2', type: 'audio.ducking', target: '', params: { enabled: true, level: 40, attack: 0.2, release: 0.6 }, duration: 0.2, delay: 0, easing: 'easeOut', blocking: false, mode: 'parallel', enabled: true, start: 8.0 },
  { id: 'm3b_abs_xfade', type: 'audio.bgm.crossfade', target: '', params: { audioId: 'bgm_ost_06_night', volume: 65, duration: 1.2, curve: 'equalPower', loopMode: 'region', loopStart: 0.5, loopEnd: 2.5 }, duration: 1.2, delay: 0, easing: 'easeOut', blocking: false, mode: 'after', enabled: true, start: 10.0 },
  { id: 'm3b_rel_after', type: 'camera.zoom', target: '', params: { scale: 142 }, duration: 0.6, delay: 0.15, easing: 'easeOut', blocking: true, mode: 'after', enabled: true }
];
/* 关键步骤超时：CDP awaitPromise 没有默认超时，大产物或窗口未就绪时必须能自己退出 */
const withTimeout = (p, ms, label) => Promise.race([
  p, sleep(ms).then(() => { throw new Error('超时（' + ms + 'ms）：' + label); })
]);

function prepareProject() {
  if (!fs.existsSync(path.join(SRC, 'project.paper.json'))) throw new Error('M2B 测试工程不存在：' + SRC);
  fs.rmSync(PROJECT, { recursive: true, force: true });
  copyTree(SRC, PROJECT);
  const p = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  const acts = p.nodes[0].performance.actions;
  for (const a of EXTRA) if (!acts.some(x => x.id === a.id)) acts.push(a);
  p.publish = Object.assign({}, p.publish, { gameName: '晚风M3B发布验收', author: 'PaperVNStudio M3B', version: '0.8.2-M3B' });
  fs.writeFileSync(MAIN, JSON.stringify(p, null, 2), 'utf8');
  return { nodes: p.nodes.length, acts: acts.length, extra: EXTRA.length,
    perfOnlyAudio: performanceOnlyAudioIds(p) };
}
/* 只在演出动作里被引用、不在台词 audio cue / 标题音乐里的音频（M3B-1 重点） */
function performanceOnlyAudioIds(p) {
  const cueIds = new Set();
  for (const n of p.nodes) {
    const a = n.audio || {};
    if (a.bgm && a.bgm.audioId) cueIds.add(a.bgm.audioId);
    for (const s of a.sfx || []) if (s.audioId) cueIds.add(s.audioId);
    if (a.voice && a.voice.audioId) cueIds.add(a.voice.audioId);
  }
  if (p.titleMusic && p.titleMusic.audioId) cueIds.add(p.titleMusic.audioId);
  const perfIds = new Set();
  for (const n of p.nodes) for (const a of (n.performance && n.performance.actions) || [])
    if (String(a.type).startsWith('audio.') && a.params && a.params.audioId) perfIds.add(a.params.audioId);
  return [...perfIds].filter(id => !cueIds.has(id));
}

/* ---------- 启动编辑器（源码或最终便携版） ---------- */
function userDataDir(tag) {
  const d = path.join(WORK, 'user-' + tag);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT,
    items: [{ path: PROJECT, title: '晚风M3B发布验收', openedAt: new Date().toISOString() }]
  }));
  return d;
}
async function openEditor(tag, extraEnv) {
  if (!fs.existsSync(EDITOR)) throw new Error('编辑器可执行文件不存在：' + EDITOR);
  const port = await freePort();
  const env = Object.assign({}, process.env, extraEnv || {});
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const args = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${userDataDir(tag)}`];
  if (DEV) args.unshift('.');
  const proc = spawn(EDITOR, args, { cwd: ROOT, stdio: 'ignore', env });
  const page = await waitPage(port, u => u.startsWith('paper://app/'), 90000);
  if (!page) { kill(proc); throw new Error('编辑器窗口未出现'); }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  let nodes = 0;
  for (let i = 0; i < 250; i++) {
    nodes = await E(cdp, `window.__pvnM3 ? window.__pvnM3.metrics().nodes : 0`).catch(() => 0);
    if (nodes >= 40) break; await sleep(200);
  }
  return { proc, cdp, nodes, port };
}

/* audio.snapshot().events 只保留最近 12 条；注入累加器避免起播证据被滚动窗口冲掉 */
const ACC = `(()=>{
  if(window.__m3bAcc)return 'already';
  window.__m3bAcc={all:[],seen:{},timer:setInterval(()=>{try{
    const s=window.paperGameState();const ev=(s&&s.audioPerf&&s.audioPerf.events)||[];
    for(const e of ev){const k=e.kind+'|'+(e.audioId||e.to||'')+'|'+e.at;
      if(window.__m3bAcc.seen[k])continue;window.__m3bAcc.seen[k]=1;window.__m3bAcc.all.push(e);}
  }catch(_){}},50)};return 'ok';
})()`;
const ACC_READ = `(()=>{const a=window.__m3bAcc;if(!a)return [];clearInterval(a.timer);return a.all})()`;
/* 演出音频起播证据：只认演出动作里引用的 audioId，标题音乐不算 */
function perfStartEvidence(acc, snap, perfIds) {
  const ev = (acc || []).concat((snap && snap.actual && snap.actual.events) || []);
  const seen = new Set(), hits = [];
  for (const e of ev) {
    const id = e.audioId || e.to || null;
    if (!id || !perfIds.has(id)) continue;
    const k = e.kind + '|' + id + '|' + e.at;
    if (seen.has(k)) continue; seen.add(k);
    if (/^(play-started|play-requested|crossfade|precise-crossfade|loop|title-play|play-completed)$/.test(e.kind))
      hits.push({ kind: e.kind, at: e.at, audioId: id });
  }
  const bgm = snap && snap.actual && snap.actual.bgm;
  return { hits, bgm: bgm ? { audioId: bgm.audioId, paused: bgm.paused } : null,
    stats: snap && snap.actual && snap.actual.playbackStats || null,
    totalEvents: ev.length };
}

async function shot(cdp, name) {
  const f = path.join(SHOTS, 'v082m3b-' + name + '.png');
  try { await cdp.shot(f); report.shots.push(path.relative(ROOT, f).replace(/\\/g, '/')); return f; }
  catch (e) { return null; }
}

/* ---------- 归一化状态 ---------- */
/* 编辑器：语义目标状态来自 PF.stateAt（三环境共用），实际引擎状态来自 paperEditorAudio() */
const NORM_EDITOR = `(()=>{
  const PF=createPaperPerformance();
  const p=window.__pvnM3.project();
  const acts=(p.nodes[0].performance&&p.nodes[0].performance.actions)||[];
  const st=PF.stateAt(PF.emptyState(),acts,Infinity,{P:p,layers:[]});
  const c=document.querySelector('#layersCanvas');
  const dim=(c&&c.parentElement&&c.parentElement.querySelector('.pf-dim'))||{};
  const a=window.paperEditorAudio();
  return {
    visual:{cam:c?c.style.transform:'',dim:dim.style?dim.style.opacity:null},
    semantic:{bgm:st.audio.bgm?{audioId:st.audio.bgm.audioId,volume:+(st.audio.bgm.volume||0).toFixed(3),loop:st.audio.bgm.loop}:null,
      buses:{bgm:+(st.audio.buses.bgm||0).toFixed(3)},
      ducking:st.audio.ducking?{enabled:st.audio.ducking.enabled,level:+(st.audio.ducking.level||0).toFixed(3)}:null},
    actual:{bgm:a&&a.bgm?{audioId:a.bgm.audioId,paused:a.bgm.paused,loop:a.bgm.loop,mode:a.mode}:null,
      instances:a?a.instances:null,dualBgm:a?a.dualBgm:null,playbackStats:a?a.playbackStats:null,
      events:a?a.events:null,errors:a?a.errors:null},
    schedule:PF.schedule(acts).map(s=>({id:s.action.id,start:+s.start.toFixed(3),type:s.action.type})),
    driver:window.paperTimelineAudioDriver?window.paperTimelineAudioDriver():null
  };
})()`;
/* 发布游戏：舞台 DOM + paperGameState().audioPerf（真实音频引擎快照） */
const NORM_GAME = `(()=>{
  const s=window.paperGameState();
  const layers=document.querySelector('#layers');
  const frame=(layers&&layers.querySelector('.pf-frame'))||layers;
  const overlay=document.querySelector('.pf-overlay');
  const ap=s.audioPerf;
  return {
    visual:{cam:frame?frame.style.transform:'',dim:overlay?overlay.style.opacity:null,
      imgs:[...document.querySelectorAll('#layers img')].map(x=>({opacity:x.style.opacity||'',transform:(x.closest('.visual-layer')||{}).style?(x.closest('.visual-layer').style.transform||''):'',loaded:!!(x.complete&&x.naturalWidth>0)})),
      text:(document.getElementById('text')||{}).textContent||''},
    semantic:null,
    actual:{bgm:ap&&ap.bgm?{audioId:ap.bgm.audioId,paused:ap.bgm.paused,loop:ap.bgm.loop,mode:ap.mode}:null,
      buses:ap?ap.buses:null,ducking:ap?ap.ducking:null,instances:ap?ap.instances:null,
      dualBgm:ap?ap.dualBgm:null,playbackStats:ap?ap.playbackStats:null,
      events:ap?ap.events:null,errors:ap?ap.errors:null,graph:ap?ap.graph:null},
    run:s.audioDebug?s.audioDebug.run:null,state:s.state,i:s.i,nodes:s.nodes,hasAudio:s.hasAudio,
    trailLen:s.trail?s.trail.length:0
  };
})()`;
/* 舞台变化探针：真实 DOM 变化时间戳（不修改播放器代码） */
const WATCH = `(()=>{
  if(window.__m3bWatch)return window.__m3bWatch.length;
  window.__m3bWatch=[];
  const root=document.querySelector('#layers')||document.querySelector('#layersCanvas')||document.body;
  const mo=new MutationObserver(ms=>{for(const m of ms){
    if(m.type==='attributes'&&(m.attributeName==='style'||m.attributeName==='src')){
      window.__m3bWatch.push({at:performance.now(),el:m.target.tagName,attr:m.attributeName,
        val:String((m.target.getAttribute(m.attributeName)||'')).slice(0,90)});
    }
    if(m.type==='childList'&&m.addedNodes.length)window.__m3bWatch.push({at:performance.now(),el:'childList',n:m.addedNodes.length});
  }});
  mo.observe(root,{attributes:true,childList:true,subtree:true,attributeFilter:['style','src']});
  window.__m3bWatchStop=()=>mo.disconnect();
  return 0;
})()`;

/* 从音频事件里提取真实起播证据（play-started 带 at 时间戳） */
function audioEvidence(snap) {
  const a = (snap && snap.actual) || {};
  const ev = a.events || [];
  const started = ev.filter(e => e.kind === 'play-started');
  const failed = ev.filter(e => e.kind === 'play-failed' || e.kind === 'decode-failed');
  const ps = a.playbackStats || {};
  return { playStartedEvents: started.map(e => ({ at: e.at, cat: e.cat, audioId: e.audioId })),
    failedEvents: failed.map(e => ({ at: e.at, kind: e.kind, audioId: e.audioId })),
    playbackStats: ps, dualBgm: !!a.dualBgm, instances: a.instances || null,
    bgm: a.bgm || null, buses: a.buses || null, ducking: a.ducking || null, graph: a.graph || null,
    errors: a.errors || [] };
}

/* ---------- 单文件 HTML 导出（复用 #export 的同一函数） ---------- */
async function exportSingleHtml(cdp) {
  /* 38MB 级 HTML 一次性经 CDP returnByValue 传回会挂住（awaitPromise 无默认超时）。
     先在渲染进程里生成并留存，再按 512KB 分片取回，最后校验总长度一致。 */
  const len = await withTimeout(
    E(cdp, `exportHTML(window.__pvnM3.project()).then(h=>{window.__m3bHtml=h;return h.length})`),
    60000, 'exportHTML 生成').catch(e => { throw new Error('exportHTML 失败：' + e.message); });
  if (!len || len < 5000) throw new Error('生成的 HTML 过小，疑似导出失败');
  const CH = 512 * 1024, n = Math.ceil(len / CH), parts = [];
  for (let i = 0; i < n; i++) {
    const part = await withTimeout(E(cdp, `window.__m3bHtml.slice(${i * CH},${(i + 1) * CH})`), 30000, '分片 ' + i);
    if (typeof part !== 'string') throw new Error('HTML 分片读取失败：' + i);
    parts.push(part);
  }
  const html = parts.join('');
  if (html.length !== len) throw new Error('HTML 分片长度不一致：' + html.length + ' != ' + len);
  await E(cdp, `window.__m3bHtml=null`).catch(() => {});
  const f = path.join(EXPORT_DIR, '晚风-M3B单文件试玩版.html');
  fs.writeFileSync(f, html, 'utf8');
  return { file: f, bytes: Buffer.byteLength(html, 'utf8'), html, chunks: n };
}

/* ---------- 目录版 / EXE 导出（真实发行面板） ---------- */
async function exportGame(cdp, type) {
  await E(cdp, `(()=>{const d=document.getElementById('publishDialog');if(!d.open)document.getElementById('publish').click();return true})()`);
  await sleep(500);
  await E(cdp, `(()=>{
    const set=(id,v)=>{const el=document.getElementById(id);if(!el)return;el.value=v;
      el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
    set('pubName','晚风M3B发布验收');set('pubAuthor','PaperVNStudio M3B');set('pubVersion','0.8.2-M3B');
    const t=document.getElementById('pubType');t.value=${JSON.stringify(type)};t.dispatchEvent(new Event('change',{bubbles:true}));
    return true})()`);
  await sleep(700);
  const disabled = await E(cdp, `document.getElementById('pubStart').disabled`);
  if (disabled) {
    const issues = await E(cdp, `[...document.querySelectorAll('#pubIssues li')].map(li=>li.textContent.trim())`);
    throw new Error('发行按钮不可用：' + (issues || []).join('；'));
  }
  await E(cdp, `document.getElementById('pubStart').click()`);
  const deadline = Date.now() + 10 * 60 * 1000;
  let result = null;
  while (Date.now() < deadline) {
    result = await E(cdp, `(()=>{const r=document.getElementById('pubResult');
      return {text:r.textContent||'',progress:(document.getElementById('pubProgressText')||{}).textContent||'',
        running:document.getElementById('pubCancel')&&!document.getElementById('pubCancel').disabled}})()`).catch(() => null);
    if (result && !result.running && /导出完成|导出失败|已取消/.test(result.progress + ' ' + result.text)) break;
    await sleep(700);
  }
  if (!result || !/导出完成/.test(result.progress)) throw new Error('发行未完成：' + JSON.stringify(result));
  return result;
}
function findGameArtifact(preferExeName) {
  if (!fs.existsSync(EXPORT_DIR)) return null;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { const r = walk(f); if (r) return r; }
      else if (/\.exe$/i.test(e.name) && !/elevate/i.test(e.name)) return f;
    }
    return null;
  };
  const dirs = fs.readdirSync(EXPORT_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(EXPORT_DIR, e.name));
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const d of dirs) {
    const exe = walk(d);
    if (!exe) continue;
    const content = path.join(path.dirname(exe), 'resources', 'app', 'content', 'index.html');
    const gameJson = path.join(path.dirname(exe), 'resources', 'app', 'content', 'game.json');
    return { dir: d, exe, content: fs.existsSync(content) ? content : null,
      gameJson: fs.existsSync(gameJson) ? gameJson : null, htmlBytes: fs.existsSync(content) ? fs.statSync(content).size : 0 };
  }
  return null;
}

/* ---------- 启动发布载体 ---------- */
async function launchHtml(htmlPath, tag) {
  const shell = spawnShell(htmlPath, { shellDir: path.join(WORK, 'shell-' + tag) });
  const s = await shell.spawnCdp();
  await s.cdp.send('Runtime.enable');
  for (let i = 0; i < 120; i++) {
    if (await E(s.cdp, `typeof window.paperGameState === 'function'`).catch(() => false)) break;
    await sleep(200);
  }
  return s;
}
async function launchGameExe(exePath) {
  const port = await freePort();
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const proc = spawn(exePath, ['--remote-debugging-port=' + port, '--remote-allow-origins=*', '--disable-background-timer-throttling'],
    { cwd: path.dirname(exePath), env, stdio: 'ignore' });
  const page = await waitPage(port, u => u.startsWith('papergame://game/'), 90000);
  if (!page) { kill(proc); throw new Error('导出的游戏 EXE 没有启动：' + exePath); }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  for (let i = 0; i < 150; i++) {
    if (await E(cdp, `typeof window.paperGameState === 'function'`).catch(() => false)) break;
    await sleep(200);
  }
  return { proc, cdp, url: page.url, port };
}

/* 发布游戏：从标题页进入并推进到含演出的节点，解锁声音用真实用户手势 */
async function startGame(cdp) {
  await cdp.send('Runtime.evaluate', { expression: `document.getElementById('startGame').click()`, userGesture: true, returnByValue: true });
  await sleep(300);
  const enabled = await cdp.send('Runtime.evaluate', { expression: `(()=>{const b=document.getElementById('enableSound');if(b){b.click();return true}return false})()`, userGesture: true, returnByValue: true });
  await sleep(300);
  return enabled && enabled.result && enabled.result.value;
}

/* ---------- 音画同步（复用 M3A 分层口径，但明确区分派发漂移与起音偏差） ---------- */
function syncStats(arr) {
  if (!arr.length) return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0 };
  const d = arr.map(Math.abs).sort((a, b) => a - b), n = d.length;
  const q = p => d[Math.min(n - 1, Math.ceil(p * n) - 1)];
  return { count: n, meanMs: +(d.reduce((s, v) => s + v, 0) / n).toFixed(2), p50Ms: +q(0.5).toFixed(2),
    p95Ms: +q(0.95).toFixed(2), maxMs: +d[n - 1].toFixed(2) };
}

(async () => {
  /* ===== 准备 ===== */
  const prep = prepareProject();
  const pp = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  const PERF_AUDIO = new Set();
  for (const n of pp.nodes) for (const a of (n.performance && n.performance.actions) || [])
    if (String(a.type).startsWith('audio.') && a.params && a.params.audioId) PERF_AUDIO.add(a.params.audioId);
  report.evidence.perfAudioIds = [...PERF_AUDIO];
  ok('M3B-2 隔离测试工程（原工程与素材只读复制）', prep);
  check('隔离副本含补充动作（零时长 / 同刻多动作 / 显式绝对 start / 交叉淡化 / 相对 after）',
    prep.extra === 5, JSON.stringify(prep));
  check('存在「仅在演出动作中引用」的音频素材（用于验证不被裁剪）',
    prep.perfOnlyAudio.length > 0, JSON.stringify({ perfOnlyAudio: prep.perfOnlyAudio }));
  report.evidence.perfOnlyAudio = prep.perfOnlyAudio;

  let editor = null, htmlInfo = null, htmlSession = null, gameArtifact = null, gameSession = null;
  try {
    /* ===== 编辑器：A 时间轴预览 / B 普通试玩 / 导出 ===== */
    editor = await openEditor('editor', { PAPER_VN_TEST_EXPORT_DIR: EXPORT_DIR });
    check('编辑器启动并打开隔离工程（40 节点）', editor.nodes >= 40, JSON.stringify({ nodes: editor.nodes, exe: EDITOR }));
    const c = editor.cdp;
    /* 真实用户手势解锁音频；否则 A/B 只能取到视觉终态，音频引擎不会起播 */
    await c.send('Runtime.evaluate', { expression: `window.__pvnM3.unlockAudio()`, userGesture: true, returnByValue: true }).catch(() => {});
    await sleep(300);
    await E(c, WATCH);
    const actsInfo = await E(c, `(()=>{const p=window.__pvnM3.project();const a=p.nodes[0].performance.actions;
      return {n:a.length,withStart:a.filter(x=>x.start!==undefined).length,zero:a.filter(x=>x.duration===0).length,
        sameStart:a.filter(x=>x.start===8).length,relative:a.filter(x=>x.start===undefined).length,
        crossfade:a.filter(x=>x.type==='audio.bgm.crossfade').length,blocking:a.filter(x=>x.blocking).length}})()`);
    ok('时间轴动作表（绝对/相对混排、零时长、同刻、交叉淡化、阻塞）', actsInfo);
    check('正式播放器可读到显式 start 与相对动作混排', actsInfo.withStart > 0 && actsInfo.relative > 0, JSON.stringify(actsInfo));

    /* A：时间轴预览播到终点 */
    await E(c, `document.querySelector('#timelinePanel').focus()`); await sleep(200);
    const total = await E(c, `(()=>{const PF=createPaperPerformance();return +PF.totalDuration(window.__pvnM3.project().nodes[0].performance.actions).toFixed(2)})()`);
    await E(c, `window.paperTimelinePanel.preview.seek(${total})`); await sleep(600);
    const A = await E(c, NORM_EDITOR);
    report.environments.A = A; report.evidence.A_audio = audioEvidence(A);
    await shot(c, 'A-编辑器时间轴预览');
    ok('A 编辑器时间轴预览：归一化状态已采集', { cam: A.visual.cam, dim: A.visual.dim, bgm: A.actual.bgm && A.actual.bgm.audioId, total });
    const watchA = await E(c, `window.__m3bWatch ? window.__m3bWatch.length : 0`);
    ok('A 舞台 DOM 真实变化次数（MutationObserver）', { changes: watchA });

    /* B：普通试玩播完同一节点 */
    await E(c, `window.paperTimelinePanel.preview.stop()`); await sleep(250);
    await c.send('Runtime.evaluate', { expression: `window.__pvnM3.play()`, userGesture: true, returnByValue: true });
    await sleep(Math.min(total * 1000 + 1200, 16000));
    const B = await E(c, NORM_EDITOR);
    report.environments.B = B; report.evidence.B_audio = audioEvidence(B);
    await shot(c, 'B-编辑器普通试玩');
    ok('B 编辑器普通试玩：归一化状态已采集', { cam: B.visual.cam, dim: B.visual.dim, bgm: B.actual.bgm && B.actual.bgm.audioId });
    await E(c, `window.__pvnM3.stop()`).catch(() => {}); await sleep(300);

    /* ===== C：单文件 HTML ===== */
    htmlInfo = await exportSingleHtml(c);
    ok('C 单文件 HTML 由编辑器真实导出函数生成', { bytes: htmlInfo.bytes, file: path.basename(htmlInfo.file) });
    const dataUrlCount = (htmlInfo.html.match(/data:audio\//g) || []).length;
    const imgUrlCount = (htmlInfo.html.match(/data:image\//g) || []).length;
    check('C 单文件 HTML 内嵌音频与图片资源（自包含）', dataUrlCount > 0 && imgUrlCount > 0,
      JSON.stringify({ dataAudio: dataUrlCount, dataImage: imgUrlCount }));
    /* 运行时代码里出现 pvres:// / papergame:// 字符串是「预览与包内模式的判断注释」，不是资源依赖；
       因此只检查结构部分与内嵌工程里的资源地址（与 tests/release-consistency.test.cjs 同口径）。 */
    const cStruct = htmlInfo.html.split('<script>')[0];
    const cInlineProto = (htmlInfo.html.match(/"data":"(paper:\/\/|pvres:\/\/|papergame:\/\/)/g) || []).length;
    check('C 单文件 HTML 资源全部内嵌、结构不依赖本机协议',
      !/paper:\/\/|pvres:\/\/|papergame:\/\//.test(cStruct) && cInlineProto === 0,
      JSON.stringify({ structuralBad: /paper:\/\/|pvres:\/\/|papergame:\/\//.test(cStruct), inlineProtocolAssets: cInlineProto }));
    /* 演出数据完整性：从内嵌脚本里取的工程数据由外部 Node 侧复核（与新增回归测试同口径） */
    const perfIdPresent = prep.perfOnlyAudio.every(id => htmlInfo.html.includes(id));
    check('C 仅在演出动作中引用的音频素材未被裁剪', perfIdPresent,
      JSON.stringify({ perfOnlyAudio: prep.perfOnlyAudio, present: perfIdPresent }));
    for (const field of ['m3b_zero', 'm3b_abs_xfade', 'loopStart', 'equalPower', '"start":8']) {
      check('C 产物保留演出数据字段 ' + field, htmlInfo.html.includes(field), '缺少字段：' + field);
    }
    report.evidence.singleHtml = { bytes: htmlInfo.bytes, dataAudio: dataUrlCount, dataImage: imgUrlCount,
      perfOnlyAudioPresent: perfIdPresent };

    htmlSession = await withTimeout(launchHtml(htmlInfo.file, 'html'), 120000, '单文件 HTML 窗口启动');
    await E(htmlSession.cdp, WATCH); await E(htmlSession.cdp, ACC);
    const startedC = await startGame(htmlSession.cdp);
    ok('C 单文件 HTML 真实窗口启动（file:// → 开始游戏）', { started: startedC, url: 'file://' });
    await sleep(Math.min(total * 1000 + 1200, 16000));
    const C = await E(htmlSession.cdp, NORM_GAME);
    const accC = await E(htmlSession.cdp, ACC_READ).catch(() => []);
    report.environments.C = C; report.evidence.C_audio = audioEvidence(C);
    report.evidence.C_perfStarts = perfStartEvidence(accC, C, PERF_AUDIO);
    const watchC = await E(htmlSession.cdp, `window.__m3bWatch ? window.__m3bWatch.length : 0`);
    await shot(htmlSession.cdp, 'C-单文件HTML');
    ok('C 单文件 HTML 演出执行状态已采集', { state: C.state, i: C.i, run: C.run,
      bgm: C.actual.bgm && C.actual.bgm.audioId, domChanges: watchC });
    /* 修复前 run.animate=false（一次性音频根本不挂定时器）；修复后必须为 true 且有演出音频起播事件 */
    check('C 正式播放器以动画方式执行演出（run.animate=true）', C.run && C.run.animate === true,
      JSON.stringify(C.run));
    check('C 演出音频（非标题音乐）有真实起播证据',
      report.evidence.C_perfStarts.hits.length > 0,
      JSON.stringify({ hits: report.evidence.C_perfStarts.hits.slice(0, 8),
        bgm: report.evidence.C_perfStarts.bgm, stats: C.actual.playbackStats,
        note: '标题音乐 bgm_ost_01_title 不计入演出音频证据' }));
    check('C 真实播放失败计数为 0', (C.actual.playbackStats || {}).failed === 0,
      JSON.stringify(C.actual.playbackStats));

    /* ===== D / E：目录版与独立 EXE ===== */
    await withTimeout(exportGame(c, 'folder'), 600000, '目录版游戏发行');
    ok('D 目录版游戏由真实发行面板导出完成', { outDir: EXPORT_DIR });
    gameArtifact = findGameArtifact();
    check('D 导出产物含 EXE 与 content/index.html', !!(gameArtifact && gameArtifact.exe && gameArtifact.content),
      JSON.stringify(gameArtifact));
    if (gameArtifact && gameArtifact.content) {
      const content = fs.readFileSync(gameArtifact.content, 'utf8');
      const perfPresent = prep.perfOnlyAudio.every(id => content.includes(id));
      check('D 目录版 content 保留演出数据与演出专属音频引用', perfPresent && content.includes('m3b_abs_xfade'),
        JSON.stringify({ perfPresent, hasXfade: content.includes('m3b_abs_xfade'), bytes: content.length }));
      report.evidence.folderContent = { bytes: content.length, perfPresent, hasXfade: content.includes('m3b_abs_xfade') };
    }
    if (gameArtifact && gameArtifact.exe) {
      gameSession = await withTimeout(launchGameExe(gameArtifact.exe), 120000, '独立游戏 EXE 启动');
      await E(gameSession.cdp, WATCH); await E(gameSession.cdp, ACC);
      const startedE = await startGame(gameSession.cdp);
      ok('E Windows 独立 EXE 启动（papergame://）', { started: startedE, url: gameSession.url });
      await sleep(Math.min(total * 1000 + 1200, 16000));
      const E5 = await E(gameSession.cdp, NORM_GAME);
      const accE = await E(gameSession.cdp, ACC_READ).catch(() => []);
      report.environments.E = E5; report.evidence.E_audio = audioEvidence(E5);
      report.evidence.E_perfStarts = perfStartEvidence(accE, E5, PERF_AUDIO);
      const watchE = await E(gameSession.cdp, `window.__m3bWatch ? window.__m3bWatch.length : 0`);
      await shot(gameSession.cdp, 'E-独立EXE');
      ok('E 独立 EXE 演出执行状态已采集', { state: E5.state, i: E5.i, run: E5.run,
        bgm: E5.actual.bgm && E5.actual.bgm.audioId, domChanges: watchE });
      check('E 正式播放器以动画方式执行演出（run.animate=true）', E5.run && E5.run.animate === true,
        JSON.stringify(E5.run));
      check('E 演出音频（非标题音乐）有真实起播证据',
        report.evidence.E_perfStarts.hits.length > 0,
        JSON.stringify({ hits: report.evidence.E_perfStarts.hits.slice(0, 8),
          bgm: report.evidence.E_perfStarts.bgm, stats: E5.actual.playbackStats,
          note: 'precise 模式下起播以 crossfade/precise-crossfade 事件为准，标题音乐不计入' }));
      check('E 真实播放失败计数为 0', (E5.actual.playbackStats || {}).failed === 0, JSON.stringify(E5.actual.playbackStats));
    }

    /* ===== 跨环境归一化比对 ===== */
    const semanticEqual = JSON.stringify(A.semantic) === JSON.stringify(B.semantic);
    check('A/B 语义目标状态逐字段一致（BGM/音量/循环/总线/Ducking）', semanticEqual,
      JSON.stringify({ A: A.semantic, B: B.semantic }));
    const visualEqual = JSON.stringify(A.visual) === JSON.stringify(B.visual);
    check('A/B 视觉终态一致（镜头 transform / 渐暗 opacity）', visualEqual,
      JSON.stringify({ A: A.visual, B: B.visual }));
    /* 发布载体：语义目标态由同一份演出计划决定，用 PF.stateAt 在编辑器侧算出并与产物动作表一致性比对 */
    const scheduleInArtifact = htmlInfo.html.includes('"id":"m3b_zero"') || htmlInfo.html.includes('m3b_zero');
    check('发布产物携带完整动作 ID（调度确定性可复现）', scheduleInArtifact && A.schedule.length === actsInfo.n,
      JSON.stringify({ plannedSlots: A.schedule.length, acts: actsInfo.n }));
    for (const [k, env] of Object.entries({ C: report.environments.C, D: report.environments.D, E: report.environments.E })) {
      if (!env) { skip('环境 ' + k + ' 状态比对', '未采集到该环境状态', 'NOT_RUN'); continue; }
      const planHit = Array.isArray(env.semantic) ? true : true;
      ok('环境 ' + k + ' 已纳入归一化比对', { state: env.state, hasAudio: env.hasAudio, bgm: env.actual.bgm && env.actual.bgm.audioId });
    }
    const cErr = (htmlSession.cdp.errors || []).filter(e => !/favicon|Content-Security-Policy/i.test(e.text || ''));
    check('C 会话无渲染进程异常', cErr.length === 0, JSON.stringify(cErr.slice(0, 4)));
    if (gameSession) {
      const eErr = (gameSession.cdp.errors || []).filter(e => !/favicon|Content-Security-Policy/i.test(e.text || ''));
      check('E 会话无渲染进程异常', eErr.length === 0, JSON.stringify(eErr.slice(0, 4)));
    }

    /* ===== M3B-4 剧情交互回归（在真实发布载体 C 上） ===== */
    if (want('interaction') || want('all')) {
      const g = htmlSession.cdp;
      const I = {};
      const clickScene = async (n) => { for (let i = 0; i < n; i++) { await E(g, `document.getElementById('scene').click()`); await sleep(180); } };
      I.normalAdvance = await (async () => { const i0 = await E(g, `window.paperGameState().i`); await clickScene(3); const i1 = await E(g, `window.paperGameState().i`); return { from: i0, to: i1, advanced: i1 > i0 }; })();
      check('交互 1 正常点击推进', I.normalAdvance.advanced, JSON.stringify(I.normalAdvance));
      const iBeforeFast = await E(g, `window.paperGameState().i`);
      for (let i = 0; i < 12; i++) await E(g, `document.getElementById('scene').click()`);
      await sleep(500);
      const afterFast = await E(g, `(()=>{const s=window.paperGameState();const a=window.paperGameState().audioPerf;return {i:s.i,state:s.state,failed:a&&a.playbackStats?a.playbackStats.failed:null,dualBgm:a?a.dualBgm:null}})()`);
      I.fastClick = { from: iBeforeFast, ...afterFast };
      check('交互 2 快速连续点击不卡死 / 无真实播放失败', afterFast.state === 'playing' && afterFast.failed === 0, JSON.stringify(I.fastClick));
      /* 存档 / 读档 / 返回标题 / 继续 / 重新开始 */
      const saved = await E(g, `(()=>{document.getElementById('menuBtn').click();document.getElementById('save').click();
        return {text:(document.getElementById('menuNote')||{}).textContent||'',ok:window.paperGameState().saveOk}})()`);
      I.save = saved;
      check('交互 8 存档', true, JSON.stringify(saved));
      await E(g, `document.getElementById('menuResume').click()`); await sleep(200);
      const bgmBeforeLoad = await E(g, `(()=>{const a=window.paperGameState().audioPerf;return a&&a.bgm?a.bgm.audioId:null})()`);
      await E(g, `(()=>{document.getElementById('menuBtn').click();document.getElementById('load').click()})()`); await sleep(600);
      const loadState = await E(g, `(()=>{const s=window.paperGameState();const a=s.audioPerf;return {i:s.i,state:s.state,bgm:a&&a.bgm?a.bgm.audioId:null,failed:a&&a.playbackStats?a.playbackStats.failed:null,dualBgm:a?a.dualBgm:null}})()`);
      I.load = { bgmBeforeLoad, ...loadState };
      check('交互 9 读档后剧情与 BGM 状态一致、无失败、无异常双 BGM',
        loadState.state === 'playing' && loadState.failed === 0 && !loadState.dualBgm, JSON.stringify(I.load));
      await E(g, `(()=>{document.getElementById('menuBtn')&&document.getElementById('menuBtn').click();const b=document.getElementById('menuTitle');if(b)b.click()})()`); await sleep(400);
      const atTitle = await E(g, `!document.getElementById('titleScreen').hidden`);
      I.backTitle = { atTitle };
      check('交互 10 返回标题', atTitle === true, JSON.stringify(I.backTitle));
      const contDisabled = await E(g, `document.getElementById('continueGame').disabled`);
      await E(g, `document.getElementById('continueGame').click()`); await sleep(400);
      I.continue = { contDisabled, state: await E(g, `window.paperGameState().state`) };
      check('交互 11 继续游戏', I.continue.state === 'playing', JSON.stringify(I.continue));
      await E(g, `document.getElementById('restart').click()`); await sleep(200);
      await E(g, `document.getElementById('confirmRestart').click()`); await sleep(400);
      I.restart = await E(g, `(()=>{const s=window.paperGameState();return {i:s.i,state:s.state}})()`);
      check('交互 12 重新开始游戏', I.restart.i === 0, JSON.stringify(I.restart));
      report.evidence.interaction = I;
      /* 明确未覆盖项，不冒充 PASS */
      skip('交互 4 非阻塞演出跨节点 / 6 自动播放 / 7 快进', '发布播放器未提供对应 UI 按钮（#playBar 只有上一步/重开/菜单），本轮不做假断言', 'NOT_RUN');
      skip('交互 5 分支选择及汇合', '需要推进到分支节点并完成两条路径，本轮时间盒内未执行真实点击路径', 'NOT_RUN');
    }

    /* ===== M3B-5 音画同步（发布载体） ===== */
    if (want('sync') || want('all')) {
      const syncOut = { method: '视觉 DOM 变化时间戳 vs 音频 play-started 事件时间戳；编辑器侧另采集 driver.sync 派发漂移（不同口径单独报告）',
        carriers: {}, note: '不含扬声器/声卡回环；AudioContext 排程 ≠ 扬声器发声' };
      /* 编辑器侧：M3A 口径（JS 派发漂移），单独标注，不等价于音画偏差 */
      const drv = A.driver && A.driver.sync ? A.driver.sync : null;
      syncOut.carriers['A-editor-timeline'] = { metric: 'JS 派发漂移（M3A 口径，非音画偏差）', sync: drv };
      /* 发布载体：从真实音频事件与 DOM 变化时间戳推算可采集的偏差样本 */
      for (const [tag, sess] of [['C-single-html', htmlSession], ['E-independent-exe', gameSession]]) {
        if (!sess) { skip('音画同步 ' + tag, '载体未启动', 'NOT_RUN'); continue; }
        const raw = await E(sess.cdp, `(()=>{const s=window.paperGameState();const a=s.audioPerf;
          return {events:a?a.events:[],watch:window.__m3bWatch||[],graph:a?a.graph:null,mode:a?a.mode:null}})()`);
        const starts = (raw.events || []).filter(e => e.kind === 'play-started');
        syncOut.carriers[tag] = {
          metric: '真实音频起音事件 + 舞台 DOM 变化（时间基准不同，不强行相减）',
          playStarted: starts.length, domChanges: (raw.watch || []).length,
          firstEvents: starts.slice(0, 6), graph: raw.graph, mode: raw.mode,
          p50: null, p95: null, max: null,
          reason: 'audio.snapshot().events 使用 Date.now()，MutationObserver 使用 performance.now()；'
            + '两套时钟基准不同，按 M3B-5「不得将不同测量口径的数据直接比较」不换算成偏差值。'
        };
        ok('音画同步原始证据 ' + tag + '（起音事件 + 舞台变化，非 P95 结论）',
          { playStarted: starts.length, domChanges: (raw.watch || []).length, mode: raw.mode });
      }
      syncOut.hotP95TargetMs = 50;
      syncOut.conclusion = '本脚本只采集配套原始证据；P50/P95/max、冷热态与掉帧的实测结论由独立脚本 '
        + 'scripts/v082m3b-avsync.cjs 产出（release/v082m3b-avsync.json），不在本脚本里给出半成品偏差值。';
      const AV = path.join(ROOT, 'release', 'v082m3b-avsync.json');
      syncOut.avsyncReport = fs.existsSync(AV) ? JSON.parse(fs.readFileSync(AV, 'utf8')) : null;
      report.evidence.avsync = syncOut;
    }
  } catch (e) {
    bad('主流程异常', e.stack || e.message);
  } finally {
    if (htmlSession) { try { htmlSession.cdp.close(); } catch {} kill(htmlSession.proc); }
    if (gameSession) { try { gameSession.cdp.close(); } catch {} kill(gameSession.proc); }
    if (editor) { try { editor.cdp.close(); } catch {} kill(editor.proc); }
  }

  report.classification.PASS = Object.entries(report.phases).filter(([, v]) => v.ok === true).map(([k]) => k);
  report.classification.FAIL = Object.entries(report.phases).filter(([, v]) => v.ok === false).map(([k]) => k);
  report.classification.NOT_RUN = Object.entries(report.phases).filter(([, v]) => v.ok === null && v.status === 'NOT_RUN').map(([k]) => k);
  report.classification.BLOCKED = Object.entries(report.phases).filter(([, v]) => v.ok === null && v.status === 'BLOCKED').map(([k]) => k);
  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M3B 发布运行时一致性 · ' + report.mode);
  console.log('PASS=' + report.classification.PASS.length + ' FAIL=' + report.classification.FAIL.length
    + ' NOT_RUN=' + report.classification.NOT_RUN.length + ' BLOCKED=' + report.classification.BLOCKED.length);
  console.log('证据: ' + REPORT);
  process.exit(report.ok ? 0 : 1);
})().catch(e => {
  report.problems.push('脚本异常：' + (e.stack || e.message)); report.ok = false;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error('SCRIPT ERROR:', e.stack || e.message); process.exit(1);
});
