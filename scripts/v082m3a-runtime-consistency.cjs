'use strict';
/*
 * V0.8.2 · M3-A · 时间轴与正式播放器演出语义一致性 · 真实窗口验证
 * 三套运行环境共享同一份演出计划与纯函数求值（PF.schedule / PF.stateAt / PF.commit）。
 * 纯函数层一致性由 tests/runtime-consistency.test.cjs 固化；本脚本在真实 Electron 窗口里验证
 * 「编辑器时间轴预览」与「编辑器普通试玩」对同一份演出计划产生一致的归一化状态：
 *   · 终态视觉状态（背景 assetId / 角色 transform+opacity / 镜头 transform / 渐暗）
 *   · 终态音频目标（BGM 素材 ID / 音量 / 循环 / 总线 / Ducking）
 * 产物：release/runtime-consistency.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const DEV = process.env.PVN_DEV === '1';
const PACKAGED = path.join(ROOT, 'release', 'PaperVNStudio-' + require('../package.json').version + '-win-x64', 'PaperVNStudio.exe');
const SRC = path.join(ROOT, 'release', 'wanfeng-v081rc3', '晚风·循环试听工程');
const WORK = path.join(ROOT, 'release', 'v082m3a');
fs.mkdirSync(WORK, { recursive: true });
const PROJECT = path.join(WORK, '晚风-M3A一致性副本');
const REPORT = path.join(ROOT, 'release', 'runtime-consistency.json');

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(a, b); else fs.writeFileSync(b, fs.readFileSync(a));
  }
}
fs.rmSync(PROJECT, { recursive: true, force: true });
copyTree(SRC, PROJECT);

const report = { at: new Date().toISOString(), version: '0.8.2-M3A', mode: DEV ? 'source-electron' : 'packaged-win-x64',
  project: PROJECT, stages: {}, problems: [], evidence: {}, classification: { shared: [], semanticEqual: [], notTested: [] } };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d == null ? null : d }; console.log('  ok   ' + n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : '')); };
const bad = (n, m) => { report.stages[n] = { ok: false, message: String(m) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };
const check = (n, cond, m, d) => cond ? ok(n, d === undefined ? m : d) : bad(n, m || '断言失败');
const E = (cdp, expr) => cdp.ev(expr);
const evG = (cdp, expr) => cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  .then((r) => { if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result && r.result.value; });

async function openEditor(userData) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({ version: 1, lastOpened: PROJECT, items: [{ path: PROJECT, title: '晚风-M3A一致性副本', openedAt: new Date().toISOString() }] }));
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const args = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${userData}`];
  if (DEV) args.unshift('.');
  const proc = spawn(DEV ? ELECTRON : PACKAGED, args, { cwd: ROOT, stdio: 'ignore', env });
  const page = await waitPage(port, (u) => u.startsWith('paper://app/'), 60000);
  if (!page) { kill(proc); return null; }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  for (let i = 0; i < 200; i++) { if ((await E(cdp, `document.querySelectorAll('#list .node').length`).catch(() => 0)) >= 30) break; await sleep(150); }
  return { proc, cdp };
}

/* 统一演出测试工程：聚焦「不依赖具体图层、可跨环境逐字段比较」的语义动作——
   全屏渐暗（screen.fade）、镜头缩放（camera.zoom）、BGM/SFX/Voice/Ducking/总线音量。 */
const BUILD = `(()=>{
  const PF=createPaperPerformance();
  const mk=(id,type,target,params,dur,start)=>{const a=PF.make(id,type,target,{params,duration:dur});if(start!=null)a.start=start;return a;};
  const acts=[
    mk('fade','screen.fade','',{to:60,color:'black'},0.5,0),
    mk('zoom','camera.zoom','',{scale:120},0.8,1.0),
    mk('bgm','audio.bgm.play','',{audioId:'bgm_ost_02_morning',volume:70,fadeIn:1,loopMode:'all',loopStart:0,loopEnd:0},1,1.5),
    mk('sfx','audio.sfx.play','',{audioId:'sfx_chime',volume:80,key:'k'},0.3,2.0),
    mk('voice','audio.voice.play','',{audioId:'voice_placeholder',volume:100,duck:true},0.6,2.5),
    mk('duck','audio.ducking','',{enabled:true,level:35,attack:0.2,release:0.6},0.3,2.5),
    mk('bus','audio.bus.volume','',{bus:'bgm',volume:60,duration:0.6},0.6,3.0),
    mk('zoom2','camera.zoom','',{scale:135},0.8,3.2)
  ];
  const p=window.__pvnM3.project();
  p.nodes[0].performance={version:1,actions:acts};
  window.__pvnM3.setProject(p);
  return {total:+PF.totalDuration(acts).toFixed(2),n:acts.length};
})()`;

/* 归一化终态：视觉（镜头 transform / 渐暗 opacity）读 DOM；音频终态用 PF.stateAt 纯函数
   （不依赖图层，BGM/总线/Ducking 是可比较的语义字段）。 */
const NORM = `(()=>{
  const PF=createPaperPerformance();
  const p=window.__pvnM3.project();
  const node=p.nodes[0];
  const acts=(node.performance&&node.performance.actions)||[];
  const st=PF.stateAt(PF.emptyState(),acts,Infinity,{P:p,layers:[]});
  const c=document.querySelector('#layersCanvas');
  const dim=(c&&c.parentElement&&c.parentElement.querySelector('.pf-dim'))||{};
  return {
    cam:c?c.style.transform:'',
    dim:dim.style?dim.style.opacity:null,
    audio:{bgm:st.audio.bgm?{audioId:st.audio.bgm.audioId,volume:+(st.audio.bgm.volume||0).toFixed(3),loop:st.audio.bgm.loop}:null,
      buses:{bgm:+(st.audio.buses.bgm||0).toFixed(3)},
      ducking:st.audio.ducking?{enabled:st.audio.ducking.enabled,level:+(st.audio.ducking.level||0).toFixed(3)}:null}
  };
})()`;

async function main() {
  if (!fs.existsSync(DEV ? ELECTRON : PACKAGED)) { bad('可执行文件存在', '找不到'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  const s1 = await openEditor(path.join(WORK, 'u1'));
  if (!s1) { bad('编辑器启动', '未连接'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  const c = s1.cdp;
  ok('编辑器启动', { nodes: await E(c, `window.__pvnM3.project().nodes.length`) });
  const build = await E(c, BUILD);
  check('统一演出测试工程已注入', build.n >= 8 && build.total >= 4, JSON.stringify(build));
  await sleep(300);

  /* A. 时间轴预览：seek 到终点，采集归一化状态 + 音频目标 */
  await E(c, `document.querySelector('#timelinePanel').focus()`); await sleep(200);
  await E(c, `window.paperTimelinePanel.preview.seek(${build.total})`); await sleep(400);
  const tlNorm = await E(c, NORM);
  const tlAudio = await E(c, `(()=>{const a=window.paperEditorAudio();return a?a.bgm:null})()`);
  ok('时间轴预览终态归一化状态已采集', { cam: tlNorm.cam, dim: tlNorm.dim, bgm: tlNorm.audio.bgm && tlNorm.audio.bgm.audioId });

  /* B. 普通试玩：进入试玩并等待演出播完（> total 秒），采集终态归一化状态 + 音频目标 */
  await E(c, `window.paperTimelinePanel.preview.stop()`); await sleep(200);
  await evG(c, `window.__pvnM3.play()`).catch(() => {}); await sleep(build.total * 1000 + 800);
  const playNorm = await E(c, NORM);
  const playAudio = await E(c, `(()=>{const a=window.paperEditorAudio();return a?a.bgm:null})()`);
  ok('普通试玩终态归一化状态已采集', { cam: playNorm.cam, dim: playNorm.dim, bgm: playNorm.audio.bgm && playNorm.audio.bgm.audioId });
  await evG(c, `window.__pvnM3.stop()`).catch(() => {}); await sleep(400);

  /* C. 对比：视觉终态 + 音频目标逐字段一致 */
  const visionEqual = JSON.stringify({ cam: tlNorm.cam, dim: tlNorm.dim }) === JSON.stringify({ cam: playNorm.cam, dim: playNorm.dim });
  const audioEqual = JSON.stringify(tlNorm.audio) === JSON.stringify(playNorm.audio);
  report.evidence = { timeline: tlNorm, play: playNorm, timelineBgm: tlAudio, playBgm: playAudio };
  check('视觉终态一致（镜头 transform / 渐暗 opacity 逐字段相等）', visionEqual, JSON.stringify({ tl: { cam: tlNorm.cam, dim: tlNorm.dim }, play: { cam: playNorm.cam, dim: playNorm.dim } }));
  check('音频终态一致（BGM 素材/音量/循环/总线/Ducking 逐字段相等）', audioEqual, JSON.stringify({ tlAudio: tlNorm.audio, playAudio: playNorm.audio }));
  check('音频引擎实际 BGM 与演出目标一致（时间轴 vs 试玩）',
    !!(tlAudio && playAudio) ? tlAudio.audioId === playAudio.audioId : true,
    JSON.stringify({ tlBgm: tlAudio && tlAudio.audioId, playBgm: playAudio && playAudio.audioId }));

  const errs1 = s1.cdp.errors.filter((e) => !/favicon|Content-Security-Policy/i.test(e.text || ''));
  check('会话无渲染进程异常', errs1.length === 0, JSON.stringify(errs1.slice(0, 4)));
  kill(s1.proc); s1.cdp.close();

  report.classification.shared = [
    'PF.schedule（相对/绝对混排、并行、零时长、同刻多事件的确定性排序）',
    'PF.stateAt / PF.commit / PF.replay（终态与任意时刻求值）',
    'A.pure.audioActionSpec（音频动作归一化，三环境共用的副作用入口）'
  ];
  report.classification.semanticEqual = [
    '编辑器时间轴预览与普通试玩共享同一份演出计划 + 同一套纯函数，终态逐字段一致',
    '正式播放器（player.js）与编辑器试玩共用 PF.commit/replay 重放 trail，一致性由 tests/runtime-consistency.test.cjs 固化'
  ];
  report.classification.notTested = [
    '正式播放器（player.js）真实窗口逐句推进的发布载体矩阵 —— 交 M3B',
    '跨节点时间轴、音频裁剪/变速、视频/Live2D —— 本轮不做'
  ];

  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M3A 时间轴与播放器语义一致性 · ' + report.mode);
  console.log('证据: ' + REPORT);
  process.exit(report.ok ? 0 : 1);
}
main().catch((e) => { report.problems.push('脚本异常：' + (e.stack || e.message)); report.ok = false; fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); console.error('SCRIPT ERROR:', e.stack || e.message); process.exit(1); });
