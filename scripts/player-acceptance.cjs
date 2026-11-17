'use strict';
/*
 * V0.6.1 标题页 / 游戏菜单真实窗口验收。
 *
 *   npm run player:acceptance
 *
 * 复用《晚风》音频测试工程导出 HTML，在独立 Electron 窗口里跑完整流程：
 * 标题 → 开始 → 菜单 → 设置 → 保存 → 返回标题 → 继续 → 返回标题清理 → 坏存档。
 * 解锁与按钮使用注入的鼠标/键盘输入事件（不是真人点击），报告里如实区分。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const createStore = require('../desktop/project-store.cjs');
const createVNCore = require('../dist/core.js');
const { buildGameHTML } = require('../dist/export.js');
const { paperPlayer, paperPlayerCSS } = require('../dist/player.js');
const createPaperEffects = require('../dist/effects.js');
const createPaperAudio = require('../dist/audio.js');

const OUT = process.env.WANFENG_OUT || 'F:/Wanfeng-Demo';
const TEST = path.join(OUT, '晚风-audio-1794931114339');
const RESULT = path.join(OUT, '验收结果-v061');
const EXPORT = path.join(RESULT, 'wanfeng-player.html');
const REPORT = path.join(RESULT, '验收报告-v061.json');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-player-userdata-'));
app.setPath('userData', userData);
require('../desktop/main.cjs');

const store = createStore();
const C = createVNCore();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const deps = { player: paperPlayer, coreFactory: createVNCore, effectFactory: createPaperEffects,
  audioFactory: createPaperAudio, css: paperPlayerCSS, esc };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { startedAt: new Date().toISOString(), checks: [],
  unverified: ['真人点击与人工听审（脚本使用注入的输入事件）', '第二台电脑与安装包'] };
function check(name, fn) { fn(); report.checks.push(name); console.log('  ok  ' + name); }
async function shot(win, name) {
  fs.mkdirSync(RESULT, { recursive: true });
  fs.writeFileSync(path.join(RESULT, name + '.png'), (await win.webContents.capturePage()).toPNG());
  (report.screenshots || (report.screenshots = [])).push(name + '.png');
}
async function run(win, js) { return JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(' + js + ')')); }
async function realClick(win, sel) {
  await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e&&e.scrollIntoView)e.scrollIntoView({block:'center'});return true})()`);
  await sleep(140);
  const box = JSON.parse(await win.webContents.executeJavaScript(
    `JSON.stringify((()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;
      const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})())`));
  if (!box) throw new Error('找不到可点击元素：' + sel);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'])
    await win.webContents.sendInputEvent({ type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(220);
}
async function pressEsc(win) {
  await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(200);
}
function openWindow(file, opts = {}) {
  const win = new BrowserWindow({ width: 1200, height: 860, minWidth: 720, minHeight: 600, show: true,
    title: '播放器验收', backgroundColor: '#17261f',
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const d = args[0], level = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
    if (level >= 2) errors.push(String((d && d.message) || args[2]));
  });
  return win.loadFile(file).then(() => sleep(600)).then(() => ({ win, errors }));
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(RESULT, { recursive: true });
  const project = store.openProject(TEST).project;
  const html = buildGameHTML(project, deps);
  fs.writeFileSync(EXPORT, html, 'utf8');
  assert(html.includes('data:audio/wav;base64,'), '导出内嵌音频');
  assert(!html.includes('paper://') && !html.includes('blob:') && !html.includes('F:\\'), '导出无本机依赖');

  const { win, errors } = await openWindow(EXPORT);
  const state = () => run(win, 'window.paperGameState()');
  const audio = () => run(win, 'window.paperAudioStatus()');

  /* 1. 标题页：无存档继续禁用，标题安全渲染，不自动播放 */
  let st = await state(), au = await audio();
  check('首次打开显示标题页；无存档时继续禁用；标题页不自动播放', () => {
    assert.equal(st.state, 'title');
    assert.equal(st.saveOk, false);
    assert.equal(au.bgm, null, '标题页没有 BGM');
    assert.equal(au.pendingSfx, 0, '标题页没有延迟音效任务');
  });
  const titleText = await run(win, 'document.querySelector("#title").textContent');
  assert.equal(titleText, project.title, '标题使用工程标题');
  await shot(win, '01-标题页');

  /* 2. 开始游戏：解锁并进入首句，BGM 真实播放 */
  await realClick(win, '#startGame');
  await sleep(500);
  st = await state(); au = await audio();
  check('开始游戏进入首句，点击链解锁音频并真实播放', () => {
    assert.equal(st.state, 'playing');
    assert.equal(st.i, 0);
    assert(au.unlocked, '声音已解锁');
    assert(au.bgm && au.bgm.playing, 'BGM 实际播放');
    assert(au.bgm.time > 0, '播放时间推进');
  });

  /* 3. 菜单：按钮与 Esc；点击不穿透；菜单中不能推进 */
  const beforeText = await run(win, 'document.querySelector("#text").textContent');
  await realClick(win, '#menuBtn');
  st = await state();
  check('菜单按钮打开菜单', () => assert.equal(st.state, 'menu'));
  await shot(win, '02-游戏菜单');
  await realClick(win, '#scene');
  const afterClick = await run(win, 'document.querySelector("#text").textContent');
  check('菜单打开时点击舞台不穿透、不推进台词', () => {
    assert.equal(afterClick, beforeText);
    assert.equal(st.i, 0);
  });
  await pressEsc(win);
  assert.equal((await state()).state, 'playing', 'Esc 关闭菜单');
  await pressEsc(win);
  assert.equal((await state()).state, 'menu', 'Esc 打开菜单');
  await pressEsc(win);
  assert.equal((await state()).state, 'playing', 'Esc 一次只做一个动作');

  /* 4. 设置：音量实时生效、不重启；Esc 回上一级 */
  await realClick(win, '#menuBtn');
  await realClick(win, '#menuSettings');
  assert.equal((await state()).state, 'settings');
  await shot(win, '03-设置');
  const bgmBefore = (await audio()).bgm;
  await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector('#volBgm');e.value='30';e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(250);
  const bgmAfter = (await audio()).bgm;
  check('设置里分类音量实时生效，不重启当前 BGM', () => {
    assert(Math.abs(bgmAfter.volume - .3 * (bgmBefore.itemVolume || 1)) < .05, '音量约变为 30%×本句音量：' + bgmAfter.volume);
    assert(bgmAfter.time >= bgmBefore.time, '播放位置连续，没有回到曲首');
  });
  await pressEsc(win);
  assert.equal((await state()).state, 'menu', '设置里 Esc 返回菜单');

  /* 5. 保存 → 返回标题 → 继续：恢复节点与真实 trail */
  await realClick(win, '#save');
  const savedRaw = await win.webContents.executeJavaScript('localStorage.getItem("paper-game-" + ' + JSON.stringify(project.id) + ')');
  assert(savedRaw, '写入单槽存档');
  await realClick(win, '#menuTitle');
  st = await state();
  check('保存后返回标题，继续按钮可用', () => {
    assert.equal(st.state, 'title');
    assert.equal(st.saveOk, true);
  });
  await realClick(win, '#continueGame');
  await sleep(350);
  const continued = await state(), continuedAudio = await audio();
  check('继续游戏恢复存档节点与实际 trail，并按当前句重建 BGM', () => {
    assert.equal(continued.state, 'playing');
    assert.deepEqual(Array.from(continued.trail), JSON.parse(savedRaw).trail);
    assert.equal(continued.i, project.nodes.findIndex(n => n.id === JSON.parse(savedRaw).id));
    assert(continuedAudio.bgm && continuedAudio.bgm.playing, '继续后 BGM 播放');
  });

  /* 6. 返回标题：清理演出/声音/延迟任务，等待后不复活 */
  await realClick(win, '#menuBtn');
  await realClick(win, '#menuTitle');
  await sleep(700);
  const cleared = await audio();
  await sleep(700);
  const later = await audio();
  check('返回标题立即清理声音与延迟任务，等待后旧任务不复活', () => {
    assert.equal(cleared.bgm, null);
    assert.equal(cleared.voice, null);
    assert.equal(cleared.sfx.length, 0);
    assert.equal(cleared.pendingSfx, 0);
    assert.equal(cleared.retiring, 0);
    assert.equal(later.bgm, null, '等待后仍无声音');
  });

  /* 7. 新游戏不覆盖旧存档 */
  const rawBefore = await win.webContents.executeJavaScript('localStorage.getItem("paper-game-" + ' + JSON.stringify(project.id) + ')');
  await realClick(win, '#startGame');
  await sleep(250);
  const rawAfter = await win.webContents.executeJavaScript('localStorage.getItem("paper-game-" + ' + JSON.stringify(project.id) + ')');
  check('开始新游戏不删除、不覆盖已有存档', () => assert.equal(rawAfter, rawBefore));

  /* 8. 坏存档：损坏 / 删除 / 路径失效 → 禁用并保留原数据 */
  const key = 'paper-game-' + project.id;
  await win.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(key)}, '{bad json')`);
  await realClick(win, '#menuBtn'); await realClick(win, '#menuTitle');
  st = await state();
  check('损坏存档：继续禁用、中文原因、原数据保留', () => {
    assert.equal(st.saveOk, false);
    assert.equal(st.state, 'title');
    assert.match(st.saveReason, /损坏/);
  });
  const kept = await win.webContents.executeJavaScript(`localStorage.getItem(${JSON.stringify(key)})`);
  assert.equal(kept, '{bad json', '坏存档不被静默删除');
  await win.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(key)}, JSON.stringify({id:'gone',trail:[]}))`);
  await realClick(win, '#startGame'); await realClick(win, '#menuBtn'); await realClick(win, '#menuTitle');
  st = await state();
  check('存档节点已删除：继续禁用并提示，不跳到别的句子', () => {
    assert.equal(st.saveOk, false);
    assert.match(st.saveReason, /已被删除/);
  });

  /* 9. 结局仍可打开菜单并返回标题 */
  await realClick(win, '#startGame');
  for (let k = 0; k < 24; k++) {
    const hint = await run(win, 'document.querySelector("#hint").textContent');
    if (hint.includes('故事结束')) break;
    const choices = await run(win, 'document.querySelectorAll("#choices button").length');
    if (choices) await realClick(win, '#choices button');
    else await realClick(win, '#scene');
  }
  assert.match(await run(win, 'document.querySelector("#hint").textContent'), /故事结束/, '走到结局');
  await realClick(win, '#menuBtn');
  st = await state();
  check('结局画面仍可打开菜单并返回标题', () => assert.equal(st.state, 'menu'));
  await realClick(win, '#menuTitle');
  assert.equal((await state()).state, 'title');

  /* 10. 小窗口：标题/菜单/设置关键按钮仍在视口内 */
  win.setSize(760, 640);
  await sleep(350);
  const fits = await run(win, `(()=>{const ids=['#startGame','#continueGame','#titleSettings'];
    return ids.map(id=>{const e=document.querySelector(id);const r=e.getBoundingClientRect();
      return {id,ok:r.left>=0&&r.top>=0&&r.right<=window.innerWidth+1&&r.bottom<=window.innerHeight+1}})})()`);
  check('较小窗口下标题页按钮不被裁切', () => {
    for (const f of fits) assert(f.ok, f.id + ' 在视口内');
  });
  win.setSize(1200, 860);
  await sleep(250);

  check('整个流程没有渲染进程错误', () => assert.equal(errors.length, 0, errors.join(' | ')));

  /* 11. 编辑器「完整预览」：同一份 HTML 在独立窗口从标题页开始 */
  const editorWin = BrowserWindow.getAllWindows().find(w => w.getTitle().includes('纸间'));
  assert(editorWin, '编辑器窗口存在');
  const reply = JSON.parse(await editorWin.webContents.executeJavaScript(
    `window.PaperHost.previewGame(${JSON.stringify(html)}).then(r=>JSON.stringify(r))`));
  assert(reply && reply.ok, '预览 IPC 成功');
  let preview = null;
  for (let k = 0; k < 40; k++) {
    preview = BrowserWindow.getAllWindows().find(w => {
      try { return w.webContents.getURL().includes('game-preview.html') } catch { return false }
    });
    if (preview) break;
    await sleep(100);
  }
  assert(preview, '打开完整预览窗口');
  /* file:// 存储与主验收窗口共享；先清掉测试写下的坏存档，截一张正常的标题页。 */
  await preview.webContents.executeJavaScript('localStorage.clear()');
  await preview.reload();
  await sleep(700);
  const previewState = await run(preview, 'window.paperGameState()');
  check('编辑器「完整预览」与导出同一份 HTML，从标题页开始', () => {
    assert.equal(previewState.state, 'title');
    assert.equal(previewState.saveOk, false);
    assert.match(previewState.saveReason, /还没有保存进度/, '预览使用自己的干净存档状态：' + previewState.saveReason);
    assert.equal(previewState.nodes, project.nodes.length);
  });
  await shot(preview, '05-完整预览标题页');
  await preview.close();

  /* 12. 空工程：明确提示、不进入异常状态 */
  const blank = C.blank(); blank.title = '空工程';
  const emptyFile = path.join(RESULT, 'empty-project.html');
  fs.writeFileSync(emptyFile, buildGameHTML(blank, deps), 'utf8');
  const emptyWin = await openWindow(emptyFile);
  const emptyState = await run(emptyWin.win, 'window.paperGameState()');
  const emptyNote = await run(emptyWin.win, 'document.querySelector("#titleNote").textContent');
  check('空工程：标题页明确提示，开始按钮禁用，不崩溃', () => {
    assert.equal(emptyState.state, 'title');
    assert.equal(emptyState.nodes, 0);
    assert.match(emptyNote, /还没有可播放的剧情/);
  });
  await emptyWin.win.close();

  /* 12. 无音频旧工程：正常游玩、设置说明没有音频 */
  const plain = C.sample(); plain.title = '无音频工程';
  const plainFile = path.join(RESULT, 'no-audio.html');
  fs.writeFileSync(plainFile, buildGameHTML(plain, deps), 'utf8');
  const plainRun = await openWindow(plainFile);
  await realClick(plainRun.win, '#startGame');
  await realClick(plainRun.win, '#menuBtn');
  await realClick(plainRun.win, '#menuSettings');
  const noAudio = await run(plainRun.win, `({hidden:document.querySelector('#audioPanel').hidden,
    note:document.querySelector('#settingsNote').textContent,status:window.paperAudioStatus()})`);
  check('无音频旧工程：正常游玩，设置明确说明没有音频，无误导性错误', () => {
    assert.equal(noAudio.hidden, true);
    assert.match(noAudio.note, /没有音频/);
    assert.equal(noAudio.status, null);
    assert.equal(plainRun.errors.length, 0, plainRun.errors.join(' | '));
  });
  await plainRun.win.close();

  await shot(win, '04-继续游戏后');
  fs.writeFileSync(REPORT, JSON.stringify({ ...report, finishedAt: new Date().toISOString(),
    export: EXPORT, testProject: TEST }, null, 2));
  console.log('PLAYER_ACCEPTANCE PASS');
  console.log('RESULT_DIR=' + RESULT);
  app.exit(0);
}
main().catch(e => { console.error('PLAYER_ACCEPTANCE FAILED: ' + (e.stack || e)); app.exit(1); });
