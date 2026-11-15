'use strict';
/* Static boundary checks: these catch regressions that would silently turn the
 * desktop build into an unsandboxed browser window or break the paper:// allow-list. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const main = read('desktop/main.cjs');
const preload = read('desktop/preload.cjs');
const html = read('dist/index.html');
const app = read('dist/app.js');

for (const required of [
  'contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webSecurity: true',
  'app.enableSandbox()', 'registerSchemesAsPrivileged', 'protocol.handle(',
  'will-navigate', 'will-redirect', 'will-attach-webview', 'win.webContents.setWindowOpenHandler',
  'setPermissionRequestHandler', 'event.sender !== win.webContents',
  "script-src 'self'", 'loadURL(APP_URL)', 'project:bootstrap'
]) assert(main.includes(required), 'main process missing: ' + required);
assert(!/[^.]\bwin\.setWindowOpenHandler\b/.test(main), 'setWindowOpenHandler belongs to webContents, not BrowserWindow');
for (const forbidden of [
  'nodeIntegration: true', 'contextIsolation: false', 'webSecurity: false',
  'allowRunningInsecureContent: true', 'shell.openExternal', "loadURL('http", 'nodeIntegrationInWorker: true'
]) assert(!main.includes(forbidden), 'unsafe main process option: ' + forbidden);
console.log('  ok  window is sandboxed, context-isolated, navigation and permissions are locked down');

/* Every local asset referenced by index.html must be on the paper:// allow-list. */
const refs = [
  ...[...html.matchAll(/<script src="([^"]+)"/g)].map(m => '/' + m[1]),
  ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map(m => '/' + m[1])
];
const allowed = [...main.matchAll(/'(\/[^']+)':\s*'text\//g)].map(m => m[1]);
assert(refs.length >= 7, 'index.html should load the editor scripts');
for (const r of refs) assert(allowed.includes(r), 'missing paper:// allow-list entry: ' + r);
assert(/script-src 'self'/.test(html), 'web build also declares a CSP');
console.log('  ok  index.html resources are covered by the fixed protocol allow-list and CSP');

/* The preload must be a fixed channel list; each channel has a validated main handler. */
const channels = [...preload.matchAll(/call\('([^']+)'/g)].map(m => m[1]);
const handled = [...main.matchAll(/handle\('([^']+)'/g)].map(m => m[1]);
const listened = [...main.matchAll(/ipcMain\.on\('([^']+)'/g)].map(m => m[1]);
const sent = new Set([...main.matchAll(/\.send\('([^']+)'/g)].map(m => m[1]));
assert(channels.length >= 10, 'preload should expose the project/file operations');
for (const c of channels) assert(handled.includes(c) || listened.includes(c), 'preload channel has no main handler: ' + c);
for (const c of [...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map(m => m[1])) {
  assert(sent.has(c), 'renderer listens to a channel the main process never sends: ' + c);
}
for (const forbidden of ["require('node:fs')", 'require("fs")', 'require("node:path")', 'ipcRenderer.send(', 'shell.', 'window.require']) {
  assert(!preload.includes(forbidden), 'preload leaks privileged access: ' + forbidden);
}
assert(preload.includes('contextBridge.exposeInMainWorld'), 'preload must use contextBridge');
console.log('  ok  narrow IPC surface, every channel validated and implemented');

for (const required of [
  'UNSAVED_CHOICE', '保存并继续', '放弃修改', '取消', 'requestRendererSave',
  'promoteAutosave', 'app:saveBeforeClose', 'state.dirty = false; state.closing = true; win.close()'
]) assert(main.includes(required), 'close-with-unsaved-work flow missing: ' + required);
assert(main.includes("handle('app:finishSaveBeforeClose'"), 'save-before-close reply must be an invoke/handle pair');
console.log('  ok  save / discard / cancel on close, failure keeps the window open');

/* The renderer adapter must await the IPC result before validating it: passing
 * the pending Promise into ok() reads an undefined .ok and reports a bogus
 * "desktop file operation failed" for save / open / new / startup recovery. */
const bridge = read('dist/desktop-bridge.js');
assert(!/ok\(api\./.test(bridge), 'bridge must unwrap the IPC Promise before ok(): ok(api.x()) always throws');
for (const line of [
  'bootstrap: () => call(() => api.bootstrap())',
  'save: p => call(() => api.save(p))',
  'saveAs: p => call(() => api.saveAs(p))',
  'newProject: () => call(() => api.newProject())',
  'open: () => call(() => api.open())',
  'openRecent: index => call(() => api.openRecent(index))',
  'recent: () => call(() => api.recent())'
]) assert(bridge.includes(line), 'bridged operation must resolve before validating: ' + line);
console.log('  ok  every bridged file operation resolves its async result before validation');

assert(!/require\(/.test(app), 'renderer editor must not use Node require');
assert(!/window\.require|process\.versions|__dirname/.test(app), 'renderer editor must not reach Node globals');
assert(/const H=window\.PaperHost\|\|null/.test(app), 'web build keeps its native path when the adapter is absent');
console.log('  ok  editor renderer has no Node/fs/shell access and web path is preserved');

console.log('PASS: desktop security boundary, protocol allow-list and IPC surface');
