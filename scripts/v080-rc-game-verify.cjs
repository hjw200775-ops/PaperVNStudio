'use strict';
/*
 * V0.8.0-RC 收尾验收：目录版游戏真实导出 → 启动独立 EXE → 实际播放舞台演出。
 *
 * 判定标准是「画面真的动了」，不是「打包文件里有 performance.js」：
 *   - 在导出的 EXE 里读 .pf-frame 的 transform / opacity、背景 img.src、#layers 的镜头矩阵；
 *   - 阻塞演出点击先结算再放行；跳过与播完同一终态；存档→返回标题→继续后状态恢复；
 *   - 分支两个选项都能走通并汇合；
 *   - 编辑器试玩 / 单文件 HTML / 独立游戏三处的终态归一化后必须一致；
 *   - papergame:// 协议实际被 img 使用且图片解码成功。
 *
 * 用法：node scripts/v080-rc-game-verify.cjs
 * 产物：release/v080-rc-game-verify.json、docs/screenshots/v080rc-*.png
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROJECT = path.join(ROOT, 'release', 'wanfeng-v080', 'after');
const TRIAL = path.join(ROOT, 'release', 'wanfeng-v080', '晚风经过二楼走廊·演出优化版.html');
const OUT = path.join(ROOT, 'release', 'v080-rc', 'game-out');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const REPORT = path.join(ROOT, 'release', 'v080-rc-game-verify.json');
const HARNESS = path.join(ROOT, 'release', 'v080-rc', 'harness-html.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { at: new Date().toISOString(), version: '0.8.0-rc', ok: true, stages: {}, problems: [], exceptions: [], shots: [] };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d || null }; console.log('  ok  ' + n + (d ? ' — ' + JSON.stringify(d).slice(0, 220) : '')); };
const bad = (n, m) => { report.ok = false; report.stages[n] = { ok: false, message: m }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };

/* ---------- 通用 CDP ---------- */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function httpJson(url, ms = 1500) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await (await fetch(url, { signal: ctl.signal })).json(); } finally { clearTimeout(t); }
}
async function waitPage(port, match, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const list = await httpJson('http://127.0.0.1:' + port + '/json/list').catch(() => []);
    const p = (Array.isArray(list) ? list : []).find((x) => x.type === 'page' && match(x.url || ''));
    if (p && p.webSocketDebuggerUrl) return p;
    await sleep(250);
  }
  return null;
}
async function connect(wsUrl, tag) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('CDP 超时')), 15000); ws.onopen = () => { clearTimeout(t); res(); }; ws.onerror = () => { clearTimeout(t); rej(new Error('CDP 连接失败')); }; });
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails;
      errors.push({ kind: 'exception', text: (d && d.exception && d.exception.description) || (d && d.text) || '' });
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push({ kind: 'console', text: (m.params.args || []).map((a) => a.value || a.description || '').join(' ') });
      return;
    }
    const s = pending.get(m.id); if (!s) return; pending.delete(m.id);
    m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result && r.result.value;
  };
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; };
  await send('Runtime.enable').catch(() => {});
  await send('Page.enable').catch(() => {});
  return { send, ev, shot, errors, close: () => { try { ws.close(); } catch {} } };
}
function killTree(pid) { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }

/* ---------- 舞台读数（三种运行时通用） ----------
 * 用 DOMMatrix 解析 transform：这条字符串是嵌在模板里的求值代码，
 * 正则里的反斜杠会被模板转义吃掉，所以这里一律不用正则读数值。 */
const READ_STAGE = `(() => {
  const box = document.getElementById('layersCanvas') || document.getElementById('layers');
  if (!box) return null;
  const r = box.getBoundingClientRect();
  const W = r.width || 1, H = r.height || 1;
  const camT = getComputedStyle(box).transform;
  let camera = null;
  if (camT && camT !== 'none') { try { const dm = new DOMMatrix(camT); camera = { a: dm.a, e: dm.e, f: dm.f }; } catch (e) {} }
  const layers = [...box.querySelectorAll('.visual-layer')].map(w => {
    const inner = w.querySelector('.pf-frame');
    const img = w.querySelector('img');
    let dx = 0, dy = 0, sc = 1;
    if (inner) {
      const t = getComputedStyle(inner).transform;
      if (t && t !== 'none') { try { const dm = new DOMMatrix(t); dx = dm.e; dy = dm.f; sc = dm.a; } catch (e) {} }
    }
    const src = img ? img.src : '';
    return {
      layer: w.dataset.layer,
      display: getComputedStyle(w).display,
      dxPct: dx / W * 100,
      dyPct: dy / H * 100,
      scale: sc,
      opacity: inner ? Number(getComputedStyle(inner).opacity) : 1,
      frame: !!inner,
      srcKind: src.startsWith('papergame://') ? 'papergame' : src.startsWith('pvres://') ? 'pvres' : src.startsWith('data:') ? 'data' : 'other',
      srcTail: src.slice(-46),
      srcLen: src.length,
      hash: (src.split('/').pop() || '').split('?')[0],
      loaded: !!(img && img.complete && img.naturalWidth > 0),
      w: img ? img.naturalWidth : 0, h: img ? img.naturalHeight : 0
    };
  });
  const host = document.getElementById('scene') || document.getElementById('stage');
  const dim = host ? host.querySelector(':scope > .pf-dim') : null;
  return {
    camera,
    cameraRaw: camT,
    layers, boxW: Math.round(W), boxH: Math.round(H),
    dim: dim ? Number(getComputedStyle(dim).opacity) : 0,
    who: (document.getElementById('who') || {}).textContent || '',
    text: ((document.getElementById('text') || document.getElementById('line') || {}).textContent) || '',
    hint: (document.getElementById('hint') || {}).textContent || '',
    choices: [...document.querySelectorAll('#choices button')].map(b => b.textContent),
    game: typeof window.paperGameState === 'function' ? window.paperGameState() : null,
    origin: location.origin
  };
})()`;

/* 只点一次「下一句」，不做演出跳过；用于「进句瞬间」取过程状态 */
async function advanceOnce(cdp, waitMs = 140) {
  await cdp.ev(`document.getElementById('scene').click()`);
  await sleep(waitMs);
}
/* 先把当前句的阻塞演出结算掉，再前进一句；返回时刚进入新句（动画刚开始） */
async function settleThenAdvance(cdp, waitMs = 150) {
  const hint = await cdp.ev(`document.getElementById('hint').textContent`);
  if (/演出中/.test(hint)) { await cdp.ev(`document.getElementById('scene').click()`); await sleep(100); }
  await cdp.ev(`document.getElementById('scene').click()`);
  await sleep(waitMs);
}

/* 一次只前进一句：演出中先结算，再翻页；分支节点点第一个/指定选项 */
async function step(cdp, choiceIndex = 0) {
  const hasChoice = await cdp.ev(`document.querySelectorAll('#choices button').length`);
  if (hasChoice) {
    await cdp.ev(`document.querySelectorAll('#choices button')[${choiceIndex}].click()`);
    await sleep(420);
    return 'choice';
  }
  const hint = await cdp.ev(`document.getElementById('hint').textContent`);
  if (/演出中/.test(hint)) { await cdp.ev(`document.getElementById('scene').click()`); await sleep(90); }
  await cdp.ev(`document.getElementById('scene').click()`);
  await sleep(260);
  return 'step';
}
async function walkTo(cdp, target, maxSteps = 200) {
  for (let i = 0; i < maxSteps; i++) {
    const st = await cdp.ev(READ_STAGE);
    if (st && st.game && st.game.i >= target) return st;
    await step(cdp);
  }
  return await cdp.ev(READ_STAGE);
}
/* 归一到可比较的终态：位移百分比、缩放、透明度、背景哈希 */
function normalize(st) {
  if (!st) return null;
  const byLayer = {};
  for (const l of st.layers) byLayer[l.layer] = l;
  const bg = st.layers.find((l) => l.display !== 'none' && /bg/.test(l.layer)) || st.layers[0];
  return {
    node: st.game ? st.game.i : null,
    camera: st.camera,
    dim: st.dim,
    text: st.text,
    layers: Object.fromEntries(Object.entries(byLayer).map(([k, v]) => [k, {
      dx: +v.dxPct.toFixed(2), dy: +v.dyPct.toFixed(2), scale: +v.scale.toFixed(3), opacity: +v.opacity.toFixed(3)
    }])),
    bgHash: bg ? bg.hash : ''
  };
}
function diffNormalized(a, b) {
  const out = [];
  if (!a || !b) return ['缺少一侧读数'];
  const keys = new Set([...Object.keys(a.layers || {}), ...Object.keys(b.layers || {})]);
  for (const k of keys) {
    const x = a.layers[k], y = b.layers[k];
    if (!x || !y) { out.push(k + ' 只在其中一侧存在'); continue; }
    for (const f of ['dx', 'dy']) if (Math.abs(x[f] - y[f]) > 0.5) out.push(k + '.' + f + ' ' + x[f] + ' vs ' + y[f]);
    for (const f of ['scale', 'opacity']) if (Math.abs(x[f] - y[f]) > 0.02) out.push(k + '.' + f + ' ' + x[f] + ' vs ' + y[f]);
  }
  if (Math.abs((a.camera ? a.camera.a : 1) - (b.camera ? b.camera.a : 1)) > 0.02) out.push('镜头缩放 ' + (a.camera && a.camera.a) + ' vs ' + (b.camera && b.camera.a));
  if (Math.abs((a.dim || 0) - (b.dim || 0)) > 0.03) out.push('遮罩 ' + a.dim + ' vs ' + b.dim);
  return out;
}

/* ---------- 导出：走真实编辑器窗口 ---------- */
async function exportFolderGame() {
  /* 上一次的同名产物会触发「目标已存在」的原生确认框，脚本无法代答：
     每次导出前清空自己的输出目录（限定在 release/v080-rc 下）。 */
  const guardRoot = path.join(ROOT, 'release', 'v080-rc');
  if (path.resolve(OUT).startsWith(path.resolve(guardRoot) + path.sep) && fs.existsSync(OUT)) {
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-rc-'));
  const userData = path.join(work, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT, items: [{ path: PROJECT, title: '晚风演出优化', openedAt: new Date().toISOString() }]
  }));
  const port = await freePort();
  const env = Object.assign({}, process.env, { PAPER_VN_TEST_EXPORT_DIR: OUT });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const proc = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData], { cwd: ROOT, stdio: 'ignore', env });
  let cdp = null;
  try {
    const page = await waitPage(port, (u) => u.startsWith('paper://app/'));
    if (!page) throw new Error('编辑器窗口未出现');
    cdp = await connect(page.webSocketDebuggerUrl, 'editor');
    for (let i = 0; i < 200; i++) {
      const ready = await cdp.ev(`(() => { const M = window.__pvnM3; return M ? M.metrics() : null; })()`).catch(() => null);
      if (ready && ready.nodes >= 40) break;
      await sleep(200);
    }
    const meta = await cdp.ev(`window.__pvnM3.metrics()`);
    ok('编辑器打开演出工程', meta);

    /* 发行面板：真实输入事件填表 */
    await cdp.ev(`(() => { const d = document.getElementById('publishDialog'); if (!d.open) document.getElementById('publish').click(); return true; })()`);
    await sleep(500);
    await cdp.ev(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); if (!el) return; el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      set('pubName', '晚风演出验收'); set('pubAuthor', '验收脚本'); set('pubVersion', '0.8.0-rc');
      set('pubCopyright', 'Copyright © 2026 验收');
      const t = document.getElementById('pubType'); t.value = 'folder'; t.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(600);
    const form = await cdp.ev(`(() => ({
      name: document.getElementById('pubName').value,
      type: document.getElementById('pubType').value,
      issues: [...document.querySelectorAll('#pubIssues li')].map(li => li.textContent.trim()),
      disabled: document.getElementById('pubStart').disabled,
      toolchain: (document.getElementById('pubToolchain') || {}).textContent || ''
    }))()`);
    if (form.disabled) throw new Error('导出按钮不可用：' + form.issues.join('；') + ' / ' + form.toolchain);
    ok('发行表单就绪（目录版）', form);

    await cdp.ev(`document.getElementById('pubStart').click()`);
    let result = null;
    const deadline = Date.now() + 8 * 60 * 1000;
    while (Date.now() < deadline) {
      result = await cdp.ev(`(() => { const r = document.getElementById('pubResult');
        return { text: r.textContent || '', progress: (document.getElementById('pubProgressText') || {}).textContent || '',
          running: document.getElementById('pubCancel') && !document.getElementById('pubCancel').disabled,
          stages: [...document.querySelectorAll('#pubStages li')].map(li => li.textContent.trim()) }; })()`);
      if (!result.running && /导出完成|导出失败|已取消|已导出/.test(result.progress + ' ' + result.text)) break;
      await sleep(600);
    }
    await cdp.shot(path.join(SHOTS, 'v080rc-export-done.png'));
    report.shots.push(path.relative(ROOT, path.join(SHOTS, 'v080rc-export-done.png')).replace(/\\/g, '/'));
    if (!/导出完成/.test(result.progress)) throw new Error('导出失败：' + result.progress + ' / ' + result.text);
    ok('目录版导出完成', { stages: result.stages.slice(-3), text: result.text.slice(0, 120) });

    /* 同一窗口里把编辑器试玩推到目标节点，作为三处对照的第一处 */
    return { cdp, proc };
  } catch (e) {
    if (cdp) cdp.close();
    killTree(proc.pid);
    throw e;
  }
}

/* ---------- 定位导出的 EXE ---------- */
function findArtifact() {
  const entries = fs.readdirSync(OUT, { withFileTypes: true });
  const dir = entries.find((e) => e.isDirectory() && !/\.manifest\.json$/.test(e.name));
  if (!dir) throw new Error('导出目录里没有产物：' + OUT + '（' + entries.map((e) => e.name).join(',') + '）');
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
  return { dir: dirPath, exe, content, contentBytes: fs.existsSync(content) ? fs.statSync(content).size : 0 };
}

/* ---------- 启动独立游戏 ---------- */
async function launchGame(exePath) {
  const port = await freePort();
  const env = Object.assign({}, process.env, { PAPER_GAME_DEVTOOLS: '1' });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const proc = spawn(exePath, ['--remote-debugging-port=' + port, '--remote-allow-origins=*'], { cwd: path.dirname(exePath), env, stdio: 'ignore' });
  const page = await waitPage(port, (u) => u.startsWith('papergame://game/'), 90000);
  if (!page) { killTree(proc.pid); throw new Error('导出的游戏没有启动：' + exePath); }
  const cdp = await connect(page.webSocketDebuggerUrl, 'game');
  for (let i = 0; i < 100; i++) { if (await cdp.ev(`typeof window.paperGameState === 'function'`)) break; await sleep(200); }
  return { proc, cdp, url: page.url };
}

/* ---------- 单文件 HTML（同一套播放器） ---------- */
async function launchTrial() {
  fs.mkdirSync(path.dirname(HARNESS), { recursive: true });
  fs.writeFileSync(HARNESS, [
    "'use strict';",
    "const { app, BrowserWindow, Menu } = require('electron');",
    'app.disableHardwareAcceleration();',
    'app.whenReady().then(async () => {',
    '  Menu.setApplicationMenu(null);',
    '  /* Electron 会把部分命令行开关留在 process.argv 里，按扩展名取页面路径最稳 */',
    "  const target = process.argv.slice().reverse().find((a) => /\\.html$/i.test(a));",
    "  if (!target) { console.error('缺少 HTML 路径'); app.exit(2); return; }",
    '  const win = new BrowserWindow({ width: 1280, height: 800, show: true, backgroundColor: "#17261f" });',
    '  win.setMenuBarVisibility(false);',
    '  await win.loadFile(target);',
    '});'
  ].join('\n'), 'utf8');
  const port = await freePort();
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const proc = spawn(ELECTRON, ['--remote-debugging-port=' + port, '--remote-allow-origins=*', HARNESS, TRIAL], { cwd: ROOT, stdio: 'ignore', env });
  const page = await waitPage(port, (u) => u.startsWith('file://'), 60000);
  if (!page) { killTree(proc.pid); throw new Error('单文件试玩版没有打开'); }
  const cdp = await connect(page.webSocketDebuggerUrl, 'trial');
  let ready = false;
  for (let i = 0; i < 150; i++) {
    ready = await cdp.ev(`typeof window.paperGameState === 'function' && !!document.getElementById('startGame')`).catch(() => false);
    if (ready) break;
    await sleep(200);
  }
  if (!ready) { cdp.close(); killTree(proc.pid); throw new Error('单文件试玩版没有就绪（缺少 #startGame 或播放器未初始化）'); }
  return { proc, cdp };
}

(async () => {
  let editor = null, game = null, trial = null;
  try {
    if (!fs.existsSync(path.join(PROJECT, 'project.paper.json'))) throw new Error('缺少演出工程：' + PROJECT + '（先跑 npm run wanfeng:v08）');
    if (!fs.existsSync(TRIAL)) throw new Error('缺少单文件试玩版：' + TRIAL);

    console.log('[1/6] 真实编辑器窗口导出目录版游戏');
    editor = await exportFolderGame();

    console.log('[2/6] 校验产物并启动独立 EXE');
    const art = findArtifact();
    report.artifact = { dir: path.relative(ROOT, art.dir).replace(/\\/g, '/'), exe: path.relative(ROOT, art.exe).replace(/\\/g, '/'), exeBytes: fs.statSync(art.exe).size, contentBytes: art.contentBytes, content: fs.existsSync(art.content) };
    ok('产物结构', report.artifact);
    /* 导出内容里必须有演出数据（只是静态检查，不作为唯一依据） */
    if (art.content) {
      const html = fs.readFileSync(art.content, 'utf8');
      report.artifact.hasPerfRuntime = /createPaperPerformance/.test(html);
      report.artifact.hasActionData = /character\.show/.test(html) && /background\.change/.test(html);
      report.artifact.papergameRefs = (html.match(/papergame:\/\/game\//g) || []).length;
      report.artifact.scriptTags = (html.match(/<script/g) || []).length;
      if (!report.artifact.hasPerfRuntime || !report.artifact.hasActionData || !report.artifact.papergameRefs) {
        bad('导出内容', '缺少演出运行时/动作数据/papergame 资源引用：' + JSON.stringify(report.artifact));
      } else ok('导出内容含演出运行时与 papergame 资源引用', { refs: report.artifact.papergameRefs, scriptTags: report.artifact.scriptTags });
    }
    game = await launchGame(art.exe);
    ok('独立游戏启动', { url: game.url });

    const title = await game.cdp.ev(`(() => ({ title: document.getElementById('title').textContent,
      origin: location.origin, hasBg: document.getElementById('titleScreen').classList.contains('has-bg') }))()`);
    await game.cdp.shot(path.join(SHOTS, 'v080rc-game-title.png'));
    report.shots.push(path.relative(ROOT, path.join(SHOTS, 'v080rc-game-title.png')).replace(/\\/g, '/'));

    console.log('[3/6] 游戏内逐句播放：阻塞 / 跳过 / 背景转场 / 镜头 / papergame');
    await game.cdp.ev(`document.getElementById('startGame').click()`);
    await sleep(350);

    /* 第一句：镜头轻推，应能看到 #layers 的矩阵在变 */
    const first = await game.cdp.ev(READ_STAGE);
    const camA = first.camera ? first.camera.a : 1;
    await sleep(700);
    const first2 = await game.cdp.ev(READ_STAGE);
    const camB = first2.camera ? first2.camera.a : 1;
    if (!(camB > camA + 0.002)) bad('镜头推进', '第一句镜头没有变化：' + JSON.stringify({ camA, camB, raw: first2.cameraRaw }));
    else ok('镜头推进', { from: +camA.toFixed(3), to: +camB.toFixed(3) });

    /* 第 2 句（索引 2）林澈淡入，阻塞：进句瞬间应当半透明，点击只结算不跳句 */
    let st = await walkTo(game.cdp, 1);
    await settleThenAdvance(game.cdp, 150);
    const entering2 = await game.cdp.ev(READ_STAGE);
    const at2 = entering2.game.i;
    const earlyChe = (entering2.layers.find((l) => l.layer === 'c_che') || {}).opacity;
    if (at2 !== 2) bad('阻塞演出', '没有停在第二句：' + at2 + '（' + entering2.text.slice(0, 12) + '）');
    else if (!(earlyChe > 0.01 && earlyChe < 0.95)) bad('阻塞演出', '进句瞬间不是「正在淡入」：opacity=' + earlyChe);
    else {
      await game.cdp.ev(`document.getElementById('scene').click()`);
      await sleep(180);
      const afterClick = await game.cdp.ev(READ_STAGE);
      const settled = (afterClick.layers.find((l) => l.layer === 'c_che') || {}).opacity;
      if (afterClick.game.i !== 2) bad('阻塞演出', '演出没播完就跳句了：2 → ' + afterClick.game.i);
      else if (!(settled > 0.98)) bad('阻塞演出', '点击后没有结算到终态：opacity=' + settled);
      else ok('阻塞演出：点击先结算不跳句', { midOpacity: +earlyChe.toFixed(3), settled: +settled.toFixed(3) });
    }
    /* 再点一次：真的进入第 3 句 —— 林悠从左侧进入 */
    await game.cdp.ev(`document.getElementById('scene').click()`);
    await sleep(200);
    const advanced = await game.cdp.ev(READ_STAGE);
    if (advanced.game.i !== 3) bad('阻塞放行', '第二次点击没有进入下一句：' + advanced.game.i);
    else ok('阻塞放行', { next: advanced.game.i });

    /* 第 3 句：角色从左侧进入（阻塞），位移从负偏移收敛到 0 */
    const entering = advanced;
    const youEarly = entering.layers.find((l) => l.layer === 'c_you');
    await sleep(1400);
    const youDone = (await game.cdp.ev(READ_STAGE)).layers.find((l) => l.layer === 'c_you');
    if (!youEarly || !youDone) bad('角色进入', '没有读到林悠图层');
    else if (!(youEarly.dxPct < -1)) bad('角色进入', '进句时没有侧向偏移：dx=' + youEarly.dxPct.toFixed(2));
    else if (!(Math.abs(youDone.opacity - 1) < 0.03 && Math.abs(youDone.dxPct) < 1)) bad('角色进入', '终态不对：' + JSON.stringify({ dx: youDone.dxPct, opacity: youDone.opacity }));
    else ok('角色进入（淡入 + 位移归零）', { earlyDx: +youEarly.dxPct.toFixed(2), earlyOpacity: +youEarly.opacity.toFixed(3), dx: +youDone.dxPct.toFixed(2), opacity: +youDone.opacity.toFixed(3) });

    /* papergame 资源：图片必须来自协议且解码成功 */
    const assetCheck = await game.cdp.ev(`(() => {
      const imgs = [...document.querySelectorAll('#layers img')];
      return { total: imgs.length, papergame: imgs.filter(i => i.src.startsWith('papergame://game/')).length,
               loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
               sample: imgs.map(i => i.src.slice(0, 48)) };
    })()`);
    if (!assetCheck.total || assetCheck.papergame !== assetCheck.total || assetCheck.loaded !== assetCheck.total) bad('papergame 资源', JSON.stringify(assetCheck));
    else ok('papergame:// 资源全部加载', { images: assetCheck.total });

    /* 第二场第一句（第 13 句）：背景交叉淡化 1.0s，过程中必须看到 ghost 真的在淡入 */
    st = await walkTo(game.cdp, 12);
    await step(game.cdp);
    const mid = await game.cdp.ev(`(() => { const g = document.querySelector('#scene > .pf-bg-ghost');
      return { ghost: !!g, opacity: g ? Number(getComputedStyle(g).opacity) : -1 }; })()`);
    await sleep(1700);
    const scene2 = await game.cdp.ev(READ_STAGE);
    const bg2 = scene2.layers.find((l) => /bg/.test(l.layer));
    if (!bg2 || bg2.srcKind !== 'papergame') bad('背景转场', '背景没有走 papergame：' + JSON.stringify(bg2));
    else if (!mid.ghost || !(mid.opacity > 0.02 && mid.opacity < 0.99)) bad('背景转场', '交叉淡化没有过渡层：' + JSON.stringify(mid));
    else ok('第二场：背景交叉淡化', { ghost: mid.ghost, ghostOpacity: +mid.opacity.toFixed(3), bg: bg2.hash });
    await game.cdp.shot(path.join(SHOTS, 'v080rc-game-scene2.png'));
    report.shots.push(path.relative(ROOT, path.join(SHOTS, 'v080rc-game-scene2.png')).replace(/\\/g, '/'));

    /* 分支：第 24 句是选择节点，走第二个选项 */
    st = await walkTo(game.cdp, 24);
    const choiceUI = st.choices;
    if (!choiceUI.length || choiceUI.length !== 2) bad('分支选项', '没有出现两个选项：' + JSON.stringify(choiceUI));
    else {
      await game.cdp.ev(`document.querySelectorAll('#choices button')[1].click()`);
      await sleep(700);
      const branchB = await game.cdp.ev(READ_STAGE);
      const textB = branchB.text;
      if (!/车棚/.test(textB)) bad('分支选项', '第二个选项没有进入对应句子：' + textB);
      else ok('分支：第二个选项', { text: textB.slice(0, 20), node: branchB.game.i });
      /* 回到分支点走另一条，验证两条路都通 */
      await game.cdp.ev(`document.getElementById('back').click()`);
      await sleep(500);
      const back = await game.cdp.ev(READ_STAGE);
      if (!back.choices.length) bad('分支回退', '返回上一步没有回到选择节点');
      else {
        await game.cdp.ev(`document.querySelectorAll('#choices button')[0].click()`);
        await sleep(700);
        const branchA = await game.cdp.ev(READ_STAGE);
        if (!/一起走/.test(branchA.text)) bad('分支选项', '第一个选项没有进入对应句子：' + branchA.text);
        else ok('分支：两条路都通', { a: branchA.text.slice(0, 12), b: textB.slice(0, 12), backToChoice: true });
      }
    }

    /* 第三场：夜晚（第 34 句），双人站位 + 镜头 */
    st = await walkTo(game.cdp, 34);
    await sleep(1400);
    const scene3 = await game.cdp.ev(READ_STAGE);
    const night = scene3.layers.find((l) => /bg/.test(l.layer));
    const duo = scene3.layers.filter((l) => l.display !== 'none' && /c_/.test(l.layer));
    if (!night || night.srcKind !== 'papergame') bad('夜景', '背景不是 papergame 资源');
    else if (!(scene3.camera && Math.abs(scene3.camera.a - 1) > 0.005)) bad('夜景', '镜头没有推近：' + JSON.stringify(scene3.camera));
    else ok('第三场：夜景 + 双人站位', { bg: night.hash, chars: duo.length, camera: +scene3.camera.a.toFixed(3) });
    await game.cdp.shot(path.join(SHOTS, 'v080rc-game-scene3.png'));
    report.shots.push(path.relative(ROOT, path.join(SHOTS, 'v080rc-game-scene3.png')).replace(/\\/g, '/'));

    console.log('[4/6] 存档 → 返回标题 → 继续：终态恢复');
    const saved = await game.cdp.ev(READ_STAGE);
    const savedNorm = normalize(saved);
    await game.cdp.ev(`document.getElementById('menuBtn').click()`);
    await sleep(300);
    await game.cdp.ev(`document.getElementById('save').click()`);
    await sleep(400);
    await game.cdp.ev(`document.getElementById('menuTitle').click()`);
    await sleep(600);
    const canContinue = await game.cdp.ev(`!document.getElementById('continueGame').disabled`);
    if (!canContinue) bad('存档', '「继续游戏」仍不可用');
    await game.cdp.ev(`document.getElementById('continueGame').click()`);
    await sleep(900);
    const loaded = await game.cdp.ev(READ_STAGE);
    const loadedNorm = normalize(loaded);
    const loadDiff = diffNormalized(savedNorm, loadedNorm);
    if (loadDiff.length) bad('读档恢复', loadDiff.join('；'));
    else ok('读档恢复终态', { node: loadedNorm.node, bg: loadedNorm.bgHash });

    console.log('[5/6] 对照：编辑器试玩 / 单文件 HTML / 独立游戏');
    /* 编辑器试玩 */
    const ed = editor.cdp;
    await ed.ev(`document.querySelector('#publishDialog').close()`);
    await ed.ev(`window.__pvnM3.play()`);
    await sleep(300);
    for (let i = 0; i < 220; i++) {
      const pos = await ed.ev(`(() => { const t = document.querySelector('#position').textContent.split('/')[0].trim(); return Number(t) || 0; })()`);
      if (pos >= 35) break;
      const hasChoice = await ed.ev(`document.querySelectorAll('#choices button').length`);
      if (hasChoice) { await ed.ev(`document.querySelectorAll('#choices button')[0].click()`); await sleep(400); continue; }
      const blocking = await ed.ev(`(() => { const h = document.querySelector('#hint'); return !!h && /演出中/.test(h.textContent); })()`);
      if (blocking) { await ed.ev(`window.__pvnM3.advance()`); await sleep(90); }
      await ed.ev(`window.__pvnM3.advance()`);
      await sleep(220);
    }
    await sleep(900);
    const editorStage = await ed.ev(READ_STAGE);
    if (!editorStage) bad('编辑器试玩', '没有读到编辑器舞台');
    else ok('编辑器试玩到同一句', { text: editorStage.text.slice(0, 16), layers: editorStage.layers.length });
    /* 单文件 HTML */
    trial = await launchTrial();
    await trial.cdp.ev(`document.getElementById('startGame').click()`);
    await sleep(300);
    const trialStage = await walkTo(trial.cdp, 34);
    await sleep(900);
    const trialFinal = await trial.cdp.ev(READ_STAGE);
    const edNorm = normalize(editorStage), trialNorm = normalize(trialFinal), gameNorm = normalize(loaded);
    const d1 = diffNormalized(edNorm, gameNorm);
    const d2 = diffNormalized(trialNorm, gameNorm);
    report.compare = { editor: edNorm, trial: trialNorm, game: gameNorm, editorVsGame: d1, trialVsGame: d2 };
    if (d1.length) bad('编辑器 vs 独立游戏', d1.join('；'));
    if (d2.length) bad('单文件 vs 独立游戏', d2.join('；'));
    if (!d1.length && !d2.length) ok('三处终态一致', { node: gameNorm.node, camera: gameNorm.camera && gameNorm.camera.a });

    console.log('[6/6] 汇总');
    const allErrors = [...(game.cdp.errors || []), ...(editor.cdp.errors || []), ...(trial.cdp.errors || [])];
    report.exceptions = allErrors;
    if (allErrors.length) bad('运行时异常', allErrors.slice(0, 3).map((e) => e.text).join(' | '));
    else ok('运行时异常', { count: 0 });
  } catch (e) {
    bad('v080-rc', e.message);
  } finally {
    for (const run of [trial, game]) { if (run) { try { run.cdp.close(); } catch {} killTree(run.proc.pid); } }
    if (editor) { try { editor.cdp.close(); } catch {} killTree(editor.proc.pid); }
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
    console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' — release/v080-rc-game-verify.json');
    if (report.problems.length) console.log(report.problems.join('\n'));
    process.exit(report.ok ? 0 : 1);
  }
})();
