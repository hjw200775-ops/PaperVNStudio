'use strict';
/*
 * V0.6.2 内置示例、标题背景与复制创作的真实窗口验收。
 *
 *   npm run sample:acceptance
 *
 * 复用《晚风》45 节点原作模板与本机 Electron 主进程：
 *  - 编辑器点「体验示例」→ 独立窗口 + 独立持久分区，从标题页开始；
 *  - 编辑器点「复制示例开始创作」→ 原生目录对话框被替换为固定返回值（脚本无法点真人对话框）；
 *  - 标题背景在真实窗口保存、重开、导出，缺失素材回退默认样式；
 *  - 导出 HTML 在断网会话里打开。
 * 注入的鼠标/键盘事件不是真人点击，报告里如实区分。
 */
const { app, BrowserWindow, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const createStore = require('../desktop/project-store.cjs');
const createVNCore = require('../dist/core.js');
const { buildPlayerHTML } = require('../dist/game-html.js');

const OUT = process.env.WANFENG_OUT || 'F:/Wanfeng-Demo';
const RESULT = path.join(OUT, '验收结果-v062');
const EXPORT = path.join(RESULT, 'wanfeng-home-title.html');
const REPORT = path.join(RESULT, '验收报告-v062.json');
const SAMPLE = path.resolve(__dirname, '..', 'dist', 'samples', 'wanfeng-ch01');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-sample-userdata-'));
app.setPath('userData', userData);
require('../desktop/main.cjs');

const store = createStore();
const C = createVNCore();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const report = { startedAt: new Date().toISOString(), checks: [],
  unverified: [
    '真人点击（脚本注入鼠标/键盘事件；复制用固定对话框返回值代替真人选择目录）',
    '人工视觉与听感审阅',
    '复制过程中磁盘写入失败的清理路径（无法安全制造磁盘错误）',
    '第二台电脑与安装包'
  ] };
function check(name, fn) { fn(); report.checks.push(name); console.log('  ok  ' + name); }
async function shot(win, name) {
  fs.mkdirSync(RESULT, { recursive: true });
  fs.writeFileSync(path.join(RESULT, name + '.png'), (await win.webContents.capturePage()).toPNG());
  (report.screenshots || (report.screenshots = [])).push(name + '.png');
}
async function run(win, js) { return JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(' + js + ')')); }
async function realClick(win, sel) {
  await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e&&e.scrollIntoView)e.scrollIntoView({block:'center'});return true})()`);
  await sleep(150);
  const box = JSON.parse(await win.webContents.executeJavaScript(
    `JSON.stringify((()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;
      const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})())`));
  if (!box) throw new Error('找不到可点击元素：' + sel);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'])
    await win.webContents.sendInputEvent({ type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(240);
}
function hashTree(dir) {
  const out = {};
  const walk = rel => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const r = path.join(rel, name);
      const abs = path.join(dir, r);
      if (fs.statSync(abs).isDirectory()) walk(r); else out[r] = sha(fs.readFileSync(abs));
    }
  };
  walk('');
  return out;
}
/* 主进程的 dialog 是同一个对象：替换方法即可让脚本走真实 IPC 流程。 */
const realOpen = dialog.showOpenDialog, realSave = dialog.showSaveDialog;
const stubOpen = value => { dialog.showOpenDialog = async () => value; };

async function main() {
  await app.whenReady();
  fs.mkdirSync(RESULT, { recursive: true });
  let editor = null;
  for (let k = 0; k < 80; k++) {
    editor = BrowserWindow.getAllWindows().find(w => {
      try { return w.webContents.getURL().startsWith('paper://app/') } catch { return false }
    });
    if (editor && !editor.webContents.isLoading()) break;
    await sleep(120);
  }
  assert(editor, '编辑器窗口存在');
  await sleep(900);
  const errors = [];
  editor.webContents.on('console-message', (...args) => {
    const d = args[0], level = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
    if (level >= 2) errors.push(String((d && d.message) || args[2]));
  });

  const sampleDisk = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'project.paper.json'), 'utf8'));
  const sampleProject = store.diskToRuntime(SAMPLE, sampleDisk);
  const homeAsset = sampleProject.assets.find(a => a.id === 'bg_home');
  const schoolAsset = sampleProject.assets.find(a => a.id === 'bg_school');
  const beforeHashes = hashTree(SAMPLE);
  const recentFile = path.join(userData, 'recent-projects.json');
  const draftFile = path.join(userData, 'drafts', 'backups', 'autosave', 'project.paper.json');
  const recentBefore = fs.existsSync(recentFile) ? sha(fs.readFileSync(recentFile)) : '';
  const draftBefore = fs.existsSync(draftFile) ? sha(fs.readFileSync(draftFile)) : '';
  const editorBefore = await run(editor, `({id:p.id,title:p.title,nodes:p.nodes.length,dir:window.PaperHost?1:0})`);

  /* ---------- 1. 示例入口：卡片显示真实节点数 ---------- */
  await realClick(editor, '.tabs [data-tab="title"]');
  await sleep(400);
  const card = await run(editor, `({nodes:document.querySelector('#sampleNodes').textContent,
    title:document.querySelector('.sample-card h3').textContent,
    play:!document.querySelector('#samplePlay').hidden,
    copy:!document.querySelector('#sampleCopy').hidden})`);
  check('编辑器示例卡片：标题、45 节点、体验与复制入口可见', () => {
    assert.equal(card.nodes, '45');
    assert.match(card.title, /晚风经过二楼走廊/);
    assert.equal(card.play, true);
    assert.equal(card.copy, true);
  });
  await shot(editor, '01-示例入口');

  /* ---------- 2. 体验示例：独立窗口、独立分区、从标题页开始 ---------- */
  await realClick(editor, '#samplePlay');
  let sampleWin = null;
  for (let k = 0; k < 80; k++) {
    sampleWin = BrowserWindow.getAllWindows().find(w => {
      try { return w.webContents.getURL().includes('game-sample.html') } catch { return false }
    });
    if (sampleWin) break;
    await sleep(150);
  }
  assert(sampleWin, '打开示例窗口');
  await sleep(900);
  const st0 = await run(sampleWin, 'window.paperGameState()');
  const sampleSession = session.fromPartition('persist:papervn-sample');
  check('体验示例：独立窗口 + 独立持久分区，从标题页开始且不自动播放音频', () => {
    assert.equal(st0.state, 'title');
    assert.equal(st0.nodes, 45);
    assert.equal(st0.titleBg, true, '标题页使用家中走廊背景');
    assert.equal(st0.saveOk, false, '首次体验没有存档');
    assert.equal(sampleWin.webContents.session, sampleSession, '使用示例专用存储分区');
    assert.notEqual(sampleSession, session.defaultSession, '与编辑器默认会话隔离');
    assert.equal(st0.hasAudio, false, '原作节选不含音频素材');
    assert.equal(st0.audio, null, '没有创建播放层，标题页不会自动播放');
  });
  await shot(sampleWin, '02-家中走廊标题页');

  /* 较小窗口：标题与三个按钮仍在视口内，不被背景布局裁切 */
  sampleWin.setSize(760, 640);
  await sleep(500);
  const fits = await run(sampleWin, `['#startGame','#continueGame','#titleSettings','#title'].map(id=>{
    const e=document.querySelector(id);if(!e)return {id,ok:false};
    const r=e.getBoundingClientRect();
    return {id,ok:r.left>=-1&&r.top>=-1&&r.right<=window.innerWidth+1&&r.bottom<=window.innerHeight+1};
  })`);
  check('小窗口下标题与按钮不被裁切', () => {
    for (const f of fits) assert(f.ok, f.id + ' 在视口内');
  });
  sampleWin.setSize(1200, 860);
  await sleep(300);

  /* ---------- 3. 体验不改当前工程 / 草稿 / 最近工程；模板哈希不变 ---------- */
  const editorAfter = await run(editor, `({id:p.id,title:p.title,nodes:p.nodes.length})`);
  const recentAfter = fs.existsSync(recentFile) ? sha(fs.readFileSync(recentFile)) : '';
  const draftAfter = fs.existsSync(draftFile) ? sha(fs.readFileSync(draftFile)) : '';
  const afterHashes = hashTree(SAMPLE);
  check('体验示例不改动当前工程、草稿、最近工程与模板文件', () => {
    assert.deepEqual(editorAfter, { id: editorBefore.id, title: editorBefore.title, nodes: editorBefore.nodes });
    assert.equal(recentAfter, recentBefore, '最近工程未变化');
    assert.equal(draftAfter, draftBefore, '草稿未变化');
    assert.deepEqual(afterHashes, beforeHashes, '模板文件哈希一致');
  });

  /* ---------- 4. 开始游戏：正文仍用原作场景，标题图没有替换正文 ---------- */
  await realClick(sampleWin, '#startGame');
  await sleep(700);
  const first = await run(sampleWin, `({state:window.paperGameState().state,i:window.paperGameState().i,
    text:document.querySelector('#text').textContent,
    bg:document.querySelector('#layers [data-layer="background"] img').src,
    layers:document.querySelectorAll('#layers .visual-layer').length})`);
  check('开始游戏进入首句，正文背景仍是林家早餐场景', () => {
    assert.equal(first.state, 'playing');
    assert.equal(first.i, 0);
    assert.equal(first.text, '九月。开学后的第二周。');
    assert.equal(first.bg, homeAsset.data, '正文使用原 bg_home，不是标题图');
    assert(first.layers >= 2, '两人同场');
  });

  /* ---------- 5. 走到 road_17 检查特写/虚化，再到 demo_end ---------- */
  let closeup = null, schoolSeen = false;
  for (let step = 0; step < 60; step++) {
    const info = await run(sampleWin, `({i:window.paperGameState().i,
      text:document.querySelector('#text').textContent,
      hint:document.querySelector('#hint').textContent,
      bg:(document.querySelector('#layers [data-layer="background"] img')||{}).src||'',
      fx:(()=>{const l=document.querySelector('#layers [data-layer="linyou"]');
        return l?l.style.transform+'|'+l.style.filter:''})()})`);
    if (info.text === '林澈！' && !closeup) closeup = info.fx;
    if (info.bg === schoolAsset.data) schoolSeen = true;
    if (/故事结束/.test(info.hint)) break;
    await realClick(sampleWin, '#scene');
  }
  const ended = await run(sampleWin, `({hint:document.querySelector('#hint').textContent,
    i:window.paperGameState().i})`);
  check('原作可从 home_01 走到 demo_end，road_17 特写与背景虚化仍在', () => {
    assert.match(ended.hint, /故事结束/);
    assert.equal(ended.i, 44, '停在最后一个节点');
    assert(schoolSeen, '学校场景仍在正文中出现');
    assert(closeup && /scale/.test(closeup), 'road_17 林悠近景缩放生效：' + closeup);
    assert(closeup && /blur/.test(closeup), 'road_17 背景虚化生效：' + closeup);
  });

  /* ---------- 6. 示例存档稳定：保存 → 返回标题 → 再次体验可继续 ---------- */
  await realClick(sampleWin, '#menuBtn');
  await realClick(sampleWin, '#save');
  const sampleKey = 'paper-game-' + sampleProject.id;
  const savedRaw = await sampleWin.webContents.executeJavaScript(`localStorage.getItem(${JSON.stringify(sampleKey)})`);
  assert(savedRaw, '示例存档写入分区');
  const savedProjectTrail = JSON.parse(savedRaw).trail;
  await realClick(sampleWin, '#menuTitle');
  const back = await run(sampleWin, 'window.paperGameState()');
  check('返回标题后继续按钮可用，示例存档只在示例分区', () => {
    assert.equal(back.state, 'title');
    assert.equal(back.saveOk, true);
  });
  sampleWin.close();
  await sleep(400);
  await realClick(editor, '#samplePlay');
  let second = null;
  for (let k = 0; k < 80; k++) {
    second = BrowserWindow.getAllWindows().find(w => {
      try { return w.webContents.getURL().includes('game-sample.html') } catch { return false }
    });
    if (second) break;
    await sleep(150);
  }
  await sleep(800);
  const again = await run(second, `({state:window.paperGameState().state,saveOk:window.paperGameState().saveOk,
    note:document.querySelector('#titleNote').textContent})`);
  check('再次体验读取同一份示例存档（稳定示例身份）', () => {
    assert.equal(again.state, 'title');
    assert.equal(again.saveOk, true, '仍然能看到上次存档');
    assert.match(again.note, /继续游戏会回到/);
  });
  await realClick(second, '#continueGame');
  await sleep(600);
  const resumed = await run(second, 'window.paperGameState()');
  const savedNode = JSON.parse(savedRaw).id;
  check('继续游戏回到保存的那一句', () => {
    assert.equal(resumed.state, 'playing');
    assert.equal(resumed.trail.length, savedProjectTrail.length, 'trail 与存档一致');
    assert.equal(savedNode, 'demo_end');
    assert.equal(resumed.i, 44, '回到 demo_end');
  });
  second.close();
  await sleep(300);

  /* ---------- 7. 复制示例：取消 / 非空目录 / 成功 ---------- */
  const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-sample-copy-'));
  stubOpen({ canceled: true, filePaths: [] });
  await realClick(editor, '#sampleCopy');
  await sleep(600);
  const cancelled = await run(editor, `({note:document.querySelector('#sampleNote').textContent,id:p.id})`);
  check('取消复制：当前工程与草稿不变', () => {
    assert.match(cancelled.note, /已取消/);
    assert.equal(cancelled.id, editorBefore.id);
  });

  const busy = path.join(copyRoot, 'busy');
  fs.mkdirSync(busy, { recursive: true });
  fs.writeFileSync(path.join(busy, '别人的文件.txt'), 'keep me', 'utf8');
  stubOpen({ canceled: false, filePaths: [busy] });
  await realClick(editor, '#sampleCopy');
  await sleep(700);
  const conflict = await run(editor, `({note:document.querySelector('#sampleNote').textContent})`);
  check('目标目录非空：明确拒绝，不覆盖不合并', () => {
    assert.match(conflict.note, /不是空目录/);
    assert.equal(fs.readFileSync(path.join(busy, '别人的文件.txt'), 'utf8'), 'keep me', '用户文件原样保留');
    assert(!fs.existsSync(path.join(busy, 'project.paper.json')), '没有写入工程文件');
  });

  const target = path.join(copyRoot, 'copy');
  fs.mkdirSync(target, { recursive: true });
  stubOpen({ canceled: false, filePaths: [target] });
  await realClick(editor, '#sampleCopy');
  await sleep(1600);
  const copied = await run(editor, `({id:p.id,title:p.title,nodes:p.nodes.length,bg:p.titleBackground,
    saved:document.querySelector('#saved').textContent,
    recent:document.querySelector('#recentList').options[1]?document.querySelector('#recentList').options[1].textContent:'',
    path:document.querySelector('#projectPath').textContent})`);
  check('复制成功：编辑器打开副本，新工程 ID、45 节点、标题背景保留', () => {
    assert.notEqual(copied.id, sampleProject.id, '副本 ID 与模板不同');
    assert.notEqual(copied.id, editorBefore.id, '副本 ID 与之前的工程不同');
    assert.equal(copied.nodes, 45);
    assert.equal(copied.bg, 'asset_title_home_corridor');
    assert(/已复制|已打开|已自动保存|正在保存/.test(copied.saved), '状态栏：' + copied.saved);
    assert.match(copied.path, /copy/);
    assert.match(copied.recent, /copy/, '副本进入最近工程');
  });
  await editor.webContents.executeJavaScript('window.scrollTo(0,0)');
  await sleep(250);
  await shot(editor, '03-复制后工程');
  const copyOnDisk = store.openProject(target);
  check('副本落盘可重开：内部引用有效，存档键独立', () => {
    assert.equal(copyOnDisk.project.id, copied.id);
    assert.equal(copyOnDisk.project.nodes.length, 45);
    assert.deepEqual(C.analyze(copyOnDisk.project).errors, []);
    assert.notEqual('paper-game-' + copyOnDisk.project.id, 'paper-game-' + sampleProject.id);
    assert.deepEqual(hashTree(SAMPLE), beforeHashes, '复制后模板仍未被改动');
  });

  /* ---------- 8. 标题背景：界面设置 / 清除 / 重新设置，并导出 ---------- */
  await realClick(editor, '.tabs [data-tab="title"]');
  await sleep(300);
  const bgUi = await run(editor, `({label:document.querySelector('#titleBgLabel').textContent,
    thumb:!document.querySelector('#titleBgThumb').hidden,
    value:document.querySelector('#titleBgAsset').value})`);
  check('标题页标签显示当前标题背景', () => {
    assert.match(bgUi.label, /家中二楼走廊/);
    assert.equal(bgUi.thumb, true);
    assert.equal(bgUi.value, 'asset_title_home_corridor');
  });
  await editor.webContents.executeJavaScript(
    `(()=>{const e=document.querySelector('#titleBgPreview');if(e)e.scrollIntoView({block:'center'});return true})()`);
  await sleep(300);
  await shot(editor, '04-标题背景设置');

  await editor.webContents.executeJavaScript(`(()=>{const s=document.querySelector('#titleBgAsset');
    s.value='bg_home';return true})()`);
  await realClick(editor, '#titleBgApply');
  await sleep(350);
  const applied = await run(editor, `({bg:p.titleBackground})`);
  await realClick(editor, '#titleBgClear');
  await sleep(300);
  const cleared = await run(editor, `({bg:p.titleBackground,label:document.querySelector('#titleBgLabel').textContent})`);
  check('标题背景可设置、可清除回默认样式', () => {
    assert.equal(applied.bg, 'bg_home');
    assert.equal(cleared.bg, '');
    assert.match(cleared.label, /默认标题页样式/);
  });
  await editor.webContents.executeJavaScript(`(()=>{const s=document.querySelector('#titleBgAsset');
    s.value='asset_title_home_corridor';return true})()`);
  await realClick(editor, '#titleBgApply');
  await sleep(300);

  /* 保存并重开：标题背景进入工程文件 */
  const savedReply = JSON.parse(await editor.webContents.executeJavaScript(
    `window.PaperHost.save(p).then(r=>JSON.stringify(r))`));
  assert(savedReply && savedReply.ok, '保存成功');
  const reopened = store.openProject(target);
  check('保存后重开：标题背景仍在工程里', () => {
    assert.equal(reopened.project.titleBackground, 'asset_title_home_corridor');
  });

  /* 导出：对话框替换为固定路径，走真实 file:save 通道 */
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: EXPORT });
  await realClick(editor, '#export');
  await sleep(1200);
  assert(fs.existsSync(EXPORT), '导出文件已写入');
  const html = fs.readFileSync(EXPORT, 'utf8');
  check('导出 HTML 自包含：标题背景内嵌、无网络与本机路径', () => {
    assert(html.includes('id="titleBg"'));
    assert(html.includes('data:image/png;base64,'));
    const structural = html.split('<script>')[0];
    assert(!/https?:\/\//.test(structural), '结构部分没有网络地址');
    assert(!/[A-Za-z]:\\/.test(structural), '没有本机绝对路径');
    assert(!/src="(?!data:)/.test(structural), '没有外部资源');
  });

  /* 断网会话里打开导出 HTML */
  const offlineWin = new BrowserWindow({ width: 1100, height: 800, show: true, title: '断网验收',
    backgroundColor: '#17261f', webPreferences: { sandbox: true, contextIsolation: true,
      partition: 'persist:papervn-offline-v062' } });
  const requests = [];
  offlineWin.webContents.session.webRequest.onBeforeRequest((details, cb) => {
    requests.push(details.url); cb({});
  });
  await offlineWin.webContents.session.enableNetworkEmulation({ offline: true });
  await offlineWin.loadFile(EXPORT);
  await sleep(900);
  const offlineState = await run(offlineWin, 'window.paperGameState()');
  check('断网打开导出 HTML：标题页正常、背景已渲染、无网络请求', () => {
    assert.equal(offlineState.state, 'title');
    assert.equal(offlineState.titleBg, true);
    assert(requests.every(u => u.startsWith('file://')), '只有本地文件请求：' + requests.slice(0, 3).join(','));
  });
  await offlineWin.webContents.session.enableNetworkEmulation({ offline: false });
  await offlineWin.close();

  /* ---------- 9. 缺素材：回退默认样式并提示，不崩溃 ---------- */
  const brokenProject = JSON.parse(JSON.stringify(sampleProject));
  brokenProject.titleBackground = 'missing_asset';
  const brokenFile = path.join(RESULT, 'missing-title-bg.html');
  fs.writeFileSync(brokenFile, buildPlayerHTML(brokenProject), 'utf8');
  const brokenWin = new BrowserWindow({ width: 900, height: 700, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, partition: 'persist:papervn-broken-v062' } });
  await brokenWin.loadFile(brokenFile);
  await sleep(700);
  const broken = await run(brokenWin, `({state:window.paperGameState().state,bg:window.paperGameState().titleBg,
    note:document.querySelector('#titleBgNote').textContent,noteHidden:document.querySelector('#titleBgNote').hidden,
    startDisabled:document.querySelector('#startGame').disabled})`);
  check('标题背景素材缺失：回退默认样式并提示，仍可开始游戏', () => {
    assert.equal(broken.bg, false);
    assert.equal(broken.noteHidden, false);
    assert.match(broken.note, /缺失/);
    assert.equal(broken.startDisabled, false);
  });
  await brokenWin.close();

  /* ---------- 10. 模板只读：只读取与复制，不写入安装目录 ---------- */
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-sample-ro-'));
  fs.cpSync(SAMPLE, path.join(ro, 'wanfeng-ch01'), { recursive: true });
  const roDir = path.join(ro, 'wanfeng-ch01');
  const roHash = hashTree(roDir);
  try { for (const f of fs.readdirSync(roDir)) fs.chmodSync(path.join(roDir, f), 0o444); } catch { /* Windows 可能忽略 */ }
  const roProject = store.diskToRuntime(roDir, JSON.parse(fs.readFileSync(path.join(roDir, 'project.paper.json'), 'utf8')));
  const roHtml = buildPlayerHTML(roProject);
  check('模板在只读属性下仍可读取并生成体验 HTML，文件哈希不变', () => {
    assert(roHtml.includes('id="titleBg"'));
    assert.deepEqual(hashTree(roDir), roHash, '没有写入模板目录');
  });

  check('整个流程没有渲染进程错误', () => assert.equal(errors.length, 0, errors.join(' | ')));

  dialog.showOpenDialog = realOpen;
  dialog.showSaveDialog = realSave;
  fs.writeFileSync(REPORT, JSON.stringify({ ...report, finishedAt: new Date().toISOString(),
    sample: { dir: SAMPLE, id: sampleProject.id, nodes: sampleProject.nodes.length },
    export: EXPORT, copiedTo: target, checks: report.checks }, null, 2));
  console.log('SAMPLE_ACCEPTANCE PASS');
  console.log('RESULT_DIR=' + RESULT);
  console.log('COPIED_TO=' + target);
  app.exit(0);
}
main().catch(async e => {
  console.error('SAMPLE_ACCEPTANCE FAILED: ' + (e.stack || e));
  try { fs.writeFileSync(path.join(RESULT, '验收失败-v062.txt'), String(e.stack || e)); } catch { /* best effort */ }
  dialog.showOpenDialog = realOpen; dialog.showSaveDialog = realSave;
  app.exit(1);
});
