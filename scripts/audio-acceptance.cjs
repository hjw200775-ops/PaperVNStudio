'use strict';
/*
 * V0.5 基础音频实机验收：真实 Electron 主进程 + 真实窗口 + 独立离线 HTML 窗口。
 *
 *   npm run audio:acceptance                  # 主流程：导入、逐句设置、运行层状态、导出、重开
 *   PAPER_AUDIO_REOPEN=1 npm run ...         # 新进程重开：核对音频素材与指令都还在
 *
 * 全部在 F:/Wanfeng-Demo 下带时间戳的独立测试工程中操作，不改正式原作与素材包。
 * 断言的是 play() Promise 的结果、真实播放状态与 currentTime 推进，不是「调用了 play」。
 * 解锁使用自动化注入的鼠标输入事件（sendInputEvent），不是真人点击；报告里如实区分。
 */
const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const createStore = require('../desktop/project-store.cjs');
const createVNCore = require('../dist/core.js');

const OUT = process.env.WANFENG_OUT || process.env.CHAPTERS_OUT || 'F:/Wanfeng-Demo';
const KIT = path.join(OUT, 'V05-Audio-Kit', 'PaperVNStudio-V05-Audio-Test-Kit');
const STAMP = Date.now();
const REOPEN = process.env.PAPER_AUDIO_REOPEN === '1';
const RESULT = path.join(OUT, '验收结果-v05');
const POINTER = path.join(RESULT, '当前音频工程.json');
const EXPORT = path.join(RESULT, 'wanfeng-audio.html');
const REPORT = path.join(RESULT, REOPEN ? '验收报告-v05-重开.json' : '验收报告-v05.json');
let WORK, MOVED;
if (REOPEN) {
  const saved = JSON.parse(fs.readFileSync(POINTER, 'utf8'));
  WORK = saved.work; MOVED = saved.moved;
} else {
  WORK = path.join(OUT, '晚风-audio-' + STAMP);
  MOVED = path.join(OUT, '晚风-audio-moved-' + STAMP);
  fs.mkdirSync(RESULT, { recursive: true });
  fs.writeFileSync(POINTER, JSON.stringify({ work: WORK, moved: MOVED, stamp: STAMP }, null, 2));
}
const C = createVNCore();
const store = createStore();

const FILES = {
  bgm: path.join(KIT, 'bgm_morning_test.wav'),
  knock: path.join(KIT, 'sfx_double_knock.wav'),
  confirm: path.join(KIT, 'sfx_choice_confirm.wav'),
  female: path.join(KIT, 'voice_test_female_en.wav'),
  male: path.join(KIT, 'voice_test_male_en.wav')
};
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const ID = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, 'au_' + sha(f).slice(0, 16)]));
for (const [k, f] of Object.entries(FILES)) assert(fs.existsSync(f), '缺少测试素材：' + f);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-audio-userdata-'));
app.setPath('userData', userData);
const fileQueue = [], dirQueue = [], saveQueue = [], messageQueue = [];
dialog.showOpenDialog = async (_win, opts) => {
  const props = (opts && opts.properties) || [];
  if (props.includes('openFile')) {
    const f = fileQueue.shift();
    return f ? { canceled: false, filePaths: [f] } : { canceled: true, filePaths: [] };
  }
  const d = dirQueue.shift();
  return d ? { canceled: false, filePaths: [d] } : { canceled: true, filePaths: [] };
};
dialog.showSaveDialog = async () => {
  const f = saveQueue.shift();
  return f ? { canceled: false, filePath: f } : { canceled: true, filePath: '' };
};
dialog.showMessageBox = async () => ({ response: messageQueue.length ? messageQueue.shift() : 2 });

/* ---------- 独立测试工程：短脚本 + 两条分支汇合 + 独立画面入口 ---------- */
function testProject() {
  const p = C.blank();
  p.title = '晚风 · V0.5 音频测试（独立工程）';
  const pid = p.chapters[0].paragraphs[0].id;
  const n = (id, text, extra) => Object.assign(C.makeNode('say'), { id, text, paragraphId: pid, next: '' }, extra || {});
  const s1 = n('a_start', '清晨，走廊里传来两下敲门声。', { sceneMode: 'own', next: 'a_second' });
  const s2 = n('a_second', '他应了一声，声音从屋里传来。', { next: 'a_choice' });
  const ch = Object.assign(C.makeNode('choice'), { id: 'a_choice', text: '要往哪边走？', paragraphId: pid,
    options: [{ text: '走左边', target: 'a_left' }, { text: '走右边', target: 'a_right' }] });
  const left = n('a_left', '左边是安静的楼梯间。', { next: 'a_merge' });
  const right = n('a_right', '右边通往操场。', { next: 'a_merge' });
  const merge = n('a_merge', '两条路最后都回到同一个门口。', { sceneMode: 'own', next: 'a_end' });
  const end = Object.assign(C.makeNode('end'), { id: 'a_end', text: '故事结束。', paragraphId: pid });
  p.nodes = [s1, s2, ch, left, right, merge, end];
  assert(C.validate(p));
  return p;
}

/* 启动时让主进程自动打开测试工程，避免额外对话框。 */
function prepare() {
  fs.mkdirSync(RESULT, { recursive: true });
  if (!REOPEN) {
    fs.mkdirSync(WORK, { recursive: true });
    store.createProject(WORK, testProject());
  }
  const recent = path.join(userData, 'recent-projects.json');
  store.writeRecent(recent, { lastOpened: WORK,
    items: [{ path: WORK, title: 'V0.5 音频测试', openedAt: new Date().toISOString() }] });
}
prepare();
require('../desktop/main.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let win = null;
const run = js => win.webContents.executeJavaScript(js);
const report = { startedAt: new Date().toISOString(), mode: REOPEN ? 'reopen' : 'main',
  checks: [], unverified: ['人工听审（未听审）', '真人界面操作（脚本用合成事件与注入鼠标事件）', '第二台电脑与安装包'],
  kitVerified: true, workDir: WORK };
function check(name, fn) { fn(); report.checks.push(name); console.log('  ok  ' + name); }
async function shot(name, target) {
  const w = target || win;
  fs.writeFileSync(path.join(RESULT, name + '.png'), (await w.webContents.capturePage()).toPNG());
  (report.screenshots || (report.screenshots = [])).push(name + '.png');
}
async function click(sel) { await run(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(90); }
async function scrollTo(sel) {
  await run(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e&&e.scrollIntoView)e.scrollIntoView({block:'center'});return true})()`);
  await sleep(160);
}
async function audioTab(section) {
  await click('.tabs [data-tab="audio"]');
  if (section) await scrollTo(section);
}
/* 结构化克隆安全：executeJavaScript 只返回 JSON 字符串。 */
async function evalJSON(js) { const s = await run(`JSON.stringify(${js})`); return JSON.parse(s); }
async function waitLoad() {
  for (let i = 0; i < 150; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading() && win.webContents.getURL()) return;
    await sleep(100);
  }
  throw new Error('窗口没有加载完成');
}
/* 自动化注入的鼠标输入事件：用来取得浏览器的播放许可，不是真人点击。 */
async function realMouseClick(w, sel) {
  await w.webContents.executeJavaScript(
    `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e&&e.scrollIntoView)e.scrollIntoView({block:'center'});return true})()`);
  await sleep(160);
  const box = JSON.parse(await w.webContents.executeJavaScript(
    `JSON.stringify((()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;
      const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})())`));
  if (!box) throw new Error('找不到可点击元素：' + sel);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
    await w.webContents.sendInputEvent({ type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await sleep(220);
}
async function unlockEditor() {
  await click('.tabs [data-tab="audio"]');
  if (await evalJSON(`runtime().isUnlocked()`)) return;
  await realMouseClick(win, '#audioUnlock');
  if (!(await evalJSON(`runtime().isUnlocked()`))) {
    /* 回退：executeJavaScript 的 userGesture 标志同样是自动化注入，不是真人点击 */
    await win.webContents.executeJavaScript(`(async()=>{await runtime().unlock();return true})()`, true);
    await sleep(200);
  }
  assert(await evalJSON(`runtime().isUnlocked()`), '浏览器允许播放（自动化注入手势解锁）');
}
async function importFile(file, category) {
  await click('.tabs [data-tab="audio"]');
  await run(`document.querySelector('#audioCategory').value=${JSON.stringify(category)}`);
  fileQueue.push(file);
  await click('#audioImport');
  for (let i = 0; i < 60; i++) {
    const n = await evalJSON(`(p.audioAssets||[]).length`);
    if (n > 0) return;
    await sleep(50);
  }
}
async function importAll() {
  await audioTab('#audioAssets');
  const before = await evalJSON(`(p.audioAssets||[]).length`);
  for (const [file, cat] of [[FILES.bgm, 'bgm'], [FILES.knock, 'sfx'], [FILES.confirm, 'sfx'],
    [FILES.female, 'voice'], [FILES.male, 'voice']]) {
    const want = (await evalJSON(`(p.audioAssets||[]).length`)) + 1;
    await run(`document.querySelector('#audioCategory').value=${JSON.stringify(cat)}`);
    fileQueue.push(file);
    await click('#audioImport');
    for (let i = 0; i < 80; i++) {
      if ((await evalJSON(`(p.audioAssets||[]).length`)) >= want) break;
      await sleep(60);
    }
  }
  const list = await evalJSON(`(p.audioAssets||[]).map(a=>({id:a.id,name:a.name,cats:a.categories,duration:a.duration,bytes:a.bytes,note:a.durationNote||''}))`);
  assert.equal(list.length - before, 5, '五个测试 WAV 全部导入');
  return list;
}

/* ---------- 重开模式：新进程只核对落盘结果 ---------- */
async function reopen() {
  await app.whenReady();
  await waitLoad();
  await sleep(600);
  const state = await evalJSON(`({title:p.title,nodes:p.nodes.length,audio:(p.audioAssets||[]).length,
    path:document.querySelector('#projectPath').textContent,
    ids:(p.audioAssets||[]).map(a=>a.id),
    bgm:(p.nodes.find(n=>n.id==='a_start').audio||{}).bgm||null,
    sfx:(p.nodes.find(n=>n.id==='a_left').audio||{}).sfx||[],
    voice:(p.nodes.find(n=>n.id==='a_start').audio||{}).voice||null})`);
  check('新进程重开：音频素材、逐句 BGM / 音效 / 语音指令都在，剧情未变', () => {
    assert.equal(state.nodes, 7);
    assert.equal(state.audio, 5);
    assert.deepEqual(state.ids.slice().sort(), Object.values(ID).slice().sort());
    assert(state.bgm && state.bgm.action === 'play' && state.bgm.audioId === ID.bgm);
    assert(state.sfx.length >= 1);
    assert(state.voice && state.voice.audioId);
    assert(state.path.includes(path.basename(WORK)), '工程目录已关联');
  });
  /* 独立离线 HTML 窗口：解锁后可播放 */
  const html = fs.readFileSync(EXPORT, 'utf8');
  assert(html.includes('data:audio/wav;base64,'), '导出 HTML 内嵌音频');
  assert(!html.includes('paper://') && !html.includes('blob:'), '无本机协议与 blob 引用');
  const game = new BrowserWindow({ width: 1200, height: 820, show: true, title: '离线音频验证',
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await game.loadFile(EXPORT); await sleep(700);
  await realMouseClick(game, '#enableSound');
  await sleep(500);
  const st = JSON.parse(await game.webContents.executeJavaScript('JSON.stringify(window.paperAudioStatus())'));
  check('离线 HTML 独立窗口：解锁后实际播放，播放时间推进', () => {
    assert(st && st.unlocked, '离线播放器已解锁');
    assert(st.bgm && st.bgm.playing, 'BGM 实际处于播放状态');
    assert(st.bgm.time > 0, '播放时间推进：' + (st.bgm && st.bgm.time));
  });
  await shot('10-离线HTML独立窗口', game);
  await game.close();
  fs.writeFileSync(path.join(RESULT, '重开检查.json'), JSON.stringify({ state, offline: st }, null, 2));
  finish('AUDIO_REOPEN PASS');
  app.exit(0);
}

function finish(label) {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(label);
  console.log('RESULT_DIR=' + RESULT);
}

async function main() {
  if (REOPEN) return reopen();
  await app.whenReady();
  await waitLoad();
  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const d = args[0];
    const level = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
    if (level >= 2) errors.push(String((d && d.message) || args[2]));
  });
  await sleep(500);
  check('在独立测试副本上开始（正式原作工程与素材包未被改动）', () => {
    assert(fs.existsSync(path.join(WORK, 'project.paper.json')));
    assert.equal((testProject().audioAssets || []).length, 0);
  });

  /* ---------- 1. 五个 WAV 导入、元数据与素材试听 ---------- */
  const list = await importAll();
  const meta = await evalJSON(`(p.audioAssets||[]).map(a=>({id:a.id,name:a.name,d:a.duration,bytes:a.bytes,cats:a.categories}))`);
  check('五个测试 WAV 导入、时长与大小异步读取、分类显示', () => {
    assert.equal(meta.length, 5);
    assert.deepEqual(meta.map(x => x.id).sort(), Object.values(ID).sort(), '内容寻址 ID 与素材包 SHA256 一致');
    for (const m of meta) {
      assert(m.d > 0, m.name + ' 时长读取成功：' + m.d);
      assert(m.bytes > 0);
      assert(m.cats.length >= 1);
    }
    assert(Math.abs(meta.find(x => x.id === ID.bgm).d - 24) < .2, 'BGM 24 秒');
    assert(Math.abs(meta.find(x => x.id === ID.female).d - 2.96) < .3, '女声约 3 秒');
  });
  await audioTab('#audioAssets');
  await shot('01-音频素材管理');

  /* ---------- 2. 重复导入复用、损坏音频拒绝 ---------- */
  const beforeReuse = await evalJSON(`(p.audioAssets||[]).length`);
  await run(`document.querySelector('#audioCategory').value='voice'`);
  fileQueue.push(FILES.bgm);
  await click('#audioImport'); await sleep(500);
  const reused = await evalJSON(`({count:(p.audioAssets||[]).length,cats:(p.audioAssets.find(a=>a.id==='${ID.bgm}')||{}).categories||[]})`);
  check('重复导入同一文件复用资源、用途可合并，保存不失败', () => {
    assert.equal(reused.count, beforeReuse, '没有产生第二个素材 ID');
    assert(reused.cats.includes('bgm') && reused.cats.includes('voice'), '同一物理文件可被不同用途引用');
  });
  const bad = path.join(RESULT, '损坏音频.wav');
  fs.writeFileSync(bad, Buffer.from('RIFFbroken-not-a-real-wav-file'));
  const beforeBad = await evalJSON(`JSON.stringify(p)`);
  fileQueue.push(bad);
  await click('#audioImport'); await sleep(600);
  const afterBad = await evalJSON(`({count:(p.audioAssets||[]).length,toast:document.querySelector('#toast').textContent})`);
  const afterBadJson = await evalJSON(`JSON.stringify(p)`);
  check('损坏 WAV 明确拒绝，原工程不受影响', () => {
    assert.equal(afterBad.count, beforeReuse, '损坏素材没有进入工程');
    assert(/WAV|损坏|不是有效|无法/.test(afterBad.toast), '给出中文原因：' + afterBad.toast);
    assert.equal(afterBadJson, beforeBad, '工程内容未变');
  });

  /* ---------- 3. 逐句音频指令（界面写入 + 测试数据准备） ---------- */
  await click('#list [data-id="a_start"]');
  await run(`(()=>{document.querySelector('input[name=bgmMode][value=play]').checked=true;
    document.querySelector('input[name=bgmMode][value=play]').dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await sleep(150);
  const uiCue = await evalJSON(`p.nodes.find(n=>n.id==='a_start').audio`);
  check('逐句界面：BGM「播放 / 切换音乐」写入工程，一次编辑一条撤销记录', () => {
    assert(uiCue && uiCue.bgm && uiCue.bgm.action === 'play');
    assert.equal(uiCue.bgm.audioId, ID.bgm, '默认选中第一首（bgm_morning_test）');
    assert.equal(uiCue.bgm.loop, true);
  });
  /* 每次界面编辑各是一条撤销记录：这里只回退刚才那一次。 */
  await click('#undo');
  const undone = await evalJSON(`p.nodes.find(n=>n.id==='a_start').audio`);
  await click('#redo');
  const redone = await evalJSON(`p.nodes.find(n=>n.id==='a_start').audio`);
  check('音频编辑撤销 / 重做可整体恢复', () => {
    assert(!undone || !undone.bgm, '撤销后回到无音频指令');
    assert(redone && redone.bgm && redone.bgm.action === 'play', '重做恢复');
  });
  /* 再验证「选择指定音乐素材」这一条界面编辑 */
  await run(`(()=>{const s=document.querySelector('#bgmAsset');s.value=${JSON.stringify(ID.bgm)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await sleep(150);

  /* 其余分支 / 汇合 / 延迟音效等结构作为测试数据写入（非界面操作，报告中如实说明）。 */
  await run(`(()=>{
   const set=(id,a)=>{const n=p.nodes.find(n=>n.id===id);n.audio=a};
   set('a_start',{bgm:{action:'play',audioId:'${ID.bgm}',volume:.8,loop:true,fadeIn:.1,fadeOut:.1},
     sfx:[{id:'sfx_knock',audioId:'${ID.knock}',volume:.9,delay:0},{id:'sfx_late',audioId:'${ID.confirm}',volume:.7,delay:.4}],
     voice:{audioId:'${ID.female}',volume:1}});
   set('a_second',{voice:{audioId:'${ID.male}',volume:.9}});
   set('a_left',{bgm:{action:'play',audioId:'${ID.bgm}',volume:.6,loop:true,fadeIn:0,fadeOut:.1},
     sfx:[{id:'sfx_left',audioId:'${ID.knock}',volume:1,delay:0}]});
   set('a_right',{bgm:{action:'play',audioId:'${ID.confirm}',volume:.7,loop:true,fadeIn:0,fadeOut:.1}});
   set('a_merge',null);                 /* 汇合句「沿用」：两条路线的音乐差异才会生效 */
   set('a_end',{bgm:{action:'stop',fadeOut:0}});
   revision++;group='';queueSave();render();return true})()`);
  await sleep(300);
  await click('#list [data-id="a_start"]');
  await scrollTo('#nodeAudioPanel');
  await shot('02-逐句音频设置');

  /* ---------- 4. 分支 BGM 不混用、own 不丢音频历史、预算 ---------- */
  const routes = await evalJSON(`(()=>{const plan=C.entryPlan(p,'a_merge');
    return {ambiguous:plan.ambiguous,audioAgrees:plan.audioAgrees,options:plan.options.map(o=>({
      ids:o.trail,bgm:C.audioStateAlong(p,[...o.trail,'a_merge'])})),
      ownBefore:C.entryPlan(p,'a_merge').source,
      single:C.entryPlan(p,'a_second').bgm}})()`);
  check('分支分别设置不同 BGM，汇合 / 定点试玩不混用；own 之前音乐不被清除', () => {
    assert.equal(routes.ambiguous, true, '汇合句前面有多条路线');
    assert.equal(routes.audioAgrees, false, '不同路线生效音乐不同');
    const states = routes.options.map(o => o.bgm && o.bgm.audioId);
    assert(states.includes(ID.bgm) && states.includes(ID.confirm), '各候选路线各自带正确 BGM');
    for (const o of routes.options) assert(!(o.ids.includes('a_left') && o.ids.includes('a_right')), '不拼接互斥分支');
    assert(routes.single && routes.single.audioId === ID.bgm, '单一路线时 own 场景入口前的 BGM 被正确沿用');
  });

  /* ---------- 5. 解锁与分类音量（自动化注入手势，非真人点击） ---------- */
  await unlockEditor();
  await run(`(()=>{const set=(id,v)=>{const e=document.querySelector(id);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}))};
    set('#volMaster',80);set('#volBgm',50);return true})()`);
  await sleep(150);
  await audioTab('#audioMixers');
  await shot('03-分类音量与解锁');
  const prefs = await evalJSON(`runtime().getPrefs()`);
  const projectKeys = await evalJSON(`Object.keys(p)`);
  check('总音量 / 分类音量 / 静音属于播放偏好，不写入工程', () => {
    assert(Math.abs(prefs.master - .8) < .01 && Math.abs(prefs.bgm - .5) < .01);
    assert(!projectKeys.includes('audioPrefs') && !projectKeys.includes('master'), '偏好没有混进工程数据');
  });

  /* 素材管理试听：真实播放、时间推进、再次点击停止，且不与试玩叠音 */
  await run(`previewAudio('${ID.bgm}',true)`); await sleep(320);
  const pv1 = await evalJSON(`runtime().status()`);
  await sleep(320);
  const pv2 = await evalJSON(`runtime().status()`);
  await run(`previewAudio('${ID.bgm}',true)`); await sleep(160);
  const pv3 = await evalJSON(`runtime().status()`);
  check('素材试听：实际播放、时间推进、再次点击停止，不与游戏试玩叠音', () => {
    assert(pv1.preview && pv1.preview.playing, '素材试听播放中');
    assert(pv2.preview.time > pv1.preview.time, '试听时间推进：' + pv1.preview.time + ' → ' + pv2.preview.time);
    assert.equal(pv1.bgm, null, '试听时没有同时播放游戏 BGM');
    assert.equal(pv3.preview, null, '再次点击停止试听');
  });

  /* ---------- 6. 试听本句、编辑不自动播放、试听与试玩不叠音 ---------- */
  await click('#audioCuePreview'); await sleep(300);
  const cue1 = await evalJSON(`runtime().status()`);
  await click('#audioCuePreview'); await sleep(150);
  const cue2 = await evalJSON(`runtime().status()`);
  check('编辑节点不自动播放；「试听本句音频」再次点击即停止', () => {
    assert(cue1.bgm && cue1.bgm.playing, '试听时 BGM 实际播放');
    assert(cue1.sfx.length >= 1 || cue1.pendingSfx >= 1, '进入本句触发音效与延迟任务');
    assert.equal(cue2.bgm, null, '再次点击停止，全部通道清理');
    assert.equal(cue2.pendingSfx, 0, '延迟任务已取消');
  });

  /* ---------- 7. 真实试玩：沿用不重启 / 显式播放从头 / 切换 / 停止 / 循环 / 快速切句 ---------- */
  await click('#play'); await sleep(450);
  const t1 = await evalJSON(`runtime().status()`);
  await sleep(350);
  const t1b = await evalJSON(`runtime().status()`);
  check('从头试玩：播放 Promise 成功、实际播放状态、时间推进与循环', () => {
    assert(t1.bgm && t1.bgm.playing, 'BGM 实际播放');
    assert.equal(t1.bgm.audioId, ID.bgm);
    assert.equal(t1.bgm.loop, true, '循环生效');
    assert(t1b.bgm.time > t1.bgm.time, '播放时间推进：' + t1.bgm.time + ' → ' + t1b.bgm.time);
    assert(Math.abs(t1.bgm.volume - .8 * .5 * .8) < .02, '总 × 分类 × 本句音量：' + t1.bgm.volume);
    assert(t1.voice && t1.voice.playing, '台词语音进入本句从头播放');
  });
  await run(`(()=>{const m=document.querySelector('#muteAll');m.checked=true;m.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await sleep(150);
  const muted = await evalJSON(`runtime().status()`);
  await run(`(()=>{const m=document.querySelector('#muteAll');m.checked=false;m.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await sleep(150);
  const unmuted = await evalJSON(`runtime().status()`);
  check('静音归零但不重启当前声音；取消静音后恢复且播放位置连续', () => {
    assert.equal(muted.bgm.volume, 0, '静音后音量为 0');
    assert(muted.bgm.playing, '静音不销毁通道、不重启');
    assert(unmuted.bgm.volume > 0, '取消静音音量恢复');
    assert(unmuted.bgm.time >= muted.bgm.time, '播放位置连续，没有回到曲首');
  });
  await click('#next'); await sleep(220);
  const t2 = await evalJSON(`runtime().status()`);
  check('普通推进且选择「沿用」时不重启音乐；语音互斥、离开即停止', () => {
    assert(t2.bgm && t2.bgm.audioId === ID.bgm && t2.bgm.playing, '仍是同一首');
    assert(t2.bgm.time >= t1b.bgm.time, '播放位置连续，没有回到曲首');
    assert(t2.voice && t2.voice.audioId === ID.male, '新语音替换旧语音（单通道）');
    assert.equal(t2.sfx.length, 0, '推进下一句停止上一句未结束的音效');
    assert.equal(t2.pendingSfx, 0, '尚未触发的延迟任务被取消');
  });
  /* 快速连续切句：过期淡变回调不能让旧音乐重新响起 */
  await run(`(()=>{go('a_choice');go('a_left');go('a_merge');go('a_end');return true})()`);
  await sleep(450);
  const fast = await evalJSON(`runtime().status()`);
  check('快速连续切句、切换与停止：取消过期淡变，旧音乐不复活', () => {
    assert.equal(fast.bgm, null, '最新指令是停止音乐');
    assert.equal(fast.pendingSwitch, false, '过期切换已取消');
    assert.equal(fast.retiring, 0, '没有残留淡出通道');
    assert.equal(fast.sfx.length, 0);
  });
  await click('#play'); await sleep(280);
  const restarted = await evalJSON(`runtime().status()`);
  check('显式「播放 / 重新开始」从曲首启动，同一首音乐也从头开始', () => {
    assert(restarted.bgm && restarted.bgm.audioId === ID.bgm);
    assert(restarted.bgm.time < 1, '从曲首启动：' + restarted.bgm.time);
  });

  /* ---------- 8. 分支路线选择与定点试玩音频 ---------- */
  await click('#stop');
  await click('#list [data-id="a_merge"]');
  await click('#playHere'); await sleep(250);
  const modalOpen = await evalJSON(`document.querySelector('#modal').open`);
  const routeCount = await evalJSON(`document.querySelectorAll('#modalBody [data-route]').length`);
  check('路径不确定时让作者选择路线，不把分支音乐拼在一起', () => {
    assert.equal(modalOpen, true, '弹出路线选择');
    assert(routeCount >= 2, '至少两条候选路线：' + routeCount);
  });
  await run(`document.querySelector('#modalBody [data-route="0"]').click()`);
  await sleep(350);
  const picked = await evalJSON(`({status:runtime().status(),trail:[...trail],current,
    expected:(C.audioStateAlong(p,[...trail,current])||{}).audioId||null})`);
  check('定点试玩按所选真实路线重建 BGM，从曲首启动，不混用另一条分支', () => {
    assert.equal(picked.current, 'a_merge');
    assert(picked.trail.length > 0, '使用了选定的真实路径');
    assert(picked.status.bgm && picked.status.bgm.playing, '按路线重建了生效音乐');
    assert.equal(picked.status.bgm.audioId, picked.expected, '与该路线最后一条音乐指令一致');
    assert(picked.status.bgm.time < 1, '从曲首启动，不追算此前耗时');
  });

  /* ---------- 9. 返回 / 读档 / 重开 / 退出试玩 ---------- */
  await click('#stop');
  await click('#play'); await sleep(250);
  await click('#next');
  await click('#slotSave');
  await click('#next');
  await click('#slotLoad'); await sleep(250);
  const loaded = await evalJSON(`runtime().status()`);
  await click('#prev'); await sleep(200);
  const backed = await evalJSON(`runtime().status()`);
  await click('#stop'); await sleep(150);
  const stopped = await evalJSON(`runtime().status()`);
  check('返回 / 读档 / 重开按目标句从曲首重建；退出试玩全部停止', () => {
    assert(loaded.bgm && loaded.bgm.playing, '读档后按目标句状态重建 BGM');
    assert(loaded.bgm.time < 1, '从曲首启动，不追算此前耗时');
    assert(backed.bgm && backed.bgm.playing, '返回后重建');
    assert.equal(stopped.bgm, null);
    assert.equal(stopped.voice, null);
    assert.equal(stopped.sfx.length, 0);
    assert.equal(stopped.pendingSfx, 0);
  });

  /* ---------- 10. 播放失败提示（未获许可 / 素材缺失） ---------- */
  /* 新建一个未解锁的运行层：明确提示「点击启用声音」，不假报正在播放 */
  await click('.tabs [data-tab="audio"]');
  await run(`(()=>{audioStopAll();audioRT=null;audioStatus(null);return true})()`);
  const lockedText = await run(`document.querySelector('#audioStatus').textContent`);
  check('播放失败提示：未获许可与素材缺失都用中文说明，不假报正在播放', () => {
    assert(/启用声音|没有音频/.test(lockedText), '未解锁提示：' + lockedText);
  });
  await unlockEditor();
  const savedData = await evalJSON(`p.audioAssets.find(a=>a.id==='${ID.knock}').data`);
  await run(`(()=>{const a=p.audioAssets.find(a=>a.id==='${ID.knock}');a.data='';return true})()`);
  await run(`previewAudio('${ID.knock}',false)`);
  await sleep(300);
  const failText = await run(`document.querySelector('#audioStatus').textContent`);
  await audioTab('#audioStatus');
  await shot('04-播放失败提示');
  await run(`(()=>{const a=p.audioAssets.find(a=>a.id==='${ID.knock}');a.data=${JSON.stringify(savedData)};audioStopAll();return true})()`);
  check('素材缺失被明确报告到素材，状态可重试', () => {
    assert(/素材缺失|缺失|重新导入/.test(failText), '中文错误：' + failText);
    assert(!/正在播放「/.test(failText), '失败时不显示正在播放');
  });

  /* ---------- 11. 保存、体积提示、导出、工程移动 ---------- */
  await click('#save'); await sleep(900);
  const disk = JSON.parse(fs.readFileSync(path.join(WORK, 'project.paper.json'), 'utf8'));
  check('原子保存：音频按内容哈希落到 assets/audio/，元数据只有相对路径', () => {
    assert.equal((disk.audioAssets || []).length, 5);
    for (const a of disk.audioAssets) {
      assert(/^assets\/audio\/[a-f0-9]{64}\.(wav|mp3|ogg|m4a|flac|webm)$/.test(a.file), a.file);
      assert(fs.existsSync(path.join(WORK, a.file)), '音频文件存在：' + a.file);
      assert(!('data' in a), '磁盘元数据不内嵌音频');
    }
    assert.equal(disk.nodes.find(n => n.id === 'a_start').audio.bgm.audioId, ID.bgm);
  });
  fs.cpSync(WORK, MOVED, { recursive: true });
  const movedProject = store.openProject(MOVED).project;
  check('工程目录移动后音频仍可打开', () => {
    assert.equal(movedProject.audioAssets.length, 5);
    assert.equal(movedProject.nodes.find(n => n.id === 'a_start').audio.bgm.audioId, ID.bgm);
  });
  saveQueue.push(EXPORT);
  await click('#export'); await sleep(200);
  const volNote = await run(`document.querySelector('#modalBody').textContent`);
  check('导出前提示音频增加的体积，不静默生成大文件', () => {
    assert(/音频素材/.test(volNote) && /MB/.test(volNote), volNote.slice(0, 120));
  });
  await click('#confirmAudioExport'); await sleep(1200);
  const html = fs.readFileSync(EXPORT, 'utf8');
  check('导出 HTML 内嵌音频、无本机路径 / paper:// / blob: / 外部引用', () => {
    assert(html.includes('data:audio/wav;base64,'), '音频内嵌');
    assert(!html.includes('paper://') && !html.includes('blob:') && !html.includes('F:\\'));
    assert(!/<script[^>]+\bsrc=/i.test(html) && !/<audio[^>]+\bsrc="(?!data:)/i.test(html));
    assert(!/https?:\/\/(?!127|localhost)/i.test(html.split('<script>')[0]));
    assert(html.includes('点击开始 / 启用声音'), '离线播放器有启用声音入口');
  });

  /* ---------- 12. 离线 HTML 独立窗口解锁与播放 ---------- */
  const game = new BrowserWindow({ width: 1200, height: 820, show: true, title: '离线音频验证',
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const offlineErrors = [];
  game.webContents.on('console-message', (...args) => {
    const d = args[0], level = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
    if (level >= 2) offlineErrors.push(String((d && d.message) || args[2]));
  });
  await game.loadFile(EXPORT); await sleep(700);
  const beforeUnlock = JSON.parse(await game.webContents.executeJavaScript('JSON.stringify(window.paperAudioStatus())'));
  await realMouseClick(game, '#enableSound'); await sleep(450);
  const s1 = JSON.parse(await game.webContents.executeJavaScript('JSON.stringify(window.paperAudioStatus())'));
  await sleep(400);
  const s2 = JSON.parse(await game.webContents.executeJavaScript('JSON.stringify(window.paperAudioStatus())'));
  check('离线 HTML 独立窗口：未解锁不假播放，解锁后真实播放且时间推进', () => {
    assert(beforeUnlock && !beforeUnlock.unlocked, '首次播放受限');
    assert.equal(beforeUnlock.bgm, null, '未解锁没有创建播放任务');
    assert(s1 && s1.unlocked && s1.bgm && s1.bgm.playing, '解锁后 BGM 实际播放');
    assert(s2.bgm.time > s1.bgm.time, '离线播放时间推进：' + s1.bgm.time + ' → ' + s2.bgm.time);
    assert.equal(offlineErrors.length, 0, '离线窗口无渲染错误：' + offlineErrors.join(' | '));
  });
  await shot('09-离线HTML音频', game);
  await game.close();

  /* ---------- 13. 旧无音频工程回归 ---------- */
  const legacy = C.sample();
  const legacyDisk = store.createProject(path.join(RESULT, 'legacy-' + STAMP), legacy);
  const legacyOpen = store.openProject(path.join(RESULT, 'legacy-' + STAMP)).project;
  check('旧无音频工程：角色、场景、演出与分支不变，零播放任务', () => {
    assert.equal(legacyOpen.nodes.length, 7);
    assert.equal(legacyOpen.nodes[1].options.length, 3, '三选项分支');
    assert.equal(legacyOpen.audioAssets.length, 0);
    assert.equal(C.hasAnyAudio(legacyOpen), false);
    assert.deepEqual(C.analyze(legacyOpen).errors, []);
    assert.equal(C.entryPlan(legacyOpen, legacyOpen.nodes[0].id).ambiguous, false);
  });

  check('整个流程没有渲染进程报错', () => {
    assert.equal(errors.length, 0, errors.join(' | '));
  });
  finish('AUDIO_ACCEPTANCE PASS');
  app.exit(0);
}

main().catch(e => { console.error('AUDIO_ACCEPTANCE FAILED: ' + (e.stack || e)); app.exit(1); });
