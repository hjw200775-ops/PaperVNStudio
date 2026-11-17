'use strict';
/*
 * V0.4.3 批量编辑实机验收（在测试副本上进行，不改正式原作工程）。
 *
 *   npm run batch:acceptance                  # 多选 / 批量设置 / 预览 / 场景与演出粘贴 / 导出
 *   PAPER_BATCH_REOPEN=1 npm run ...          # 新进程重开，核对批量结果
 *
 * 原生对话框用队列代答；拖动、Shift 连选用合成事件（不代表人工点击）。
 */
const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

const OUT = process.env.CHAPTERS_OUT || 'F:/Wanfeng-Demo';
const CANON = path.join(OUT, '晚风-canon');
const WORK = path.join(OUT, '晚风-batch');
const RESULT = path.join(OUT, '验收结果-v043');
const EXPORT = path.join(RESULT, 'wanfeng-batch.html');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-batch-userdata-'));
app.setPath('userData', userData);
const openQueue = [], messageQueue = [], saveQueue = [];
dialog.showOpenDialog = async () => {
  const next = openQueue.shift();
  return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
};
dialog.showSaveDialog = async () => {
  const next = saveQueue.shift();
  return next ? { canceled: false, filePath: next } : { canceled: true, filePath: '' };
};
dialog.showMessageBox = async () => ({ response: messageQueue.length ? messageQueue.shift() : 2 });
require('../desktop/main.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let win = null;
const run = js => win.webContents.executeJavaScript(js);
const report = { startedAt: new Date().toISOString(), checks: [], unverified: ['真人鼠标勾选与拖动（脚本用合成事件）', '第二台电脑与安装包'] };
function check(name, fn) { fn(); report.checks.push(name); console.log('  ok  ' + name); }
async function shot(name) { fs.writeFileSync(path.join(RESULT, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function click(sel) { await run(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(80); }
async function waitLoad() {
  for (let i = 0; i < 120; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading() && win.webContents.getURL()) return;
    await sleep(100);
  }
  throw new Error('窗口没有加载完成');
}
async function openDir(dir) {
  const target = path.basename(dir);
  const opened = async () => (await run('document.querySelector("#projectPath").textContent')).includes(target);
  for (let i = 0; i < 3; i++) {
    await click('#save'); await sleep(800);
    const failed = (await run('document.querySelector("#saved").textContent')).includes('失败');
    openQueue.length = 0; messageQueue.length = 0;
    messageQueue.push(failed ? 1 : 0, 0); openQueue.push(dir);
    await click('#open'); await sleep(1800);
    if (await opened()) { openQueue.length = 0; messageQueue.length = 0; return; }
  }
  throw new Error('无法打开工程目录：' + dir);
}
const pick = async id => { await run(`document.querySelector('#list [data-pick="${id}"]').click()`); await sleep(90); };
const pickShift = async id => {
  await run(`(()=>{const el=document.querySelector('#list [data-id="${id}"]');el.dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))})()`);
  await sleep(120);
};

async function main() {
  await app.whenReady();
  await waitLoad();
  fs.mkdirSync(RESULT, { recursive: true });
  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const d = args[0];
    const level = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
    if (level >= 2) errors.push(String((d && d.message) || args[2]));
  });
  await sleep(400);

  /* 测试副本：不改正式工程 */
  let work = WORK;
  try { fs.rmSync(WORK, { recursive: true, force: true }); }
  catch { work = WORK + '-' + Date.now(); }   // 沙箱有批量删除上限，删不掉就换目录
  fs.rmSync(work, { recursive: true, force: true });
  fs.cpSync(CANON, work, { recursive: true });
  await openDir(work);
  report.checks.push('在测试副本上开始（正式原作工程未被改动）');
  console.log('  ok  在测试副本上开始：' + work);

  const base = await run(`(()=>{const t=C.tree(p);return {nodes:p.nodes.length,paras:t.chapters[0].paragraphs.map(g=>({id:g.id,title:g.title,n:g.nodes.length})),chars:(p.characters||[]).length}})()`);
  assert.equal(base.nodes, 45);
  assert.deepEqual(base.paras.map(g => g.title), ['早餐', '上学路', '学校走廊']);

  /* ---------- 1. 多选 ---------- */
  await click('#batchToggle');
  const barShown = await run(`!document.querySelector('#batchBar').hidden`);
  await pick('home_02'); await pick('home_04');
  const afterTwo = await run(`({count:document.querySelector('#batchCount').textContent,picked:document.querySelectorAll('#list .node.picked').length})`);
  await pick('home_02');                       // 再点一次取消
  const afterToggle = await run(`document.querySelector('#batchCount').textContent`);
  await pick('home_04');
  await pickShift('home_08');                  // 从 home_04 连选到 home_08
  const afterShift = await run(`({count:document.querySelector('#batchCount').textContent,picked:[...document.querySelectorAll('#list .node.picked')].map(x=>x.dataset.id)})`);
  const pgBreak = base.paras[0].id;
  await run(`document.querySelector('#list [data-pick-paragraph="${pgBreak}"]').click()`);
  await sleep(150);
  const afterParagraph = await run(`({count:document.querySelector('#batchCount').textContent,picked:document.querySelectorAll('#list .node.picked').length})`);
  /* 折叠后选择保留 */
  await run(`document.querySelector('#list [data-toggle-paragraph="${pgBreak}"]').click()`);
  await sleep(150);
  const collapsed = await run(`({count:document.querySelector('#batchCount').textContent,visible:document.querySelectorAll('#list .node.picked').length,pickHint:(document.querySelector('#list [data-paragraph="${pgBreak}"] .pick-badge')||{}).textContent||''})`);
  await shot('01-批量多选与折叠');
  check('批量多选：勾选、取消、Shift 连选、整段全选，折叠后选择保留并显示数量', () => {
    assert(barShown, '进入批量后出现工具栏');
    assert.equal(afterTwo.picked, 2);
    assert.equal(afterToggle, '已选 1 句 · 跨 1 段');
    assert.deepEqual(afterShift.picked.sort(), ['home_04', 'home_05', 'home_06', 'home_07', 'home_08']);
    assert.equal(afterParagraph.picked, 8, '整段选中 8 句');
    assert.equal(collapsed.count, afterParagraph.count, '折叠不清空选择');
    assert.equal(collapsed.visible, 0, '折叠后不渲染被选中的行');
    assert(collapsed.pickHint.includes('已选 8'), '折叠段落的标题上显示已选数量：' + collapsed.pickHint);
  });
  await run(`document.querySelector('#list [data-toggle-paragraph="${pgBreak}"]').click()`);
  await sleep(150);
  await click('#batchClear');
  const cleared = await run(`document.querySelector('#batchCount').textContent`);
  report.checks.push('清空选择');
  assert.equal(cleared, '还没有选择句子');
  console.log('  ok  清空选择');

  /* 未分组说明：删掉一个段落，句子进未分组，树里给出说明；随后撤销恢复 */
  await click('#batchToggle');
  await run(`document.querySelector('#list [data-del-paragraph="${pgBreak}"]').click()`);
  await sleep(250);
  await click('#confirmRemoveParagraph');
  await sleep(400);
  const ungrouped = await run(`(()=>{const n=document.querySelector('#list .ungrouped-note');const c=document.querySelector('#list .chapter.ungrouped .chapter-title');return {note:(n||{}).textContent||'',title:(c||{}).textContent||'',nodes:p.nodes.length}})()`);
  await click('#undo'); await sleep(400);
  const restored = await run(`({paras:C.tree(p).chapters[0].paragraphs.length,nodes:p.nodes.length})`);
  await click('#batchToggle');   // 回到批量模式，后面的勾选才有勾选框
  check('未分组区域说明「仅集中显示、播放位置不变」，撤销后段落恢复', () => {
    assert(ungrouped.title.includes('未分组'));
    assert(ungrouped.note.includes('仅集中显示') && ungrouped.note.includes('播放位置保持原样'), ungrouped.note);
    assert.equal(ungrouped.nodes, 45, '删段落不删剧情');
    assert.equal(restored.paras, 3);
    assert.equal(restored.nodes, 45);
  });

  /* ---------- 2. 批量改说话角色（含旁白与旧表情） ---------- */
  await pick('road_05'); await pick('road_06'); await pick('road_07');
  await click('#batchFields'); await sleep(200);
  const youId = await run(`(p.characters.find(c=>c.name==='林悠')||{}).id`);
  await run(`(()=>{document.querySelector('#fSpeaker').checked=true;document.querySelector('#fSpeaker').dispatchEvent(new Event('change',{bubbles:true}));const s=document.querySelector('#vSpeaker');s.value=${JSON.stringify(youId)};s.dispatchEvent(new Event('change',{bubbles:true}));return s.value})()`);
  await sleep(150);
  await shot('02-批量字段面板');
  await click('#batchPreview'); await sleep(300);
  const preview = await run(`(()=>{const b=document.querySelector('#modalBody');return {text:b.textContent.replace(/\\s+/g,' ').slice(0,160),apply:!!b.querySelector('#batchApply'),skipped:b.querySelectorAll('.issue-list li').length}})()`);
  await shot('03-批量预览');
  const beforeOrder = await run(`JSON.stringify(p.nodes.map(n=>n.id))`);
  await click('#batchApply'); await sleep(500);
  const applied = await run(`(()=>{const ids=['road_05','road_06','road_07'];return ids.map(id=>{const n=p.nodes.find(x=>x.id===id);return {id,speaker:n.speakerId,expr:n.expressionId,name:n.name}})})()`);
  check('批量改说话角色：预览说明、应用后角色与表情正确', () => {
    assert(/已选 3 句/.test(preview.text), preview.text);
    assert(preview.apply, '预览里有应用按钮');
    assert(applied.every(n => n.speaker === youId), '三句都换成了林悠');
    assert(applied.every(n => n.name === '林悠'));
  });
  await click('#undo'); await sleep(400);
  const undone = await run(`(()=>{const n=p.nodes.find(x=>x.id==='road_05');return {speaker:n.speakerId,order:JSON.stringify(p.nodes.map(x=>x.id))}})()`);
  await click('#redo'); await sleep(400);
  const redone = await run(`(()=>{const n=p.nodes.find(x=>x.id==='road_05');return {speaker:n.speakerId}})()`);
  check('一次撤销恢复整批，一次重做恢复结果，节点顺序不变', () => {
    assert.notEqual(undone.speaker, youId, '撤销后回到原说话人');
    assert.equal(undone.order, beforeOrder);
    assert.equal(redone.speaker, youId);
  });
  await click('#undo'); await sleep(300);

  /* ---------- 3. 批量设置在场角色表情 ---------- */
  const geoBefore = await run(`JSON.stringify(p.nodes[0].layers)`);
  await click('#batchClear');
  await pick('road_09'); await pick('road_10'); await pick('road_11');
  await click('#batchFields'); await sleep(200);
  const cheId = await run(`(p.characters.find(c=>c.name==='林澈')||{}).id`);
  const cheSmile = await run(`(()=>{const c=p.characters.find(c=>c.name==='林澈');return (c.expressions.find(e=>e.name==='微笑')||{}).id})()`);
  await run(`(()=>{document.querySelector('#fCast').checked=true;document.querySelector('#fCast').dispatchEvent(new Event('change',{bubbles:true}));const c=document.querySelector('#vCastChar');c.value=${JSON.stringify(cheId)};c.dispatchEvent(new Event('change',{bubbles:true}));const e=document.querySelector('#vCastExpr');e.value=${JSON.stringify(cheSmile)};e.dispatchEvent(new Event('change',{bubbles:true}));return [c.value,e.value]})()`);
  await click('#batchPreview'); await sleep(250);
  const castPreview = await run(`document.querySelector('#modalBody').textContent.replace(/\\s+/g,' ').slice(0,80)`);
  await click('#batchApply'); await sleep(400);
  const castState = await run(`(()=>{const asset=n=>{const l=C.stage(p,n).find(l=>l.characterId===${JSON.stringify(cheId)});return l?l.asset:''};return {a:asset('road_09'),b:asset('road_10'),you:C.stage(p,'road_09').find(l=>l.characterId===${JSON.stringify(youId)}).asset,geo:JSON.stringify(p.nodes[0].layers)}})()`);
  check('批量设置林澈表情：只改在场绑定，林悠与图层几何不变', () => {
    assert(/已选 3 句/.test(castPreview));
    assert.equal(castState.a, 'che_smile');
    assert.equal(castState.b, 'che_smile');
    assert.equal(castState.you, 'you_annoyed', '林悠的表情没被改');
    assert.equal(castState.geo, geoBefore, '图层几何完全没动');
  });
  await click('#undo'); await sleep(300);

  /* ---------- 4. 跳过与冲突原因 ---------- */
  await click('#batchClear');
  await pick('road_09');
  const endId = await run(`(p.nodes.find(n=>n.type==='end')||{}).id`);
  if (endId) await pick(endId);
  await click('#batchFields'); await sleep(200);
  await run(`(()=>{document.querySelector('#fCast').checked=true;document.querySelector('#fCast').dispatchEvent(new Event('change',{bubbles:true}));const c=document.querySelector('#vCastChar');c.value=${JSON.stringify(cheId)};c.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await click('#batchPreview'); await sleep(250);
  const skipPreview = await run(`document.querySelector('#modalBody').textContent.replace(/\\s+/g,' ')`);
  await shot('04-跳过原因');
  await click('#closeModal'); await sleep(200);
  check('结局节点被跳过并说明原因', () => {
    assert(/跳过 1 句/.test(skipPreview), skipPreview.slice(0, 120));
    assert(/不参与批量修改/.test(skipPreview));
  });

  /* ---------- 5. 场景复制粘贴 ---------- */
  await click('#batchClear');
  await run(`(()=>{const b=document.querySelector('#list [data-id="road_09"]');b.click()})()`);
  await sleep(200);
  await click('#batchCopyScene');
  const sceneBefore = await run(`(()=>{const t=p.nodes.find(n=>n.id==='road_12');return {mode:t.sceneMode,text:t.text,next:t.next,effects:t.effects.length}})()`);
  await pick('road_12'); await pick('road_13');
  await click('#batchPasteScene'); await sleep(250);
  const scenePreview = await run(`document.querySelector('#modalBody').textContent.replace(/\\s+/g,' ')`);
  await click('#pasteApply'); await sleep(450);
  const sceneAfter = await run(`(()=>{const t=p.nodes.find(n=>n.id==='road_12');return {mode:t.sceneMode,text:t.text,next:t.next,effects:t.effects.length,layers:t.layers.map(l=>l.id),bg:t.layers.find(l=>l.kind==='bg').asset}})()`);
  await shot('05-粘贴场景');
  check('粘贴场景：目标变独立场景，只换布局，不动台词/跳转/演出', () => {
    assert(/可应用 2 句/.test(scenePreview));
    assert.equal(sceneBefore.mode, 'inherit');
    assert.equal(sceneAfter.mode, 'own');
    assert.equal(sceneAfter.text, sceneBefore.text);
    assert.equal(sceneAfter.next, sceneBefore.next);
    assert.equal(sceneAfter.effects, sceneBefore.effects, '演出数量没变');
    assert.deepEqual(sceneAfter.layers, ['background', 'linyou', 'linche']);
    assert.equal(sceneAfter.bg, 'bg_road');
  });
  /* 粘贴后的目标之间、与源句之间不共享图层对象 */
  await run(`(()=>{edit(()=>{const n=p.nodes.find(n=>n.id==='road_12');n.layers[0].opacity=55});return true})()`);
  await sleep(200);
  const independent = await run(`(()=>{const o=id=>p.nodes.find(n=>n.id===id).layers[0].opacity;return {a:o('road_12'),b:o('road_13'),src:o('road_09')}})()`);
  check('修改粘贴后的某一句不影响其他目标与源句', () => {
    assert.equal(independent.a, 55);
    assert.equal(independent.b, 100);
    assert.equal(independent.src, 100);
  });

  /* ---------- 6. 演出复制粘贴 ---------- */
  await click('#batchClear');
  await run(`(()=>{document.querySelector('#list [data-id="road_17"]').click()})()`);
  await sleep(200);
  const srcFx = await run(`(()=>{const n=p.nodes.find(n=>n.id==='road_17');return {count:n.effects.length,types:n.effects.map(e=>e.type).sort()}})()`);
  await click('#batchCopyFx');
  await pick('road_20');
  await click('#batchPasteFx'); await sleep(200);
  await shot('06-粘贴演出方式');
  await click('#fxReplace'); await sleep(300);
  const fxPreview = await run(`document.querySelector('#modalBody').textContent.replace(/\\s+/g,' ')`);
  await click('#pasteApply'); await sleep(400);
  const fxAfter = await run(`(()=>{const n=p.nodes.find(n=>n.id==='road_20');return {count:n.effects.length,types:n.effects.map(e=>e.type).sort(),ids:n.effects.map(e=>e.id),layers:n.effects.map(e=>e.layer).sort()}})()`);
  const fxSrcIds = await run(`p.nodes.find(n=>n.id==='road_17').effects.map(e=>e.id)`);
  await shot('07-演出粘贴结果');
  check('复制演出：替换目标、自动匹配同图层、生成新 ID', () => {
    assert.equal(srcFx.count, 2);
    assert(/可应用 1 句/.test(fxPreview));
    assert.equal(fxAfter.count, 2);
    assert.deepEqual(fxAfter.types, srcFx.types);
    assert(fxAfter.ids.every(id => !fxSrcIds.includes(id)), '演出 ID 是新的');
    assert.deepEqual(fxAfter.layers, ['background', 'linyou']);
  });
  /* 追加冲突 */
  await click('#batchCopyFx');
  await click('#batchPasteFx'); await sleep(200);
  await click('#fxAppend'); await sleep(300);
  const appendPreview = await run(`document.querySelector('#modalBody').textContent.replace(/\\s+/g,' ')`);
  await shot('08-追加冲突');
  await click('#closeModal'); await sleep(200);
  check('追加同图层同类型演出时识别冲突并阻止写入', () => {
    assert(/可应用 0 句/.test(appendPreview), appendPreview.slice(0, 120));
    assert(/已经有同类演出/.test(appendPreview));
  });

  /* ---------- 7. 预览取消不改数据 ---------- */
  await click('#batchClear');
  await pick('road_22');
  const snapBefore = await run(`JSON.stringify(p.nodes.find(n=>n.id==='road_22'))`);
  await click('#batchFields'); await sleep(200);
  await run(`(()=>{document.querySelector('#fSpeaker').checked=true;document.querySelector('#fSpeaker').dispatchEvent(new Event('change',{bubbles:true}));const s=document.querySelector('#vSpeaker');s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await click('#batchPreview'); await sleep(250);
  await click('#closeModal'); await sleep(250);
  const snapAfterCancel = await run(`JSON.stringify(p.nodes.find(n=>n.id==='road_22'))`);
  check('预览取消后工程完全不变', () => {
    assert.equal(snapAfterCancel, snapBefore);
  });

  /* ---------- 8. 保存、导出、离线一致 ---------- */
  await click('#batchToggle');
  await click('#save'); await sleep(1500);
  const saveState = await run('({saved:document.querySelector("#saved").textContent,toast:document.querySelector("#toast").textContent})');
  if (/失败/.test(saveState.saved)) throw new Error('界面保存失败：' + saveState.saved + ' / ' + saveState.toast);
  const disk = JSON.parse(fs.readFileSync(path.join(work, 'project.paper.json'), 'utf8'));
  const n12 = disk.nodes.find(n => n.id === 'road_12');
  const n20 = disk.nodes.find(n => n.id === 'road_20');
  check('保存后批量结果落盘：场景与演出粘贴都在', () => {
    assert.equal(n12.sceneMode, 'own');
    assert.equal(n12.layers.length, 3);
    assert.equal(n20.effects.length, 2);
  });
  saveQueue.push(EXPORT);
  await click('#export'); await sleep(2500);
  const html = fs.readFileSync(EXPORT, 'utf8');
  check('导出 HTML 自包含且携带批量结果', () => {
    assert(!html.includes('file:///') && html.includes('"chapters"'));
    assert(html.length > 5 * 1024 * 1024);
  });

  const game = new BrowserWindow({ width: 1200, height: 820, show: true, title: '离线核对', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await game.loadFile(EXPORT); await sleep(800);
  const road20 = disk.nodes.find(n => n.id === 'road_20');
  const offlineScript = `(async()=>{
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const target=TARGET_TEXT;
 for(let i=0;i<90;i++){
  if(document.querySelector('#text').textContent===target){await sleep(800);break}
  if(document.querySelector('#hint').textContent.indexOf('故事结束')>=0)break;
  document.querySelector('#scene').click();
  await sleep(25);
 }
 const you=document.querySelector('#layers .visual-layer[data-layer="linyou"]');
 const bg=document.querySelector('#layers .visual-layer[data-layer="background"]');
 return JSON.stringify({text:document.querySelector('#text').textContent,transform:you?you.style.transform:'',filter:bg?bg.style.filter:''});
})()`.replace('TARGET_TEXT', JSON.stringify(road20.text));
  fs.writeFileSync(path.join(RESULT, 'offline-script.js'), offlineScript, 'utf8');
  const offlineRaw = await game.webContents.executeJavaScript(offlineScript);
  const offline = JSON.parse(offlineRaw);
  if (offline.error) throw new Error('离线脚本出错：' + offline.error);
  fs.writeFileSync(path.join(RESULT, '09-离线HTML.png'), (await game.webContents.capturePage()).toPNG());
  game.destroy();
  check('离线 HTML 里粘贴过来的演出按编辑器一致播放', () => {
    assert.equal(offline.text, road20.text, '走到了粘贴演出的那一句');
    assert(/scale\(1\.2\)/.test(offline.transform), '角色特写生效：' + offline.transform);
    assert(/blur\((?!0px)/.test(offline.filter), '背景虚化生效：' + offline.filter);
  });

  check('整个流程没有渲染进程报错', () => assert.equal(errors.length, 0, errors.join(' | ')));

  report.finishedAt = new Date().toISOString();
  report.workDir = work;
  report.exported = EXPORT;
  report.screenshots = fs.readdirSync(RESULT).filter(f => f.endsWith('.png')).sort();
  fs.writeFileSync(path.join(RESULT, '验收报告-v043.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\nBATCH_ACCEPTANCE PASS');
  console.log('RESULT_DIR=' + RESULT);
}

async function reopen() {
  await app.whenReady();
  await waitLoad();
  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const d = args[0];
    const level = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
    if (level >= 2) errors.push(String((d && d.message) || args[2]));
  });
  await sleep(400);
  const workDir = JSON.parse(fs.readFileSync(path.join(RESULT, '验收报告-v043.json'), 'utf8')).workDir;
  await openDir(workDir);
  const n12text = JSON.parse(fs.readFileSync(path.join(workDir, 'project.paper.json'), 'utf8')).nodes.find(n => n.id === 'road_12').text;
  const state = await run(`(()=>{const n12=p.nodes.find(n=>n.id==='road_12'),n20=p.nodes.find(n=>n.id==='road_20');
    return {nodes:p.nodes.length,sceneMode:n12.sceneMode,layers:n12.layers.map(l=>l.id),effects:n20.effects.length,text:n12.text}})()`);
  assert.equal(state.nodes, 45);
  assert.equal(state.sceneMode, 'own');
  assert.deepEqual(state.layers, ['background', 'linyou', 'linche']);
  assert.equal(state.effects, 2);
  assert.equal(state.text, n12text, '台词没有被场景粘贴改掉');
  await shot('10-重开工程');
  fs.writeFileSync(path.join(RESULT, '重开检查.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...state }, null, 2), 'utf8');
  assert.equal(errors.length, 0, errors.join(' | '));
  console.log('  ok  新进程重开：45 句、粘贴后的场景与演出都在，台词未变');
  console.log('\nBATCH_REOPEN PASS');
}

if (process.env.PAPER_BATCH_REOPEN === '1') {
  reopen().then(() => app.exit(0)).catch(err => { console.error('BATCH REOPEN FAILED: ' + (err && err.stack)); app.exit(1); });
} else {
  main().then(() => app.exit(0)).catch(err => { console.error('BATCH ACCEPTANCE FAILED: ' + (err && err.stack)); app.exit(1); });
}
