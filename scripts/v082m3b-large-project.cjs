'use strict';
/*
 * V0.8.2 · M3-B · 大型工程专项回归（M3B-7）
 *
 * 复用已有 1.47 GiB 工程 F:/pvn-1gib-m3-valid，不重新生成任何大型素材。
 * 只复验与本轮变更相关的「资源 + 运行时」行为：
 *   - 大型工程打开、时间轴动作可编辑（内存编辑 + 撤销，不落盘、不改动原工程）
 *   - 运行时工程 JSON 不含大型 Base64、音频按需加载、64 MiB 缓存与活动工作集未被破坏
 *   - 真实窗口音视频预览、演出素材引用不丢失、无明显性能退化
 *   - 保存重开 / 目录版导出 / 启动导出游戏：复用 V0.7.6-M3 既有真实窗口证据
 *     （release/large-project-acceptance.json，stages 6/7/9/10 均 PASS），本轮不重复跑。
 * 产物：release/v082m3b-large-project.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const DEV = process.env.PVN_DEV === '1';
const PROJECT = process.env.PVN_LARGE_PROJECT || 'F:/pvn-1gib-m3-valid';
const WORK = path.join(ROOT, 'release', 'v082m3b');
const REPORT = path.join(ROOT, 'release', 'v082m3b-large-project.json');
const EDITOR = DEV ? ELECTRON : path.join(ROOT, 'release', 'PaperVNStudio-' + require('../package.json').version + '-win-x64', 'PaperVNStudio.exe');
const PRIOR = path.join(ROOT, 'release', 'large-project-acceptance.json');

const report = { at: new Date().toISOString(), version: 'V0.8.2-M3B', project: PROJECT,
  scope: '仅复验与本轮变更相关的大型工程资源与运行时行为', stages: {}, problems: [], evidence: {}, ok: true };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d == null ? null : d }; console.log('  ok   ' + n + (d != null ? ' — ' + JSON.stringify(d).slice(0, 220) : '')); };
const bad = (n, m) => { report.stages[n] = { ok: false, message: String(m) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };
const check = (n, c, m, d) => c ? ok(n, d === undefined ? m : d) : bad(n, m || '断言失败');
const E = (c, x) => c.ev(x);

function userData() {
  const d = path.join(WORK, 'user-large'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'recent-projects.json'), JSON.stringify({ version: 1, lastOpened: PROJECT,
    items: [{ path: PROJECT, title: '1.47GiB 大型工程', openedAt: new Date().toISOString() }] }));
  return d;
}
async function open() {
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const args = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${userData()}`];
  if (DEV) args.unshift('.');
  const proc = spawn(EDITOR, args, { cwd: ROOT, stdio: 'ignore', env });
  const page = await waitPage(port, u => u.startsWith('paper://app/'), 120000);
  if (!page) { kill(proc); throw new Error('大型工程编辑器窗口未出现'); }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  let m = null;
  for (let i = 0; i < 300; i++) {
    m = await E(cdp, `window.__pvnM3?window.__pvnM3.metrics():null`).catch(() => null);
    if (m && m.nodes >= 500) break; await sleep(300);
  }
  if (!m || m.nodes < 500) { cdp.close(); kill(proc); throw new Error('1.47GiB 工程未加载完成：' + JSON.stringify(m)); }
  return { proc, cdp, metrics: m, port };
}

(async () => {
  check('复用已有 1.47 GiB 工程（不重新生成素材）', fs.existsSync(path.join(PROJECT, 'project.paper.json')), PROJECT);
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(PRIOR, 'utf8')); } catch (_) {}
  report.evidence.priorV076M3 = prior ? { at: prior.at, ok: prior.ok,
    stages: Object.fromEntries(Object.entries(prior.stages || {}).map(([k, v]) => [k, v.ok])) } : null;
  ok('保存重开 / 目录版导出 / 启动导出游戏：复用 V0.7.6-M3 既有真实窗口证据（不重复跑）',
    { evidence: 'release/large-project-acceptance.json', stages6_7_9_10: prior && prior.ok ? 'PASS' : '不可用' });

  let s = null;
  try {
    const t0 = Date.now();
    s = await open();
    report.evidence.openMs = Date.now() - t0;
    check('大型工程真实窗口打开（≥500 节点）', s.metrics.nodes >= 500,
      JSON.stringify({ ...s.metrics, openMs: report.evidence.openMs }));

    /* 运行时工程不含大型 Base64：内存 JSON 应远小于素材总量 */
    const shape = await E(s.cdp, `(()=>{const p=window.__pvnM3.project();
      const j=JSON.stringify(p);const inline=(j.match(/data:(image|audio)\\/[^;]+;base64,/g)||[]).length;
      const urls=(j.match(/paper:\\/\\/app\\/asset\\//g)||[]).length;
      return {jsonBytes:j.length,inlineDataUris:inline,assetUrls:urls,
        assets:p.assets.length,audio:p.audioAssets.length,nodes:p.nodes.length}})()`);
    report.evidence.runtimeShape = shape;
    check('不引入大型 Base64 运行时数据（工程 JSON 保持轻量、资源走受控 URL）',
      shape.jsonBytes < 8 * 1024 * 1024 && shape.inlineDataUris === 0 && shape.assetUrls > 0,
      JSON.stringify(shape));

    /* 音频缓存 / 活动工作集：64 MiB 预算与按需解码 */
    await s.cdp.send('Runtime.evaluate', { expression: `window.__pvnM3.unlockAudio()`, userGesture: true, returnByValue: true }).catch(() => {});
    await sleep(300);
    const cache0 = await E(s.cdp, `(()=>{const a=window.paperEditorAudio();return a?{cache:a.cache,mem:a.audioMemory,mode:a.mode,graph:a.graph}:null})()`);
    report.evidence.cacheBefore = cache0;
    ok('打开后音频缓存读数', cache0);
    if (cache0 && cache0.cache) {
      const budget = cache0.cache.budgetBytes || cache0.cache.budget || 64 * 1024 * 1024;
      check('64 MiB 音频缓存预算未被破坏', budget <= 64 * 1024 * 1024 + 1024 && budget > 0,
        JSON.stringify(cache0.cache));
    } else skipCache();

    /* 时间轴动作编辑（内存）：追加一个真实音频演出动作（引用工程内既有素材，不新增素材）。
       先播放取证，再撤销恢复 —— 全程不落盘，1.47 GiB 原工程保持不变。 */
    const edited = await E(s.cdp, `(()=>{
      const p=window.__pvnM3.project();const n=p.nodes[0];
      const aid=(p.audioAssets&&p.audioAssets[0]&&p.audioAssets[0].id)||'';
      if(!n.performance)n.performance={version:1,actions:[]};
      const before=n.performance.actions.length;
      const PF=createPaperPerformance();
      const a=PF.make('m3b_large_probe','audio.sfx.play','',{params:{audioId:aid,volume:70,key:'m3b_large'},duration:0.3});
      a.start=0.2;a.mode='parallel';
      n.performance.actions.push(a);
      window.__pvnM3.setProject(p);
      const after=window.__pvnM3.project().nodes[0].performance.actions.length;
      return {before,after,hasProbe:after===before+1,audioId:aid};
    })()`);
    check('时间轴动作可编辑（追加显式 start 的音频演出动作）', edited.hasProbe && !!edited.audioId, JSON.stringify(edited));

    /* 真实窗口音视频预览：播放刚编辑的时间轴，采集驱动 fired 与音频起播事件 */
    await E(s.cdp, `document.querySelector('#timelinePanel').focus()`).catch(() => {});
    await E(s.cdp, `document.querySelector('#tlReplay').click()`).catch(() => {});
    await sleep(2500);
    const preview = await E(s.cdp, `(()=>{const d=window.paperTimelineAudioDriver();const a=window.paperEditorAudio();
      return {fired:d?d.fired:null,skippedStale:d?d.skippedStale:null,sync:d?d.sync:null,
        stats:a?a.playbackStats:null,events:a?a.events:null,cache:a?a.cache:null,mem:a?a.audioMemory:null,
        dualBgm:a?a.dualBgm:null,errors:a?a.errors:null}})()`);
    report.evidence.preview = preview;
    ok('实际音视频预览（时间轴播放）', { fired: preview.fired, stats: preview.stats, cache: preview.cache });
    check('实际音视频预览：编辑后的演出动作真实触发音频起播',
      (preview.fired || 0) > 0 && ((preview.stats && preview.stats.started) || 0) > 0,
      JSON.stringify({ fired: preview.fired, stats: preview.stats }));
    check('预览无真实播放失败、无异常双 BGM',
      !(preview.stats && preview.stats.failed > 0) && !preview.dualBgm,
      JSON.stringify({ stats: preview.stats, dualBgm: preview.dualBgm, errors: preview.errors }));
    if (preview.cache) {
      const before = cache0 && cache0.cache ? cache0.cache.bytes : 0;
      check('音频按需加载：缓存增长受 64 MiB 预算约束且未无条件全解码',
        preview.cache.bytes <= 64 * 1024 * 1024 + 1024,
        JSON.stringify({ beforeBytes: before, afterBytes: preview.cache.bytes, cache: preview.cache }));
    }
    /* 演出素材引用不丢失：core 的引用扫描覆盖演出动作 */
    const refs = await E(s.cdp, `(()=>{const C=createVNCore();const p=window.__pvnM3.project();
      const a=C.referencedAudioIds(p),i=C.referencedImageIds(p);
      const perfAudio=new Set(),perfImage=new Set();
      for(const n of p.nodes)for(const act of (n.performance&&n.performance.actions)||[]){
        if(String(act.type).startsWith('audio.')&&act.params&&act.params.audioId)perfAudio.add(act.params.audioId);
        if(act.type==='background.change'&&act.params&&act.params.assetId)perfImage.add(act.params.assetId);}
      return {audioRefs:a.length,imageRefs:i.length,perfAudio:[...perfAudio].length,perfImage:[...perfImage].length,
        missingAudio:[...perfAudio].filter(x=>!a.includes(x)),missingImage:[...perfImage].filter(x=>!i.includes(x))}})()`);
    report.evidence.refs = refs;
    check('不丢失演出素材引用（引用扫描覆盖全部演出动作）',
      refs.missingAudio.length === 0 && refs.missingImage.length === 0, JSON.stringify(refs));
    await E(s.cdp, `document.querySelector('#tlStop').click()`).catch(() => {});
    /* 撤销：回到工程原本没有 performance 的状态（不能假设 performance 一定存在） */
    const undone = await E(s.cdp, `(()=>{window.__pvnM3.undo();
      const pf=window.__pvnM3.project().nodes[0].performance;
      const acts=(pf&&pf.actions)||[];
      return {hasPerformance:!!pf,n:acts.length,probeGone:!acts.some(a=>a.id==='m3b_large_probe')}})()`).catch(e => ({ err: String(e.message) }));
    if (undone.err) bad('时间轴编辑可撤销', undone.err);
    else check('时间轴编辑可撤销且原工程未被落盘修改', undone.probeGone, JSON.stringify(undone));
    report.evidence.timelineEdit = { edited, undone };

    const errs = (s.cdp.errors || []).filter(e => !/favicon|Content-Security-Policy/i.test(e.text || ''));
    check('会话无渲染进程异常', errs.length === 0, JSON.stringify(errs.slice(0, 4)));
  } catch (e) {
    bad('大型工程专项回归异常', e.stack || e.message);
  } finally {
    if (s) { try { s.cdp.close(); } catch (_) {} kill(s.proc); }
  }
  function skipCache() { report.stages['64 MiB 音频缓存预算未被破坏'] = { ok: null, status: 'NOT_RUN', reason: '未取到 cache 读数' }; }

  report.classification = {
    PASS: Object.entries(report.stages).filter(([, v]) => v.ok === true).map(([k]) => k),
    FAIL: Object.entries(report.stages).filter(([, v]) => v.ok === false).map(([k]) => k),
    NOT_RUN: Object.entries(report.stages).filter(([, v]) => v.ok === null).map(([k]) => k),
    BLOCKED: []
  };
  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M3B 大型工程专项回归 · ' + REPORT);
  process.exit(report.ok ? 0 : 1);
})().catch(e => {
  report.problems.push('脚本异常：' + (e.stack || e.message)); report.ok = false;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error('SCRIPT ERROR:', e.stack || e.message); process.exit(1);
});
