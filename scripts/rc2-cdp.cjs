'use strict';
/* V0.8.1-RC2 共用：真实窗口 + CDP 的最小工具集。
   只做启动、连接、求值、截图、最小化，不掺业务断言。 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function connect(wsUrl) {
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
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };
  const minimize = async (on) => {
    try {
      const w = await send('Browser.getWindowForTarget');
      await send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: on ? 'minimized' : 'normal' } });
      return true;
    } catch (e) { return String(e.message); }
  };
  return { ws, send, ev, shot, minimize, errors, close: () => { try { ws.close(); } catch {} } };
}
/* 启动一个自带窗口壳的 Electron：窗口可控（置顶 / 最小化），页面用 file:// 加载。 */
function spawnShell(pageFile, { keep = false, shellDir = path.join(ROOT, 'release', 'v081rc2'), extraArgs = [] } = {}) {
  fs.mkdirSync(shellDir, { recursive: true });
  const shell = path.join(shellDir, 'window-shell.cjs');
  if (!fs.existsSync(shell) || keep) {
    fs.writeFileSync(shell, [
      "'use strict';",
      "const { app, BrowserWindow, Menu } = require('electron');",
      "const fs = require('node:fs');",
      'app.whenReady().then(async () => {',
      '  Menu.setApplicationMenu(null);',
      "  const args = process.argv.slice();",
      "  const target = args.slice().reverse().find((a) => /\.html$/i.test(a));",
      '  const win = new BrowserWindow({ width: 1180, height: 760, show: true, alwaysOnTop: true, backgroundColor: "#17261f",',
      '    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });',
      '  win.setMenuBarVisibility(false); win.show(); win.focus();',
      '  if (process.env.PVN_SHELL_TITLE) win.setTitle(process.env.PVN_SHELL_TITLE);',
      '  /* 验收用窗口控制：最小化 / 失焦 / 遮挡都无法从渲染进程直接做，',
      '     所以用「轮询一个命令文件」这种最简单的带外通道，命令只有四种。 */',
      '  const cmdFile = process.env.PVN_WINDOW_CMD;',
      '  let last = "";',
      '  if (cmdFile) setInterval(() => {',
      '    let c = "";',
      '    try { c = fs.readFileSync(cmdFile, "utf8").trim(); } catch { return; }',
      '    if (!c || c === last) return;',
      '    last = c;',
      '    if (c === "min") win.minimize();',
      '    else if (c === "restore") { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }',
      '    else if (c === "blur") win.blur();',
      '    else if (c === "focus") { win.show(); win.focus(); win.moveTop(); }',
      '  }, 250);',
      '  await win.loadFile(target);',
      '});'
    ].join(String.fromCharCode(10)), 'utf8');
  }
  return { shell, spawnCdp: async () => {
    const port = await freePort();
    const cmdFile = path.join(shellDir, 'window-cmd-' + process.pid + '.txt');
    try { fs.writeFileSync(cmdFile, ''); } catch {}
    const env = Object.assign({}, process.env, { PVN_WINDOW_CMD: cmdFile });
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const proc = spawn(ELECTRON, ['--remote-debugging-port=' + port, '--remote-allow-origins=*',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', ...extraArgs, shell, pageFile],
      { cwd: ROOT, stdio: 'ignore', env });
    const page = await waitPage(port, () => true);
    if (!page) { kill(proc); throw new Error('窗口没有出现'); }
    const cdp = await connect(page.webSocketDebuggerUrl);
    const control = async (cmd) => {
      try { fs.writeFileSync(cmdFile, String(cmd)); return true; } catch (e) { return String(e.message); }
    };
    return { proc, cdp, port, control, cmdFile };
  } };
}
function kill(proc) {
  if (!proc) return;
  try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}
module.exports = { ROOT, ELECTRON, sleep, freePort, httpJson, waitPage, connect, spawnShell, kill };
