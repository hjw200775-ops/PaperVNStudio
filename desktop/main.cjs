'use strict';
/*
 * Main process: window, native dialogs and controlled file operations only.
 * The renderer is sandboxed, context-isolated and served exclusively from the
 * paper:// scheme (a fixed allow-list of files inside dist/).
 */
const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const createProjectStore = require('./project-store.cjs');
const createVNCore = require('../dist/core.js');

const C = createVNCore();
const store = createProjectStore();
const { MAIN_FILE, AUTOSAVE_REL, MAX_IMAGE_BYTES } = store.constants;
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

let win = null;
let recentFile = '';
let draftDir = '';
const state = { currentDir: null, label: '', dirty: false, closing: false, lastError: '' };
let pendingSave = null;
let pendingSaveToken = '';

function labelOf(dir, title) {
  return (title || '未命名') + ' · ' + path.basename(dir);
}
function reply(extra) { return { ok: true, ...extra }; }
function fail(err) { return { ok: false, message: (err && err.message) || String(err) }; }
function stateSnapshot(extra) {
  return reply({
    currentDir: state.currentDir, label: state.label,
    dirty: state.dirty, lastError: state.lastError,
    recent: store.readRecent(recentFile).items.map(x => ({ title: x.title, folder: path.basename(x.path) })),
    ...extra
  });
}
function track(dir, title) {
  state.currentDir = dir;
  state.label = labelOf(dir, title);
  state.lastError = '';
  store.touchRecent(recentFile, dir, title);
  rebuildMenu();
}

/* ---------- native dialogs ---------- */

async function chooseDirectory(title) {
  const r = await dialog.showOpenDialog(win, {
    title, properties: ['openDirectory', 'createDirectory'], buttonLabel: '使用此目录'
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

const UNSAVED_CHOICE = {
  type: 'warning', buttons: ['保存并继续', '放弃修改', '取消'],
  defaultId: 0, cancelId: 2, noLink: true,
  message: '当前工程还有未保存的修改',
  detail: '自动保存的副本仍在工程目录内。保存失败时不会继续，也不会删除已有工程文件。'
};

async function clearDirtyBefore(actionName) {
  if (!state.dirty) return true;
  const choice = await dialog.showMessageBox(win, {
    ...UNSAVED_CHOICE, message: '打开' + actionName + '前，当前工程还有未保存的修改'
  });
  if (choice.response === 2) return false;
  if (choice.response === 1) { state.dirty = false; return true; }
  const result = await requestRendererSave();
  if (!result.ok) {
    await dialog.showMessageBox(win, { type: 'error', message: '保存失败，未切换工程', detail: result.message });
    return false;
  }
  state.dirty = false;
  return true;
}

function requestRendererSave() {
  return new Promise(resolve => {
    const token = Date.now() + '-' + Math.random().toString(36).slice(2);
    pendingSaveToken = token;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; pendingSave = null; pendingSaveToken = '';
      resolve({ ok: false, message: '编辑器响应超时，自动保存副本仍保留在工程目录。' });
    }, 8000);
    pendingSave = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); pendingSave = null; pendingSaveToken = '';
      resolve(result);
    };
    win.webContents.send('app:saveBeforeClose', token);
  });
}

/* ---------- close handling ---------- */

async function handleClose() {
  let choice;
  try {
    choice = await dialog.showMessageBox(win, UNSAVED_CHOICE);
  } catch { return; }
  if (choice.response === 2) return;                 // cancel
  if (choice.response === 1) {                      // discard
    state.dirty = false; state.closing = true; win.close(); return;
  }
  let result = await requestRendererSave();
  if (!result.ok && state.currentDir) {
    // Renderer failed/hung: the autosave copy is a complete, verified project.
    try {
      if (fs.existsSync(path.join(state.currentDir, AUTOSAVE_REL, MAIN_FILE))) {
        store.promoteAutosave(state.currentDir);
        result = { ok: true };
      }
    } catch (e) { result = { ok: false, message: e.message }; }
  }
  if (!result.ok) {
    await dialog.showMessageBox(win, { type: 'error', message: '保存失败，窗口保持打开', detail: result.message });
    return;
  }
  state.dirty = false; state.closing = true; win.close();
}

/* ---------- recent / menu ---------- */

function rebuildMenu() {
  const items = store.readRecent(recentFile).items;
  const recent = items.length
    ? items.slice(0, 8).map((x, i) => ({
        label: (i + 1) + '. ' + x.title + ' (' + path.basename(x.path) + ')',
        click: () => sendCommand('recent:' + i)
      }))
    : [{ label: '（暂无）', enabled: false }];
  const template = [
    {
      label: '文件', submenu: [
        { label: '新建工程…', accelerator: 'Ctrl+N', click: () => sendCommand('new') },
        { label: '打开工程…', accelerator: 'Ctrl+O', click: () => sendCommand('open') },
        { label: '最近工程', submenu: recent },
        { type: 'separator' },
        { label: '保存', accelerator: 'Ctrl+S', click: () => sendCommand('save') },
        { label: '另存为…', accelerator: 'Ctrl+Shift+S', click: () => sendCommand('saveAs') },
        { type: 'separator' },
        { label: '导出离线 HTML 游戏', click: () => sendCommand('export') },
        { label: '导出工程 JSON 备份', click: () => sendCommand('exportJson') },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    { label: '编辑', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
    ] },
    { label: '检查', submenu: [{ label: '检查剧情', click: () => sendCommand('check') }] },
    { label: '帮助', submenu: [{ label: '使用指南', click: () => sendCommand('help') }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function sendCommand(command) { if (win && !win.isDestroyed()) win.webContents.send('app:command', command); }

/* ---------- IPC (validated sender, fixed channels) ---------- */

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) return { ok: false, message: '拒绝的来源' };
    const url = event.senderFrame ? String(event.senderFrame.url) : '';
    if (url && !url.startsWith('paper://app/')) return { ok: false, message: '拒绝的页面来源' };
    try { return await fn(...args); } catch (e) { state.lastError = e.message; return fail(e); }
  });
}

function registerIPC() {
  handle('project:bootstrap', () => {
    const recent = store.readRecent(recentFile);
    const candidates = [recent.lastOpened, ...recent.items.map(x => x.path)].filter(Boolean);
    const dir = candidates.find(p => fs.existsSync(path.join(p, MAIN_FILE)));
    if (dir) {
      try {
        const opened = store.openProject(dir);
        track(opened.root, opened.project.title);
        state.dirty = opened.recovered === 'autosave';
        return stateSnapshot({
          project: opened.project,
          recovered: opened.recovered,
          notice: opened.recovered === 'autosave'
            ? '已从上次的自动保存副本恢复未保存的修改；主工程文件仍是上一次手动保存的版本。'
            : opened.recovered === 'backup' ? '主工程文件损坏，已从备份恢复。' : ''
        });
      } catch (e) {
        state.lastError = e.message;
        return stateSnapshot({ project: null, notice: '最近工程无法打开：' + e.message });
      }
    }
    // No linked project yet: recover the unlinked draft from the user data dir.
    const draft = path.join(draftDir, AUTOSAVE_REL, MAIN_FILE);
    if (fs.existsSync(draft)) {
      try {
        const disk = store.validateDisk(JSON.parse(fs.readFileSync(draft, 'utf8')));
        const project = store.diskToRuntime(draftDir, disk);
        state.dirty = true;
        return stateSnapshot({ project, recovered: 'autosave', currentDir: null, label: '未保存的草稿', notice: '已恢复上次未关联工程目录的草稿，请另存为正式工程。' });
      } catch (e) { state.lastError = e.message; }
    }
    return stateSnapshot({ project: null, recovered: null, notice: '' });
  });

  handle('project:autoSave', p => {
    const target = state.currentDir || draftDir;
    const saved = store.autoSave(target, p);
    state.dirty = true;
    return reply({ savedAt: saved.disk.savedAt });
  });

  handle('project:save', async p => {
    let dir = state.currentDir;
    if (!dir) {
      dir = await chooseDirectory('为工程选择一个目录');
      if (!dir) return reply({ cancelled: true });
      const result = store.saveAsProject(dir, p);
      track(result.root, result.project.title);
    } else {
      const result = store.saveProject(dir, p);
      track(result.root, result.project.title);
    }
    state.dirty = false;
    return stateSnapshot({ saved: true, cancelled: false });
  });

  handle('project:saveAs', async p => {
    const dir = await chooseDirectory('另存为：选择新的空白工程目录');
    if (!dir) return reply({ cancelled: true });
    const result = store.saveAsProject(dir, p);
    track(result.root, result.project.title);   // old project directory untouched
    state.dirty = false;
    return stateSnapshot({ saved: true, cancelled: false });
  });

  handle('project:new', async () => {
    if (!await clearDirtyBefore('新工程')) return reply({ cancelled: true });
    const dir = await chooseDirectory('新建工程：选择一个空白目录');
    if (!dir) return reply({ cancelled: true });
    // A brand-new project starts with one empty dialogue node: an editor with a
    // zero-length node list has nothing to select and looks like a failed create.
    const blank = C.blank();
    blank.nodes.push(C.makeNode('say'));
    const result = store.createProject(dir, blank);
    track(result.root, result.project.title);
    state.dirty = false;
    return stateSnapshot({ project: result.project, cancelled: false });
  });

  handle('project:open', async () => {
    if (!await clearDirtyBefore('工程')) return reply({ cancelled: true });
    const kind = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['工程目录', '旧 .paper.json 文件', '取消'],
      defaultId: 0, cancelId: 2, noLink: true,
      message: '要打开哪一种工程？',
      detail: '桌面工程是一个包含 project.paper.json 与 assets/ 的目录；旧版单文件工程会被导入到新目录，原文件保持不变。'
    });
    if (kind.response === 2) return reply({ cancelled: true });
    let dir, imported = false;
    if (kind.response === 0) {
      dir = await chooseDirectory('打开工程目录');
      if (!dir) return reply({ cancelled: true });
      if (!fs.existsSync(path.join(dir, MAIN_FILE))) throw new Error('所选目录没有 project.paper.json，若这是旧工程请选择「旧 .paper.json 文件」');
    } else {
      const picked = await dialog.showOpenDialog(win, {
        title: '选择旧版 .paper.json 工程', properties: ['openFile'],
        filters: [{ name: '纸间工程', extensions: ['json'] }]
      });
      if (picked.canceled || !picked.filePaths[0]) return reply({ cancelled: true });
      const target = await chooseDirectory('为导入的工程选择新的空白目录');
      if (!target) return reply({ cancelled: true });
      const result = store.importLegacy(picked.filePaths[0], target);
      dir = result.root;
      imported = true;
      track(dir, result.project.title);
      state.dirty = false;
      return stateSnapshot({ project: result.project, imported, cancelled: false, notice: '旧工程已导入到新目录，原文件未改动。' });
    }
    const opened = store.openProject(dir);
    track(opened.root, opened.project.title);
    state.dirty = opened.recovered === 'autosave';
    return stateSnapshot({
      project: opened.project, imported, recovered: opened.recovered, cancelled: false,
      notice: opened.recovered === 'autosave' ? '此工程有比主文件更新的自动保存副本，已恢复未保存的修改。' : ''
    });
  });

  handle('project:openRecent', async index => {
    const items = store.readRecent(recentFile).items;
    const item = items[Number(index)];
    if (!item || !Number.isInteger(Number(index))) return { ok: false, message: '最近工程不存在' };
    if (!await clearDirtyBefore('最近工程')) return reply({ cancelled: true });
    const opened = store.openProject(item.path);
    track(opened.root, opened.project.title);
    state.dirty = opened.recovered === 'autosave';
    return stateSnapshot({ project: opened.project, recovered: opened.recovered, cancelled: false });
  });

  handle('project:recent', () => reply({ items: store.readRecent(recentFile).items.map(x => ({ title: x.title, folder: path.basename(x.path) })) }));

  handle('file:pickImage', async assetKind => {
    if (!['bg', 'char'].includes(assetKind)) throw new Error('无效的素材类型');
    const picked = await dialog.showOpenDialog(win, {
      title: '选择图片（将复制到工程素材目录）', properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    });
    if (picked.canceled || !picked.filePaths[0]) return reply({ cancelled: true });
    const file = picked.filePaths[0];
    const buf = fs.readFileSync(file);
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片超过 12MB');
    const ext = path.extname(file).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
    if (!mime || !store.imageSize(buf, mime)) throw new Error('无法识别的 PNG / JPEG / WebP 图片');
    const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
    return reply({ cancelled: false, file: {
      name: path.basename(file), size: buf.length, type: mime, dataUrl,
      id: store.newAssetId(assetKind, dataUrl)
    } });
  });

  handle('file:pickText', async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: '导入 UTF-8 文本', properties: ['openFile'],
      filters: [{ name: '文本', extensions: ['txt', 'md'] }]
    });
    if (picked.canceled || !picked.filePaths[0]) return reply({ cancelled: true });
    const buf = fs.readFileSync(picked.filePaths[0]);
    if (buf.length > 2 * 1024 * 1024) throw new Error('文本请小于 2MB');
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    return reply({ cancelled: false, file: { name: path.basename(picked.filePaths[0]), size: buf.length, type: 'text/plain', text } });
  });

  handle('file:save', async payload => {
    const kind = String(payload && payload.kind || '');
    const conf = {
      html: { ext: 'html', filter: [{ name: '离线网页游戏', extensions: ['html'] }] },
      json: { ext: 'json', filter: [{ name: '纸间工程备份', extensions: ['json'] }] },
      png: { ext: 'png', filter: [{ name: 'PNG 图片', extensions: ['png'] }] }
    }[kind];
    if (!conf) return { ok: false, message: '不支持的导出类型' };
    const requested = path.basename(String(payload.name || '')).replace(/[\\/:*?"<>|\r\n\0]/g, '_').slice(0, 120) || ('story.' + conf.ext);
    const name = requested.toLowerCase().endsWith('.' + conf.ext) ? requested : requested + '.' + conf.ext;
    const picked = await dialog.showSaveDialog(win, {
      title: '保存导出文件', defaultPath: path.join(app.getPath('documents'), name), filters: conf.filter
    });
    if (picked.canceled || !picked.filePath) return reply({ cancelled: true });
    const data = kind === 'png'
      ? Buffer.from(String(payload.base64 || ''), 'base64')
      : Buffer.from(String(payload.text || ''), 'utf8');
    if (!data.length) throw new Error('导出内容为空');
    fs.writeFileSync(picked.filePath, data);
    return reply({ cancelled: false, path: picked.filePath });
  });

  // invoke/handle pair: the renderer's await resolves, and the sender is validated.
  handle('app:finishSaveBeforeClose', result => {
    if (pendingSave && result && result.token === pendingSaveToken) {
      pendingSave({ ok: !!result.ok, message: String(result.message || '') });
    }
    return reply({});
  });
}

/* ---------- window ---------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1120, minHeight: 720,
    title: '纸间 PaperVNStudio · 桌面预览版',
    backgroundColor: '#f5f7f0',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== APP_URL && !url.startsWith(APP_URL + '#')) event.preventDefault();
  });
  win.webContents.on('will-redirect', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    state.lastError = '页面加载失败：' + code + ' ' + desc;
  });
  win.on('close', event => {
    if (state.closing || !state.dirty) return;
    event.preventDefault();
    void handleClose();
  });
  win.on('closed', () => { win = null; });
  // Opt-in packaged self-check. Only active when explicitly launched with
  // PAPER_VN_SMOKE=1; reports the real page origin and renderer isolation.
  if (process.env.PAPER_VN_SMOKE === '1') {
    win.webContents.once('did-finish-load', async () => {
      let info;
      try {
        const raw = await win.webContents.executeJavaScript('JSON.stringify({url:location.href,title:document.title,nodes:document.querySelectorAll("#list .node").length,host:!!window.PaperHost,requireType:typeof window.require,processType:typeof window.process})');
        info = JSON.parse(raw);
      } catch (e) { info = { error: e.message }; }
      const ok = !!(info && String(info.url).startsWith('paper://app/') && info.nodes >= 7 &&
        info.host && info.requireType === 'undefined' && info.processType === 'undefined');
      const out = process.env.PAPER_VN_SMOKE_OUT;
      if (out) { try { fs.writeFileSync(out, JSON.stringify({ ok, info })); } catch { /* best effort */ } }
      console.log('PAPER_VN_SMOKE ' + (ok ? 'PASS' : 'FAIL') + ' ' + JSON.stringify(info));
      app.exit(ok ? 0 : 1);
    });
  }
  win.loadURL(APP_URL);
}

app.whenReady().then(() => {
  recentFile = path.join(app.getPath('userData'), 'recent-projects.json');
  draftDir = path.join(app.getPath('userData'), 'drafts');
  fs.mkdirSync(draftDir, { recursive: true });

  protocol.handle('paper', request => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Forbidden', { status: 403 });
      const type = ALLOWED[url.pathname];
      if (!type) return new Response('Not found', { status: 404 });
      const body = fs.readFileSync(path.join(DIST, url.pathname.slice(1)));
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-type': type, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  registerIPC();
  rebuildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
