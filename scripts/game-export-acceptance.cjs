'use strict';
/*
 * V0.7.2 通用独立游戏导出 · 端到端验收。
 *
 *   node scripts/game-export-acceptance.cjs                 # 开发环境（node_modules/electron）
 *   node scripts/game-export-acceptance.cjs --packaged      # 已打包的纸间（release/win-unpacked）
 *   node scripts/game-export-acceptance.cjs --editor-exe=<路径> --skip-portable
 *
 * 全部操作走真实图形界面：启动编辑器 → 打开「游戏发行」→ 在表单里填信息、导入图标 →
 * 点「导出 Windows 游戏」→ 用 CDP 打开导出的游戏 EXE 实际游玩、存档、重启读档。
 * 不调用内部函数绕过界面，也不把「源码启动能导」当成通用导出通过。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { listZipEntries } = require('./zip-manifest.cjs');
const { readPeVersion } = require('./pe-version.cjs');
const fixtures = require('./game-export-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const args = process.argv.slice(2);
const argOf = name => {
  const hit = args.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const packaged = !!argOf('packaged');
const skipPortable = !!argOf('skip-portable');
const editorExeArg = argOf('editor-exe');

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';

const report = {
  ok: false, mode: packaged ? 'packaged' : 'dev', startedAt: new Date().toISOString(),
  stages: {}, problems: [], unverified: [], env: process.env.PAPER_VN_STAGE || ''
};
const ok = (stage, detail) => {
  report.stages[stage] = Object.assign({ ok: true }, detail || {});
  console.log('  ok   ' + stage + (detail && detail.summary ? ' — ' + detail.summary : ''));
};
const bad = (stage, message, detail) => {
  report.stages[stage] = Object.assign({ ok: false, message }, detail || {});
  report.problems.push(stage + '：' + message);
  console.log('  FAIL ' + stage + ' — ' + message);
};

/* ---------- 基础设施 ---------- */

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', () => resolve(9300 + Math.floor(Math.random() * 200)));
  });
}
async function httpJson(url, timeoutMs = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await (await fetch(url, { signal: ctl.signal })).json(); } finally { clearTimeout(timer); }
}
async function waitPage(port, match, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await httpJson('http://127.0.0.1:' + port + '/json/list');
      const page = (Array.isArray(list) ? list : []).find(t => t.type === 'page' && typeof t.url === 'string' && match(t.url));
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
  const screenshot = async file => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  };
  await send('Page.enable').catch(() => {});
  return { evaluate, screenshot, send, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}
function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

/* ---------- 编辑器 ---------- */

function editorCommand() {
  if (editorExeArg && editorExeArg !== true) return { exe: path.resolve(editorExeArg), args: [] };
  if (packaged) {
    const direct = path.join(ROOT, 'release', 'win-unpacked', 'PaperVNStudio.exe');
    if (fs.existsSync(direct)) return { exe: direct, args: [] };
    /* 受限环境里 electron-builder 覆盖式输出会被安全删除策略拦下，允许打到 release/pkgedN。 */
    const candidates = fs.existsSync(path.join(ROOT, 'release'))
      ? fs.readdirSync(path.join(ROOT, 'release'))
        .filter(n => /^pkg/.test(n))
        .map(n => path.join(ROOT, 'release', n, 'win-unpacked', 'PaperVNStudio.exe'))
        .filter(p => fs.existsSync(p))
      : [];
    if (candidates.length) return { exe: candidates[candidates.length - 1], args: [] };
    throw new Error('还没有打包好的纸间（release/win-unpacked 或 release/pkg*/win-unpacked）');
  }
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  return { exe: electron, args: [ROOT] };
}

function seedRecent(userData, projectDir, title) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    format: 'paper-recent', formatVersion: 1, savedAt: new Date().toISOString(),
    lastOpened: projectDir, items: [{ path: projectDir, title, openedAt: new Date().toISOString() }]
  }, null, 2), 'utf8');
}

async function openEditor(opts) {
  const { projectDir, title, workDir, exportDir, iconPath, conflict } = opts;
  const userData = fs.mkdtempSync(path.join(workDir, 'userdata-'));
  seedRecent(userData, projectDir, title);
  const port = await freePort();
  const cmd = editorCommand();
  const env = Object.assign({}, process.env, {
    PAPER_VN_TEST_EXPORT_DIR: exportDir || '',
    PAPER_VN_TEST_ICON: iconPath || '',
    PAPER_VN_TEST_CONFLICT: conflict || ''
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(cmd.exe, [...cmd.args,
    '--remote-debugging-port=' + port, '--remote-allow-origins=*',
    '--user-data-dir=' + userData], { cwd: path.dirname(cmd.exe), env, stdio: 'ignore' });
  const page = await waitPage(port, url => url.startsWith('paper://app/'), 30000);
  if (!page) { killTree(proc.pid); throw new Error('编辑器窗口没有启动'); }
  const cdp = await connect(page.webSocketDebuggerUrl);
  const deadline = Date.now() + 25000;
  let ready = null;
  while (Date.now() < deadline) {
    ready = await cdp.evaluate(`({host:typeof window.PaperHost==='object',
      title:(document.getElementById('title')||{}).value||'',
      nodes:document.querySelectorAll('#list .node').length,
      publishBtn:!!document.getElementById('publish')})`);
    if (ready.host && ready.nodes > 0) break;
    await sleep(300);
  }
  if (!ready || !ready.nodes) throw new Error('编辑器没有打开工程（' + JSON.stringify(ready) + '）');
  return { proc, cdp, userData };
}

async function closeEditor(editor) {
  if (!editor) return;
  try { await editor.cdp.evaluate('window.close()'); } catch { /* ignore */ }
  try { editor.cdp.close(); } catch { /* ignore */ }
  await sleep(600);
  killTree(editor.proc.pid);
  await sleep(400);
}

/* 在发行面板里按真实输入事件填表。 */
async function fillPublish(cdp, values) {
  await cdp.evaluate(`(()=>{const d=document.getElementById('publishDialog');if(!d.open)document.getElementById('publish').click()})()`);
  await sleep(400);
  await cdp.evaluate(`(()=>{const set=(id,v)=>{const el=document.getElementById(id);if(!el)return;
    el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
    set('pubName',${JSON.stringify(values.gameName)});
    set('pubAuthor',${JSON.stringify(values.author)});
    set('pubVersion',${JSON.stringify(values.version)});
    set('pubCopyright',${JSON.stringify(values.copyright)});
    set('pubW',String(${values.width}));
    set('pubH',String(${values.height}));
    const rs=document.getElementById('pubResizable');rs.checked=${values.resizable};rs.dispatchEvent(new Event('change',{bubbles:true}));
    const md=document.getElementById('pubMode');md.value=${JSON.stringify(values.mode)};md.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await sleep(600);
}

async function readPublishForm(cdp) {
  return cdp.evaluate(`(()=>({
    name:document.getElementById('pubName').value,
    author:document.getElementById('pubAuthor').value,
    version:document.getElementById('pubVersion').value,
    copyright:document.getElementById('pubCopyright').value,
    w:document.getElementById('pubW').value,
    h:document.getElementById('pubH').value,
    resizable:document.getElementById('pubResizable').checked,
    mode:document.getElementById('pubMode').value,
    releaseId:(document.getElementById('pubReleaseId')||{}).textContent||'',
    saveDir:(document.getElementById('pubSaveDir')||{}).textContent||'',
    hasIcon:document.getElementById('pubIconImg').parentElement.classList.contains('has-icon'),
    iconTitle:(document.getElementById('pubIconTitle')||{}).textContent||'',
    iconNote:(document.getElementById('pubIconNote')||{}).textContent||'',
    toolchain:(document.getElementById('pubToolchain')||{}).textContent||'',
    issues:[...document.querySelectorAll('#pubIssues li')].map(li=>li.textContent.trim()),
    exportDisabled:document.getElementById('pubStart').disabled,
    typeOptions:[...document.querySelectorAll('#pubType option')].map(o=>({v:o.value,disabled:o.disabled}))
  }))()`);
}

async function clickExport(cdp, type) {
  await cdp.evaluate(`(()=>{const s=document.getElementById('pubType');s.value=${JSON.stringify(type)};s.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('pubStart').click()})()`);
}

async function waitExportResult(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`(()=>{const r=document.getElementById('pubResult');
      return {text:r.textContent||'',cls:r.className,progress:(document.getElementById('pubProgressText')||{}).textContent||'',
        running:document.getElementById('pubCancel')&&!document.getElementById('pubCancel').disabled,
        stages:[...document.querySelectorAll('#pubStages li')].map(li=>li.textContent.trim())};})()`);
    if (!last.running && /导出完成|导出失败|已取消|已导出/.test(last.progress + ' ' + last.text)) return last;
    await sleep(500);
  }
  return last;
}

/* ---------- 游戏 EXE ---------- */

async function launchGame(exePath) {
  /* 首次启动 250MB 的 EXE 可能被杀毒软件拦住几十秒，也可能撞上端口占用：
   * 给 3 次机会、每次 60 秒，并把子进程的 stderr 留下来便于定位。 */
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = await freePort();
    const logFile = path.join(os.tmpdir(), 'pvn-game-launch-' + Date.now() + '.log');
    const out = fs.openSync(logFile, 'a');
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    env.PAPER_GAME_DEVTOOLS = '1';
    const proc = spawn(exePath, ['--remote-debugging-port=' + port, '--remote-allow-origins=*'],
      { cwd: path.dirname(exePath), env, stdio: ['ignore', out, out] });
    let exited = null;
    proc.on('exit', code => { exited = code; });
    const page = await waitPage(port, url => url.startsWith('papergame://game/'), 60000);
    try { fs.closeSync(out); } catch { /* ignore */ }
    if (page) {
      const cdp = await connect(page.webSocketDebuggerUrl);
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const ready = await cdp.evaluate(`({hook:typeof window.paperGameState==='function',ready:document.readyState})`);
        if (ready.hook) break;
        await sleep(200);
      }
      return { proc, cdp };
    }
    lastError = 'attempt ' + attempt + '：窗口未就绪' + (exited === null ? '' : '（进程退出码 ' + exited + '）')
      + (fs.existsSync(logFile) ? ' · ' + fs.readFileSync(logFile, 'utf8').trim().slice(-300) : '');
    killTree(proc.pid);
    /* 上一轮崩溃可能留下同一作品的实例，单实例锁会让新进程立刻退出：按镜像名清掉再试。 */
    spawnSync('taskkill', ['/IM', path.basename(exePath), '/T', '/F'], { stdio: 'ignore' });
    await sleep(1500);
  }
  throw new Error('游戏窗口没有启动：' + exePath + ' · ' + lastError);
}

async function closeGame(run) {
  if (!run) return;
  try { await run.cdp.evaluate('window.close()'); } catch { /* ignore */ }
  try { run.cdp.close(); } catch { /* ignore */ }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { process.kill(run.proc.pid, 0); await sleep(200); } catch { return; }
  }
  killTree(run.proc.pid);
}

const STATE = `(()=>{const st=window.paperGameState();
  return {state:st.state,i:st.i,trail:st.trail.length,who:document.getElementById('who').textContent,
   text:document.getElementById('text').textContent,hint:document.getElementById('hint').textContent,
   imgs:[...document.querySelectorAll('#layers img')].map(im=>({name:im.alt,ok:im.complete&&im.naturalWidth>0})),
   w:window.innerWidth,h:window.innerHeight,audio:st.audio,titleBg:st.titleBg};})()`;

async function gameTitle(cdp) {
  return cdp.evaluate(`(()=>{const img=document.getElementById('titleBgImg');
    return {title:document.getElementById('title').textContent,documentTitle:document.title,
      origin:location.origin,hasBg:document.getElementById('titleScreen').classList.contains('has-bg'),
      bgLoaded:!!img&&img.complete&&img.naturalWidth>0,w:window.innerWidth,h:window.innerHeight};})()`);
}

async function playTo(run, { stopAt = Infinity, chooseSecond = false } = {}) {
  const cdp = run.cdp;
  await cdp.evaluate(`document.getElementById('startGame').click()`);
  const seen = [];
  for (let guard = 0; guard < 200; guard++) {
    await sleep(160);
    const s = await cdp.evaluate(STATE);
    if (!seen.length || seen[seen.length - 1].i !== s.i) {
      seen.push({ i: s.i, text: s.text, who: s.who });
      if (s.i === stopAt) return { seen, at: s };
      if (s.i >= 200) break;
    }
    if (s.hint === '故事结束') return { seen, at: s };
    const choice = await cdp.evaluate(`(()=>{const b=document.querySelectorAll('#choices button');
      if(!b.length)return null;return b.length;})()`);
    if (choice) {
      await cdp.evaluate(`document.querySelectorAll('#choices button')[${chooseSecond ? 1 : 0}].click()`);
      await sleep(300);
      continue;
    }
    await cdp.evaluate(`document.getElementById('scene').click()`);
  }
  return { seen, at: await cdp.evaluate(STATE) };
}

async function saveAt(run, saveKey) {
  await run.cdp.evaluate(`document.getElementById('menuBtn').click()`);
  await sleep(250);
  await run.cdp.evaluate(`document.getElementById('save').click()`);
  await sleep(300);
  const raw = await run.cdp.evaluate(`localStorage.getItem(${JSON.stringify(saveKey)})`);
  const before = await run.cdp.evaluate(STATE);
  await run.cdp.evaluate(`document.getElementById('menuResume').click()`);
  await sleep(200);
  if (!raw) throw new Error('保存后没有存档数据');
  return { save: JSON.parse(raw), index: before.i, text: before.text };
}

async function resume(run) {
  const disabled = await run.cdp.evaluate(`document.getElementById('continueGame').disabled`);
  if (disabled) return null;
  await run.cdp.evaluate(`document.getElementById('continueGame').click()`);
  await sleep(500);
  return run.cdp.evaluate(STATE);
}


/* 读 PE 资源表里的 RT_GROUP_ICON，确认 EXE 里真的是我们生成的 9 档图标。 */
function peIconSizes(exe) {
  const b = fs.readFileSync(exe);
  const u16 = o => b.readUInt16LE(o);
  const u32 = o => b.readUInt32LE(o);
  const peOff = u32(0x3c);
  if (u32(peOff) !== 0x00004550) return [];
  const numSections = u16(peOff + 6);
  const optSize = u16(peOff + 20);
  const opt = peOff + 24;
  const magic = u16(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const resRva = u32(dirs + 2 * 8);
  const secTable = opt + optSize;
  let resOff = -1;
  let resSize = 0;
  for (let i = 0; i < numSections; i++) {
    const s = secTable + i * 40;
    const va = u32(s + 12);
    const rawSize = u32(s + 16);
    const rawPtr = u32(s + 20);
    if (resRva >= va && resRva < va + Math.max(rawSize, 1)) { resOff = rawPtr + (resRva - va); resSize = rawSize; }
  }
  if (resOff < 0) return [];
  const entries = off => {
    const named = u16(off + 12);
    const ids = u16(off + 14);
    const out = [];
    for (let i = 0; i < named + ids; i++) {
      const e = off + 16 + i * 8;
      out.push({ id: u32(e), offset: u32(e + 4) });
    }
    return out;
  };
  const root = entries(resOff);
  const type = root.find(t => !(t.id & 0x80000000) && t.id === 14);
  if (!type) return [];
  const names = entries(resOff + (type.offset & 0x7fffffff));
  const langs = names.length ? entries(resOff + (names[0].offset & 0x7fffffff)) : [];
  if (!langs.length) return [];
  const dataEntry = resOff + (langs[0].offset & 0x7fffffff);
  const rva = u32(dataEntry);
  let dataOff = -1;
  for (let i = 0; i < numSections; i++) {
    const s = secTable + i * 40;
    const va = u32(s + 12);
    const rawSize = u32(s + 16);
    const rawPtr = u32(s + 20);
    if (rva >= va && rva < va + Math.max(rawSize, 1)) dataOff = rawPtr + (rva - va);
  }
  if (dataOff < 0) return [];
  const count = u16(dataOff + 4);
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(b.readUInt8(dataOff + 6 + i * 14) || 256);
  return sizes;
}

function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const r = spawnSync(TAR, ['-xf', zip, '-C', dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('解压失败：' + (r.stderr || r.status));
  const dirs = fs.readdirSync(dest, { withFileTypes: true }).filter(d => d.isDirectory());
  if (!dirs.length) throw new Error('解压后没有目录');
  return path.join(dest, dirs[0].name);
}

function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* leveldb 文件可能还被刚退出的进程短暂占用：读不到就跳过，不让它中断验收。 */
function readLoose(file) {
  for (let i = 0; i < 5; i++) {
    try { return fs.readFileSync(file); } catch (e) {
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') return Buffer.alloc(0);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  return Buffer.alloc(0);
}

function gameSaveText() {
  const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PaperVNStudio-Game-');
  const out = {};
  for (const name of fs.readdirSync(path.dirname(dir))) {
    if (!name.startsWith('PaperVNStudio-Game-')) continue;
    const store = path.join(path.dirname(dir), name, 'Local Storage', 'leveldb');
    let text = '';
    if (fs.existsSync(store)) {
      for (const f of fs.readdirSync(store)) {
        const abs = path.join(store, f);
        if (fs.statSync(abs).isFile()) text += readLoose(abs).toString('latin1');
      }
    }
    out[name.replace('PaperVNStudio-Game-', '')] = text.length;
  }
  return out;
}

/* ---------- 主流程 ---------- */

async function main() {
  const work = path.join(os.tmpdir(), '纸间 通用导出 验收', stamp());
  fs.mkdirSync(work, { recursive: true });
  const shots = path.join(ROOT, 'docs', 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  report.work = work;

  console.log('验收模式：' + report.mode + ' · 工作目录 ' + work);
  const store = require(path.join(ROOT, 'desktop', 'project-store.cjs'))();
  const core = require(path.join(ROOT, 'dist', 'core.js'))();

  /* --- 准备工程 --- */
  const A = fixtures.buildProjectA(work, { stamp: stamp().replace(/[^0-9]/g, '').slice(0, 10) });
  const Bfix = fixtures.buildProjectB(work, { stamp: 'fixture' });
  const createdB = store.createProject(Bfix.dir, Bfix.project);
  const B = { dir: createdB.root, id: Bfix.id, releaseId: Bfix.releaseId, title: Bfix.title,
    author: Bfix.author, version: Bfix.version, iconPng: Bfix.iconPng };
  ok('测试工程', { summary: 'A ' + A.nodes + ' 节点（晚风原作） · B ' + Bfix.nodes + ' 节点（分支+音频+自定义图标）' });

  const outA = path.join(work, '导出 A');
  const outB = path.join(work, '导出 B');
  const outPortable = path.join(work, '导出 便携版');
  for (const d of [outA, outB, outPortable]) fs.mkdirSync(d, { recursive: true });
  const iconPathA = path.join(work, 'A-icon.png');
  fs.writeFileSync(iconPathA, B.iconPng);

  /* --- 工程 A：图形界面导出 ZIP --- */
  let editor = null;
  try {
    editor = await openEditor({ projectDir: A.dir, title: A.title, workDir: work, exportDir: outA, iconPath: iconPathA });
    await editor.cdp.evaluate(`document.getElementById('publish').click()`);
    await sleep(600);
    let before = await readPublishForm(editor.cdp);
    for (let i = 0; i < 40 && /检查中/.test(before.toolchain); i++) {
      await sleep(250);
      before = await readPublishForm(editor.cdp);
    }
    const toolchainOk = /rcedit 就绪/.test(before.toolchain) && /NSIS 就绪/.test(before.toolchain);
    report.toolchainText = before.toolchain;
    await editor.cdp.screenshot(path.join(shots, 'v072-publish-settings.png'));
    await fillPublish(editor.cdp, {
      gameName: '晚风经过二楼走廊', author: '黄嘉文', version: '1.0.0',
      copyright: 'Copyright © 2026 黄嘉文', width: 1180, height: 760, resizable: true, mode: 'window'
    });
    /* 图标：导入 → 预览 → 恢复默认（A 最终使用默认图标，覆盖回退路径） */
    await editor.cdp.evaluate(`document.getElementById('pubIconPick').click()`);
    for (let i = 0; i < 40; i++) {
      const s = await readPublishForm(editor.cdp);
      if (s.hasIcon) break;
      await sleep(250);
    }
    const afterIcon = await readPublishForm(editor.cdp);
    await editor.cdp.screenshot(path.join(shots, 'v072-icon-import.png'));
    await editor.cdp.evaluate(`document.getElementById('pubIconReset').click()`);
    await sleep(400);
    const afterReset = await readPublishForm(editor.cdp);
    const iconProblems = [];
    if (!afterIcon.hasIcon) iconProblems.push('导入后没有图标预览');
    if (!/已导入/.test(afterIcon.iconNote)) iconProblems.push('预览说明没有更新：' + afterIcon.iconNote);
    if (afterReset.hasIcon) iconProblems.push('恢复默认后仍显示自定义图标');
    if (iconProblems.length) bad('图标导入 / 恢复默认', iconProblems.join('；'));
    else ok('图标导入 / 恢复默认', { summary: '导入后预览生效，恢复默认回到纸间图标' });

    /* 撤销：连续输入会按 900ms 合并成一次快照，所以两次修改之间要留出间隔。 */
    const typeName = v => editor.cdp.evaluate(`(()=>{const el=document.getElementById('pubName');el.value=${JSON.stringify(v)};el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await typeName('撤销 甲');
    await sleep(1200);
    await typeName('撤销 乙');
    await sleep(400);
    await editor.cdp.evaluate(`document.getElementById('undo').click()`);
    await sleep(600);
    /* 输入框有焦点时 render 不会覆盖用户正在输入的内容：先失焦再读，读到的才是工程里的值。 */
    await editor.cdp.evaluate(`document.activeElement.blur()`);
    await sleep(300);
    const afterUndo = await editor.cdp.evaluate(`document.getElementById('pubName').value`);
    if (afterUndo !== '撤销 甲') bad('撤销发行设置', '撤销后名称是「' + afterUndo + '」（期望「撤销 甲」）');
    else ok('撤销发行设置', { summary: '连续两次改名后撤销，回到上一版「撤销 甲」' });
    await fillPublish(editor.cdp, {
      gameName: '晚风经过二楼走廊', author: '黄嘉文', version: '1.0.0',
      copyright: 'Copyright © 2026 黄嘉文', width: 1180, height: 760, resizable: true, mode: 'window'
    });

    const form = await readPublishForm(editor.cdp);
    if (form.name !== '晚风经过二楼走廊' || form.author !== '黄嘉文' || form.version !== '1.0.0') {
      bad('发行设置表单', '表单没有回写工程：' + JSON.stringify({ n: form.name, a: form.author, v: form.version }));
    } else if (form.releaseId !== A.releaseId || !form.saveDir.includes(A.releaseId)) {
      bad('发行设置表单', '发行标识/存档目录不对：' + form.releaseId + ' · ' + form.saveDir);
    } else if (!toolchainOk) {
      bad('构建组件', '组件未就绪：' + before.toolchain.replace(/\n/g, ' '));
    } else {
      ok('发行设置表单', { summary: '名称/作者/版本/窗口回写工程，发行标识 ' + form.releaseId });
    }
    if (form.exportDisabled) bad('导出前检查', '工程检查未通过：' + form.issues.join('；'));

    await clickExport(editor.cdp, 'zip');
    await sleep(1200);
    await editor.cdp.screenshot(path.join(shots, 'v072-export-progress.png'));
    const result = await waitExportResult(editor.cdp, 10 * 60 * 1000);
    await editor.cdp.screenshot(path.join(shots, 'v072-export-result.png'));
    if (!/导出完成/.test(result.progress)) {
      bad('A · 图形界面导出 ZIP', result.progress + ' / ' + result.text, result);
    } else {
      ok('A · 图形界面导出 ZIP', { summary: result.progress, stages: result.stages });
    }
  } finally {
    await closeEditor(editor);
  }

  /* --- 校验 A 的产物 --- */
  const zipA = path.join(outA, fs.readdirSync(outA).find(f => f.endsWith('.zip')) || '');
  if (!fs.existsSync(zipA)) {
    throw new Error('A 没有产出 ZIP：' + outA + '（' + fs.readdirSync(outA).join(',') + '）');
  }
  const manifestA = readManifest(zipA.replace(/\.zip$/, '.manifest.json'));
  const entries = listZipEntries(zipA).map(e => e.name);
  const leak = entries.filter(n => /(^|\/)(dist|desktop|scripts|tests|docs)\//.test(n) || /app\.asar/.test(n) || /project\.paper\.json$/.test(n));
  if (leak.length) bad('A · ZIP 内容', '混入了不该有的文件：' + leak.slice(0, 5).join(', '));
  if (manifestA.game.title !== '晚风经过二楼走廊') bad('A · 清单', '标题未写入清单：' + manifestA.game.title);
  if (manifestA.signature && manifestA.signature.signed) bad('A · 清单', '没有证书却标记为已签名');
  ok('A · ZIP 内容与清单', { summary: entries.length + ' 条目 · ' + mb(manifestA.artifact.bytes) + ' · 未签名（如实记录）' });

  const extractA = path.join(work, '解压 A 带 空格');
  const dirA = extractZip(zipA, extractA);
  const exeA = path.join(dirA, manifestA.entry.exe);
  /* 版本资源是 UTF-16LE：直接查字节，不依赖外部命令。 */
  const exeBuf = fs.readFileSync(exeA);
  const utf16 = v => Buffer.from(v, 'utf16le');
  const verFields = ['晚风经过二楼走廊', '黄嘉文', '1.0.0', 'Copyright © 2026 黄嘉文']
    .filter(v => exeBuf.includes(utf16(v)));
  /* 版本要分两处看：清单里的作者原值，和 PE 资源里实际写入的四段数字。 */
  const peA = readPeVersion(exeA);
  const verProblems = [];
  if (verFields.length !== 4) verProblems.push('缺少版本字段：' + verFields.join(' / '));
  if (manifestA.game.version !== '1.0.0') verProblems.push('清单里的作者版本不对：' + manifestA.game.version);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(manifestA.exeVersion))) verProblems.push('exeVersion 不是四段数字：' + manifestA.exeVersion);
  if (!peA || peA.fileVersion !== manifestA.exeVersion) verProblems.push('EXE FileVersion 与 exeVersion 不一致：' + (peA && peA.fileVersion));
  if (!peA || peA.productVersion !== manifestA.exeVersion) verProblems.push('EXE ProductVersion 与 exeVersion 不一致：' + (peA && peA.productVersion));
  if (verProblems.length) bad('A · EXE 版本信息', verProblems.join('；'), { manifest: manifestA, pe: peA });
  else ok('A · EXE 版本信息', { summary: '产品名/公司/版权写入资源，清单 ' + manifestA.game.version + ' → EXE ' + peA.fileVersion });

  /* --- 玩 A：标题、窗口、通关、存档 --- */
  const portA = await freePort();
  let gameA = await launchGame(exeA);
  const titleA = await gameTitle(gameA.cdp);
  const winProblems = [];
  if (titleA.title !== '晚风经过二楼走廊') winProblems.push('标题不对：' + titleA.title);
  if (!titleA.hasBg || !titleA.bgLoaded) winProblems.push('标题背景没有加载');
  if (Math.abs(titleA.w - 1180) > 60 || Math.abs(titleA.h - 760) > 80) winProblems.push('窗口尺寸不是 1180×760：' + titleA.w + '×' + titleA.h);
  if (titleA.origin !== 'papergame://game') winProblems.push('页面来源不是 papergame://game：' + titleA.origin);
  const net = await gameA.cdp.evaluate(`Promise.race([
    fetch('https://example.com/').then(()=>'reachable').catch(()=>'blocked'),
    new Promise(r=>setTimeout(()=>r('timeout'),4000))])`);
  if (net !== 'blocked') winProblems.push('网络没有被拦截：' + net);
  if (winProblems.length) bad('A · 启动与窗口', winProblems.join('；'), titleA);
  else ok('A · 启动与窗口', { summary: titleA.w + '×' + titleA.h + ' · 标题与背景正确 · 来源 ' + titleA.origin + ' · 断网可玩' });

  const playA = await playTo(gameA);
  const savedA = await saveAt(gameA, 'paper-game-' + A.id);
  await closeGame(gameA);
  const relaunchA = await launchGame(exeA);
  const resumedA = await resume(relaunchA);
  if (!resumedA || resumedA.i !== savedA.index) {
    bad('A · 存读档', '重启后没有回到第 ' + (savedA.index + 1) + ' 句');
  } else {
    ok('A · 存读档', { summary: '通关 ' + playA.seen.length + ' 句 · 存档后重启回到「' + resumedA.text.slice(0, 12) + '」' });
  }
  await closeGame(relaunchA);
  report.stages['A 游玩'] = { nodes: playA.seen.length, saved: savedA.save, resumed: resumedA && { i: resumedA.i, text: resumedA.text } };

  /* --- 版本后缀专项：作者填 0.7.2-test，EXE 属性必须是 0.7.2.0 ---
   * 纯数字的 1.0.0 走不出这个缺陷（旧实现也能得到 1.0.0.0），必须用带后缀的版本
   * 端到端跑一次，否则回归保护是假的。 */
  {
    const outSuffix = path.join(work, '版本后缀');
    fs.mkdirSync(outSuffix, { recursive: true });
    let suffixEditor = null;
    try {
      suffixEditor = await openEditor({ projectDir: A.dir, title: A.title, workDir: work, exportDir: outSuffix });
      await suffixEditor.cdp.evaluate(`document.getElementById('publish').click()`);
      await sleep(500);
      await suffixEditor.cdp.evaluate(`(() => { const el = document.getElementById('pubVersion');
        el.value = '0.7.2-test'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(500);
      await clickExport(suffixEditor.cdp, 'zip');
      const suffixResult = await waitExportResult(suffixEditor.cdp, 10 * 60 * 1000);
      if (!/导出完成/.test(suffixResult.progress)) {
        bad('版本后缀', '导出失败：' + suffixResult.progress);
      } else {
        const suffixZip = path.join(outSuffix,
          fs.readdirSync(outSuffix).find(f => /0\.7\.2-test.*\.zip$/.test(f)) || '');
        const suffixManifest = readManifest(suffixZip.replace(/\.zip$/, '.manifest.json'));
        const suffixDir = extractZip(suffixZip, path.join(work, '解压 版本后缀'));
        const suffixPe = readPeVersion(path.join(suffixDir, suffixManifest.entry.exe));
        const suffixProblems = [];
        if (suffixManifest.game.version !== '0.7.2-test') {
          suffixProblems.push('清单里的作者原值被改：' + suffixManifest.game.version);
        }
        if (suffixManifest.exeVersion !== '0.7.2.0') {
          suffixProblems.push('exeVersion 应为 0.7.2.0，实际 ' + suffixManifest.exeVersion);
        }
        if (!suffixPe || suffixPe.fileVersion !== '0.7.2.0') {
          suffixProblems.push('EXE FileVersion 应为 0.7.2.0，实际 ' + (suffixPe && suffixPe.fileVersion));
        }
        if (!suffixPe || suffixPe.productVersion !== suffixManifest.exeVersion) {
          suffixProblems.push('EXE ProductVersion 与 exeVersion 不一致：' + (suffixPe && suffixPe.productVersion));
        }
        if (!/0\.7\.2-test/.test(path.basename(suffixZip))) {
          suffixProblems.push('文件名应保留作者原值：' + path.basename(suffixZip));
        }
        if (suffixProblems.length) bad('版本后缀', suffixProblems.join('；'), { manifest: suffixManifest, pe: suffixPe });
        else {
          ok('版本后缀', {
            summary: '0.7.2-test → 清单原值 / EXE ' + suffixPe.fileVersion + ' / 文件名保留后缀',
            manifest: suffixManifest.game.version, exeVersion: suffixManifest.exeVersion, pe: suffixPe
          });
        }
      }
    } finally {
      if (suffixEditor) await closeEditor(suffixEditor);
    }
  }

  /* --- 工程 B：分支 + 音频 + 自定义图标 --- */
  editor = null;
  try {
    editor = await openEditor({ projectDir: B.dir, title: B.title, workDir: work, exportDir: outB });
    await editor.cdp.evaluate(`document.getElementById('publish').click()`);
    await sleep(600);
    let formB = await readPublishForm(editor.cdp);
    for (let i = 0; i < 40 && /检查中/.test(formB.toolchain); i++) {
      await sleep(250);
      formB = await readPublishForm(editor.cdp);
    }
    await editor.cdp.screenshot(path.join(shots, 'v072-publish-b.png'));
    const bProblems = [];
    if (formB.name !== '雨停之前') bProblems.push('游戏名称：' + formB.name);
    if (formB.author !== '雨中测试组' && formB.author !== '纸间测试组') bProblems.push('作者：' + formB.author);
    if (formB.version !== '2.3.1') bProblems.push('版本：' + formB.version);
    if (String(formB.w) !== '1024' || String(formB.h) !== '640') bProblems.push('窗口：' + formB.w + '×' + formB.h);
    if (formB.resizable) bProblems.push('允许缩放：' + formB.resizable);
    if (!formB.hasIcon) bProblems.push('图标没有出现在表单里');
    if (bProblems.length) bad('B · 发行设置回读', bProblems.join('；'), formB);
    else ok('B · 发行设置回读', { summary: '名称/作者/版本/窗口/图标都来自工程' });

    await clickExport(editor.cdp, 'zip');
    const resultB = await waitExportResult(editor.cdp, 10 * 60 * 1000);
    if (!/导出完成/.test(resultB.progress)) bad('B · 图形界面导出 ZIP', resultB.progress + ' / ' + resultB.text);
    else ok('B · 图形界面导出 ZIP', { summary: resultB.progress });
  } finally {
    await closeEditor(editor);
  }

  const zipB = path.join(outB, fs.readdirSync(outB).find(f => f.endsWith('.zip')) || '');
  const manifestB = readManifest(zipB.replace(/\.zip$/, '.manifest.json'));
  if (manifestB.game.title !== '雨停之前' || manifestB.game.author !== '纸间测试组' || manifestB.game.version !== '2.3.1'
    || manifestB.exeVersion !== '2.3.1.0') {
    bad('B · 清单', '标题/作者/版本不对：' + JSON.stringify(manifestB.game));
  } else if (!manifestB.game.window || manifestB.game.window.resizable !== false || manifestB.game.window.width !== 1024) {
    bad('B · 窗口配置', '清单窗口配置不对：' + JSON.stringify(manifestB.game.window));
  } else if (!manifestB.icon || manifestB.icon.source !== 'custom') {
    bad('B · 图标', '清单没有记录自定义图标：' + JSON.stringify(manifestB.icon));
  } else if (manifestB.icon.bytes === manifestA.icon.bytes) {
    bad('B · 图标', '自定义图标与默认图标字节数相同，可能没有生效');
  } else {
    ok('B · 清单与图标', { summary: '自定义图标 ' + manifestB.icon.bytes + ' B · 版本 ' + manifestB.game.version });
  }

  const entriesB = listZipEntries(zipB).map(e => e.name);
  const leakB = entriesB.filter(n => /(^|\/)(dist|desktop|scripts|tests|docs)\//.test(n) || /app\.asar/.test(n) || /project\.paper\.json$/.test(n));
  if (leakB.length) bad('B · ZIP 内容', '混入了不该有的文件：' + leakB.slice(0, 5).join(', '));
  else ok('B · ZIP 内容', { summary: entriesB.length + ' 条目，只有播放器与游戏资源' });

  const dirB = extractZip(zipB, path.join(work, '解压 B'));
  const exeB = path.join(dirB, manifestB.entry.exe);
  let gameB = await launchGame(exeB);
  const titleB = await gameTitle(gameB.cdp);
  const bWin = [];
  if (titleB.title !== '雨停之前') bWin.push('标题：' + titleB.title);
  if (Math.abs(titleB.w - 1024) > 60) bWin.push('宽度：' + titleB.w);
  if (bWin.length) bad('B · 启动', bWin.join('；'));
  else ok('B · 启动', { summary: titleB.w + '×' + titleB.h + ' · 标题正确' });

  /* 走第二条分支，检查音频与分支汇合 */
  await gameB.cdp.evaluate(`document.getElementById('startGame').click()`);
  let sawChoice = false, audioOk = null, branchText = '', audioTries = 0;
  for (let guard = 0; guard < 40; guard++) {
    await sleep(200);
    const s = await gameB.cdp.evaluate(STATE);
    if (s.audio && s.audio.bgm && s.audio.bgm.playing) audioOk = s.audio;
    else if (s.audio && audioOk === null && audioTries < 3) {
      /* 自动播放可能被拒：像玩家一样点一次「启用声音」再等。 */
      audioTries += 1;
      await gameB.cdp.evaluate(`(()=>{const b=document.getElementById('menuBtn');b.click();
        const e=document.getElementById('enableSound');if(e)e.click();})()`).catch(() => {});
      await sleep(600);
      await gameB.cdp.evaluate(`document.getElementById('menuResume').click()`).catch(() => {});
    }
    if (s.hint === '故事结束') break;
    const buttons = await gameB.cdp.evaluate(`document.querySelectorAll('#choices button').length`);
    if (buttons) {
      sawChoice = true;
      await gameB.cdp.evaluate(`document.querySelectorAll('#choices button')[1].click()`);
      await sleep(400);
      branchText = (await gameB.cdp.evaluate(STATE)).text;
      continue;
    }
    await gameB.cdp.evaluate(`document.getElementById('scene').click()`);
  }
  const audioStatus = audioOk && audioOk.bgm ? audioOk.bgm : null;
  if (!sawChoice) bad('B · 分支', '没有遇到选择节点');
  else if (!/再站一会儿|站一会儿/.test(branchText)) bad('B · 分支', '第二个选项没有进入对应分支：' + branchText.slice(0, 20));
  else ok('B · 分支', { summary: '选择第二项进入「' + branchText.slice(0, 14) + '…」' });
  if (!audioStatus || !audioStatus.playing) bad('B · 音频', 'BGM 没有播放：' + JSON.stringify(audioStatus));
  else ok('B · 音频', { summary: 'BGM ' + (audioStatus.audioId || '') + ' 正在播放' });

  const icoA = peIconSizes(exeA);
  const icoB = peIconSizes(exeB);
  if (icoA.length !== 9 || icoB.length !== 9) {
    bad('EXE 图标资源', '图标组不是 9 档：A ' + icoA.join('/') + ' · B ' + icoB.join('/'));
  } else {
    ok('EXE 图标资源', { summary: 'A/B 都是 9 档（16–256），默认图标与自定义图标分别生效' });
  }

  const savedB = await saveAt(gameB, 'paper-game-' + B.id);
  await closeGame(gameB);

  /* --- 存档隔离：A 与 B 各读各的 --- */
  await sleep(800);
  const dirs = gameSaveText();
  const savedDirs = Object.keys(dirs);
  if (!savedDirs.includes(A.releaseId) || !savedDirs.includes(B.releaseId)) {
    bad('存档隔离', '两个作品的存档目录没有同时出现：' + savedDirs.join(', '));
  } else {
    const gameA2 = await launchGame(exeA);
    const rA = await resume(gameA2);
    await closeGame(gameA2);
    const gameB2 = await launchGame(exeB);
    const rB = await resume(gameB2);
    await closeGame(gameB2);
    if (!rA || rA.i !== savedA.index) bad('存档隔离', 'A 读档被影响：' + (rA && rA.i));
    else if (!rB || rB.i !== savedB.index) bad('存档隔离', 'B 读档被影响：' + (rB && rB.i));
    else ok('存档隔离', { summary: 'A 回第 ' + (rA.i + 1) + ' 句、B 回第 ' + (rB.i + 1) + ' 句，互不影响' });
  }

  /* --- 重新导出同一作品：覆盖提示 + 旧存档仍可用 --- */
  const zipABefore = sha256(fs.readFileSync(zipA));
  editor = null;
  try {
    editor = await openEditor({ projectDir: A.dir, title: A.title, workDir: work, exportDir: outA, conflict: 'overwrite' });
    await fillPublish(editor.cdp, {
      gameName: '晚风经过二楼走廊', author: '黄嘉文', version: '1.0.0',
      copyright: 'Copyright © 2026 黄嘉文', width: 1180, height: 760, resizable: true, mode: 'window'
    });
    await clickExport(editor.cdp, 'zip');
    const r = await waitExportResult(editor.cdp, 10 * 60 * 1000);
    if (!/导出完成/.test(r.progress)) bad('重新导出（覆盖）', r.progress + ' / ' + r.text);
    else if (sha256(fs.readFileSync(zipA)) === zipABefore) bad('重新导出（覆盖）', '文件没有更新');
    else ok('重新导出（覆盖）', { summary: '覆盖成功，旧存档仍指向同一发行标识' });
  } finally {
    await closeEditor(editor);
  }
  const gameA3 = await launchGame(exeA);
  const rA3 = await resume(gameA3);
  await closeGame(gameA3);
  if (!rA3 || rA3.i !== savedA.index) bad('重新导出后读档', '旧存档失效');
  else ok('重新导出后读档', { summary: '仍回到第 ' + (rA3.i + 1) + ' 句' });

  /* --- 冲突取消：不覆盖 --- */
  const zipAHash = sha256(fs.readFileSync(zipA));
  editor = null;
  try {
    editor = await openEditor({ projectDir: A.dir, title: A.title, workDir: work, exportDir: outA, conflict: 'cancel' });
    await fillPublish(editor.cdp, {
      gameName: '晚风经过二楼走廊', author: '黄嘉文', version: '1.0.0',
      copyright: 'Copyright © 2026 黄嘉文', width: 1180, height: 760, resizable: true, mode: 'window'
    });
    await clickExport(editor.cdp, 'zip');
    const r = await waitExportResult(editor.cdp, 60000);
    if (!/已取消/.test(r.progress + r.text)) bad('目标冲突 · 取消', '没有报告取消：' + r.progress + ' / ' + r.text);
    else if (sha256(fs.readFileSync(zipA)) !== zipAHash) bad('目标冲突 · 取消', '取消后文件仍被改动');
    else ok('目标冲突 · 取消', { summary: '选择取消后原文件未改动' });
  } finally {
    await closeEditor(editor);
  }

  /* --- 构建中途取消 --- */
  const outCancel = path.join(work, '导出 取消');
  fs.mkdirSync(outCancel, { recursive: true });
  editor = null;
  try {
    editor = await openEditor({ projectDir: A.dir, title: A.title, workDir: work, exportDir: outCancel });
    await fillPublish(editor.cdp, {
      gameName: '晚风经过二楼走廊', author: '黄嘉文', version: '1.0.0',
      copyright: 'Copyright © 2026 黄嘉文', width: 1180, height: 760, resizable: true, mode: 'window'
    });
    await clickExport(editor.cdp, 'zip');
    /* 构建在本机只需几秒：立刻点取消，界面会持续重试直到主进程真正收到。 */
    await sleep(300);
    const beforeCancel = await editor.cdp.evaluate(`({disabled:document.getElementById('pubCancel').disabled,
      progress:document.getElementById('pubProgressText').textContent})`);
    await editor.cdp.evaluate(`document.getElementById('pubCancel').click()`);
    const r = await waitExportResult(editor.cdp, 120000);
    const leftovers = fs.readdirSync(outCancel).filter(f => /\.zip$/.test(f));
    if (!/已取消/.test(r.progress + r.text)) bad('构建中途取消', '没有按取消结束：' + r.progress + ' / ' + r.text
      + ' · 点击时 ' + JSON.stringify(beforeCancel));
    else if (leftovers.length) bad('构建中途取消', '取消后仍留下产物：' + leftovers.join(','));
    else ok('构建中途取消', { summary: '取消后没有留下 ZIP' });
  } finally {
    await closeEditor(editor);
  }

  /* --- 构建失败：目标目录不可用 --- */
  const brokenDir = path.join(work, '不是目录.txt');
  fs.writeFileSync(brokenDir, 'x');
  editor = null;
  try {
    editor = await openEditor({ projectDir: A.dir, title: A.title, workDir: work, exportDir: brokenDir });
    await fillPublish(editor.cdp, {
      gameName: '晚风经过二楼走廊', author: '黄嘉文', version: '1.0.0',
      copyright: 'Copyright © 2026 黄嘉文', width: 1180, height: 760, resizable: true, mode: 'window'
    });
    await clickExport(editor.cdp, 'zip');
    const r = await waitExportResult(editor.cdp, 120000);
    if (!/导出失败/.test(r.text + r.progress)) bad('构建失败提示', '没有显示失败原因：' + r.text + r.progress);
    else if (sha256(fs.readFileSync(zipA)) !== zipAHash) bad('构建失败提示', '失败时改动了旧产物');
    else ok('构建失败提示', { summary: r.text.slice(0, 60) });
  } finally {
    await closeEditor(editor);
  }

  /* --- 单文件便携版（A） --- */
  if (skipPortable) {
    report.unverified.push('单文件便携版：本次用 --skip-portable 跳过');
  } else {
    editor = null;
    try {
      editor = await openEditor({ projectDir: A.dir, title: A.title, workDir: work, exportDir: outPortable });
      await fillPublish(editor.cdp, {
        gameName: '晚风经过二楼走廊', author: '黄嘉文', version: '1.0.0',
        copyright: 'Copyright © 2026 黄嘉文', width: 1180, height: 760, resizable: true, mode: 'window'
      });
      await clickExport(editor.cdp, 'portable');
      const r = await waitExportResult(editor.cdp, 20 * 60 * 1000);
      if (!/导出完成/.test(r.progress)) bad('A · 单文件便携版导出', r.progress + ' / ' + r.text);
      else ok('A · 单文件便携版导出', { summary: r.progress });
    } finally {
      await closeEditor(editor);
    }
    const portableFile = fs.readdirSync(outPortable).find(f => f.endsWith('.exe'));
    if (!portableFile) bad('A · 单文件便携版运行', '没有产出 EXE');
    else {
      const portable = path.join(outPortable, portableFile);
      const manifestP = readManifest(portable.replace(/\.exe$/, '.manifest.json'));
      const runP = await launchGame(portable);
      const resumedP = await resume(runP);
      const titleP = await gameTitle(runP.cdp);
      await closeGame(runP);
      if (!resumedP || resumedP.i !== savedA.index) bad('A · 单文件便携版运行', '没有读到 ZIP 版的存档');
      else if (titleP.title !== '晚风经过二楼走廊') bad('A · 单文件便携版运行', '标题不对：' + titleP.title);
      else ok('A · 单文件便携版运行', { summary: mb(manifestP.artifact.bytes) + ' · 与 ZIP 共用存档，回到第 ' + (resumedP.i + 1) + ' 句' });
    }
  }

  report.ok = report.problems.length === 0;
  report.finishedAt = new Date().toISOString();
  report.unverified.push('第二台 Windows 电脑（未装纸间与开发环境）：本机无法验证');
  report.unverified.push('原生保存对话框（HTML 导出 / 选择目录）：自动化用测试钩子替代，已在文档说明');
  const reportPath = path.join(ROOT, 'release', 'game-export-acceptance-' + report.mode + '.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('');
  console.log(report.ok ? 'GAME EXPORT ACCEPTANCE PASS (' + report.mode + ')' : 'GAME EXPORT ACCEPTANCE FAIL (' + report.mode + ')');
  console.log('  报告 ' + reportPath);
  if (report.problems.length) for (const p of report.problems) console.log('  - ' + p);
  console.log('  截图 ' + shots);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch(e => {
  console.error('ACCEPTANCE ERROR ' + (e.stack || e.message));
  report.problems.push('异常终止：' + e.message);
  try {
    const p = path.join(ROOT, 'release', 'game-export-acceptance-' + report.mode + '.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
  process.exitCode = 1;
});
