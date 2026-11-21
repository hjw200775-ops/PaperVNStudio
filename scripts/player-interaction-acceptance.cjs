'use strict';
/*
 * 播放器交互专项验收（V0.7.2 P0）。
 *
 * 同一套检查跑在五个载体上：编辑器试玩、完整预览、HTML 导出、ZIP 游戏、单文件便携版。
 * 检查的是「玩家手势」而不是内部状态：双击台词、从台词拖到立绘、按住立绘拖动，
 * 都应该既不出选区也不出图片拖拽；单击仍然正常推进，选项与设置控件仍然可用。
 *
 * 用法：
 *   node scripts/player-interaction-acceptance.cjs                 # 全部（单文件较慢）
 *   node scripts/player-interaction-acceptance.cjs --skip-portable # 不含单文件
 *   node scripts/player-interaction-acceptance.cjs --only=html,editor
 *   node scripts/player-interaction-acceptance.cjs --packaged      # 用打包后的纸间
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARGS = process.argv.slice(2);
const argOf = k => {
  const eq = ARGS.find(a => a.startsWith('--' + k + '='));
  if (eq) return eq.slice(k.length + 3);
  const i = ARGS.indexOf('--' + k);
  return i >= 0 ? (ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : true) : null;
};
const PACKAGED = ARGS.includes('--packaged');
const ONLY = (() => { const v = argOf('only'); return v && v !== true ? String(v).split(',') : null; })();
const SKIP_PORTABLE = ARGS.includes('--skip-portable');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const report = { at: new Date().toISOString(), packaged: PACKAGED, ok: true, stages: {}, problems: [], unverified: [] };

function ok(name, detail) { report.stages[name] = { ok: true, detail }; console.log('  ok  ' + name + (detail && detail.summary ? ' — ' + detail.summary : '')); }
function bad(name, message, detail) { report.ok = false; report.problems.push(name + '：' + message); report.stages[name] = { ok: false, message, detail }; console.log('  FAIL ' + name + ' — ' + message); }

/* ---------- 基础设施 ---------- */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

async function httpJson(url, timeoutMs = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await (await fetch(url, { signal: ctl.signal })).json(); } finally { clearTimeout(timer); }
}

async function waitPage(port, match, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await httpJson('http://127.0.0.1:' + port + '/json/list');
      const page = (Array.isArray(list) ? list : [])
        .find(t => t.type === 'page' && typeof t.url === 'string' && match(t.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return null;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 12000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); };
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    }
    return r.result && r.result.value;
  };
  return { send, evaluate, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

function editorCommand() {
  if (PACKAGED) {
    const direct = path.join(ROOT, 'release', 'win-unpacked', 'PaperVNStudio.exe');
    if (fs.existsSync(direct)) return { exe: direct, args: [] };
    const cands = fs.existsSync(path.join(ROOT, 'release'))
      ? fs.readdirSync(path.join(ROOT, 'release')).filter(n => /^pkg/.test(n))
        .map(n => path.join(ROOT, 'release', n, 'win-unpacked', 'PaperVNStudio.exe'))
        .filter(p => fs.existsSync(p))
        .map(p => ({ p, t: fs.statSync(p).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      : [];
    if (cands.length) return { exe: cands[0].p, args: [] };
    throw new Error('没有找到打包好的纸间（release/win-unpacked 或 release/pkg*）');
  }
  return { exe: ELECTRON, args: [ROOT] };
}

/* 让编辑器启动后直接打开指定工程：写一份 recent 列表即可。 */
function seedRecent(userData, projectDir, title) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: projectDir, items: [{ path: projectDir, title, openedAt: new Date().toISOString() }]
  }, null, 2), 'utf8');
}

/* ---------- 页面手势 ---------- */
const mouseDrag = async (cdp, from, to, steps = 12) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps,
      button: 'left', buttons: 1
    });
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(180);
};

const mouseClick = async (cdp, at, clickCount = 1) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount });
  await sleep(220);
};

const rectOf = (cdp, sel) => cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null; const b = el.getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);

const selectionOf = cdp => cdp.evaluate(`(() => { const s = getSelection();
  return { text: s ? s.toString().slice(0, 40) : '', ranges: s ? s.rangeCount : 0 }; })()`);

const clearSelection = cdp => cdp.evaluate('getSelection().removeAllRanges()');

/* ---------- 一组手势检查：游戏/试玩页面通用 ---------- */
async function gestureSuite(cdp, opts) {
  const { label, hasAudio = false, enterGame = true, withTitlePage = true,
    readyExpr = `!!(document.getElementById('title') && document.getElementById('startGame'))` } = opts;
  const problems = [];
  const detail = {};

  /* 导出页面接近 20MB，target 出现时 DOM 可能还没解析完。 */
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    ready = await cdp.evaluate(readyExpr);
    if (!ready) await sleep(150);
  }
  if (!ready) {
    const diag = await cdp.evaluate(`({url:location.href,state:document.readyState,
      body:document.body?document.body.innerHTML.length:0,
      hasTitle:!!document.getElementById('title'),hasStart:!!document.getElementById('startGame'),
      hasStage:!!document.getElementById('stage')})`).catch(e => ({ error: e.message }));
    throw new Error(label + '：页面没有就绪 ' + JSON.stringify(diag));
  }

  await cdp.evaluate(`(() => { window.__drags = [];
    document.addEventListener('dragstart', e => window.__drags.push({ prevented: e.defaultPrevented,
      target: e.target && e.target.nodeName }), true); })()`);

  const title = withTitlePage ? await rectOf(cdp, '#title') : null;
  const titleBg = withTitlePage ? await rectOf(cdp, '#titleBgImg') : null;
  if (withTitlePage) {
    detail.titleUserSelect = await cdp.evaluate(`(() => { const el = document.getElementById('title');
      return el ? getComputedStyle(el).userSelect : null; })()`);
  }

  if (title) {
    await mouseDrag(cdp, { x: title.x - 20, y: title.y + title.h / 2 }, { x: title.x + title.w * 0.8, y: title.y + title.h / 2 });
    const s = await selectionOf(cdp); await clearSelection(cdp);
    if (s.ranges) problems.push('标题拖选产生了选区：' + s.text);
    await mouseClick(cdp, { x: title.x + 16, y: title.y + title.h / 2 }, 1);
    await mouseClick(cdp, { x: title.x + 16, y: title.y + title.h / 2 }, 2);
    const d = await selectionOf(cdp); await clearSelection(cdp);
    if (d.ranges) problems.push('标题双击产生了选区：' + d.text);
  }
  if (titleBg) {
    await mouseDrag(cdp, { x: titleBg.x + 50, y: titleBg.y + titleBg.h - 70 }, { x: titleBg.x + 380, y: titleBg.y + 50 });
    const s = await selectionOf(cdp); await clearSelection(cdp);
    if (s.ranges) problems.push('拖动标题背景产生了选区');
    const n = await cdp.evaluate('window.__drags.length');
    if (n) problems.push('标题背景触发了 ' + n + ' 次原生 dragstart');
  }

  /* 进入游戏（编辑器已在试玩状态时跳过） */
  if (enterGame) {
    await cdp.evaluate(`document.getElementById('startGame').click()`);
    await sleep(800);
  }

  detail.scene = await cdp.evaluate(`(() => {
    const g = el => el ? getComputedStyle(el).userSelect : null;
    return { text: g(document.getElementById('text')) || g(document.getElementById('line')),
      box: g(document.getElementById('box')) || g(document.getElementById('dialogue')),
      scene: g(document.getElementById('scene')) || g(document.getElementById('stage')),
      imgDraggable: [...document.querySelectorAll('#layers img, #layersCanvas img')].map(i => i.draggable) };
  })()`);
  (detail.scene.imgDraggable || []).forEach((v, i) => { if (v) problems.push('第 ' + (i + 1) + ' 张立绘仍可被原生拖动'); });

  const lineSel = (await rectOf(cdp, '#text')) ? '#text' : '#line';
  const boxSel = (await rectOf(cdp, '#box')) ? '#box' : '#dialogue';
  const sceneSel = (await rectOf(cdp, '#scene')) ? '#scene' : '#stage';
  const text = await rectOf(cdp, lineSel);
  const box = await rectOf(cdp, boxSel);
  const scene = await rectOf(cdp, sceneSel);

  const readLine = () => cdp.evaluate(`document.querySelector(${JSON.stringify(lineSel)}).textContent`);

  /* 单击推进：文本必须变化 */
  const l0 = await readLine();
  await mouseClick(cdp, { x: scene.x + 30, y: scene.y + scene.h * 0.3 });
  await sleep(300);
  const l1 = await readLine();
  detail.advance = { before: l0.slice(0, 18), after: l1.slice(0, 18), changed: l0 !== l1 };
  if (l0 === l1) problems.push('单击没有推进剧情');

  /* 双击台词 */
  await mouseClick(cdp, { x: text.x + 30, y: text.y + text.h / 2 }, 1);
  await mouseClick(cdp, { x: text.x + 30, y: text.y + text.h / 2 }, 2);
  const dbl = await selectionOf(cdp); await clearSelection(cdp);
  if (dbl.ranges) problems.push('双击台词产生了选区：' + dbl.text);

  /* 从台词框拖到立绘区：无选区且不推进 */
  const beforeDrag = await readLine();
  await mouseDrag(cdp, { x: box.x + 30, y: box.y + box.h - 14 }, { x: scene.x + scene.w * 0.55, y: scene.y + 50 });
  const afterDrag = await readLine();
  const dragSel = await selectionOf(cdp); await clearSelection(cdp);
  detail.lineDrag = { selection: dragSel, advanced: beforeDrag !== afterDrag };
  if (dragSel.ranges) problems.push('从台词拖到立绘产生了选区：' + dragSel.text);
  if (beforeDrag !== afterDrag) problems.push('拖动台词被当成点击，剧情被推进');

  /* 按住立绘拖动：无选区、无原生拖拽、不推进 */
  const drags0 = await cdp.evaluate('window.__drags.length');
  const beforeSprite = await readLine();
  await mouseDrag(cdp, { x: scene.x + scene.w * 0.5, y: scene.y + 80 }, { x: scene.x + scene.w * 0.75, y: scene.y + 230 });
  const afterSprite = await readLine();
  detail.spriteDrag = {
    selection: await selectionOf(cdp), newDrags: (await cdp.evaluate('window.__drags.length')) - drags0,
    advanced: beforeSprite !== afterSprite
  };
  await clearSelection(cdp);
  if (detail.spriteDrag.selection.ranges) problems.push('拖动立绘产生了选区');
  if (detail.spriteDrag.newDrags) problems.push('拖动立绘触发了原生 dragstart');
  if (afterSprite !== beforeSprite) problems.push('拖动立绘被当成点击，剧情被推进');

  /* 选项：推进到出现选项为止，点第一个 */
  let choiceInfo = { found: false };
  for (let i = 0; i < 5; i++) {
    const n = await cdp.evaluate(`document.querySelectorAll('#choices button').length`);
    if (n > 0) { choiceInfo.found = true; choiceInfo.count = n; break; }
    await mouseClick(cdp, { x: scene.x + 40, y: scene.y + 40 });
    await sleep(220);
  }
  if (choiceInfo.found) {
    const btn = await rectOf(cdp, '#choices button');
    const beforeChoice = await readLine();
    await mouseClick(cdp, { x: btn.x + btn.w / 2, y: btn.y + btn.h / 2 });
    await sleep(400);
    choiceInfo.textChanged = beforeChoice !== await readLine();
    if (!choiceInfo.textChanged) problems.push('点击选项没有进入分支');
  } else {
    report.unverified.push(label + '：这个工程在检查范围内没有遇到选项节点');
  }
  detail.choice = choiceInfo;

  /* 菜单 + 设置滑块 */
  const menuBtn = await rectOf(cdp, '#menuBtn');
  if (menuBtn) {
    await mouseClick(cdp, { x: menuBtn.x + menuBtn.w / 2, y: menuBtn.y + menuBtn.h / 2 });
    await sleep(350);
    detail.menuOpened = await cdp.evaluate(`!document.getElementById('menuOverlay').hidden`);
    if (!detail.menuOpened) problems.push('菜单没有打开');
    await cdp.evaluate(`document.getElementById('menuSettings').click()`);
    await sleep(350);
    const range = await rectOf(cdp, '#volBgm');
    if (range && hasAudio) {
      const before = await cdp.evaluate(`document.getElementById('volBgm').value`);
      const thumb = range.x + range.w * (Number(before) / 100);
      await mouseDrag(cdp, { x: thumb, y: range.y + range.h / 2 }, { x: range.x + range.w * 0.62, y: range.y + range.h / 2 });
      const after = await cdp.evaluate(`document.getElementById('volBgm').value`);
      detail.volume = { before, after, changed: before !== after,
        selectable: await cdp.evaluate(`getComputedStyle(document.getElementById('volBgm')).userSelect`) };
      if (before === after) problems.push('音量滑块拖不动');
    } else if (range) {
      detail.volume = { skipped: '工程没有音频，设置面板不显示音量' };
    }
    await cdp.evaluate(`(() => { document.getElementById('setBack').click(); document.getElementById('menuResume').click(); })()`);
    await sleep(250);
    detail.menuClosed = await cdp.evaluate(`document.getElementById('menuOverlay').hidden`);
    if (!detail.menuClosed) problems.push('返回游戏后菜单没有关闭');
  } else {
    report.unverified.push(label + '：页面没有游戏菜单按钮');
  }

  return { problems, detail };
}

/* ---------- 载体：独立 HTML ---------- */
function makeHtml(which, dir) {
  const { buildPlayerHTML } = require('../dist/game-html.js');
  const store = require('../desktop/project-store.cjs')();
  let project;
  if (which === 'b') {
    const f = require('./game-export-fixtures.cjs');
    project = f.buildProjectB(path.join(dir, 'fixture-b'), { stamp: 'interaction' }).project;
  } else {
    const sampleDir = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
    project = store.diskToRuntime(sampleDir, JSON.parse(fs.readFileSync(path.join(sampleDir, 'project.paper.json'), 'utf8')));
  }
  const file = path.join(dir, 'html-' + which + '.html');
  fs.writeFileSync(file, buildPlayerHTML(project), 'utf8');
  return file;
}

async function runHtml(which, dir) {
  const label = 'HTML 导出 · 工程 ' + which.toUpperCase();
  const file = makeHtml(which, dir);
  const port = await freePort();
  const loader = path.join(ROOT, 'scripts', 'html-probe-loader.cjs');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(ELECTRON,
    [loader, file, '--remote-debugging-port=' + port, '--remote-allow-origins=*',
      '--user-data-dir=' + path.join(dir, 'ud-html-' + which)],
    { stdio: 'ignore', env });
  try {
    const page = await waitPage(port, url => url.includes('html-' + which + '.html'));
    if (!page) throw new Error('页面没有加载');
    const cdp = await connect(page.webSocketDebuggerUrl);
    const r = await gestureSuite(cdp, { label, hasAudio: which === 'b' });
    cdp.close();
    if (r.problems.length) bad(label, r.problems.join('；'), r.detail);
    else ok(label, { summary: '无选区、无图片拖拽、单击推进与选项正常', ...r.detail });
    return r;
  } finally {
    killTree(proc.pid);
    await sleep(400);
  }
}

/* ---------- 载体：编辑器（试玩 + 完整预览） ---------- */
async function runEditor(dir, projectDir, title) {
  const label = '编辑器内试玩';
  const userData = path.join(dir, 'ud-editor');
  seedRecent(userData, projectDir, title);
  const port = await freePort();
  const cmd = editorCommand();
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(cmd.exe, [...cmd.args, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData],
    { stdio: 'ignore', env });
  let cdp = null;
  try {
    const page = await waitPage(port, url => url.startsWith('paper://app/'), 40000);
    if (!page) throw new Error('编辑器窗口没有启动');
    cdp = await connect(page.webSocketDebuggerUrl);
    let ready = null;
    for (let i = 0; i < 80; i++) {
      ready = await cdp.evaluate(`({host:typeof window.PaperHost==='object',
        nodes:document.querySelectorAll('#list .node').length})`);
      if (ready.host && ready.nodes > 0) break;
      await sleep(300);
    }
    if (!ready || !ready.nodes) throw new Error('编辑器没有打开工程：' + JSON.stringify(ready));

    /* 创作模式：台词仍可选中（这是制作界面，不是玩家端） */
    const stage = await rectOf(cdp, '#stage');
    const line = await rectOf(cdp, '#line');
    await mouseDrag(cdp, { x: stage.x + 20, y: line.y + line.h / 2 }, { x: line.x + line.w * 0.7, y: line.y + line.h / 2 });
    const craftSel = await selectionOf(cdp);
    const craftSelectable = await cdp.evaluate(`(() => { const el = document.getElementById('line');
      return el ? getComputedStyle(el).userSelect : null; })()`);
    await clearSelection(cdp);
    if (!craftSel.ranges) bad('创作模式仍可选中文字', '在舞台上拖选没有选中任何文字');
    else if (craftSelectable === 'none') bad('创作模式仍可选中文字', '#line 被错误地设成了不可选中');
    else ok('创作模式仍可选中文字', { summary: '选中了「' + craftSel.text.replace(/\s+/g, ' ').slice(0, 24) + '…」' });

    /* 进入试玩 */
    await cdp.evaluate(`document.getElementById('play').click()`);
    await sleep(700);
    const playing = await cdp.evaluate(`document.body.classList.contains('playing')`);
    if (!playing) throw new Error('没有进入试玩状态');

    const r = await gestureSuite(cdp, {
      label, hasAudio: false, enterGame: false, withTitlePage: false,
      readyExpr: `!!(document.getElementById('stage') && document.getElementById('line'))`
    });
    if (r.problems.length) bad(label, r.problems.join('；'), r.detail);
    else ok(label, { summary: '试玩时舞台不出选区、立绘不可拖，创作模式不受影响', ...r.detail });

    /* 完整预览：独立窗口加载同一份导出 HTML */
    const before = await cdp.evaluate(`document.getElementById('fullPreview') ? 1 : 0`);
    if (!before) {
      report.unverified.push('完整预览：编辑器没有 #fullPreview 按钮');
    } else {
      await cdp.evaluate(`document.getElementById('fullPreview').click()`);
      const page2 = await waitPage(port, url => url.includes('game-preview.html'), 30000);
      if (!page2) {
        bad('完整预览', '预览窗口没有出现');
      } else {
        const cdp2 = await connect(page2.webSocketDebuggerUrl);
        const r2 = await gestureSuite(cdp2, { label: '完整预览', hasAudio: false });
        cdp2.close();
        if (r2.problems.length) bad('完整预览', r2.problems.join('；'), r2.detail);
        else ok('完整预览', { summary: '独立预览窗口与导出页面行为一致', ...r2.detail });
      }
    }
    return { proc, cdp };
  } finally {
    try { if (cdp) cdp.close(); } catch { /* ignore */ }
    killTree(proc.pid);
    await sleep(600);
  }
}

/* ---------- ZIP 工具：自己解，不依赖 bsdtar 与代码页 ---------- */
function extractZip(zipPath, dest) {
  const { listZipEntries } = require('./zip-manifest.cjs');
  const buf = fs.readFileSync(zipPath);
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of listZipEntries(zipPath)) {
    if (e.directory) continue;
    const o = e.localOffset;
    if (buf.readUInt32LE(o) !== 0x04034b50) throw new Error('ZIP 条目损坏：' + e.name);
    const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
    const raw = buf.subarray(start, start + e.compressed);
    const data = e.method === 8 ? zlib.inflateRawSync(raw) : raw;
    const target = path.join(dest, ...e.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    count += 1;
  }
  return count;
}

function latestArtifact(pattern) {
  const dir = path.join(ROOT, 'release', 'exports');
  if (!fs.existsSync(dir)) return null;
  const list = fs.readdirSync(dir).filter(f => pattern.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return list.length ? path.join(dir, list[0].f) : null;
}

async function runPackagedGame(kind, dir) {
  const label = kind === 'zip' ? 'ZIP 游戏（真实 EXE）' : '单文件便携版';
  const zip = latestArtifact(/独立试玩包\.zip$/);
  let exePath = null;
  let cleanupDir = null;

  if (kind === 'zip') {
    if (!zip) { report.unverified.push(label + '：release/exports 里没有独立试玩包'); return; }
    cleanupDir = path.join(dir, 'zip-game');
    extractZip(zip, cleanupDir);
    const tops = fs.readdirSync(cleanupDir).filter(n => fs.statSync(path.join(cleanupDir, n)).isDirectory());
    const top = path.join(cleanupDir, tops[0]);
    exePath = fs.readdirSync(top).filter(f => /\.exe$/i.test(f) && !/elevate/i.test(f))
      .map(f => path.join(top, f))[0];
  } else {
    exePath = latestArtifact(/单文件便携版\.exe$/);
    if (!exePath) { report.unverified.push(label + '：release/exports 里没有单文件便携版'); return; }
    exePath = path.join(dir, 'portable', path.basename(exePath));
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.copyFileSync(latestArtifact(/单文件便携版\.exe$/), exePath);
  }
  if (!exePath || !fs.existsSync(exePath)) throw new Error('找不到可执行文件');

  const port = await freePort();
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(exePath, ['--remote-debugging-port=' + port, '--remote-allow-origins=*'],
    { stdio: 'ignore', env, cwd: path.dirname(exePath) });
  try {
    const page = await waitPage(port, url => url.startsWith('papergame://'), kind === 'portable' ? 180000 : 60000);
    if (!page) throw new Error('游戏窗口没有启动（可能被杀毒软件拦下）');
    const cdp = await connect(page.webSocketDebuggerUrl);
    const r = await gestureSuite(cdp, { label, hasAudio: false });
    cdp.close();
    if (r.problems.length) bad(label, r.problems.join('；'), r.detail);
    else ok(label, { summary: '解压/自解压后行为与 HTML 一致', ...r.detail });
  } finally {
    killTree(proc.pid);
    await sleep(1200);
  }
}

/* ---------- 主流程 ---------- */
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-interaction-'));
  const want = n => !ONLY || ONLY.includes(n);
  console.log('播放器交互验收 · ' + (PACKAGED ? '已打包纸间' : '开发环境'));

  try {
    if (want('html')) {
      await runHtml('a', dir);
      await runHtml('b', dir);
    }
    if (want('editor')) {
      await runEditor(dir, path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01'), '晚风经过二楼走廊');
    }
    if (want('zip')) await runPackagedGame('zip', dir);
    if (want('portable') && !SKIP_PORTABLE) await runPackagedGame('portable', dir);
  } catch (e) {
    bad('执行', (e && e.message) || String(e));
  }

  const out = path.join(ROOT, 'release', PACKAGED ? 'player-interaction-acceptance-packaged.json' : 'player-interaction-acceptance-dev.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');

  console.log('');
  if (report.ok) console.log('RESULT PASS · ' + Object.keys(report.stages).length + ' 项检查');
  else console.log('RESULT FAIL · ' + report.problems.length + ' 个问题');
  if (report.unverified.length) report.unverified.forEach(u => console.log('  未验证：' + u));
  console.log('报告：' + out);
  console.log('临时目录：' + dir);
  process.exit(report.ok ? 0 : 1);
})();
