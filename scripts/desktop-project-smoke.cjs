'use strict';
/*
 * End-to-end check of the real main process (desktop/main.cjs) for the project
 * lifecycle: 新建工程 → 添加节点 → 保存 → 再次打开。
 *
 * Native dialogs cannot be clicked from a script, so this wrapper answers them
 * from a queue and then drives the real UI. Everything else (window, protocol,
 * preload, IPC handlers, project store) is the production code path.
 *
 *   npm run desktop:smoke:project
 */
const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-project-smoke-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-project-userdata-'));
app.setPath('userData', userData);            // hermetic: no recent list, no draft

const openQueue = [];
const messageQueue = [];
dialog.showOpenDialog = async () => {
  const next = openQueue.shift();
  return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
};
dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
dialog.showMessageBox = async () => ({ response: messageQueue.length ? messageQueue.shift() : 1 });

require('../desktop/main.cjs');               // the real entry point

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAIN = path.join(projectDir, 'project.paper.json');
const disk = () => JSON.parse(fs.readFileSync(MAIN, 'utf8'));
let win = null;

async function waitForLoad() {
  for (let i = 0; i < 100; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading() && win.webContents.getURL()) return;
    await sleep(100);
  }
  throw new Error('桌面窗口没有加载完成');
}
const run = js => win.webContents.executeJavaScript(js);
const savedText = () => run('document.querySelector("#saved").textContent');

async function main() {
  await app.whenReady();
  await waitForLoad();
  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const d = args[0];
    const level = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
    const message = d && typeof d === 'object' && 'message' in d ? d.message : args[2];
    if (level >= 2) errors.push(String(message));
  });
  await sleep(400);

  assert(fs.existsSync(path.join(userData, 'drafts')), 'main process created its draft directory');

  // 1. 新建工程
  openQueue.push(projectDir);
  await run('document.querySelector("#new").click()');
  await sleep(900);
  assert(fs.existsSync(MAIN), '新建工程 wrote project.paper.json into the chosen directory');
  assert.equal(disk().title, '未命名的故事');
  assert.equal(disk().nodes.length, 1, '新建工程 seeds one editable dialogue node instead of an empty story');
  const linked = await run('({path:document.querySelector("#projectPath").textContent,saved:document.querySelector("#saved").textContent})');
  assert(linked.path.includes(path.basename(projectDir)), 'renderer shows the linked project directory: ' + linked.path);
  assert(!linked.saved.includes('失败'), 'new project reported no failure: ' + linked.saved);
  console.log('  ok  新建工程 creates a real project directory and reports the state back');

  // 2. 添加节点并修改标题后保存
  await run('document.querySelector("#add").click()');
  await sleep(200);
  await run('(()=>{const t=document.querySelector("#title");t.value="端到端 标题";t.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await sleep(500);
  await run('document.querySelector("#save").click()');
  await sleep(900);
  assert.equal(disk().title, '端到端 标题', '保存 writes the edited title without asking for a directory again');
  assert.equal(disk().nodes.length, 2, 'saved project holds the starting node and the added node');
  assert((await savedText()).startsWith('已保存'), 'renderer received the save result: ' + await savedText());
  console.log('  ok  保存 writes to the linked directory and resolves the state');

  // 3. 重新打开同一个工程目录
  messageQueue.push(0);              // 未保存修改 → 保存并继续
  messageQueue.push(0);              // 打开哪一种 → 工程目录
  openQueue.push(projectDir);
  await run('document.querySelector("#add").click()');   // make it dirty again
  await sleep(300);
  await run('document.querySelector("#open").click()');
  await sleep(1200);
  const reopened = await run('({nodes:document.querySelectorAll("#list .node").length,title:document.querySelector("#title").value})');
  assert.equal(reopened.nodes, 2, '打开的工程渲染出磁盘上的节点');
  assert.equal(reopened.title, '端到端 标题');
  console.log('  ok  打开工程 by directory restores the saved nodes and title');

  await sleep(200);
  assert.equal(errors.length, 0, 'no renderer console errors: ' + errors.join(' | '));

  console.log('PASS: real main process - new project, edit, save, reopen');
  console.log('PROJECT_SMOKE_DIR=' + projectDir);
}

main().then(() => app.exit(0)).catch(err => {
  console.error('PROJECT SMOKE FAILED: ' + (err && err.stack));
  app.exit(1);
});
