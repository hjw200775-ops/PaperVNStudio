'use strict';
/*
 * V0.8.2 · M3-B · 环境 D（目录版游戏）独立运行会话补采
 *
 * 主验收脚本把 D 定义为「导出产物完整性」、E 定义为「启动该 EXE 的实机状态」，
 * 两者共用同一个 papergame:// 运行时，因此把 D 的状态比对标成 NOT_RUN。
 * 本脚本用独立 APPDATA / 独立端口再启动一次目录版产物，采集与 E 相同口径的
 * 归一化状态并逐字段比对，使五种环境都有独立状态快照（产物相同、会话独立）。
 * 产物：release/v082m3b-env-d.json
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { ROOT, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const WORK = path.join(ROOT, 'release', 'v082m3b');
const EXPORT_DIR = path.join(WORK, 'exports');
const VERIFY = path.join(ROOT, 'release', 'v082m3b-release-verify.json');
const REPORT = path.join(ROOT, 'release', 'v082m3b-env-d.json');
const report = { at: new Date().toISOString(), version: 'V0.8.2-M3B',
  carrier: 'D 目录版游戏（独立 APPDATA / 独立端口的第二次运行会话）',
  stages: {}, problems: [], evidence: {}, ok: true };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d == null ? null : d }; console.log('  ok   ' + n + (d != null ? ' — ' + JSON.stringify(d).slice(0, 240) : '')); };
const bad = (n, m) => { report.stages[n] = { ok: false, message: String(m) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };
const check = (n, c, m, d) => c ? ok(n, d === undefined ? m : d) : bad(n, m || '断言失败');
const E = (c, x) => c.ev(x);

const NORM = `(()=>{const s=window.paperGameState();const a=s.audioPerf;
  const frame=(document.querySelector('#layers .pf-frame'))||document.querySelector('#layers');
  const overlay=document.querySelector('.pf-overlay');
  return {i:s.i,state:s.state,stateNodes:s.nodes,hasAudio:s.hasAudio,
    visual:{cam:frame?frame.style.transform:'',dim:overlay?overlay.style.opacity:null,
      imgCount:document.querySelectorAll('#layers img').length},
    audio:{bgmId:a&&a.bgm?a.bgm.audioId:null,bgmPaused:a&&a.bgm?a.bgm.paused:null,
      bgmLoop:a&&a.bgm?a.bgm.loop:null,buses:a?a.buses:null,ducking:a?a.ducking:null,
      instances:a?a.instances:null,dualBgm:a?a.dualBgm:null,stats:a?a.playbackStats:null,mode:a?a.mode:null},
    run:s.audioDebug?s.audioDebug.run:null,timers:s.audioDebug?s.audioDebug.timers:null,
    origin:location.origin,protocol:location.protocol}})()`;

function findExe() {
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
  for (const d of dirs) { const x = walk(d); if (x) return x; }
  return null;
}

(async () => {
  const exe = findExe();
  check('目录版导出产物 EXE 存在', !!exe, exe || '未找到');
  const verify = JSON.parse(fs.readFileSync(VERIFY, 'utf8'));
  const Eenv = verify.environments && verify.environments.E;
  check('主验收脚本的环境 E 状态可比对', !!Eenv, '缺少 E 状态', { from: 'release/v082m3b-release-verify.json' });
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-m3b-envd-'));
  const port = await freePort();
  const env = Object.assign({}, process.env, { APPDATA: appData });
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  let proc = null, cdp = null;
  try {
    proc = spawn(exe, ['--remote-debugging-port=' + port, '--remote-allow-origins=*', '--disable-background-timer-throttling'],
      { cwd: path.dirname(exe), env, stdio: 'ignore' });
    const page = await waitPage(port, u => u.startsWith('papergame://game/'), 90000);
    if (!page) throw new Error('目录版游戏第二次独立启动失败');
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    for (let i = 0; i < 150; i++) {
      if (await E(cdp, `typeof window.paperGameState==='function'?1:0`).catch(() => 0) === 1) break;
      await sleep(200);
    }
    await cdp.send('Runtime.evaluate', { expression: `document.getElementById('startGame').click()`, userGesture: true, returnByValue: true });
    await sleep(300);
    await cdp.send('Runtime.evaluate', { expression: `(()=>{const b=document.getElementById('enableSound');if(b)b.click();return true})()`, userGesture: true, returnByValue: true });
    await sleep(16000);
    const D = await E(cdp, NORM);
    report.evidence.D = D;
    ok('D 目录版独立会话状态已采集', { i: D.i, state: D.state, bgm: D.audio.bgmId, run: D.run, protocol: D.protocol });
    check('D 在 papergame:// 环境真实运行', D.protocol === 'papergame:' && D.state === 'playing',
      JSON.stringify({ protocol: D.protocol, state: D.state }));
    check('D 正式播放器以动画方式执行演出', D.run && D.run.animate === true, JSON.stringify(D.run));
    check('D 无真实播放失败 / 异常双 BGM', D.audio.stats.failed === 0 && !D.audio.dualBgm,
      JSON.stringify({ stats: D.audio.stats, dualBgm: D.audio.dualBgm }));

    /* 与 E 的归一化状态逐字段比对：相同工程、相同首节点、相同逻辑时间 */
    const normE = {
      state: Eenv.state, i: Eenv.i, hasAudio: Eenv.hasAudio,
      visual: { cam: Eenv.visual && Eenv.visual.cam, dim: Eenv.visual && Eenv.visual.dim },
      audio: { bgmId: Eenv.actual && Eenv.actual.bgm && Eenv.actual.bgm.audioId,
        buses: Eenv.actual && Eenv.actual.buses, ducking: Eenv.actual && Eenv.actual.ducking,
        dualBgm: Eenv.actual && Eenv.actual.dualBgm },
      run: Eenv.run
    };
    const normD = {
      state: D.state, i: D.i, hasAudio: D.hasAudio,
      visual: { cam: D.visual.cam, dim: D.visual.dim },
      audio: { bgmId: D.audio.bgmId, buses: D.audio.buses, ducking: D.audio.ducking, dualBgm: D.audio.dualBgm },
      run: D.run
    };
    report.evidence.comparison = { D: normD, E: normE };
    check('D 与 E 归一化状态一致（剧情索引 / 视觉 / 音频目标 / 演出调度）',
      JSON.stringify(normD) === JSON.stringify(normE),
      JSON.stringify({ D: normD, E: normE }));
    const errs = (cdp.errors || []).filter(e => !/favicon|Content-Security-Policy/i.test(e.text || ''));
    check('D 会话无渲染进程异常', errs.length === 0, JSON.stringify(errs.slice(0, 4)));
  } catch (e) {
    bad('环境 D 补采异常', e.stack || e.message);
  } finally {
    if (cdp) { try { cdp.close(); } catch (_) {} }
    if (proc) kill(proc);
    try { fs.rmSync(appData, { recursive: true, force: true }); } catch (_) {}
  }
  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M3B 环境 D 独立会话补采 · ' + REPORT);
  process.exit(report.ok ? 0 : 1);
})().catch(e => {
  report.problems.push('脚本异常：' + (e.stack || e.message)); report.ok = false;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error('SCRIPT ERROR:', e.stack || e.message); process.exit(1);
});
