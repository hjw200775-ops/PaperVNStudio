'use strict';
/*
 * V0.4.2 章节与段落验收：真实主进程 + 真实窗口。
 *
 *   npm run chapters:acceptance              # 整理原作工程 + 截图 + 导入预览 + 定位 + 定点试玩 + 导出
 *   PAPER_CHAPTERS_REOPEN=1 npm run ...      # 新进程重开，确认章节与角色都还在
 *
 * 原生对话框用队列代答（与其它烟测一致）；其余是真实窗口事件流。
 * 批量归组调用编辑器自己的 C.moveNodeToParagraph，一次性编辑、可整体撤销。
 */
const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

const OUT = process.env.CHAPTERS_OUT || 'F:/Wanfeng-Demo';
const CANON = path.join(OUT, '晚风-canon');
const TXT_DIR = path.join(OUT, '晚风-txt导入');
const BAD_DIR = path.join(OUT, '晚风-canon-异常');
const RESULT = path.join(OUT, '验收结果-v042');
const EXPORT = path.join(RESULT, 'wanfeng-chapters.html');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-chapters-userdata-'));
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
const report = { startedAt: new Date().toISOString(), checks: [], unverified: ['真人鼠标拖动（脚本用 DragEvent 合成拖动事件）', '第二台电脑与 EXE 安装包'] };
function check(name, fn) { fn(); report.checks.push(name); console.log('  ok  ' + name); }
async function shot(name) { fs.writeFileSync(path.join(RESULT, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function click(sel) { await run(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(60); }
async function setInput(sel, value, event = 'input') {
  await run(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('缺少 ${sel}');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));return e.value})()`);
  await sleep(60);
}
async function waitLoad() {
  for (let i = 0; i < 120; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading() && win.webContents.getURL()) return;
    await sleep(100);
  }
  throw new Error('窗口没有加载完成');
}
/* 打开工程目录：先落盘减少「未保存修改」的概率，打不开就补一次队列重试。 */
async function openDir(dir) {
  const target = path.basename(dir);
  openQueue.length = 0; messageQueue.length = 0;   // 清掉上一轮残留的对话框答案，避免开错目录
  const opened = async () => (await run('document.querySelector("#projectPath").textContent')).includes(target);
  for (let i = 0; i < 3; i++) {
    await click('#save'); await sleep(900);
    /* 工程本身有校验错误时保存会失败，这时只能放弃修改才能切走（异常测试副本正是这种情况） */
    const saveFailed = (await run('document.querySelector("#saved").textContent')).includes('失败');
    /* 可能有两个原生弹窗：先「保存并继续/放弃修改」，再「打开哪一种」→ 工程目录 */
    messageQueue.push(saveFailed ? 1 : 0, 0); openQueue.push(dir);
    await click('#open'); await sleep(1900);
    if (await opened()) { openQueue.length = 0; messageQueue.length = 0; return; }
    messageQueue.push(saveFailed ? 1 : 0, 0); openQueue.push(dir);
    await click('#open'); await sleep(1900);
    if (await opened()) { openQueue.length = 0; messageQueue.length = 0; return; }
  }
  throw new Error('无法打开工程目录：' + dir);
}
async function renameChapter(id, title) {
  await run(`document.querySelector('#list [data-rename-chapter="${id}"]').click()`); await sleep(150);
  await setInput('#nameInput', title); await click('#confirmName'); await sleep(200);
}
async function renameParagraph(id, title) {
  await run(`document.querySelector('#list [data-rename-paragraph="${id}"]').click()`); await sleep(150);
  await setInput('#nameInput', title); await click('#confirmName'); await sleep(200);
}
async function addParagraph(chapterId, title) {
  await run(`document.querySelector('#list [data-add-paragraph="${chapterId}"]').click()`); await sleep(150);
  await setInput('#nameInput', title); await click('#confirmName'); await sleep(200);
}

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
  await sleep(500);

  await openDir(CANON);
  const initial = await run('({nodes:document.querySelectorAll("#list .node").length,chapters:document.querySelectorAll("#list .chapter").length,paras:document.querySelectorAll("#list .paragraph").length,title:document.querySelector("#title").value})');
  assert.equal(initial.nodes, 45, '原作工程 45 句');
  check('打开 V0.4.1 工程：45 句都在，章节结构可用（首次为默认章节/段落）', () => {
    assert(initial.chapters >= 1);
    assert(initial.paras >= 1);
  });
  /* 先确认播放顺序仍是剧本原顺序：早前的失败运行曾把演示工程拖乱，
     这里按素材包里的节点顺序恢复，并按 id 前缀重新归组，避免在错误状态上证实验收。 */
  const packOrder = JSON.parse(fs.readFileSync('F:/Wanfeng-Demo-Pack/story/wanfeng_canon.paper.json', 'utf8')).nodes.map(n => n.id);
  const curOrder = await run('p.nodes.map(n=>n.id)');
  const struct0 = await run("p.chapters.map(c=>({id:c.id,title:c.title,paras:c.paragraphs.map(g=>({id:g.id,title:g.title}))}))");
  const threeParas = struct0.length === 1 && struct0[0].paras.length === 3;
  if (curOrder.join('|') !== packOrder.join('|')) {
    await run(`(()=>{
      const want=${JSON.stringify(packOrder)};
      const pg={home:${JSON.stringify(threeParas ? struct0[0].paras[0].id : '')},road:${JSON.stringify(threeParas ? struct0[0].paras[1].id : '')},school:${JSON.stringify(threeParas ? struct0[0].paras[2].id : '')}};
      edit(()=>{
        const m=new Map(p.nodes.map(n=>[n.id,n]));
        const out=want.map(id=>m.get(id)).filter(Boolean);
        for(const n of p.nodes)if(!want.includes(n.id))out.push(n);
        p.nodes=out;
        if(pg.home)for(const n of p.nodes)n.paragraphId=/^home_/.test(n.id)?pg.home:/^road_/.test(n.id)?pg.road:pg.school;
      });
    })()`);
    await sleep(400);
    console.log('  --  播放顺序已恢复为剧本原顺序，并按前缀重新归组');
  }

  /* 工程可能已经整理过：重复运行时不要重复加段落，也不要覆盖第一次的「默认分组」截图。 */
  const struct = await run("p.chapters.map(c=>({id:c.id,title:c.title,paras:c.paragraphs.map(g=>({id:g.id,title:g.title}))}))");
  const organized = struct.length===1 && struct[0].paras.length===3 && struct[0].paras.map(x=>x.title).join('|')==='早餐|上学路|学校走廊';
  const chId = struct[0].id;
  let pgBreak, pgRoad, pgSchool;
  if(organized){
   [pgBreak,pgRoad,pgSchool] = struct[0].paras.map(x=>x.id);
   console.log('  --  工程已经是「第一章 / 早餐 · 上学路 · 学校走廊」，跳过整理');
  }else{
   if(!fs.existsSync(path.join(RESULT,'01-默认章节.png')))await shot('01-默认章节');
   const pgIds = await run("[...document.querySelectorAll('#list [data-paragraph-head]')].map(x=>x.dataset.paragraphHead)");
   await renameChapter(chId, '第一章');
   await renameParagraph(pgIds[0], '早餐');
   await addParagraph(chId, '上学路');
   await addParagraph(chId, '学校走廊');
   const paras = await run("[...document.querySelectorAll('#list [data-paragraph-head]')].map(x=>({id:x.dataset.paragraphHead,title:x.querySelector('.paragraph-title').textContent}))");
   pgBreak = paras.find(g => g.title === '早餐').id;
   pgRoad = paras.find(g => g.title === '上学路').id;
   pgSchool = paras.find(g => g.title === '学校走廊').id;
  }

  const idsBefore = await run('JSON.stringify(p.nodes.map(n=>n.id))');
  if(!organized){
    const group = await run(`(()=>{
      const ids=p.nodes.map(n=>n.id);
      const byId=(prefix,a,b)=>ids.filter(id=>{const m=new RegExp('^'+prefix+'(\\\\d+)$').exec(id);return m&&+m[1]>=a&&+m[1]<=b});
      const plan=[
        {pg:${JSON.stringify(pgBreak)},ids:byId('home_',1,8)},
        {pg:${JSON.stringify(pgRoad)},ids:byId('road_',1,28)},
        {pg:${JSON.stringify(pgSchool)},ids:[...byId('school_',1,8),'demo_end']}
      ];
      edit(()=>{for(const step of plan)for(const id of step.ids)C.moveNodeToParagraph(p,id,step.pg,null)});
      return plan.map(s=>({pg:s.pg,n:s.ids.length}));
    })()`);
    await sleep(400);
  }
  const idsAfter = await run('JSON.stringify(p.nodes.map(n=>n.id))');
  const counts = await run("[...document.querySelectorAll('#list .paragraph')].map(g=>({title:g.querySelector('.paragraph-title').textContent,count:g.querySelector('.count-pill').textContent}))");
  check('整理为「第一章 / 早餐 · 上学路 · 学校走廊」，播放顺序与节点 ID 完全不变', () => {
    assert.equal(idsAfter, idsBefore, '整理前后 p.nodes 顺序一致');
    assert.deepEqual(counts.map(c => c.count), ['8', '28', '9']);
  });
  await shot('02-章节树');

  /* 折叠/展开 */
  await run(`document.querySelector('#list [data-toggle-paragraph="${pgRoad}"]').click()`);
  await sleep(200);
  const collapsed = await run(`document.querySelectorAll('#list [data-paragraph="${pgRoad}"] .node').length`);
  await shot('03-折叠段落');
  await run(`document.querySelector('#list [data-toggle-paragraph="${pgRoad}"]').click()`);
  await sleep(200);
  const expanded = await run(`document.querySelectorAll('#list [data-paragraph="${pgRoad}"] .node').length`);
  check('折叠后该段不渲染句子，展开后恢复（折叠状态随工程保存）', () => {
    assert.equal(collapsed, 0);
    assert.equal(expanded, 28);
  });

  /* 拖动一句：早餐 -> 上学路（合成 DragEvent，走真实拖动处理） */
  const dragResult = await run(`(()=>{
    const row=document.querySelector('#list [data-paragraph="${pgBreak}"] .node');
    const fromId=row.dataset.id;
    const target=document.querySelector('#list [data-drop-paragraph="${pgRoad}"]');
    const dt=new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
    target.dispatchEvent(new DragEvent('dragover',{bubbles:true,dataTransfer:dt,clientY:target.getBoundingClientRect().bottom-2}));
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));
    return {fromId,modal:document.querySelector('#modal').open};
  })()`);
  await sleep(300);
  const afterDrop = await run(`(()=>{
    const modal=document.querySelector('#modal').open;
    const heading=modal?document.querySelector('#modalBody h2').textContent:'';
    const confirm=document.querySelector('#applyMove');
    if(confirm)confirm.click();
    return {heading,confirm:!!confirm};
  })()`);
  await sleep(400);
  const dropState = await run(`(()=>{
    const n=p.nodes.find(x=>x.id===${JSON.stringify(dragResult.fromId)});
    return {paragraph:n.paragraphId,order:p.nodes.map(x=>x.id).slice(0,3)};
  })()`);
  check('拖动一句到另一个段落：落点生效，并先解释「按顺序继续」的变化', () => {
    assert(afterDrop.confirm, '拖动后出现顺序影响提示：' + afterDrop.heading);
    assert.equal(dropState.paragraph, pgRoad);
    assert.notEqual(dropState.order[0], dragResult.fromId, '句子确实移动了位置');
  });
  await shot('04-拖动后');
  await click('#undo'); await sleep(400);
  const undone = await run(`(()=>{const n=p.nodes.find(x=>x.id===${JSON.stringify(dragResult.fromId)});return {paragraph:n.paragraphId,order:JSON.stringify(p.nodes.map(x=>x.id))}})()`);
  check('撤销恢复分组与顺序', () => assert.equal(undone.order, idsBefore));
  await click('#redo'); await sleep(400);
  const redone = await run(`(()=>{const n=p.nodes.find(x=>x.id===${JSON.stringify(dragResult.fromId)});return {paragraph:n.paragraphId,order:JSON.stringify(p.nodes.map(x=>x.id))}})()`);
  check('重做恢复移动后的分组与顺序', () => {
    assert.equal(redone.paragraph, pgRoad);
    assert.notEqual(redone.order, idsBefore, '重做后回到移动过的顺序');
  });
  await click('#undo'); await sleep(400);
  assert.equal(await run('JSON.stringify(p.nodes.map(n=>n.id))'), idsBefore, '再撤销一次回到原始顺序');

  /* 移动到…（对话框）+ 影响提示，然后取消 */
  await run(`document.querySelector('#list [data-paragraph="${pgBreak}"] .node').click()`);
  await sleep(200);
  await click('#moveNode'); await sleep(200);
  const moveModal = await run("({open:document.querySelector('#modal').open,options:document.querySelectorAll('#moveTarget option').length})");
  assert(moveModal.open, '「移动到…」对话框打开');
  await run(`(()=>{const s=document.querySelector('#moveTarget');s.value=${JSON.stringify(pgSchool)};document.querySelector('#confirmMove').click()})()`);
  await sleep(300);
  const impact = await run("({open:document.querySelector('#modal').open,heading:document.querySelector('#modalBody h2').textContent,items:document.querySelectorAll('#modalBody li').length})");
  await shot('05-顺序影响提示');
  await run("document.querySelector('#closeModal').click()");
  await sleep(200);
  const keptOrder = await run('JSON.stringify(p.nodes.map(n=>n.id))');
  check('「移动到…」先展示影响清单，取消后工程不变', () => {
    assert(/按顺序继续/.test(impact.heading));
    assert(impact.items > 0, '列出了受影响句子');
    assert.equal(keptOrder, idsBefore);
  });

  /* 检查定位：在临时副本里删除一个被引用的表情，看能否点结果跳过去 */
  /* 本机沙箱有每回合批量删除上限，删不掉就换一个带时间戳的副本目录，避免同一轮重复删。 */
  let badDir = BAD_DIR;
  try { fs.rmSync(BAD_DIR, { recursive: true, force: true }); }
  catch { badDir = BAD_DIR + '-' + Date.now(); }
  fs.rmSync(badDir, { recursive: true, force: true });
  fs.cpSync(CANON, badDir, { recursive: true });
  await openDir(badDir);
  await run(`(()=>{const b=[...document.querySelectorAll('#castList [data-char]')];if(b[0])b[0].click();return b.length})()`);
  await sleep(200);
  const badExpr = await run(`(()=>{
    const btn=document.querySelectorAll('#exprList [data-del-expr]')[0];
    if(!btn)return null;
    btn.click();
    return true;
  })()`);
  await sleep(300);
  if (badExpr) {
    // 选择「保留占位」，制造一个被引用的失效表情
    await run(`(()=>{const s=document.querySelector('#exprReplace');if(s)s.value='__keep';document.querySelector('#confirmExprDelete').click()})()`);
    await sleep(400);
  }
  await click('#check'); await sleep(400);
  const checkModal = await run(`(()=>{const body=document.querySelector('#modalBody');return {title:body.querySelector('h2').textContent,items:body.querySelectorAll('[data-issue]').length,jump:body.querySelectorAll('[data-issue] .jump').length}})()`);
  await shot('06-剧情检查');
  const located = await run(`(()=>{
    const list=document.querySelectorAll('#modalBody [data-issue]');
    for(const b of list){if(b.querySelector('.jump')){b.click();break}}
    return new Promise(r=>setTimeout(()=>r({modalOpen:document.querySelector('#modal').open,active:document.querySelectorAll('#list .node.active').length,activeText:(document.querySelector('#list .node.active')||{}).title||''}),300));
  })()`);
  check('剧情检查结果可点击定位：展开章段、选中节点、关闭弹窗', () => {
    assert(/错误|提示/.test(checkModal.title), '检查弹窗：' + checkModal.title);
    assert(checkModal.jump > 0, '存在可定位条目');
    assert.equal(located.active, 1, '定位后有一句被选中');
    assert.equal(located.modalOpen, false, '定位后弹窗关闭');
  });
  await shot('07-定位结果');

  /* 从本句 / 本段试玩（回到正式工程） */
  await openDir(CANON);
  await run(`(()=>{const b=document.querySelector('#list [data-id="road_17"]');if(b)b.click();return !!b})()`);
  await sleep(250);
  await click('#playHere'); await sleep(1000);   // 试玩中不可点「效果终态」，等入场动画播完再读状态
  const cue = await run(`(()=>{const w=document.querySelector('#layersCanvas [data-layer="linyou"]');const bg=document.querySelector('#layersCanvas [data-layer="background"]');const i=document.querySelector('#layersCanvas [data-layer="linyou"] img');return {transform:w.style.transform,filter:bg.style.filter,who:document.querySelector('#speaker').textContent,notice:document.querySelector('#entryNotice').textContent,text:document.querySelector('#line').textContent}})()`);
  await shot('08-从road_17试玩');
  check('从 road_17 试玩：林悠表情、120% 特写与背景虚化都在，并说明入口规则', () => {
    assert.equal(cue.text, '林澈！');
    assert.equal(cue.who, '林悠');
    assert(/scale\(1\.2\)/.test(cue.transform), cue.transform);
    assert(/blur\((?!0px)/.test(cue.filter), cue.filter);
    assert(/从「/.test(cue.notice), '入口提示：' + cue.notice);
  });
  await click('#next'); await sleep(250);
  const afterLine = await run(`(()=>{const w=document.querySelector('#layersCanvas [data-layer="linyou"]');const bg=document.querySelector('#layersCanvas [data-layer="background"]');return {transform:w.style.transform,filter:bg.style.filter}})()`);
  check('下一句恢复：特写与虚化按 sentence 规则撤销', () => {
    assert(!/scale\(1\.2\)/.test(afterLine.transform), afterLine.transform);
    assert(/blur\(0px\)/.test(afterLine.filter), afterLine.filter);
  });
  /* 从学校走廊段落试玩，不沿用上学路背景 */
  await click('#stop'); await sleep(200);
  await run(`(()=>{const b=document.querySelector('#list [data-id="school_04"]');if(b)b.click()})()`);
  await sleep(250);
  await click('#playPara'); await sleep(350);
  const schoolPlay = await run(`(()=>{const bg=document.querySelector('#layersCanvas [data-layer="background"]');const img=bg?bg.querySelector('img'):null;const start=p.nodes.find(x=>x.id===current);return {startId:start.id,bgSrcLen:img?img.src.length:0,notice:document.querySelector('#entryNotice').textContent,who:document.querySelector('#speaker').textContent}})()`);
  const expectedSchool = await run(`(()=>{const a=p.assets.find(a=>a.id==='bg_school');return a.data.length})()`);
  await shot('09-从学校段试玩');
  check('从学校走廊段试玩：起点是该段第一句，背景是学校走廊而不是上学路', () => {
    assert.equal(schoolPlay.startId, 'school_01', '从段落第一句开始');
    assert.equal(schoolPlay.bgSrcLen, expectedSchool, '背景素材为校园走廊');
  });
  await click('#stop'); await sleep(200);

  /* TXT 导入预览（独立测试工程） */
  /* 用主进程同一个工程存储建一个空白测试工程，再用「打开工程目录」进入；
     比连续点「新建」更稳，也不依赖对话框队列顺序。 */
  const createProjectStore = require('../desktop/project-store.cjs');
  const createVNCore = require('../dist/core.js');
  const S = createProjectStore(); const Cc = createVNCore();
  const blank = Cc.blank();
  const seed = Cc.makeNode('say');
  seed.paragraphId = blank.chapters[0].paragraphs[0].id;
  seed.text = '测试工程的起始句。';
  blank.nodes.push(seed);
  try { fs.rmSync(TXT_DIR, { recursive: true, force: true }); } catch { /* 目录不存在或删不掉都不影响 */ }
  if (fs.existsSync(path.join(TXT_DIR, 'project.paper.json'))) {
    const reopen = S.openProject(TXT_DIR);                 // 上次残留就清空内容重建
    reopen.project.nodes = [seed];
    reopen.project.chapters = blank.chapters;
    S.saveProject(TXT_DIR, reopen.project);
  } else {
    S.createProject(TXT_DIR, blank);
  }
  await openDir(TXT_DIR);
  const fresh = await run('p.nodes.length');
  assert.equal(fresh, 1, '导入测试工程应为空白（当前 ' + fresh + ' 句）');
  console.log('  --  导入测试工程：' + (await run('document.querySelector("#title").value')));
  await run(`(()=>{edit(()=>{p.characters=[{id:'ch_t1',name:'林悠',color:'#3f6753',defaultExpressionId:'',expressions:[]},{id:'ch_t2',name:'林澈',color:'#7a5b3f',defaultExpressionId:'',expressions:[]}]});return p.characters.length})()`);
  await sleep(300);
  await run(`document.querySelector('.tabs [data-tab="text"]').click()`); await sleep(150);
  const text = ['# 测试章', '## 早餐', '林悠：豆浆快凉了。', '林澈：来了。', '两人低头吃饭。', '陌生人：借过一下。', '## 上学路', '林悠：今天风大。'].join('\n');
  await run(`(()=>{const t=document.querySelector('#importText');t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const beforeImport = await run('p.nodes.length');
  await click('#parse'); await sleep(400);
  const preview = await run(`(()=>{const body=document.querySelector('#modalBody');return {open:document.querySelector('#modal').open,text:body.textContent.replace(/\\s+/g,' ').slice(0,400),rows:body.querySelectorAll('.import-tree li').length,options:body.querySelectorAll('input[name="impTarget"]').length}})()`);
  await shot('10-导入预览');
  await run("document.querySelector('#closeModal').click()"); await sleep(200);
  const afterCancel = await run('p.nodes.length');
  check('导入预览：显示句数/角色绑定/章段结构，取消后工程不变', () => {
    assert(preview.open);
    assert(/识别到/.test(preview.text), preview.text.slice(0, 80));
    assert.equal(afterCancel, beforeImport, '取消不新增节点');
  });
  await click('#parse'); await sleep(300);
  await click('#confirmImport'); await sleep(600);
  const imported = await run(`({nodes:p.nodes.length,chapters:p.chapters.length,paras:p.chapters.reduce((s,c)=>s+c.paragraphs.length,0),bound:p.nodes.filter(n=>n.speakerId).length,last:p.chapters[p.chapters.length-1].paragraphs.map(g=>g.title)})`);
  check('确认导入：一次写入 5 句、新建 1 个章节 2 个段落、绑定 3 句已登记角色', () => {
    assert.equal(imported.nodes, beforeImport + 5);
    assert.equal(imported.chapters, 2, '原章节 + 文本里的新章节');
    assert.equal(imported.paras, 3, '原段落 + 早餐 + 上学路');
    assert.deepEqual(imported.last, ['早餐', '上学路']);
    assert.equal(imported.bound, 3, '林悠 2 句 + 林澈 1 句');
  });
  await shot('11-导入结果');
  await click('#undo'); await sleep(500);
  const afterUndo = await run('({nodes:p.nodes.length,chapters:p.chapters.length})');
  check('导入可一次整体撤销', () => {
    assert.equal(afterUndo.nodes, beforeImport);
    assert.equal(afterUndo.chapters, 1);
  });

  /* 回到正式工程：保存、导出 */
  await openDir(CANON);
  await click('#save'); await sleep(1200);
  const disk = JSON.parse(fs.readFileSync(path.join(CANON, 'project.paper.json'), 'utf8'));
  check('保存：schema 5，章节/段落/归属与 45 句一起落盘', () => {
    assert.equal(disk.schema, 5);
    assert.equal(disk.chapters.length, 1);
    assert.deepEqual(disk.chapters[0].paragraphs.map(p => p.title), ['早餐', '上学路', '学校走廊']);
    assert.equal(disk.nodes.length, 45);
    assert(disk.nodes.every(n => n.paragraphId));
  });
  saveQueue.push(EXPORT);
  await click('#export'); await sleep(2500);
  const html = fs.readFileSync(EXPORT, 'utf8');
  check('导出 HTML：自包含且带章节数据，播放结果不变', () => {
    assert(html.includes('"chapters"') && html.includes('"paragraphId"'));
    assert(!html.includes('file:///') && !html.includes('127.0.0.1'));
    assert(html.includes('"characters"'));
    assert(html.length > 5 * 1024 * 1024);
  });

  const game = new BrowserWindow({ width: 1200, height: 820, show: true, title: '离线播放验证', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await game.loadFile(EXPORT); await sleep(800);
  const offline = await game.webContents.executeJavaScript(`(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<80;i++){const t=document.querySelector('#text').textContent;if(t==='林澈！'){await sleep(800);break}if(document.querySelector('#hint').textContent.includes('故事结束'))break;document.querySelector('#scene').click();await sleep(30)}const w=document.querySelector('#layers .visual-layer[data-layer="linyou"]');return {text:document.querySelector('#text').textContent,who:document.querySelector('#who').textContent,transform:w?w.style.transform:'',filter:document.querySelector('#layers .visual-layer[data-layer="background"]').style.filter}})()`);
  await sleep(200);
  fs.writeFileSync(path.join(RESULT, '12-离线HTML.png'), (await game.webContents.capturePage()).toPNG());
  game.destroy();
  check('离线 HTML：剧情、角色、表情与演出与编辑器一致', () => {
    assert.equal(offline.text, '林澈！');
    assert.equal(offline.who, '林悠');
    assert(/scale\(1\.2\)/.test(offline.transform), offline.transform);
    assert(/blur\((?!0px)/.test(offline.filter), offline.filter);
  });

  check('整个流程没有渲染进程报错', () => assert.equal(errors.length, 0, errors.join(' | ')));

  const crypto = require('node:crypto');
  report.export = {
    file: EXPORT,
    bytes: fs.statSync(EXPORT).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(EXPORT)).digest('hex')
  };
  report.finishedAt = new Date().toISOString();
  report.demoDirs = { canon: CANON, txt: TXT_DIR, anomaly: badDir };
  report.exported = EXPORT;
  report.screenshots = fs.readdirSync(RESULT).filter(f => f.endsWith('.png')).sort();
  fs.writeFileSync(path.join(RESULT, '验收报告-v042.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\nCHAPTERS_ACCEPTANCE PASS');
  console.log('RESULT_DIR=' + RESULT);
  console.log('EXPORTED=' + EXPORT);
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
  await openDir(CANON);
  const state = await run(`({
    nodes:p.nodes.length,
    chapters:p.chapters.map(c=>({title:c.title,paras:c.paragraphs.map(g=>g.title)})),
    chars:(p.characters||[]).length,
    first:p.nodes[0].id,last:p.nodes[p.nodes.length-1].id
  })`);
  assert.equal(state.nodes, 45);
  assert.equal(state.chars, 2, '重开后角色仍在');
  assert.deepEqual(state.chapters[0].paras, ['早餐', '上学路', '学校走廊']);
  assert.equal(state.first, 'home_01');
  assert.equal(state.last, 'demo_end');
  const counts = await run("[...document.querySelectorAll('#list .paragraph .count-pill')].map(x=>x.textContent)");
  assert.deepEqual(counts, ['8', '28', '9']);
  await shot('13-重开工程');
  const reopenFile = path.join(RESULT, 'wanfeng-chapters-重开导出.html');
  saveQueue.push(reopenFile);
  await click('#export'); await sleep(2200);
  assert(fs.existsSync(reopenFile));
  assert.equal(errors.length, 0, errors.join(' | '));

  const crypto = require('node:crypto');
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const first = JSON.parse(fs.readFileSync(path.join(RESULT, '验收报告-v042.json'), 'utf8'));
  const comparison = {
    checkedAt: new Date().toISOString(),
    reopen: {
      nodes: state.nodes,
      chapters: state.chapters,
      characters: state.chars,
      firstNode: state.first,
      lastNode: state.last,
      paragraphCounts: counts
    },
    export: {
      first: first.export,
      afterReopen: { file: reopenFile, bytes: fs.statSync(reopenFile).size, sha256: sha(reopenFile) },
      identical: first.export && first.export.sha256 === sha(reopenFile)
    }
  };
  fs.writeFileSync(path.join(RESULT, '重开检查.json'), JSON.stringify(comparison, null, 2), 'utf8');
  console.log('  ok  新进程重开：45 句、3 个段落、2 个角色都在，段落计数一致');
  console.log('  ok  重开后再导出成功；两次导出一致：' + comparison.export.identical);
  console.log('\nCHAPTERS_REOPEN PASS');
}

if (process.env.PAPER_CHAPTERS_REOPEN === '1') {
  reopen().then(() => app.exit(0)).catch(err => { console.error('CHAPTERS REOPEN FAILED: ' + (err && err.stack)); app.exit(1); });
} else {
  main().then(() => app.exit(0)).catch(err => { console.error('CHAPTERS ACCEPTANCE FAILED: ' + (err && err.stack)); app.exit(1); });
}
