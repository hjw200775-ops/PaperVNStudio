'use strict';
/* V0.8.1-RC2 / M5：编辑器试玩 与 Windows 免安装版 的真实音频验收。
 * （单文件 HTML、目录版游戏、完整预览分别由 v081rc2-title-audio / -game-audio / -large-audio 覆盖）
 *
 * 用法：node scripts/v081rc2-envs.cjs [exe路径]
 * 产物：release/audio-runtime-compatibility.json（editor / packaged 段）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const PROJECT = path.join(ROOT, 'release', 'wanfeng-v081', 'audio');
const REPORT = path.join(ROOT, 'release', 'audio-runtime-compatibility.json');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const report = { at: new Date().toISOString(), version: '0.8.1-rc2', ok: true, stages: {}, problems: [] };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d || null }; console.log('  ok  ' + n + (d ? ' — ' + JSON.stringify(d).slice(0, 220) : '')); };
const bad = (n, m, d) => { report.ok = false; report.stages[n] = { ok: false, message: m, ...(d || {}) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };

const ED_STATE = `(() => { const a = window.paperEditorAudio ? window.paperEditorAudio() : null; return a ? {
  mode: a.mode, reason: a.preciseReason, graph: a.graph, instances: a.instances,
  bgm: a.bgm && { id: a.bgm.audioId, time: a.bgm.time, loop: a.bgm.loop && a.bgm.loop.mode, vol: a.bgm.volume },
  mem: a.audioMemory, prefs: a.prefs,
  playing: (document.querySelector('#position') || {}).textContent || ''
} : null; })()`;

async function openEditor(exe, userData, port) {
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const args = exe === ELECTRON
    ? [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData]
    : ['--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData];
  const proc = spawn(exe, args, { cwd: ROOT, stdio: 'ignore', env });
  const page = await waitPage(port, (u) => u.startsWith('paper://app/'), 120000);
  if (!page) { kill(proc); throw new Error('编辑器没有启动：' + exe); }
  const cdp = await connect(page.webSocketDebuggerUrl);
  for (let i = 0; i < 400; i++) {
    const m = await cdp.ev(`(() => { const M = window.__pvnM3; return M ? M.metrics() : null; })()`).catch(() => null);
    if (m && m.nodes >= 40) return { proc, cdp, metrics: m };
    await sleep(150);
  }
  kill(proc);
  throw new Error('工程没有打开');
}


/* 真实鼠标事件：编辑器的「启用声音」要求用户手势，JS 的 el.click() 不算。 */
async function clickReal(cdp, selector) {
  /* 面板比窗口高，元素可能在视口外：先滚进来再量坐标，否则点到的是一片空白。 */
  const box = await cdp.ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
  if (!box || !box.w || !box.h) return false;
  await sleep(250);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}

async function trialAndMeasure(cdp, label, shots) {
  /* 编辑器试玩必须先在「音频」面板点一次启用声音（浏览器自动播放限制），
     而且必须是真实手势，所以这里发 CDP 鼠标事件而不是 el.click()。 */
  await cdp.ev(`(() => { const t = [...document.querySelectorAll('.tabs button')].find(b => /音频/.test(b.textContent)); if (t) t.click(); })()`);
  await sleep(500);
  await clickReal(cdp, '#audioUnlock');
  await sleep(1200);
  const unlocked = await cdp.ev(`(() => { const a = window.paperEditorAudio(); return a ? a.unlocked : null; })()`);
  if (unlocked !== true) bad(label + ' 启用声音', '点过启用声音后仍为未解锁：' + unlocked);
  else ok(label + ' 启用声音', { unlocked });
  await cdp.ev(`document.getElementById('play').click()`);
  await sleep(2800);
  let s = await cdp.ev(ED_STATE);
  if (!s) return { error: '没有 paperEditorAudio' };
  const out = { mode: s.mode, reason: s.reason, graph: s.graph, bgm: s.bgm, instances: s.instances, mem: s.mem };
  if (s.mode !== 'precise') bad(label + ' 精确模式', '实际 ' + s.mode + ' / ' + s.reason);
  else ok(label + ' 试玩进入 precise', out);

  /* 走到换曲节点（第 14 句）验证演出里的交叉淡化在编辑器试玩里同样生效 */
  for (let i = 0; i < 16; i++) {
    const pos = await cdp.ev(`(() => { const p = document.querySelector('#position'); return p ? p.textContent : ''; })()`);
    if (/\b1[4-9]\s*\/|\b2\d\s*\//.test(String(pos))) break;
    const hint = await cdp.ev(`(() => { const h = document.querySelector('#entryNotice'); return h ? h.textContent : ''; })()`);
    void hint;
    await cdp.ev(`document.getElementById('next').click()`);
    await sleep(700);
  }
  await sleep(1800);
  const x = await cdp.ev(ED_STATE);
  if (!x || !x.bgm) bad(label + ' 交叉淡化', '没有读到 BGM');
  else if (!/school/.test(String(x.bgm.id))) bad(label + ' 交叉淡化', '换曲后仍是 ' + x.bgm.id + '（' + x.playing + '）');
  else if (x.instances.bgm !== 1) bad(label + ' 交叉淡化实例', JSON.stringify(x.instances));
  else ok(label + ' 交叉淡化', { bgm: x.bgm.id, mode: x.mode, instances: x.instances, mem: x.mem });
  await cdp.shot(path.join(SHOTS, shots));

  /* 停止试玩后不能有残留 */
  await cdp.ev(`document.getElementById('stop').click()`);
  await sleep(1200);
  const after = await cdp.ev(ED_STATE);
  if (!after) bad(label + ' 退出试玩', '没有状态');
  else if (after.instances && (after.instances.bgm > 0 || after.instances.sfx > 0 || after.instances.voice > 0)) {
    bad(label + ' 退出试玩', '仍有实例：' + JSON.stringify(after.instances));
  } else ok(label + ' 退出试玩无残留', after.instances);
  return out;
}

(async () => {
  const exeArg = process.argv[2];
  const exe = exeArg ? path.resolve(exeArg) : ELECTRON;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-env-'));
  const userData = path.join(work, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT, items: [{ path: PROJECT, title: '晚风音频演出', openedAt: new Date().toISOString() }]
  }));

  const label = exeArg ? 'Windows 免安装版' : '编辑器';
  let ed = null;
  try {
    ed = await openEditor(exe, userData, await freePort());
    ok(label + ' 启动并打开工程', { exe: path.basename(exe), metrics: ed.metrics, version: await ed.cdp.ev(`(() => { const e = document.querySelector('#version, .version, #appVersion'); return e ? e.textContent.trim() : ''; })()`).catch(() => '') });
    const measured = await trialAndMeasure(ed.cdp, label, exeArg ? 'v081rc2-packaged-trial.png' : 'v081rc2-editor-trial.png');
    report[label] = measured;
  } catch (e) {
    bad(label, String((e && e.message) || e));
  } finally {
    if (ed) { try { ed.cdp.close(); } catch {} kill(ed.proc); }
  }

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch {}
  prev[exeArg ? 'packaged' : 'editor'] = { at: new Date().toISOString(), ok: report.ok, stages: report.stages, problems: report.problems };
  prev.at = new Date().toISOString();
  fs.writeFileSync(REPORT, JSON.stringify(prev, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' ' + label + ' 音频验收（M5）');
  if (!report.ok) console.log(report.problems.join('\n'));
  process.exit(report.ok ? 0 : 1);
})();
