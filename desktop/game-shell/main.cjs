'use strict';
/*
 * 纸间 · 通用独立游戏外壳（V0.7.2）。
 *
 * 这个文件被原样复制进每个导出的游戏包，游戏之间只有 content/game.json 不同：
 *   { title, appId, releaseId, window:{width,height,resizable,mode}, csp? }
 *
 * 它只做三件事：固定并隔离身份与用户数据目录、用白名单协议提供随包 HTML、
 * 锁死窗口边界（sandbox + contextIsolation + 无 Node / preload / IPC / 网络）。
 * 与编辑器共用的播放器逻辑一行也不在这里——那部分在 content/index.html 里，
 * 由 dist/game-html.js 生成。
 */
const { app, BrowserWindow, Menu, protocol, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const APP_DIR = __dirname;
const CONFIG_FILE = path.join(APP_DIR, 'content', 'game.json');
const CONTENT_FILE = path.join(APP_DIR, 'content', 'index.html');

/* 配置缺失时用保守默认值：宁可窗口小一点、标题朴素一点，也要能打开。 */
const DEFAULTS = {
  title: '未命名的游戏',
  appId: '',
  releaseId: 'game',
  window: { width: 1280, height: 840, resizable: true, mode: 'window' }
};
let CFG = DEFAULTS;
try {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  CFG = Object.assign({}, DEFAULTS, raw, {
    window: Object.assign({}, DEFAULTS.window, raw && raw.window)
  });
} catch { /* 用默认值，窗口仍会显示内容缺失提示 */ }

const TITLE = String(CFG.title || DEFAULTS.title).slice(0, 120);
const RELEASE_ID = /^[a-z0-9-]{3,64}$/.test(String(CFG.releaseId || '')) ? CFG.releaseId : 'game';
const WIN_W = Math.min(3840, Math.max(640, Math.round(Number(CFG.window.width) || 1280)));
const WIN_H = Math.min(2160, Math.max(480, Math.round(Number(CFG.window.height) || 840)));
const RESIZABLE = CFG.window.resizable !== false;
const FULLSCREEN = CFG.window.mode === 'fullscreen';

const SCHEME = 'papergame';
const APP_URL = SCHEME + '://game/index.html';

/* 资源只来自包内 data: URI；connect-src 'none' 表示页面没有任何联网能力。
 * script-src 的 'unsafe-inline' 是「单文件、零请求」的实现代价：导出的播放器把
 * player.js 与工程数据内联在同一个 <script> 里，页面来源固定，注入面不随内容变化。 */
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; media-src data:; font-src data:; connect-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

/* 每个作品一个独立目录：%APPDATA%\PaperVNStudio-Game-<releaseId>。
 * releaseId 由工程的发行标识决定，与安装路径无关，所以移动游戏目录、换 ZIP/单文件版
 * 都不影响读档；两个同名作品只要发行标识不同，也不会共用存档。 */
function userDataDir() {
  const base = process.env.APPDATA || app.getPath('appData');
  return path.join(base, 'PaperVNStudio-Game-' + RELEASE_ID);
}
app.setPath('userData', userDataDir());
app.setAppUserModelId(CFG.appId || 'cn.papervnstudio.game.' + RELEASE_ID);

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true }
}]);

let win = null;
let lastError = '';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerContentProtocol();
    lockDownSession();
    createWindow();
  });

  app.on('before-quit', () => {
    try { session.defaultSession.flushStorageData(); } catch { /* best effort */ }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('web-contents-created', (_event, contents) => harden(contents));
}

function registerContentProtocol() {
  protocol.handle(SCHEME, async request => {
    let url;
    try { url = new URL(request.url); } catch { return new Response('Bad request', { status: 400 }); }
    if (url.host !== 'game' || url.pathname !== '/index.html') {
      return new Response('Not found', { status: 404 });
    }
    let body;
    try {
      body = fs.readFileSync(CONTENT_FILE);
    } catch (e) {
      lastError = e.message;
      return new Response('游戏内容缺失：content/index.html', { status: 500 });
    }
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store'
      }
    });
  });
}

function lockDownSession() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function harden(contents) {
  contents.on('will-navigate', (event, url) => {
    if (url !== APP_URL) event.preventDefault();
  });
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('render-process-gone', (_event, details) => {
    lastError = '渲染进程结束：' + (details && details.reason);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    minWidth: Math.min(WIN_W, 640), minHeight: Math.min(WIN_H, 480),
    resizable: RESIZABLE,
    fullscreen: FULLSCREEN,
    title: TITLE,
    backgroundColor: '#17261f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      /* 正式包不给 DevTools；验收脚本用 PAPER_GAME_DEVTOOLS=1 显式打开远程调试，
       * 沙箱与隔离配置在两种情况下完全相同。 */
      devTools: !app.isPackaged || process.env.PAPER_GAME_DEVTOOLS === '1'
    }
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-fail-load', (_e, code, desc) => { lastError = code + ' ' + desc; });
  win.webContents.on('did-finish-load', () => {
    if (lastError) {
      dialog.showErrorBox('游戏内容加载失败', '窗口无法打开 content/index.html。\n' + lastError);
    }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(APP_URL);
}
