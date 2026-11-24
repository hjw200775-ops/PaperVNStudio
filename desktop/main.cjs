'use strict';
/*
 * Main process: window, native dialogs and controlled file operations only.
 * The renderer is sandboxed, context-isolated and served exclusively from the
 * paper:// scheme (a fixed allow-list of files inside dist/).
 */
const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, session, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const createProjectStore = require('./project-store.cjs');
const createStagingManager = require('./asset-staging.cjs');
const createGameBuilder = require('./game-builder.cjs');
const createVNCore = require('../dist/core.js');
const createPaperAudio = require('../dist/audio.js');
const { buildPlayerHTML } = require('../dist/game-html.js');

const C = createVNCore();
const AUDIO_PURE = createPaperAudio().pure;
let store = createProjectStore();
let staging = null;                       // 初始化于 app.whenReady（需要 userData 路径）
const { MAIN_FILE, AUTOSAVE_REL, MAX_IMAGE_BYTES, MAX_AUDIO_BYTES } = store.constants;
const AUDIO_EXT_MIME = { wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm' };
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
/* 通用导出：复用同一份构建器，运行时取自正在运行的这个 Electron。 */
const gameBuilder = createGameBuilder({
  repoRoot: ROOT, execPath: process.execPath,
  resourcesPath: process.resourcesPath, isPackaged: app.isPackaged
});
let exportJob = null;
const APP_URL = 'paper://app/index.html';
const CSP = "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: paperasset:; media-src 'self' data: blob: paperasset:; font-src 'self' data:; connect-src 'self' paperasset:; object-src 'none'; base-uri 'none'; form-action 'none'";
const ALLOWED = {
  '/index.html': 'text/html; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8',
  '/core.js': 'text/javascript; charset=utf-8',
  '/effects.js': 'text/javascript; charset=utf-8',
  '/performance.js': 'text/javascript; charset=utf-8',
  '/player.js': 'text/javascript; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/export.js': 'text/javascript; charset=utf-8',
  '/game-html.js': 'text/javascript; charset=utf-8',
  '/audio.js': 'text/javascript; charset=utf-8',
  '/desktop-bridge.js': 'text/javascript; charset=utf-8'
};

protocol.registerSchemesAsPrivileged([{
  scheme: 'paper',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false }
}, {
  /* 预览会话专用：只服务当前会话目录里的资源，按需读取，不再把素材塞进 HTML。 */
  scheme: 'pvres',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false }
}, {
  /* 编辑器运行时素材：paperasset://project/assets/... 只读当前工程目录下的内容寻址文件。 */
  scheme: 'paperasset',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false }
}]);
app.enableSandbox();

let win = null;
let previewWin = null;
/* 预览会话：每个窗口一个目录，关闭即删；资源按 pvres://<session>/... 读取。 */
const previewSessions = new Map();
const previewRoot = () => path.join(app.getPath('userData'), 'preview-sessions');
/* connect-src 'self'：预览页只允许 fetch 自己这个 pvres://<session>/ 会话目录里的资源，
   用于精确循环解码；会话关闭即 404，仍然没有网络能力。 */
const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src 'self' data:; media-src 'self' data:; font-src data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

function previewProgress(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('preview:progress', payload);
}
function assetProgress(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('asset:stageProgress', payload);
}
/* 渲染进程给出当前工程 + 撤销/重做栈里仍在用的暂存哈希；没有引用才允许清理。 */
function stagedRefs(payload) {
  const out = new Set();
  const scan = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.data === 'string') {
      const h = staging && staging.hashFromUrl(value.data);
      if (h) out.add(h);
    }
  };
  const project = payload && payload.project ? payload.project : payload;
  if (project) {
    scan(project);
    for (const a of project.assets || []) scan(a);
    for (const a of project.audioAssets || []) scan(a);
  }
  for (const list of [payload && payload.protected, payload && payload.references]) {
    if (Array.isArray(list)) for (const h of list) if (/^[a-f0-9]{64}$/i.test(String(h))) out.add(String(h).toLowerCase());
  }
  return out;
}
function collectStaging(payload) {
  if (!staging) return { removed: [] };
  return staging.collectGarbage({ protectedHashes: stagedRefs(payload) });
}

const stageCancellations = new Map();
/* 共用实现：显式文件列表（自动化验收/CDP）与原生文件对话框走完全相同的校验与暂存逻辑。 */
async function runAssetStage(payload) {
  if (!staging) throw new Error('素材暂存目录尚未就绪');
  const kind = payload && payload.kind === 'audio' ? 'audio' : 'image';
  const multiple = !!(payload && payload.multiple);
  let files = Array.isArray(payload && payload.files) ? payload.files.filter(x => typeof x === 'string') : null;
  if (!files) {
    const picked = await dialog.showOpenDialog(win, {
      title: kind === 'image' ? '选择图片（流式导入，不经过浏览器内存）' : '选择音频（流式导入，不经过浏览器内存）',
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [kind === 'image'
        ? { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
        : { name: '音频', extensions: ['wav', 'wave', 'mp3', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'webm'] }]
    });
    if (picked.canceled || !picked.filePaths.length) return { cancelled: true, files: [], errors: [] };
    files = picked.filePaths;
  }
  if (!files.length) return { cancelled: true, files: [], errors: [] };
  const token = 'stage-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  assetProgress({ token, phase: 'start', kind, count: files.length, percent: 0, file: '' });
  try {
    const result = await staging.stageFiles(files, {
      token, kind, assetKind: (payload && payload.assetKind) || 'bg',
      totalBytes: Number(payload && payload.totalBytes) || 0,
      maxBytes: kind === 'image' ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES,
      maxTotalBytes: kind === 'audio' ? 1536 * 1024 * 1024 : Infinity,
      isCancelled: () => !!(stageCancellations.get(token) || stageCancellations.get('*')),
      onProgress: assetProgress
    });
    assetProgress({ token, phase: result.cancelled ? 'cancelled' : 'complete', kind,
      count: files.length, percent: result.cancelled ? 0 : 100, file: '' });
    return result;
  } finally {
    stageCancellations.delete(token);
  }
}

/* data URI 落成会话目录下的内容寻址文件，返回 pvres:// 地址（同一内容只写一次）。 */
function writePreviewAsset(dir, sessionId, data) {
  const raw = String(data || '');
  let buf, ext;
  if (/^paper:\/\/app\/staging\//i.test(raw)) {
    /* M3：尚未保存的导入素材在暂存目录，预览前直接按内容哈希读取。 */
    if (!staging) throw new Error('素材暂存目录不可用');
    const rel = raw.replace(/^paper:\/\/app\/staging\//i, '');
    const m = /^([a-f0-9]{64})\.([a-z0-9]+)$/i.exec(rel);
    if (!m) throw new Error('暂存素材地址无效：' + rel);
    const abs = staging.absFor(m[1], m[2]);
    buf = fs.readFileSync(abs);
    ext = m[2].toLowerCase();
  } else if (/^paper:\/\/app\/asset\//i.test(raw)) {
    /* 运行时素材已经是磁盘文件：直接读，避免再把整张图 base64 一次。 */
    const rel = raw.replace(/^paper:\/\/app\/asset\//i, '');
    if (!state.currentDir) throw new Error('当前工程目录不可用，无法读取素材');
    const root = path.resolve(state.currentDir);
    const abs = path.resolve(root, ...rel.split('/'));
    if (!abs.startsWith(root + path.sep)) throw new Error('素材路径越界：' + rel);
    buf = fs.readFileSync(abs);
    ext = path.extname(abs).slice(1).toLowerCase();
  } else {
    const m = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(raw);
    if (!m) throw new Error('预览资源格式无效：只接受内嵌 data URI 或受控素材地址');
    buf = Buffer.from(m[2], 'base64');
    ext = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
      'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
      'audio/wave': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/webm': 'webm'
    }[m[1].toLowerCase()];
  }
  if (!ext) throw new Error('预览不支持的资源类型');
  if (!buf.length) throw new Error('预览资源为空');
  const hash = require('node:crypto').createHash('sha256').update(buf).digest('hex');
  const rel = 'assets/' + hash + '.' + ext;
  const abs = path.join(dir, 'assets', hash + '.' + ext);
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);
  return 'pvres://' + sessionId + '/' + rel;
}

function disposePreviewSession(id) {
  const s = previewSessions.get(id);
  if (!s) return;
  previewSessions.delete(id);
  fs.promises.rm(s.dir, { recursive: true, force: true }).catch(() => {});
}
let sampleWin = null;
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

/* ---------- 内置示例（只读资源） ----------
 * 渲染进程只传固定标识，主进程自己决定源目录；不接受任意路径、任意文件读写。
 * 安装目录里的示例永远只读：体验写到 userData，复制写到用户选择的空目录。 */
const SAMPLE_SLUG = 'wanfeng-ch01';
const SAMPLE_DIR = path.join(DIST, 'samples', SAMPLE_SLUG);

function readSample() {
  const main = path.join(SAMPLE_DIR, MAIN_FILE);
  if (!fs.existsSync(main)) {
    throw new Error('安装包缺少内置示例（dist/samples/' + SAMPLE_SLUG + '），请使用完整版本');
  }
  const disk = JSON.parse(fs.readFileSync(main, 'utf8'));
  store.validateDisk(disk);
  const project = store.diskToRuntime(SAMPLE_DIR, disk);
  return { project, dir: SAMPLE_DIR };
}
function sampleMeta(project) {
  return {
    slug: SAMPLE_SLUG, projectId: project.id, title: project.title,
    nodes: project.nodes.length, images: project.assets.length,
    sections: (project.chapters || []).length, author: '黄嘉文'
  };
}
/* 复制失败时只清理本次创建的文件：目录此前已确认是空的，不碰任何用户文件。 */
function cleanupPartialCopy(root) {
  for (const name of [MAIN_FILE, 'assets', 'backups']) {
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
  try {
    for (const name of fs.readdirSync(root)) {
      if (/\.tmp-\d+-[0-9a-f]+$/.test(name)) fs.rmSync(path.join(root, name), { force: true });
    }
  } catch { /* best effort */ }
}


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
        // Older builds could create a directory with zero nodes; restoring it
        // leaves an empty editor that looks like a failed startup. Leave the
        // files untouched and start from the sample instead.
        if (!opened.project.nodes.length) {
          state.currentDir = null;
          state.label = '';
          state.dirty = false;
          return stateSnapshot({
            project: null, recovered: null,
            notice: '上次的工程还没有剧情节点（旧版本创建的空白工程），已从示例开始；原文件仍在 ' + dir + '，可用「打开工程」重新选择。'
          });
        }
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

  handle('project:autoSave', payload => {
    const target = state.currentDir || draftDir;
    const saved = store.autoSave(target, payload && payload.project ? payload.project : payload);
    state.dirty = true;
    collectStaging(payload || {});
    return reply({ savedAt: saved.disk.savedAt });
  });

  handle('project:save', async payload => {
    const p = payload && payload.project ? payload.project : payload;
    let dir = state.currentDir;
    if (!dir) {
      dir = await chooseDirectory('为工程选择一个目录');
      if (!dir) return reply({ cancelled: true });
      const result = store.saveAsProject(dir, p, draftDir);
      track(result.root, result.project.title);
    } else {
      const result = store.saveProject(dir, p);
      track(result.root, result.project.title);
    }
    state.dirty = false;
    collectStaging(payload || {});
    return stateSnapshot({ saved: true, cancelled: false });
  });

  handle('project:saveAs', async payload => {
    const p = payload && payload.project ? payload.project : payload;
    const dir = await chooseDirectory('另存为：选择新的空白工程目录');
    if (!dir) return reply({ cancelled: true });
    const result = store.saveAsProject(dir, p, state.currentDir || draftDir);
    track(result.root, result.project.title);   // old project directory untouched
    state.dirty = false;
    collectStaging(payload || {});
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
    collectStaging({ project: result.project });
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
      collectStaging({ project: result.project });
      return stateSnapshot({ project: result.project, imported, cancelled: false, notice: '旧工程已导入到新目录，原文件未改动。' });
    }
    const opened = store.openProject(dir);
    track(opened.root, opened.project.title);
    state.dirty = opened.recovered === 'autosave';
    collectStaging({ project: opened.project });
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
    collectStaging({ project: opened.project });
    return stateSnapshot({ project: opened.project, recovered: opened.recovered, cancelled: false });
  });

  handle('project:recent', () => reply({ items: store.readRecent(recentFile).items.map(x => ({ title: x.title, folder: path.basename(x.path) })) }));

  /* V0.7.6-M3：素材导入统一走主进程流式暂存。渲染进程只拿到受控 URL 与元数据，
     不会再收到任何整份 Base64；旧通道保留名字但转发到同一实现，避免遗漏旧入口。 */
  handle('asset:stage', async payload => reply(await runAssetStage(payload)));

  handle('asset:cancelStage', payload => {
    const token = payload && payload.token ? String(payload.token) : '*';
    stageCancellations.set(token, true);
    if (staging) staging.cancel(token === '*' ? null : token);
    return reply({ cancelled: true, token });
  });

  handle('asset:gc', payload => reply({ gc: collectStaging(payload || {}), stats: staging ? staging.stats() : null }));

  handle('asset:stagingStats', () => reply({ stats: staging ? staging.stats() : null }));

  /* V0.7.6-M3 验收取证：只暴露数值指标，不暴露 fs/path/进程句柄，且沿用固定通道
     的发送者校验。采样脚本按阶段连续调用，用于计算主进程、渲染进程与全进程峰值。 */
  handle('app:metrics', () => {
    const metrics = app.getAppMetrics().map(m => ({
      pid: m.pid, type: String(m.type || '').toLowerCase(),
      workingSetSize: m.memory && m.memory.workingSetSize || 0,
      peakWorkingSetSize: m.memory && m.memory.peakWorkingSetSize || 0,
      privateBytes: m.memory && m.memory.privateBytes || 0,
      cpuPercent: m.cpu && m.cpu.percentCPUUsage || 0
    }));
    return reply({
      at: Date.now(), metrics,
      process: process.memoryUsage(),
      rendererPid: win && !win.isDestroyed() ? win.webContents.getOSProcessId() : null,
      currentDir: state.currentDir
    });
  });

  handle('file:pickImage', async assetKind => {
    if (!['bg', 'char'].includes(assetKind)) throw new Error('无效的素材类型');
    const result = await runAssetStage({ kind: 'image', assetKind, multiple: false });
    return result.cancelled ? reply({ cancelled: true }) : reply({ cancelled: false, file: result.files[0] });
  });

  /* V0.5 音频选文件与图片完全分离；V0.7.6 起两者都走同一个流式暂存器。 */
  handle('file:pickAudio', async () => {
    const result = await runAssetStage({ kind: 'audio', multiple: false });
    return result.cancelled ? reply({ cancelled: true }) : reply({ cancelled: false, file: result.files[0] });
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
  /* 完整预览（V0.7.4）：渲染进程只传工程数据，素材由主进程落到会话目录，
     页面通过 pvres:// 按需读取——HTML 从「素材总量」里解耦，不再受旧 64MB 限制。
     会话目录在窗口关闭后删除；启动时清一次，避免历史残留。 */
  handle('player:preview', async payload => {
    /* 渲染进程直接传工程对象；兼容旧的 { project } 包法。 */
    const project = payload && typeof payload === 'object' && payload.project ? payload.project : payload;
    if (!project || typeof project !== 'object' || !Array.isArray(project.nodes) || !Array.isArray(project.assets)) {
      throw new Error('预览内容为空：请先打开一个工程（旧版会把 HTML 传进来，V0.7.4 起只传工程数据）');
    }
    const sessionId = 's-' + require('node:crypto').randomBytes(6).toString('hex');
    const dir = path.join(previewRoot(), sessionId);
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    const startedAt = Date.now();
    try {
      previewProgress({ phase: 'prepare', text: '正在准备预览…' });
      const preview = Object.assign({}, project);
      preview.assets = (project.assets || []).map(a => Object.assign({}, a, {
        data: writePreviewAsset(dir, sessionId, a.data)
      }));
      preview.audioAssets = (project.audioAssets || []).map(a => Object.assign({}, a, {
        data: writePreviewAsset(dir, sessionId, a.data)
      }));

      previewProgress({ phase: 'build', text: '正在生成播放器…' });
      const { buildPlayerHTML } = require(path.join(ROOT, 'dist', 'game-html.js'));
      const report = {};
      const html = buildPlayerHTML(preview, undefined, report, { mode: 'preview' });
      fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
      previewSessions.set(sessionId, { dir, at: startedAt });

      if (previewWin && !previewWin.isDestroyed()) previewWin.close();
      const thisWin = new BrowserWindow({
        width: 1200, height: 860, minWidth: 720, minHeight: 600,
        title: '完整游戏预览', backgroundColor: '#17261f',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
      });
      previewWin = thisWin;
      const myId = sessionId;
      thisWin.on('closed', () => {
        if (previewWin === thisWin) previewWin = null;
        disposePreviewSession(myId);
      });
      previewProgress({ phase: 'load', text: '正在加载游戏…' });
      await thisWin.loadURL('pvres://' + sessionId + '/index.html');
      const stats = report.resources || null;
      previewProgress({ phase: 'ready', text: '预览已打开' });
      return reply({ preview: true, session: sessionId, stats, elapsedMs: Date.now() - startedAt });
    } catch (e) {
      previewSessions.delete(sessionId);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响报错 */ }
      previewProgress({ phase: 'failed', text: '预览失败：' + ((e && e.message) || e) });
      throw e;
    }
  });

  /* 体验示例：与导出完全相同的自包含 HTML，独立窗口 + 独立持久分区。
     存档只写到 userData 的分区里，不写安装目录，也不进入当前编辑工程。 */
  handle('sample:info', () => {
    const { project } = readSample();
    return reply({ sample: sampleMeta(project) });
  });

  handle('sample:experience', async () => {
    const { project } = readSample();
    const html = buildPlayerHTML(project);
    const dir = path.join(app.getPath('userData'), 'sample');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'game-sample.html');
    fs.writeFileSync(file, html, 'utf8');
    if (sampleWin && !sampleWin.isDestroyed()) sampleWin.close();
    sampleWin = new BrowserWindow({
      width: 1200, height: 860, minWidth: 720, minHeight: 600,
      title: '体验示例 · ' + project.title, backgroundColor: '#17261f',
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        partition: 'persist:papervn-sample'
      }
    });
    sampleWin.on('closed', () => { sampleWin = null; });
    await sampleWin.loadFile(file);
    return reply({ opened: true, sample: sampleMeta(project) });
  });

  handle('sample:copy', async () => {
    if (!await clearDirtyBefore('示例工程')) return reply({ cancelled: true });
    const dir = await chooseDirectory('复制示例：选择一个新的空白目录');
    if (!dir) return reply({ cancelled: true });
    const root = path.resolve(dir);
    fs.mkdirSync(root, { recursive: true });
    /* 只复制到全新目录：不覆盖已有工程，也不与非空目录静默合并。 */
    if (fs.readdirSync(root).length) {
      throw new Error('目标目录不是空目录。示例只会复制到全新的空白目录，不会覆盖或合并已有文件。');
    }
    const { project } = readSample();
    const copy = JSON.parse(JSON.stringify(project));
    copy.id = C.id();                       /* 副本拥有独立存档身份 */
    let result;
    try {
      result = store.createProject(root, copy);
    } catch (e) {
      cleanupPartialCopy(root);             /* 失败不留半成品工程 */
      throw e;
    }
    track(result.root, result.project.title);
    state.dirty = false;
    return stateSnapshot({
      project: result.project, cancelled: false, copied: true,
      notice: '已复制为独立工程（新工程 ID）：此后对副本的修改不会影响内置示例。'
    });
  });


  /* ---------- 通用独立游戏导出（V0.7.2） ---------- */

  /* 关闭预览窗口：会话目录在 closed 事件里清理，这里只负责关窗。 */
  handle('player:closePreview', () => {
    if (previewWin && !previewWin.isDestroyed()) previewWin.close();
    return reply({ closed: true });
  });

  handle('game:toolchain', () => reply({ status: gameBuilder.toolchain() }));

  /* 图标入口：PNG / JPEG / ICO。ICO 只取其中最大的一档；旧式 BMP 条目给出明确提示，
     不做「看起来导入成功、实际没生效」的静默降级。 */
  handle('game:pickIcon', async () => {
    let file = process.env.PAPER_VN_TEST_ICON || '';
    if (!file) {
      const picked = await dialog.showOpenDialog(win, {
        title: '选择游戏图标（PNG / JPEG / ICO）', properties: ['openFile'],
        filters: [{ name: '图标', extensions: ['png', 'jpg', 'jpeg', 'ico'] }]
      });
      if (picked.canceled || !picked.filePaths[0]) return reply({ cancelled: true });
      file = picked.filePaths[0];
    }
    const buf = fs.readFileSync(file);
    if (!buf.length) throw new Error('图标文件是空的');
    if (buf.length > 8 * 1024 * 1024) throw new Error('图标请小于 8MB');
    const ext = path.extname(file).toLowerCase();
    const name = path.basename(file);
    if (ext === '.ico') return reply({ cancelled: false, name, dataUrl: icoToPngDataUrl(buf) });
    const mime = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : '';
    if (!mime) throw new Error('只支持 PNG、JPEG 或 ICO');
    const magicOk = mime === 'image/png'
      ? buf.readUInt32BE(0) === 0x89504e47
      : (buf[0] === 0xff && buf[1] === 0xd8);
    if (!magicOk) throw new Error('文件内容与扩展名不符，请重新选择图片');
    return reply({ cancelled: false, name, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') });
  });

  handle('game:export', async payload => {
    if (exportJob) return { ok: false, message: '已有导出任务在进行，请等待完成或先取消' };
    const project = payload && payload.project;
    /* V0.7.6-M3 回归修复：界面提供 folder / zip / portable 三种，旧代码只认
       portable，把「目录版」静默降级成 ZIP 包。白名单要与 game-builder 一致。 */
    const type = ['folder', 'portable', 'zip'].includes(payload && payload.type) ? payload.type : 'zip';
    const token = 'export-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    let cancelled = false;
    let cancelSignal = null;
    /* 取消要立刻回到界面：构建在子进程里还要收拾临时目录，不能等它。 */
    const cancelPromise = new Promise(resolve => { cancelSignal = resolve; });
    exportJob = {
      token,
      cancel() {
        cancelled = true;
        if (cancelSignal) cancelSignal({ ok: false, cancelled: true, message: '已取消导出' });
      }
    };
    try {
      let outDir = String((payload && payload.outDir) || process.env.PAPER_VN_TEST_EXPORT_DIR || '');
      if (!outDir) {
        outDir = await chooseDirectory('选择游戏导出目录');
        if (!outDir) return { ok: false, cancelled: true, message: '已取消' };
      }
      if (fs.existsSync(outDir) && !fs.statSync(outDir).isDirectory()) {
        throw new Error('导出位置不可用：所选路径是一个文件，请选择文件夹');
      }
      const settings = gameBuilder.resolveSettings(project);
      const suffix = type === 'zip' ? '-独立试玩包.zip'
        : type === 'portable' ? '-单文件便携版.exe' : '-独立游戏';
      const fileName = settings.fileBase + suffix;
      let target = path.join(outDir, fileName);
      let overwrite = false;
      while (fs.existsSync(target)) {
        const forced = process.env.PAPER_VN_TEST_CONFLICT || '';
        let choice;
        if (forced === 'overwrite') choice = 0;
        else if (forced === 'cancel') choice = 2;
        else if (forced.startsWith('dir:')) {
          outDir = forced.slice(4);
          target = path.join(outDir, fileName);
          continue;
        } else {
          choice = await askExportConflict(target);
        }
        if (choice === 0) { overwrite = true; break; }
        if (choice === 2) return { ok: false, cancelled: true, message: '已取消（没有覆盖已有文件）' };
        const dir = await chooseDirectory('选择另一个导出目录');
        if (!dir) return { ok: false, cancelled: true, message: '已取消' };
        outDir = dir;
        target = path.join(outDir, fileName);
      }
      const buildPromise = gameBuilder.build({
        project, type, outDir, overwrite,
        /* 运行时素材是 paperasset:// 地址，构建器需要工程根目录来读取原文件。 */
        projectRoot: state.currentDir,
        onProgress: p => {
          if (win && !win.isDestroyed()) win.webContents.send('game:exportProgress', Object.assign({ token }, p));
        },
        isCancelled: () => cancelled
      }, { nativeImage });
      /* 构建结束后才释放任务锁；取消时先返回，后台把子进程和临时文件收干净。 */
      buildPromise.catch(() => {}).then(() => {
        if (exportJob && exportJob.token === token) exportJob = null;
      });
      const result = await Promise.race([buildPromise, cancelPromise]);
      if (result && result.cancelled) return { ok: false, cancelled: true, message: result.message || '已取消导出' };
      return Object.assign({ ok: true }, result);
    } catch (e) {
      if (e && e.cancelled) return { ok: false, cancelled: true, message: '已取消导出' };
      return { ok: false, message: (e && e.message) || String(e) };
    } finally {
      /* 正常路径的任务锁在上面 then 里释放；这里兜住早退（选目录取消、冲突取消）。 */
      if (exportJob && exportJob.token === token && !cancelled) exportJob = null;
    }
  });

  handle('game:cancelExport', () => {
    if (!exportJob) return reply({ cancelled: false });
    exportJob.cancel();
    return reply({ cancelled: true });
  });

  handle('game:reveal', target => {
    if (typeof target !== 'string' || !target) throw new Error('路径无效');
    const abs = path.resolve(target);
    if (!fs.existsSync(abs)) throw new Error('文件已不在该位置');
    shell.showItemInFolder(abs);
    return reply({ revealed: true });
  });

  handle('app:finishSaveBeforeClose', result => {
    if (pendingSave && result && result.token === pendingSaveToken) {
      pendingSave({ ok: !!result.ok, message: String(result.message || '') });
    }
    return reply({});
  });
}


/* ---------- 导出用的小工具 ---------- */

async function askExportConflict(file) {
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['覆盖', '选择其他目录', '取消'], defaultId: 1, cancelId: 2, noLink: true,
    message: '目标位置已经有同名文件',
    detail: file + '\n\n覆盖会替换这个文件；选择其他目录会重新挑选导出位置，原文件保持不动。'
  });
  return r.response;
}

/* ICO 容器里最大的一档如果是 PNG 条目就直接用；BMP 条目不做转换，明确要求换格式。 */
function icoToPngDataUrl(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error('不是有效的 ICO 文件');
  }
  const count = buf.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const o = 6 + 16 * i;
    if (o + 16 > buf.length) break;
    const size = buf.readUInt32LE(o + 8);
    const offset = buf.readUInt32LE(o + 12);
    if (!size || offset + size > buf.length) continue;
    const width = buf.readUInt8(o) || 256;
    if (!best || width > best.width) best = { width, offset, size };
  }
  if (!best) throw new Error('ICO 里没有可用的图标');
  const data = buf.subarray(best.offset, best.offset + best.size);
  if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('这个 ICO 用的是旧式 BMP 条目，无法保证清晰度；请导入 PNG / JPEG，或使用 PNG 压缩的新版 ICO');
  }
  return 'data:image/png;base64,' + data.toString('base64');
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
      /* 顺带证明安装包内的示例资源能被定位：不依赖开发机路径。 */
      try { info.sample = sampleMeta(readSample().project); }
      catch (e) { info.sample = { error: e.message }; }
      const ok = !!(info && String(info.url).startsWith('paper://app/') && info.nodes >= 7 &&
        info.host && info.requireType === 'undefined' && info.processType === 'undefined' &&
        info.sample && info.sample.nodes === 45);
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
  /* M3：暂存目录独立于工程目录；异常退出后重启时没有渲染进程引用，可以整体清理。 */
  staging = createStagingManager({ root: path.join(app.getPath('userData'), 'asset-staging') });
  staging.reset();
  store = createProjectStore({ stagingRoot: staging.root });

  protocol.handle('paper', request => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Forbidden', { status: 403 });
      /* 工程素材挂在同一个 paper:// 源下：同源读取，CSP 的 'self' 直接放行，
         不引入跨 scheme 的加载问题。路径仍限定内容寻址文件。 */
      if (url.pathname.startsWith('/asset/')) {
        if (!state.currentDir) return new Response('Not found', { status: 404 });
        const rel = decodeURIComponent(url.pathname.slice(7));
        if (!/^assets\/(images|audio)\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(rel)) {
          return new Response('Not found', { status: 404 });
        }
        const root = path.resolve(state.currentDir);
        const abs = path.resolve(root, ...rel.split('/'));
        if (!abs.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('Not found', { status: 404 });
        const ext = path.extname(abs).toLowerCase();
        const mime = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
          '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
          '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'audio/webm'
        }[ext] || 'application/octet-stream';
        return new Response(new Uint8Array(fs.readFileSync(abs)), {
          status: 200,
          headers: { 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }
        });
      }

      /* M3 暂存素材：只读 userData/asset-staging 下内容寻址文件，文件名即哈希。 */
      if (url.pathname.startsWith('/staging/')) {
        if (!staging) return new Response('Not found', { status: 404 });
        const rel = decodeURIComponent(url.pathname.slice(9));
        const m = /^([a-f0-9]{64})\.([a-z0-9]+)$/i.exec(rel);
        if (!m) return new Response('Not found', { status: 404 });
        const abs = staging.absFor(m[1], m[2]);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('Not found', { status: 404 });
        const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
          '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
          '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'audio/webm'
        }[path.extname(abs).toLowerCase()] || 'application/octet-stream';
        return new Response(new Uint8Array(fs.readFileSync(abs)), {
          status: 200,
          headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }
        });
      }

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

  /* 编辑器素材：只服务「当前工程目录/assets/(images|audio)/<64位哈希>.<ext>」。
     文件按内容命名，天然不可变，可以长缓存；路径规范化后再校验前缀，出不去工程目录。 */
  protocol.handle('paperasset', request => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'project' || !state.currentDir) return new Response('Not found', { status: 404 });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!/^assets\/(images|audio)\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(rel)) {
        return new Response('Not found', { status: 404 });
      }
      const root = path.resolve(state.currentDir);
      const abs = path.resolve(root, ...rel.split('/'));
      if (!abs.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('Not found', { status: 404 });
      const ext = path.extname(abs).toLowerCase();
      const type = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
        '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
        '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'audio/webm'
      }[ext] || 'application/octet-stream';
      return new Response(new Uint8Array(fs.readFileSync(abs)), {
        status: 200,
        headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  /* 预览资源：只认活跃会话，路径必须落在该会话目录内，HTML 带 CSP。 */
  protocol.handle('pvres', request => {
    try {
      const url = new URL(request.url);
      const session = previewSessions.get(url.host);
      if (!session) return new Response('Not found', { status: 404 });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const abs = path.resolve(session.dir, rel);
      if (abs !== session.dir && !abs.startsWith(session.dir + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('Not found', { status: 404 });
      const ext = path.extname(abs).toLowerCase();
      const type = {
        '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
        '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'audio/webm'
      }[ext] || 'application/octet-stream';
      const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      if (type.startsWith('text/html')) headers['content-security-policy'] = PREVIEW_CSP;
      return new Response(new Uint8Array(fs.readFileSync(abs)), { status: 200, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  /* 启动时清掉上次遗留的预览会话目录（窗口异常退出时可能留下）。 */
  try { fs.rmSync(previewRoot(), { recursive: true, force: true }); } catch { /* 忽略 */ }

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  registerIPC();
  rebuildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
/* 正常退出时没有渲染进程引用暂存文件：下一次启动会从工程目录读取正式素材。 */
app.on('before-quit', () => { if (staging) { try { staging.reset(); } catch { /* best effort */ } } });
