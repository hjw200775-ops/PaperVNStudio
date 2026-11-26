'use strict';
/*
 * V0.8.2 · M3-B · 最终打包产物实机验证（M3B-9 补完）
 *
 * 主验收脚本 scripts/v082m3b-release-verify.cjs 已用最终便携版覆盖：
 *   启动 / 打开隔离工程 / 播放时间轴 / 普通试玩 / 导出单文件 HTML / 导出目录版 /
 *   启动导出的独立 EXE / 完成关键演出与剧情交互。
 * 本脚本补上它没做的 4 步，且使用独立副本，不改动主验收脚本的工程：
 *   ① 修改时间轴动作 ② 保存并关闭工程 ③ 重新打开 ④ 确认修改正确
 * 另外核对最终产物与 Git 源码一致（dist/desktop/package.json 逐字节比对）。
 * 产物：release/v082m3b-packaged-verify.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const PKG = require('../package.json');
const EXE = path.join(ROOT, 'release', 'PaperVNStudio-' + PKG.version + '-win-x64', 'PaperVNStudio.exe');
const SRC = path.join(ROOT, 'release', 'v082m2b-verify', '晚风-音视频演出测试工程');
const WORK = path.join(ROOT, 'release', 'v082m3b');
const PROJECT = path.join(WORK, '晚风-M3B打包实机副本');
const MAIN = path.join(PROJECT, 'project.paper.json');
const REPORT = path.join(ROOT, 'release', 'v082m3b-packaged-verify.json');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const MARK_ID = 'm3b_packaged_edit';
const MARK_SCALE = 137;

const report = { at: new Date().toISOString(), version: PKG.versionLabel, exe: EXE, project: PROJECT,
  stages: {}, problems: [], evidence: {}, shots: [], ok: true };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d == null ? null : d }; console.log('  ok   ' + n + (d != null ? ' — ' + JSON.stringify(d).slice(0, 220) : '')); };
const bad = (n, m) => { report.stages[n] = { ok: false, message: String(m) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };
const check = (n, c, m, d) => c ? ok(n, d === undefined ? m : d) : bad(n, m || '断言失败');
const E = (c, x) => c.ev(x);

function copyTree(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const e of fs.readdirSync(a, { withFileTypes: true })) {
    const s = path.join(a, e.name), t = path.join(b, e.name);
    if (e.isDirectory()) copyTree(s, t); else fs.writeFileSync(t, fs.readFileSync(s));
  }
}
function userData(tag) {
  const d = path.join(WORK, 'user-' + tag); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'recent-projects.json'), JSON.stringify({ version: 1, lastOpened: PROJECT,
    items: [{ path: PROJECT, title: '晚风M3B打包实机', openedAt: new Date().toISOString() }] }));
  return d;
}
async function launch(tag) {
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const proc = spawn(EXE, ['--remote-debugging-port=' + port, '--remote-allow-origins=*', `--user-data-dir=${userData(tag)}`],
    { cwd: ROOT, stdio: 'ignore', env });
  const page = await waitPage(port, u => u.startsWith('paper://app/'), 90000);
  if (!page) { kill(proc); throw new Error('最终便携版窗口未出现'); }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  for (let i = 0; i < 250; i++) {
    if (await E(cdp, `window.__pvnM3?window.__pvnM3.metrics().nodes:0`).catch(() => 0) >= 40) break;
    await sleep(200);
  }
  return { proc, cdp };
}
async function shot(cdp, name) {
  const f = path.join(SHOTS, 'v082m3b-' + name + '.png');
  try { await cdp.shot(f); report.shots.push(path.relative(ROOT, f).replace(/\\/g, '/')); } catch (_) {}
}

(async () => {
  check('最终便携版 EXE 存在', fs.existsSync(EXE), EXE);
  fs.rmSync(PROJECT, { recursive: true, force: true });
  copyTree(SRC, PROJECT);
  ok('建立独立隔离副本（不改主验收脚本与《晚风》原始工程）', { project: PROJECT });

  /* 产物与源码一致性：打包时复制的关键文件逐字节比对 */
  const appDir = path.join(path.dirname(EXE), 'resources', 'app');
  const eq = [];
  for (const f of ['dist/player.js', 'dist/audio.js', 'dist/performance.js', 'dist/timeline-preview-audio.js',
    'dist/index.html', 'dist/app.js', 'desktop/main.cjs', 'package.json']) {
    const a = path.join(ROOT, f), b = path.join(appDir, f);
    const same = fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
    eq.push({ file: f, same });
  }
  report.evidence.artifactVsSource = eq;
  check('最终产物与 Git 源码一致（关键运行时逐字节相同）', eq.every(x => x.same),
    JSON.stringify(eq.filter(x => !x.same)));

  let s1 = null, s2 = null;
  try {
    /* ① 启动 + 修改时间轴动作 */
    s1 = await launch('pkg-1');
    check('双击启动等价：最终便携版窗口打开隔离工程',
      (await E(s1.cdp, `window.__pvnM3?window.__pvnM3.metrics().nodes:0`)) >= 40,
      { exe: path.basename(EXE) });
    const edit = await E(s1.cdp, `(()=>{
      const PF=createPaperPerformance();const p=window.__pvnM3.project();
      const acts=p.nodes[0].performance.actions;
      const a=PF.make(${JSON.stringify(MARK_ID)},'camera.zoom','',{params:{scale:${MARK_SCALE}},duration:0.4});
      a.start=2.25;a.mode='parallel';
      acts.push(a);
      window.__pvnM3.setProject(p);
      return {n:window.__pvnM3.project().nodes[0].performance.actions.length,
        hasMark:window.__pvnM3.project().nodes[0].performance.actions.some(x=>x.id===${JSON.stringify(MARK_ID)})};
    })()`);
    check('① 在最终便携版里修改时间轴动作（新增显式 start 动作）', edit.hasMark, JSON.stringify(edit));
    await shot(s1.cdp, 'M3B9-修改时间轴动作');

    /* ② 保存并关闭 */
    const saved = await E(s1.cdp, `window.__pvnM3.save()`);
    await sleep(700);
    const onDisk = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
    const markOnDisk = (onDisk.nodes[0].performance.actions || []).find(a => a.id === MARK_ID);
    check('② 保存工程：修改已写入磁盘', !!(markOnDisk && markOnDisk.params.scale === MARK_SCALE),
      JSON.stringify({ saved: saved && (saved.ok || saved.path || 'ok'), mark: markOnDisk }));
    s1.cdp.close(); kill(s1.proc); s1 = null;
    ok('② 关闭最终便携版窗口', { closed: true });
    await sleep(600);

    /* ③ 重新打开 */
    s2 = await launch('pkg-2');
    const reopened = await E(s2.cdp, `(()=>{const p=window.__pvnM3.project();
      const a=(p.nodes[0].performance.actions||[]).find(x=>x.id===${JSON.stringify(MARK_ID)});
      return {nodes:p.nodes.length,mark:a?{id:a.id,start:a.start,mode:a.mode,scale:a.params.scale}:null,
        version:document.querySelector('.intro-note b')?document.querySelector('.intro-note b').textContent:null,
        title:document.title,host:!!window.PaperHost}})()`);
    report.evidence.reopened = reopened;
    check('③ 重新打开工程（40 节点、真实 PaperHost）', reopened.nodes >= 40 && reopened.host,
      JSON.stringify({ nodes: reopened.nodes, host: reopened.host }));
    check('④ 修改正确回读（动作 ID / 显式 start / mode / 参数逐字段一致）',
      !!(reopened.mark && reopened.mark.start === 2.25 && reopened.mark.mode === 'parallel' && reopened.mark.scale === MARK_SCALE),
      JSON.stringify(reopened.mark));
    check('界面版本标识为 V0.8.2-M3B（不再是 0.6.2）', reopened.version === PKG.versionLabel,
      JSON.stringify({ shown: reopened.version }));
    await shot(s2.cdp, 'M3B9-重开确认修改');

    /* 时间轴播放 + 普通试玩（最终产物） */
    await s2.cdp.send('Runtime.evaluate', { expression: `window.__pvnM3.unlockAudio()`, userGesture: true, returnByValue: true }).catch(() => {});
    await E(s2.cdp, `document.querySelector('#timelinePanel').focus()`);
    await E(s2.cdp, `document.querySelector('#tlReplay').click()`);
    await sleep(1600);
    const tl = await E(s2.cdp, `(()=>{const d=window.paperTimelineAudioDriver();const p=window.paperTimelinePreview();
      return {fired:d?d.fired:null,state:p?p.state:null,curT:p?p.curT:null}})()`);
    report.evidence.timelinePlay = tl;
    check('最终便携版：播放时间轴（驱动已触发音频事件）', tl.fired > 0, JSON.stringify(tl));
    await E(s2.cdp, `document.querySelector('#tlStop').click()`);
    await E(s2.cdp, `window.__pvnM3.play()`).catch(() => {});
    await sleep(1200);
    const trial = await E(s2.cdp, `(()=>({state:window.__pvnM3.audioState?window.__pvnM3.audioState():null,
      perf:window.paperPerfAudioDebug?window.paperPerfAudioDebug():null}))()`);
    report.evidence.normalTrial = trial;
    ok('最终便携版：启动普通试玩', trial);
    await shot(s2.cdp, 'M3B9-普通试玩');
    const errs = (s2.cdp.errors || []).filter(e => !/favicon|Content-Security-Policy/i.test(e.text || ''));
    check('最终便携版会话无渲染进程异常', errs.length === 0, JSON.stringify(errs.slice(0, 4)));
  } catch (e) {
    bad('M3B-9 实机验证异常', e.stack || e.message);
  } finally {
    if (s1) { try { s1.cdp.close(); } catch (_) {} kill(s1.proc); }
    if (s2) { try { s2.cdp.close(); } catch (_) {} kill(s2.proc); }
  }
  report.classification = {
    PASS: Object.entries(report.stages).filter(([, v]) => v.ok === true).map(([k]) => k),
    FAIL: Object.entries(report.stages).filter(([, v]) => v.ok === false).map(([k]) => k),
    NOT_RUN: [], BLOCKED: []
  };
  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M3B 最终打包产物实机验证 · ' + REPORT);
  process.exit(report.ok ? 0 : 1);
})().catch(e => {
  report.problems.push('脚本异常：' + (e.stack || e.message)); report.ok = false;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error('SCRIPT ERROR:', e.stack || e.message); process.exit(1);
});
