'use strict';
/* V0.8.1-RC2 / M2 + M5（目录版）：真实编辑器导出目录版游戏 → 启动导出 EXE →
 * 验证 papergame:// 下的精确音频（fetch 读字节 → decodeAudioData → BufferSource）。
 *
 * 判定不是「包里有没有 audio.js」，而是导出游戏中：
 *   - 标题曲与实际 BGM 的 mode=precise，且 cache.entries>=1（说明字节真的读出来并解码了）；
 *   - 音频时间在推进；演奏到换曲节点后 BGM 换成新的那首，实例仍为 1；
 *   - 控制台没有 CSP / fetch / decode 报错。
 *
 * 用法：node scripts/v081rc2-game-audio.cjs [项目目录] [标签]
 * 产物：release/v081rc2/<标签>/game/、release/audio-runtime-compatibility.json（game 段）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const PROJECT = path.resolve(process.argv[2] || path.join(ROOT, 'release', 'wanfeng-v081', 'audio'));
const LABEL = process.argv[3] || 'wanfeng-audio';
const OUT = path.join(ROOT, 'release', 'v081rc2', LABEL, 'game');
const REPORT = path.join(ROOT, 'release', 'audio-runtime-compatibility.json');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');

const report = { at: new Date().toISOString(), version: '0.8.1-rc2', project: PROJECT, ok: true, stages: {}, problems: [], artifact: null, errors: [] };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d || null }; console.log('  ok  ' + n + (d ? ' — ' + JSON.stringify(d).slice(0, 230) : '')); };
const bad = (n, m) => { report.ok = false; report.stages[n] = { ok: false, message: m }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };

/* ---------- 1. 从真实编辑器导出目录版 ---------- */
async function exportFolder() {
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-rc2-'));
  const userData = path.join(work, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT,
    items: [{ path: PROJECT, title: '晚风音频演出', openedAt: new Date().toISOString() }]
  }));
  const port = await freePort();
  const env = Object.assign({}, process.env, { PAPER_VN_TEST_EXPORT_DIR: OUT });
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  /* 默认用仓库里的 electron 跑源码；PVN_EDITOR_EXE 指向打包产物时，
     同一个脚本就能验证「最终构建的编辑器导出游戏」这条链路。 */
  const EDITOR = process.env.PVN_EDITOR_EXE ? path.resolve(process.env.PVN_EDITOR_EXE) : ELECTRON;
  const args = process.env.PVN_EDITOR_EXE
    ? ['--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData]
    : [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData];
  const proc = spawn(EDITOR, args, { cwd: ROOT, stdio: 'ignore', env });
  let cdp = null;
  try {
    const page = await waitPage(port, (u) => u.startsWith('paper://app/'));
    if (!page) throw new Error('编辑器窗口未出现');
    cdp = await connect(page.webSocketDebuggerUrl);
    let meta = null;
    for (let i = 0; i < 250; i++) {
      meta = await cdp.ev(`(() => { const M = window.__pvnM3; return M ? M.metrics() : null; })()`).catch(() => null);
      if (meta && meta.nodes >= 40) break;
      await sleep(200);
    }
    if (!meta || !meta.nodes) throw new Error('工程没有打开：' + JSON.stringify(meta));
    ok('编辑器打开音频演出工程', { nodes: meta.nodes, assets: meta.assets });

    await cdp.ev(`(() => { const d = document.getElementById('publishDialog'); if (!d.open) document.getElementById('publish').click(); return true; })()`);
    await sleep(600);
    await cdp.ev(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); if (!el) return; el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      set('pubName', '晚风音频演出验收'); set('pubAuthor', '验收脚本'); set('pubVersion', '0.8.1-rc2');
      set('pubCopyright', 'Copyright © 2026 验收');
      const t = document.getElementById('pubType'); t.value = 'folder'; t.dispatchEvent(new Event('change', { bubbles: true }));
      return true; })()`);
    await sleep(700);
    const disabled = await cdp.ev(`document.getElementById('pubStart').disabled`);
    if (disabled) {
      const issues = await cdp.ev(`[...document.querySelectorAll('#pubIssues li')].map(li => li.textContent.trim())`);
      throw new Error('导出按钮不可用：' + issues.join('；'));
    }
    await cdp.ev(`document.getElementById('pubStart').click()`);
    let result = null;
    const deadline = Date.now() + 8 * 60 * 1000;
    while (Date.now() < deadline) {
      result = await cdp.ev(`(() => { const r = document.getElementById('pubResult');
        return { text: r.textContent || '', progress: (document.getElementById('pubProgressText') || {}).textContent || '',
          running: document.getElementById('pubCancel') && !document.getElementById('pubCancel').disabled }; })()`);
      if (!result.running && /导出完成|导出失败|已取消/.test(result.progress + ' ' + result.text)) break;
      await sleep(600);
    }
    if (!/导出完成/.test(result.progress)) throw new Error('导出失败：' + result.progress + ' / ' + result.text);
    ok('目录版导出完成', { text: result.text.slice(0, 100) });
    return { cdp, proc };
  } catch (e) {
    if (cdp) cdp.close();
    kill(proc);
    throw e;
  }
}

function findArtifact() {
  const dir = fs.readdirSync(OUT, { withFileTypes: true }).find((e) => e.isDirectory() && !/\.manifest\.json$/.test(e.name));
  if (!dir) throw new Error('导出目录里没有产物：' + OUT);
  const dirPath = path.join(OUT, dir.name);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { const r = walk(f); if (r) return r; }
      else if (/\.exe$/i.test(e.name) && !/elevate/i.test(e.name)) return f;
    }
    return null;
  };
  const exe = walk(dirPath);
  if (!exe) throw new Error('产物目录里没有 EXE：' + dirPath);
  const content = path.join(dirPath, 'resources', 'app', 'content', 'index.html');
  const shell = path.join(dirPath, 'resources', 'app', 'main.cjs');
  return { dir: dirPath, exe, content, contentBytes: fs.existsSync(content) ? fs.statSync(content).size : 0, shell };
}

async function launchGame(exePath) {
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const proc = spawn(exePath, ['--remote-debugging-port=' + port, '--remote-allow-origins=*', '--disable-background-timer-throttling'],
    { cwd: path.dirname(exePath), env, stdio: 'ignore' });
  const page = await waitPage(port, (u) => u.startsWith('papergame://game/'), 90000);
  if (!page) { kill(proc); throw new Error('导出的游戏没有启动：' + exePath); }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  for (let i = 0; i < 150; i++) { if (await cdp.ev(`typeof window.paperGameState === 'function'`).catch(() => false)) break; await sleep(200); }
  return { proc, cdp, url: page.url };
}

const SNAP = `(() => { const s = window.paperGameState(); return {
  state: s.state, i: s.i, origin: location.origin, protocol: location.protocol,
  title: s.titleLoop && { playing: s.titleLoop.playing, mode: s.titleLoop.mode, time: s.titleLoop.time, loops: s.titleLoop.loops, loop: s.titleLoop.loop, vol: s.titleLoop.volume },
  perf: s.audioPerf && { mode: s.audioPerf.mode, reason: s.audioPerf.preciseReason, graphError: s.audioPerf.graphError,
    owner: s.audioPerf.music && s.audioPerf.music.owner,
    bgm: s.audioPerf.bgm && { id: s.audioPerf.bgm.audioId, time: s.audioPerf.bgm.time, vol: s.audioPerf.bgm.volume, loop: s.audioPerf.bgm.loop, mode: s.audioPerf.bgm.mode },
    instances: s.audioPerf.instances, cache: s.audioPerf.cache && { entries: s.audioPerf.cache.entries, bytes: s.audioPerf.cache.bytes },
    mem: s.audioPerf.audioMemory, graph: s.audioPerf.graph },
  text: (document.getElementById('text') || document.getElementById('line') || {}).textContent || ''
}; })()`;

async function walkTo(cdp, target) {
  for (let guard = 0; guard < 200; guard++) {
    const st = await cdp.ev(`window.paperGameState().i`).catch(() => -1);
    if (st >= target) return st;
    const hint = await cdp.ev(`(document.getElementById('hint') || {}).textContent || ''`).catch(() => '');
    if (/演出中/.test(hint)) { await cdp.ev(`document.getElementById('scene').click()`); await sleep(120); }
    await cdp.ev(`document.getElementById('scene').click()`);
    await sleep(260);
  }
  return -1;
}

(async () => {
  if (!fs.existsSync(path.join(PROJECT, 'project.paper.json'))) { console.error('缺少工程：' + PROJECT); process.exit(2); }
  const ed = await exportFolder();
  ed.cdp.close(); kill(ed.proc);

  const art = findArtifact();
  report.artifact = { dir: path.relative(ROOT, art.dir).replace(/\\/g, '/'), exe: path.basename(art.exe),
    contentBytes: art.contentBytes, shellBytes: fs.statSync(art.shell).size };
  ok('定位导出产物', report.artifact);

  const shellSrc = fs.readFileSync(art.shell, 'utf8');
  if (!/connect-src 'self'/.test(shellSrc)) bad('导出外壳 CSP', '仍是 connect-src none，精确模式读不到字节');
  else ok('导出外壳已放开受控读取', { csp: /connect-src 'self'/.exec(shellSrc)[0], fetchApi: /supportFetchAPI: true/.test(shellSrc) });

  const game = await launchGame(art.exe);
  try {
    await sleep(1500);
    let s = await game.cdp.ev(SNAP);
    if (s.protocol !== 'papergame:') bad('游戏协议', '不是 papergame://：' + s.origin);
    else ok('游戏运行在 papergame://game', { origin: s.origin });

    if (!s.title || s.title.mode !== 'precise') bad('目录版标题精确模式', '实际 ' + (s.title && s.title.mode) + ' / ' + (s.perf && s.perf.reason));
    else ok('目录版标题曲 precise（fetch+decode 成功）', { loop: s.title.loop, cache: s.perf.cache, graph: s.perf.graph });
    if (!s.perf || !s.perf.cache || s.perf.cache.entries < 1) bad('目录版音频字节读取', '解码缓存为空，说明 fetch 没成功：' + JSON.stringify(s.perf && s.perf.cache));
    else ok('papergame:// 音频字节可读（解码缓存非空）', { entries: s.perf.cache.entries, bytes: s.perf.cache.bytes });

    await game.cdp.ev(`document.getElementById('startGame').click()`);
    await sleep(1600);
    let g = await game.cdp.ev(SNAP);
    if (!g.perf || g.perf.mode !== 'precise') bad('目录版剧情 BGM 精确模式', JSON.stringify(g.perf && { mode: g.perf.mode, reason: g.perf.reason }));
    else ok('目录版剧情 BGM precise', { bgm: g.perf.bgm, owner: g.perf.owner });
    const t1 = g.perf && g.perf.bgm ? g.perf.bgm.time : 0;
    await sleep(2200);
    g = await game.cdp.ev(SNAP);
    const t2 = g.perf && g.perf.bgm ? g.perf.bgm.time : 0;
    if (!(t2 > t1 + 1.4)) bad('目录版音频推进', 'BGM 时间没有前进：' + t1 + ' → ' + t2);
    else ok('目录版音频真实推进', { from: +Number(t1).toFixed(2), to: +Number(t2).toFixed(2) });
    await game.cdp.shot(path.join(SHOTS, 'v081rc2-game-audio.png'));

    /* 走到第 13 句：演出里有一次交叉淡化（清晨 → 放学后） */
    const reached = await walkTo(game.cdp, 14);
    if (reached < 13) bad('走到换曲节点', '只到第 ' + reached + ' 句');
    else {
      await sleep(1800);
      const x = await game.cdp.ev(SNAP);
      const id = x.perf && x.perf.bgm ? x.perf.bgm.id : '';
      if (!/school/.test(String(id))) bad('目录版交叉淡化', '换曲后仍是 ' + id);
      else if (x.perf.instances.bgm !== 1 || x.perf.instances.retiring !== 0) bad('目录版交叉淡化实例', JSON.stringify(x.perf.instances));
      else ok('目录版交叉淡化（演出动作）', { bgm: id, mode: x.perf.mode, instances: x.perf.instances, loop: x.perf.bgm.loop });
    }
    await game.cdp.shot(path.join(SHOTS, 'v081rc2-game-crossfade.png'));

    const csp = game.cdp.errors.filter((e) => /Content Security Policy|Refused to|CSP/i.test(e.text));
    report.errors = game.cdp.errors.slice(0, 10);
    if (csp.length) bad('目录版 CSP 报错', csp.map((e) => e.text).join(' | ').slice(0, 300));
    else ok('目录版 0 条 CSP / 资源读取报错');
  } finally {
    kill(game.proc);
  }

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch {}
  prev.game = report;
  prev.at = new Date().toISOString();
  prev.ok = !!((prev.title && prev.title.ok) && prev.game.ok);
  fs.writeFileSync(REPORT, JSON.stringify(prev, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' 目录版游戏音频（M2）');
  if (!report.ok) console.log(report.problems.join('\n'));
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { report.ok = false; report.problems.push(String(e && e.stack || e)); console.error(e); process.exit(1); });
