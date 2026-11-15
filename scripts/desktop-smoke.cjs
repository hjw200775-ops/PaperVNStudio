'use strict';
/*
 * Real Electron smoke test (hidden window): loads the packaged-style paper://
 * page with the real preload, runs editor interactions, and checks that the
 * autosave / save IPC chain actually writes a valid project to disk.
 * Run with: npm run desktop:smoke
 */
const { app, BrowserWindow, protocol, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const createStore = require('../desktop/project-store.cjs');
const { assertSelfContained } = require('../dist/export.js');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const APP_URL = 'paper://app/index.html';
const CSP = "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const ALLOWED = {
  '/index.html': 'text/html; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8',
  '/core.js': 'text/javascript; charset=utf-8',
  '/effects.js': 'text/javascript; charset=utf-8',
  '/player.js': 'text/javascript; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/export.js': 'text/javascript; charset=utf-8',
  '/desktop-bridge.js': 'text/javascript; charset=utf-8'
};

protocol.registerSchemesAsPrivileged([{
  scheme: 'paper',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false }
}]);
app.enableSandbox();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-desktop-smoke-'));
const store = createStore();
const MAIN = path.join(tmp, 'project.paper.json');
const DRAFT = path.join(tmp, 'backups/autosave/project.paper.json');
const ok = extra => ({ ok: true, ...extra });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function registerIPC() {
  ipcMain.handle('project:bootstrap', () => ok({ project: null, currentDir: null, label: '', dirty: false, lastError: '', recent: [], notice: '' }));
  ipcMain.handle('project:autoSave', (_e, p) => ok({ savedAt: store.autoSave(tmp, p).disk.savedAt }));
  ipcMain.handle('project:save', (_e, p) => { store.saveProject(tmp, p); return ok({ label: '烟测工程', currentDir: tmp, dirty: false, lastError: '', recent: [], cancelled: false, saved: true }); });
  ipcMain.handle('project:saveAs', () => ok({ cancelled: true }));
  ipcMain.handle('project:new', () => ok({ cancelled: true }));
  ipcMain.handle('project:open', () => ok({ cancelled: true }));
  ipcMain.handle('project:openRecent', () => ok({ cancelled: true }));
  ipcMain.handle('project:recent', () => ok({ items: [] }));
  ipcMain.handle('file:pickImage', () => ok({ cancelled: false, file: {
    name: '烟测背景.png', size: 68, type: 'image/png',
    dataUrl: 'data:image/png;base64,' + PNG, id: 'a_smoke_bg'
  } }));
  ipcMain.handle('file:pickText', () => ok({ cancelled: false, file: {
    name: '剧本.txt', size: 40, type: 'text/plain', text: '旁白：烟测导入的第一句。\n澪：烟测导入的第二句。'
  } }));
  ipcMain.handle('file:save', (_e, payload) => {
    if (payload && payload.kind === 'html') {
      const out = path.join(tmp, 'exported-game.html');
      fs.writeFileSync(out, String(payload.text || ''));
      return ok({ cancelled: false, path: out });
    }
    return ok({ cancelled: true });
  });
  ipcMain.on('app:finishSaveBeforeClose', () => {});
}

async function run() {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 820,
    webPreferences: {
      preload: path.join(ROOT, 'desktop/preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, spellcheck: false
    }
  });
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const d = args[0];
    const level = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
    const message = d && typeof d === 'object' && 'message' in d ? d.message : args[2];
    if (level >= 2) errors.push(String(message));
  });
  await win.loadURL(APP_URL);

  const env = await win.webContents.executeJavaScript(`({
    nodes: document.querySelectorAll('#list .node').length,
    title: document.querySelector('#title').value,
    host: !!window.PaperHost,
    api: !!window.paperDesktop,
    leakRequire: typeof window.require,
    leakProcess: typeof window.process,
    exportFn: typeof buildGameHTML,
    player: typeof paperPlayer,
    desktopClass: document.body.classList.contains('desktop'),
    savedText: document.querySelector('#saved').textContent
  })`);
  assert(env.nodes >= 7, 'editor rendered the sample story in a real window');
  assert(env.host && env.api, 'preload exposed the narrow desktop API');
  assert.equal(env.leakRequire, 'undefined', 'renderer has no require');
  assert.equal(env.leakProcess, 'undefined', 'renderer has no process');
  assert.equal(env.exportFn, 'function', 'shared export module loaded');
  assert.equal(env.player, 'function', 'shared player loaded');
  assert(env.desktopClass, 'desktop-only UI activated');
  console.log('  ok  paper:// window, preload bridge, CSP-compatible scripts, no Node in renderer');

  // Guard the async contract of the bridge: every IPC call must resolve to a
  // validated state object, not throw on the pending Promise.
  const bridge = await win.webContents.executeJavaScript(`(async()=>{
    const out={};
    const probe=async(name,fn)=>{try{const v=await fn();out[name]=!!(v&&v.ok)}catch(e){out[name]='throw:'+e.message}};
    await probe('bootstrap',()=>window.PaperHost.bootstrap());
    await probe('recent',()=>window.PaperHost.recent());
    await probe('newProject',()=>window.PaperHost.newProject());
    await probe('open',()=>window.PaperHost.open());
    return out;
  })()`);
  for (const key of ['bootstrap', 'recent', 'newProject', 'open']) {
    assert.strictEqual(bridge[key], true, 'bridge call "' + key + '" must resolve, got: ' + bridge[key]);
  }
  const savedText = await win.webContents.executeJavaScript(`document.querySelector('#saved').textContent`);
  assert(!savedText.includes('请手动保存工程'), 'startup recovery reached the failure branch: ' + savedText);
  console.log('  ok  desktop bridge resolves bootstrap / recent / new / open and startup recovery succeeds');

  const added = await win.webContents.executeJavaScript(`(()=>{document.querySelector('#add').click();return document.querySelectorAll('#list .node').length})()`);
  assert.equal(added, env.nodes + 1, 'adding a dialogue node works');
  const undone = await win.webContents.executeJavaScript(`(()=>{document.querySelector('#undo').click();return document.querySelectorAll('#list .node').length})()`);
  assert.equal(undone, env.nodes, 'undo restores the story');
  const playing = await win.webContents.executeJavaScript(`(()=>{document.querySelector('#play').click();return document.body.classList.contains('playing')})()`);
  assert.equal(playing, true, 'play mode starts');
  await win.webContents.executeJavaScript(`document.querySelector('#stop').click(); true`);
  console.log('  ok  dialogue editing, undo and play mode in the desktop window');

  await win.webContents.executeJavaScript(`document.querySelector('#uploadBg').click(); true`);
  await sleep(500);
  const layers = await win.webContents.executeJavaScript(`({rows:document.querySelectorAll('#layerList .layer-row').length,visual:document.querySelectorAll('#layersCanvas .visual-layer').length})`);
  assert.equal(layers.rows, 1, 'native-picked image became an editor layer');
  assert.equal(layers.visual, 1, 'image rendered on the stage');
  const effectState = await win.webContents.executeJavaScript(`(()=>{
    const lw=document.querySelector('#lw');lw.value='80';lw.dispatchEvent(new Event('input',{bubbles:true}));
    const t=document.querySelector('#effectTarget'),id=t.options[1]?t.options[1].value:'';
    t.value=id;document.querySelector('#effectType').value='scale';document.querySelector('#addEffect').click();
    return {w:document.querySelector('#lw').value,effects:document.querySelectorAll('#effectList .effect-row').length};
  })()`);
  assert.equal(effectState.effects, 1, 'per-line effect added through the editor');
  assert.equal(+effectState.w, 80, 'layer size input updates the layout');
  const beforeTxt = await win.webContents.executeJavaScript(`document.querySelectorAll('#list .node').length`);
  await win.webContents.executeJavaScript(`document.querySelector('#txtFile').click(); true`);
  await sleep(250);
  await win.webContents.executeJavaScript(`document.querySelector('#parse').click(); true`);
  const afterTxt = await win.webContents.executeJavaScript(`document.querySelectorAll('#list .node').length`);
  assert.equal(afterTxt, beforeTxt + 2, 'TXT import adds two dialogue lines');
  console.log('  ok  image layer, layout resize, effect and TXT import in the real window');

  await win.webContents.executeJavaScript(`(()=>{const t=document.querySelector('#title');t.value='烟测 标题';t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(900);
  assert(fs.existsSync(DRAFT), 'debounced autosave wrote a crash-recovery copy');
  const draft = JSON.parse(fs.readFileSync(DRAFT, 'utf8'));
  assert.equal(draft.title, '烟测 标题');
  assert.equal(draft.format, 'paper-desktop');
  assert(!JSON.stringify(draft).includes('data:image'), 'disk metadata holds no inline images');
  console.log('  ok  autosave through IPC writes valid versioned metadata');

  await win.webContents.executeJavaScript(`document.querySelector('#save').click(); true`);
  await sleep(900);
  assert(fs.existsSync(MAIN), 'explicit save wrote project.paper.json');
  const saveText = await win.webContents.executeJavaScript(`document.querySelector('#saved').textContent`);
  assert(saveText.startsWith('已保存'), 'renderer received the resolved save state, got: ' + saveText);
  const mainDisk = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  assert.equal(mainDisk.title, '烟测 标题');
  assert.equal(mainDisk.nodes.length, env.nodes + 2);
  assert.equal(mainDisk.assets.length, 1, 'image asset saved');
  assert.equal(mainDisk.nodes[0].layers.length, 1);
  assert.equal(mainDisk.nodes[0].layers[0].w, 80, 'layout edit persisted');
  assert.equal(mainDisk.nodes[0].effects.length, 1, 'effect persisted');
  assert(fs.existsSync(path.join(tmp, mainDisk.assets[0].file)), 'content-addressed image exists');
  assert.deepEqual(store.openProject(tmp).project.nodes.map(n => n.text), mainDisk.nodes.map(n => n.text));
  assert(fs.existsSync(path.join(tmp, 'backups/latest/project.paper.json')), 'last-good backup created');
  console.log('  ok  explicit save, reopen verification and last-good backup');

  await win.webContents.executeJavaScript(`document.querySelector('#export').click(); true`);
  await sleep(700);
  const exported = path.join(tmp, 'exported-game.html');
  assert(fs.existsSync(exported), 'offline HTML game exported through the desktop save path');
  const game = fs.readFileSync(exported, 'utf8');
  assertSelfContained(game);
  assert(game.includes('data:image/png;base64,' + PNG), 'exported game carries the image inline');
  for (const bad of ['file:///', 'paper://', 'blob:', '127.0.0.1:4173']) {
    assert(!game.includes(bad), 'export leaks a local dependency: ' + bad);
  }
  console.log('  ok  offline HTML export is self-contained in the real window');

  await sleep(150);
  assert.equal(errors.length, 0, 'no renderer console errors: ' + errors.join(' | '));
  console.log('PASS: real Electron window - editor, IPC file saving, autosave, backups, no console errors');
  console.log('SMOKE_TMP=' + tmp);
}

app.whenReady().then(() => {
  protocol.handle('paper', request => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Forbidden', { status: 403 });
      const type = ALLOWED[url.pathname];
      if (!type) return new Response('Not found', { status: 404 });
      const body = fs.readFileSync(path.join(DIST, url.pathname.slice(1)));
      return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': type, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  registerIPC();
  run().then(() => { app.exit(0); }).catch(err => {
    console.error('SMOKE FAILED: ' + err.stack);
    app.exit(1);
  });
});
