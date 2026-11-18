'use strict';
/*
 * 《晚风经过二楼走廊》独立试玩包 · 播放器外壳（V0.7 第一阶段）。
 *
 * 这个进程只做三件事：
 *   1. 固定并隔离身份与用户数据目录（%APPDATA%\PaperVNStudio-Game-wanfeng-ch01）；
 *   2. 用 wanfeng:// 白名单协议提供随包的自包含 HTML，不加载任何本机或远程地址；
 *   3. 锁死窗口边界：sandbox + contextIsolation + 无 Node、无 preload、无 IPC、无网络。
 *
 * 不包含编辑器 UI、工程管理 IPC、开发脚本、测试报告与备份。唯一的渲染进程内容
 * 是构建时从 dist/game-html.js 生成、再随包分发的 content/index.html。
 */
const { app, BrowserWindow, Menu, protocol, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const GAME_ID = 'wanfeng-ch01';
const GAME_TITLE = '晚风经过二楼走廊';
const APP_ID = 'cn.papervnstudio.game.wanfeng-ch01';
const SCHEME = 'wanfeng';
const APP_URL = SCHEME + '://game/index.html';
const CONTENT_DIR = path.join(__dirname, 'content');
const CONTENT_FILE = path.join(CONTENT_DIR, 'index.html');

/* 资源只来自包内 data: URI，CSP 不放开任何网络与外部协议。
 * script-src 需要 'unsafe-inline'：导出的播放器把 player.js 与工程数据内联在一个 <script> 里，
 * 这正是「单文件、零请求」的实现方式；页面来源固定为 wanfeng://game，不能被外部页面替换。 */
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; media-src data:; font-src data:; connect-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

/* 存档与音量偏好都落在这个目录：它只属于本游戏。
 * 纸间编辑器用 %APPDATA%\PaperVNStudio，内置示例用该应用内的 persist:papervn-sample 分区，
 * 三者互不共用；解压目录随便移动、改名都不影响读档。 */
function userDataDir() {
  const base = process.env.APPDATA || app.getPath('appData');
  return path.join(base, 'PaperVNStudio-Game-' + GAME_ID);
}
app.setPath('userData', userDataDir());
app.setAppUserModelId(APP_ID);

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true }
}]);

let win = null;
let lastError = '';

/* 单实例：重复双击只把已有窗口提到前面，避免两个进程同时写同一份存档。 */
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

  /* 关窗前把 localStorage（存档、音量偏好）刷到磁盘，避免「保存后立刻退出」丢档。 */
  app.on('before-quit', () => {
    try { session.defaultSession.flushStorageData(); } catch { /* best effort */ }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('web-contents-created', (_event, contents) => harden(contents));
}

/* 白名单协议：只服务 content/index.html 一个文件，其余一律 404。
 * 路径不接受参数、不接受目录穿越，也不读包外文件。 */
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

/* 断网也能玩 = 不依赖网络，同时也别偷偷联网：http(s)/ws 请求一律取消。 */
function lockDownSession() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

/* 导航、弹窗、webview 全部拒绝：窗口只认自己的那一页。 */
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
    width: 1280, height: 840, minWidth: 960, minHeight: 620,
    title: GAME_TITLE,
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
