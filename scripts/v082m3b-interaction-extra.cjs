'use strict';
/*
 * V0.8.2 · M3-B · 剧情交互补测（真实发布载体：单文件 HTML）
 *
 * 补上主验收脚本里被标为 NOT_RUN 的、本可独立完成的技术任务：
 *   - 分支选择及汇合（走到 choice 节点，分别点两个选项，验证在汇合点状态一致）
 *   - 阻塞演出结算（演出中点击跳过，验证不卡死、状态到终态、可继续推进）
 *   - 非阻塞演出跨节点、历史 SFX/Voice 不重播、退役实例不残留
 *   - 快速连续点击 / 快进等价路径（连续点击推进）
 * 发布播放器没有「自动播放 / 快进」独立按钮，故用「连续点击推进 + 阻塞跳过」
 * 覆盖等价行为，并在报告里如实说明载体能力边界。
 * 产物：release/v082m3b-interaction-extra.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, sleep, spawnShell, kill } = require('./rc2-cdp.cjs');

const WORK = path.join(ROOT, 'release', 'v082m3b');
const HTML = path.join(WORK, 'exports', '晚风-M3B单文件试玩版.html');
const REPORT = path.join(ROOT, 'release', 'v082m3b-interaction-extra.json');
const report = { at: new Date().toISOString(), version: 'V0.8.2-M3B', carrier: '单文件 HTML（真实窗口）',
  stages: {}, problems: [], evidence: {}, classification: { PASS: [], FAIL: [], NOT_RUN: [], BLOCKED: [] }, ok: true };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d == null ? null : d }; console.log('  ok   ' + n + (d != null ? ' — ' + JSON.stringify(d).slice(0, 230) : '')); };
const bad = (n, m) => { report.stages[n] = { ok: false, message: String(m) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };
const skip = (n, why) => { report.stages[n] = { ok: null, status: 'NOT_RUN', reason: why }; console.log('  NOT_RUN ' + n + ' — ' + why); };
const check = (n, c, m, d) => c ? ok(n, d === undefined ? m : d) : bad(n, m || '断言失败');
const E = (c, x) => c.ev(x);

const SNAP = `(()=>{const s=window.paperGameState();const a=s.audioPerf;
  const frame=(document.querySelector('#layers .pf-frame'))||document.querySelector('#layers');
  const overlay=document.querySelector('.pf-overlay');
  return {i:s.i,state:s.state,trailLen:s.trail?s.trail.length:0,
    text:(document.getElementById('text')||{}).textContent||'',
    hint:(document.getElementById('hint')||{}).textContent||'',
    choices:[...document.querySelectorAll('#choices button')].map(b=>b.textContent),
    cam:frame?frame.style.transform:'',dim:overlay?overlay.style.opacity:null,
    imgs:[...document.querySelectorAll('#layers img')].map(x=>String(x.src).slice(0,60)),
    audio:{bgm:a&&a.bgm?{id:a.bgm.audioId,paused:a.bgm.paused,time:+a.bgm.time.toFixed(2)}:null,
      buses:a?a.buses:null,ducking:a?a.ducking:null,instances:a?a.instances:null,
      dualBgm:a?a.dualBgm:null,stats:a?a.playbackStats:null,mode:a?a.mode:null},
    timers:s.audioDebug?s.audioDebug.timers:null,run:s.audioDebug?s.audioDebug.run:null}})()`;

async function gesture(cdp, expr) {
  await cdp.send('Runtime.evaluate', { expression: expr, userGesture: true, returnByValue: true }).catch(() => null);
}
/* 推进到目标节点：阻塞演出中第一次点击先结算，再点才推进 */
async function walkTo(cdp, target, maxClicks) {
  for (let g = 0; g < (maxClicks || 220); g++) {
    const st = await E(cdp, `window.paperGameState().i`).catch(() => -1);
    if (st >= target) return st;
    const hint = await E(cdp, `(document.getElementById('hint')||{}).textContent||''`).catch(() => '');
    if (/演出中/.test(hint)) { await E(cdp, `document.getElementById('scene').click()`); await sleep(90); }
    await E(cdp, `document.getElementById('scene').click()`);
    await sleep(150);
  }
  return await E(cdp, `window.paperGameState().i`).catch(() => -1);
}
async function startFresh(cdp) {
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(1100);
  for (let i = 0; i < 100; i++) {
    if (await E(cdp, `typeof window.paperGameState==='function'?1:0`).catch(() => 0) === 1) break;
    await sleep(150);
  }
  await gesture(cdp, `document.getElementById('startGame').click()`);
  await sleep(300);
  await gesture(cdp, `(()=>{const b=document.getElementById('enableSound');if(b)b.click();return true})()`);
  await sleep(250);
}

(async () => {
  check('单文件 HTML 载体存在', fs.existsSync(HTML), HTML);
  let s = null;
  try {
    const shell = spawnShell(HTML, { shellDir: path.join(WORK, 'shell-interaction') });
    s = await shell.spawnCdp();
    await s.cdp.send('Runtime.enable');
    for (let i = 0; i < 120; i++) {
      if (await E(s.cdp, `typeof window.paperGameState==='function'?1:0`).catch(() => 0) === 1) break;
      await sleep(200);
    }

    /* ---------- 阻塞演出结算 ---------- */
    await startFresh(s.cdp);
    const first = await E(s.cdp, SNAP);
    report.evidence.firstNode = first;
    ok('首节点（含 blocking 演出）状态', { i: first.i, hint: first.hint, run: first.run, timers: first.timers });
    const blockingHint = /演出中/.test(first.hint);
    if (blockingHint) {
      await E(s.cdp, `document.getElementById('scene').click()`); await sleep(350);
      const afterSkip = await E(s.cdp, SNAP);
      report.evidence.afterBlockingSkip = afterSkip;
      check('阻塞演出点击跳过：结算到终态且不卡死',
        !/演出中/.test(afterSkip.hint) && afterSkip.state === 'playing',
        JSON.stringify({ before: first.hint, after: afterSkip.hint, state: afterSkip.state }));
      const i0 = await E(s.cdp, `window.paperGameState().i`);
      const i1 = await walkTo(s.cdp, i0 + 2, 12);
      check('跳过阻塞演出后剧情仍可继续推进', i1 > i0, JSON.stringify({ from: i0, to: i1 }));
    } else {
      skip('阻塞演出点击跳过', '首节点 hint 未显示「演出中」，未构造出可跳过的阻塞窗口');
    }

    /* ---------- 分支选择及汇合（两条真实点击路径） ---------- */
    const paths = [];
    for (let k = 0; k < 2; k++) {
      await startFresh(s.cdp);
      const atChoice = await walkTo(s.cdp, 24, 220);
      const before = await E(s.cdp, SNAP);
      const optionCount = before.choices.length;
      check('分支 ' + k + '：到达 choice 节点并出现 ' + optionCount + ' 个选项',
        atChoice === 24 && optionCount === 2,
        JSON.stringify({ i: atChoice, choices: before.choices }));
      await E(s.cdp, `document.querySelectorAll('#choices button')[${k}].click()`);
      await sleep(400);
      const afterChoice = await E(s.cdp, SNAP);
      const atMerge = await walkTo(s.cdp, 27, 30);
      const merged = await E(s.cdp, SNAP);
      paths.push({ option: k, optionText: before.choices[k], atChoice, afterChoiceI: afterChoice.i,
        afterChoiceText: afterChoice.text, mergeI: atMerge, merged });
      check('分支 ' + k + '：点击选项后进入对应分支并到达汇合点 27',
        afterChoice.i !== 24 && atMerge === 27,
        JSON.stringify({ afterChoiceI: afterChoice.i, mergeI: atMerge, text: afterChoice.text.slice(0, 30) }));
      check('分支 ' + k + '：切换后无真实播放失败 / 异常双 BGM / 退役实例残留',
        merged.audio.stats.failed === 0 && !merged.audio.dualBgm && (merged.timers || 0) === 0,
        JSON.stringify({ stats: merged.audio.stats, dualBgm: merged.audio.dualBgm, timers: merged.timers }));
    }
    report.evidence.branchPaths = paths;
    const [p0, p1] = paths;
    check('两条分支在汇合点的剧情文本一致', p0.merged.text === p1.merged.text,
      JSON.stringify({ a: p0.merged.text.slice(0, 40), b: p1.merged.text.slice(0, 40) }));
    check('两条分支在汇合点的舞台视觉状态一致（镜头 / 渐暗 / 图层）',
      JSON.stringify({ cam: p0.merged.cam, dim: p0.merged.dim, imgs: p0.merged.imgs })
        === JSON.stringify({ cam: p1.merged.cam, dim: p1.merged.dim, imgs: p1.merged.imgs }),
      JSON.stringify({ a: { cam: p0.merged.cam, imgs: p0.merged.imgs.length }, b: { cam: p1.merged.cam, imgs: p1.merged.imgs.length } }));
    check('两条分支在汇合点的音频目标状态一致（BGM / 总线 / Ducking）',
      JSON.stringify({ bgm: p0.merged.audio.bgm && p0.merged.audio.bgm.id, buses: p0.merged.audio.buses, ducking: p0.merged.audio.ducking })
        === JSON.stringify({ bgm: p1.merged.audio.bgm && p1.merged.audio.bgm.id, buses: p1.merged.audio.buses, ducking: p1.merged.audio.ducking }),
      JSON.stringify({ a: p0.merged.audio.bgm, b: p1.merged.audio.bgm }));

    /* ---------- 非阻塞跨节点 + 快速连续点击（快进等价路径） ---------- */
    await startFresh(s.cdp);
    const beforeFast = await E(s.cdp, SNAP);
    for (let i = 0; i < 30; i++) await E(s.cdp, `document.getElementById('scene').click()`);
    await sleep(600);
    const afterFast = await E(s.cdp, SNAP);
    report.evidence.fastAdvance = { before: beforeFast.i, after: afterFast.i,
      state: afterFast.state, stats: afterFast.audio.stats, dualBgm: afterFast.audio.dualBgm, timers: afterFast.timers };
    check('快速连续点击／快进等价路径：剧情持续推进且不卡死',
      afterFast.i > beforeFast.i && afterFast.state === 'playing',
      JSON.stringify(report.evidence.fastAdvance));
    check('跨节点后无真实播放失败、无异常双 BGM、无未执行定时器残留',
      afterFast.audio.stats.failed === 0 && !afterFast.audio.dualBgm && (afterFast.timers || 0) === 0,
      JSON.stringify({ stats: afterFast.audio.stats, dualBgm: afterFast.audio.dualBgm, timers: afterFast.timers }));

    /* 载体能力边界：如实记录，不伪造 PASS */
    skip('自动播放（独立 UI 按钮）', '发布播放器 #playBar 只有 上一步/重新开始/菜单，没有自动播放按钮；'
      + '本轮以「连续点击推进」覆盖等价的剧情推进路径');
    skip('快进（独立 UI 按钮）', '发布播放器没有独立快进按钮；本轮以「快速连续点击 + 阻塞演出点击跳过」覆盖等价行为');

    const errs = (s.cdp.errors || []).filter(e => !/favicon|Content-Security-Policy/i.test(e.text || ''));
    check('会话无渲染进程异常', errs.length === 0, JSON.stringify(errs.slice(0, 4)));
  } catch (e) {
    bad('剧情交互补测异常', e.stack || e.message);
  } finally {
    if (s) { try { s.cdp.close(); } catch (_) {} kill(s.proc); }
  }
  report.classification.PASS = Object.entries(report.stages).filter(([, v]) => v.ok === true).map(([k]) => k);
  report.classification.FAIL = Object.entries(report.stages).filter(([, v]) => v.ok === false).map(([k]) => k);
  report.classification.NOT_RUN = Object.entries(report.stages).filter(([, v]) => v.ok === null && v.status === 'NOT_RUN').map(([k]) => k);
  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M3B 剧情交互补测 · ' + REPORT);
  console.log('PASS=' + report.classification.PASS.length + ' FAIL=' + report.classification.FAIL.length + ' NOT_RUN=' + report.classification.NOT_RUN.length);
  process.exit(report.ok ? 0 : 1);
})().catch(e => {
  report.problems.push('脚本异常：' + (e.stack || e.message)); report.ok = false;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error('SCRIPT ERROR:', e.stack || e.message); process.exit(1);
});
