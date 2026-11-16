'use strict';
/*
 * 《晚风经过二楼走廊》真实素材验收：
 * 用真实主进程（desktop/main.cjs）+ 真实窗口，通过「打开工程 → 旧 .paper.json」
 * 导入素材包里的两份剧本到仓库外的演示目录；在界面里建立林悠/林澈与表情、
 * 按 script_sources.json 绑定每句的角色与表情；检查 road_17 特写、走通原作线
 * 与三条测试分支；保存/移动/重开；导出离线 HTML 并用独立窗口播放验证。
 *
 * 原生对话框无法由脚本点击，因此用队列代答（与 desktop-project-smoke 相同），
 * 其余全部走生产代码路径。截图只证明渲染，不代表真人点击。
 *
 *   npm run demo:acceptance
 */
const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

const PACK = 'F:/Wanfeng-Demo-Pack';
const OUT = 'F:/Wanfeng-Demo';
const CANON_DIR = path.join(OUT, '晚风-canon');
const BRANCH_DIR = path.join(OUT, '晚风-branch');
const RESULT_DIR = path.join(OUT, '验收结果');
const MOVED_DIR = path.join(OUT, '晚风-canon-移动后');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-wanfeng-userdata-'));
app.setPath('userData', userData);

const openQueue = [];
const messageQueue = [];
const saveQueue = [];
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
const report = { startedAt: new Date().toISOString(), checks: [], unverified: [] };
function check(name, fn) { fn(); report.checks.push(name); console.log('  ok  ' + name); }
let win = null;
const run = js => win.webContents.executeJavaScript(js);
async function shot(name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(RESULT_DIR, name + '.png'), img.toPNG());
}
async function click(sel) { await run(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(45); }
async function setControl(sel, value, event = 'change') {
  await run(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('缺少控件 ${sel}');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));return e.value})()`);
  await sleep(45);
}
const sig = s => { let h = 0; for (let i = 0; i < s.length; i += 97) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
const SIG_IN_PAGE = 's=>{let h=0;for(let i=0;i<s.length;i+=97)h=(h*31+s.charCodeAt(i))|0;return h}';

const pack = {
  canon: JSON.parse(fs.readFileSync(path.join(PACK, 'story/wanfeng_canon.paper.json'), 'utf8')),
  branch: JSON.parse(fs.readFileSync(path.join(PACK, 'story/wanfeng_branch_test.paper.json'), 'utf8')),
  sources: JSON.parse(fs.readFileSync(path.join(PACK, 'story/script_sources.json'), 'utf8')),
  manifest: JSON.parse(fs.readFileSync(path.join(PACK, 'assets_manifest.json'), 'utf8'))
};
const assetFile = id => path.join(PACK, pack.manifest.assets.find(x => x.id === id).file);
/* 素材包用 asset id 描述表情，界面里用作者起的名字；验收脚本负责翻译。 */
const EXPR_NAME = { you_neutral: '自然', you_annoyed: '轻恼', che_neutral: '平静', che_smile: '微笑' };

async function waitForLoad() {
  for (let i = 0; i < 120; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading() && win.webContents.getURL()) return;
    await sleep(100);
  }
  throw new Error('桌面窗口没有加载完成');
}

async function importProject(jsonPath, dir, label) {
  messageQueue.push(1);                    // 打开哪一种 → 旧 .paper.json 文件
  openQueue.push(jsonPath);                // 旧工程文件
  openQueue.push(dir);                     // 导入到新目录
  await click('#open');
  await sleep(3000);
  assert(fs.existsSync(path.join(dir, 'project.paper.json')), label + '：导入后生成独立工程目录');
  const nodes = await run('document.querySelectorAll("#list .node").length');
  assert.equal(nodes, JSON.parse(fs.readFileSync(jsonPath, 'utf8')).nodes.length, label + '：节点全部导入');
  console.log('  ok  ' + label + ' 导入到 ' + dir + '（' + nodes + ' 节点）');
}

async function openDirectory(dir) {
  await click('#save'); await sleep(1200); // 先落盘，避免“未保存修改”对话框抢走队列
  messageQueue.push(0);                    // 打开哪一种 → 工程目录
  openQueue.push(dir);
  await click('#open');
  await sleep(2500);
}

async function createCharacter(name, color, expressions) {
  await click('#addChar');
  await setControl('#charName', name, 'input');
  await setControl('#charColorText', color, 'change');
  for (const e of expressions) {
    openQueue.push(assetFile(e.asset));
    await click('#addExpr');
    await sleep(900);
  }
  for (let i = 0; i < expressions.length; i++) {
    await run(`document.querySelectorAll('#exprList [data-rename-expr]')[${i}].click()`);
    await sleep(150);
    await setControl('#exprNewName', expressions[i].name, 'input');
    await click('#confirmExprName');
    await sleep(200);
  }
  await run(`document.querySelectorAll('#exprList [data-def]')[0].click()`);
  await sleep(150);
}

async function castIds() {
  const opts = await run(`[...document.querySelectorAll('#speakerChar option')].map(o=>({v:o.value,t:o.textContent}))`);
  return new Map(opts.filter(o => o.v).map(o => [o.t, o.v]));
}
async function exprIds(charId) {
  await run(`(()=>{const b=[...document.querySelectorAll('#castList [data-char]')].find(x=>x.dataset.char===${JSON.stringify(charId)});if(b)b.click();return !!b})()`);
  await sleep(150);
  const opts = await run(`[...document.querySelectorAll('#charDefault option')].map(o=>({v:o.value,t:o.textContent}))`);
  return new Map(opts.filter(o => o.v).map(o => [o.t, o.v]));
}

async function selectNode(id) {
  await run(`(()=>{const b=document.querySelector('#list [data-id=${JSON.stringify(id)}]');if(b)b.click()})()`);
  await sleep(160);
}
async function bindLayer(layerId, charId) {
  await run(`(()=>{const b=document.querySelector('#layerList [data-layer=${JSON.stringify(layerId)}]');if(b)b.click()})()`);
  await sleep(150);
  await setControl('#layerChar', charId);
}
async function setCastRow(charId, exprId) {
  await run(`(()=>{const s=document.querySelector('#castRows [data-cast=${JSON.stringify(charId)}]');if(!s)return false;s.value=${JSON.stringify(exprId)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await sleep(45);
}

async function bindLine(nodeId, speaker, youExpr, cheExpr, chars, exprs) {
  await selectNode(nodeId);
  const isYou = speaker === '林悠';
  const isChe = speaker === '林澈';
  if (isYou || isChe) {
    const mine = EXPR_NAME[isYou ? youExpr : cheExpr];
    await setControl('#speakerChar', isYou ? chars.get('林悠') : chars.get('林澈'));
    const exId = (isYou ? exprs.you : exprs.che).get(mine);
    if (exId) await setControl('#speakerExpr', exId);
  }
  const otherName = isYou ? '林澈' : '林悠';
  const otherExpr = EXPR_NAME[isYou ? cheExpr : youExpr];
  if (otherExpr && chars.get(otherName)) await setCastRow(chars.get(otherName), (otherName === '林悠' ? exprs.you : exprs.che).get(otherExpr));
  if (!isYou && !isChe) {
    await setCastRow(chars.get('林悠'), exprs.you.get(EXPR_NAME[youExpr]));
    await setCastRow(chars.get('林澈'), exprs.che.get(EXPR_NAME[cheExpr]));
  }
}

async function walk(limit, choiceIndex) {
  return run(`(async()=>{
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const sig=${SIG_IN_PAGE};
    const log=[];
    for(let i=0;i<${limit};i++){
      const btns=[...document.querySelectorAll('#choices button')];
      log.push({who:document.querySelector('#speaker').textContent,text:document.querySelector('#line').textContent,
        choices:btns.map(b=>b.textContent),
        layers:[...document.querySelectorAll('#layersCanvas [data-layer]')].map(w=>({id:w.dataset.layer,sig:sig(w.querySelector('img').src),transform:w.style.transform,filter:w.style.filter,left:w.style.left,top:w.style.top,width:w.style.width,height:w.style.height}))});
      if(btns.length){ ${choiceIndex == null ? 'break;' : `btns[${choiceIndex}].click(); await sleep(45); continue;`} }
      if(document.querySelector('#nextHint').textContent.includes('故事结束'))break;
      document.querySelector('#stage').click();
      await sleep(45);
    }
    return log;
  })()`);
}

async function stageState() {
  return run(`(()=>{const sig=${SIG_IN_PAGE};const out={};for(const w of document.querySelectorAll('#layersCanvas [data-layer]'))out[w.dataset.layer]={sig:sig(w.querySelector('img').src),transform:w.style.transform,filter:w.style.filter,left:w.style.left,top:w.style.top,width:w.style.width,height:w.style.height};return out})()`);
}

async function main() {
  await app.whenReady();
  await waitForLoad();
  fs.mkdirSync(RESULT_DIR, { recursive: true });
  fs.rmSync(CANON_DIR, { recursive: true, force: true });
  fs.rmSync(BRANCH_DIR, { recursive: true, force: true });
  fs.rmSync(MOVED_DIR, { recursive: true, force: true });
  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const d = args[0];
    const level = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
    const message = d && typeof d === 'object' && 'message' in d ? d.message : args[2];
    if (level >= 2) errors.push(String(message));
  });
  await sleep(500);

  /* ---------- A2：导入原作线与测试分支线 ---------- */
  await importProject(path.join(PACK, 'story/wanfeng_canon.paper.json'), CANON_DIR, '原作线');
  const canonDisk = JSON.parse(fs.readFileSync(path.join(CANON_DIR, 'project.paper.json'), 'utf8'));
  check('素材只导入 manifest 的 7 张图（3 背景 + 4 立绘），references/ 没有被当成立绘', () => {
    assert.equal(canonDisk.assets.length, 7);
    assert.equal(canonDisk.assets.filter(a => a.kind === 'bg').length, 3);
    assert.equal(canonDisk.assets.filter(a => a.kind === 'char').length, 4);
    assert(!canonDisk.assets.some(a => /reference/i.test(a.name) || /reference/i.test(a.file)));
  });
  check('背景近 16:9 用 cover；角色按原图比例摆放，没有压扁或拉长', () => {
    const node = canonDisk.nodes[0];
    const bg = node.layers.find(l => l.kind === 'bg');
    assert.equal(bg.w, 100); assert.equal(bg.h, 100); assert.equal(bg.fit, 'cover');
    for (const c of node.layers.filter(l => l.kind === 'char')) {
      const a = canonDisk.assets.find(x => x.id === c.asset);
      const shown = (c.w / c.h) * (16 / 9);
      assert(Math.abs(shown - a.width / a.height) < 0.02, c.name + ' 显示比例与原图一致');
    }
  });

  /* ---------- B/A4：界面里建角色与表情 ---------- */
  await createCharacter('林悠', '#3f6753', [
    { asset: 'you_neutral', name: '自然' },
    { asset: 'you_annoyed', name: '轻恼' }
  ]);
  await createCharacter('林澈', '#7a5b3f', [
    { asset: 'che_neutral', name: '平静' },
    { asset: 'che_smile', name: '微笑' }
  ]);
  const chars = await castIds();
  assert(chars.get('林悠') && chars.get('林澈'), '两个角色建立成功');
  const exprs = { you: await exprIds(chars.get('林悠')), che: await exprIds(chars.get('林澈')) };
  check('角色管理：林悠（自然/轻恼）、林澈（平静/微笑），默认表情已设置', () => {
    assert.deepEqual([...exprs.you.keys()].sort(), ['轻恼', '自然'].sort());
    assert.deepEqual([...exprs.che.keys()].sort(), ['平静', '微笑'].sort());
  });
  await run("document.querySelector('.tabs [data-tab=\"cast\"]').click()");
  await sleep(150);
  await run(`(()=>{const b=[...document.querySelectorAll('#castList [data-char]')].find(x=>x.dataset.char===${JSON.stringify(chars.get('林悠'))});if(b)b.click()})()`);
  await sleep(250);
  await shot('00-角色管理');

  // 每个独立画面的角色图层认领给角色身份（含 school_02/03/06 只有林悠的画面）
  const ownNodes = canonDisk.nodes.filter(n => n.sceneMode === 'own');
  for (const node of ownNodes) {
    await selectNode(node.id);
    for (const l of node.layers) {
      if (l.kind !== 'char') continue;
      const cid = l.id === 'linyou' ? chars.get('林悠') : l.id === 'linche' ? chars.get('林澈') : null;
      if (cid) await bindLayer(l.id, cid);
    }
  }
  const layerCount = await run('document.querySelectorAll("#list .node").length');
  check('把现有角色图层认领给角色身份：图层数量不变，没有复制新图层', () => {
    assert.equal(layerCount, 45);
  });

  // 按剧本映射逐句绑定（只绑定作者指定的句子，不按名字批量替换）
  let boundLines = 0;
  for (const entry of pack.sources.nodes) {
    if (!canonDisk.nodes.some(n => n.id === entry.node)) continue;
    const speaker = entry.speaker === '林悠' || entry.speaker === '林澈' ? entry.speaker : '';
    await bindLine(entry.node, speaker, entry.linyou, entry.linche, chars, exprs);
    boundLines++;
  }
  check('按 script_sources 逐句绑定 ' + boundLines + ' 句的角色与表情', () => assert(boundLines >= 40));

  await click('#check');
  await sleep(400);
  const checkTitle = await run("document.querySelector('#modalBody h2').textContent");
  await click('#closeModal');
  check('剧情检查没有阻塞错误（角色/表情引用都能解析）', () => assert(/通过|没有阻塞错误/.test(checkTitle), '检查结果：' + checkTitle));

  /* ---------- A4/A6：表情切换与 road_17 ---------- */
  const base64Of = id => 'data:image/png;base64,' + fs.readFileSync(path.join(CANON_DIR, canonDisk.assets.find(a => a.id === id).file)).toString('base64');
  const expect = Object.fromEntries(['you_neutral', 'you_annoyed', 'che_neutral', 'che_smile']
    .map(id => [id, sig(base64Of(id))]));

  await selectNode('home_01'); const s1 = await stageState();
  await selectNode('road_09'); const s2 = await stageState(); await shot('01-road_09-林悠轻恼');
  await selectNode('road_18'); const s3 = await stageState(); await shot('02-road_18-林澈微笑');
  await selectNode('school_06'); const s4 = await stageState(); await shot('03-school_06-林悠恢复自然');

  check('林悠：自然 → 轻恼 → 自然，只换素材，位置大小不变，没有累计缩放', () => {
    assert.equal(s1.linyou.sig, expect.you_neutral);
    assert.equal(s2.linyou.sig, expect.you_annoyed);
    assert.equal(s4.linyou.sig, expect.you_neutral);
    for (const s of [s1, s2, s4]) {
      assert.deepEqual([s.linyou.left, s.linyou.top, s.linyou.width, s.linyou.height],
        [s1.linyou.left, s1.linyou.top, s1.linyou.width, s1.linyou.height]);
    }
    assert(/scale\(1\)/.test(s2.linyou.transform), '切表情不叠加缩放：' + s2.linyou.transform);
    assert.equal(s2.linyou.transform, s1.linyou.transform, '变换与上一句完全一致');
  });
  check('林澈：平静 → 微笑；另一人的图层不被牵连', () => {
    assert.equal(s1.linche.sig, expect.che_neutral);
    assert.equal(s3.linche.sig, expect.che_smile);
    assert.equal(s3.linyou.sig, expect.you_annoyed, '林澈微笑时林悠保持本句表情');
    assert.equal(s2.linche.sig, expect.che_neutral, '林悠轻恼时林澈保持平静');
  });

  /* 手动切换证明：图层自带的是轻恼，选择「自然」会真的换回自然素材，几何不动 */
  await selectNode('road_17');
  await setControl('#speakerExpr', exprs.you.get('自然'));
  const forcedNeutral = await stageState();
  await shot('06-road_17-手动切回自然');
  await setControl('#speakerExpr', exprs.you.get('轻恼'));
  const forcedAnnoyed = await stageState();
  check('在真实素材上手动切表情：轻恼 → 自然 → 轻恼，只换素材不动布局', () => {
    assert.equal(forcedNeutral.linyou.sig, expect.you_neutral, '选择「自然」后显示自然素材（覆盖图层原有素材）');
    assert.equal(forcedAnnoyed.linyou.sig, expect.you_annoyed);
    assert.equal(forcedNeutral.linche.sig, expect.che_neutral, '另一个角色不受影响');
    assert.deepEqual([forcedNeutral.linyou.left, forcedNeutral.linyou.top, forcedNeutral.linyou.width, forcedNeutral.linyou.height],
      [forcedAnnoyed.linyou.left, forcedAnnoyed.linyou.top, forcedAnnoyed.linyou.width, forcedAnnoyed.linyou.height]);
    assert.equal(forcedNeutral.linyou.transform, forcedAnnoyed.linyou.transform);
  });

  await click('#effectEnd');
  await sleep(300);
  const cue = await stageState();
  const stageWidth = await run("document.querySelector('#stage').getBoundingClientRect().width");
  await shot('04-road_17-角色特写与背景虚化');
  await selectNode('road_16');
  const restored = await stageState();
  check('road_17：角色 120% 特写 + 背景 8px 模糊，离开本句后恢复、原始布局不变', () => {
    assert(/scale\(1\.2\)/.test(cue.linyou.transform), '角色 120%：' + cue.linyou.transform);
    const m = /blur\(([\d.]+)px\)/.exec(cue.background.filter);
    assert(m, '背景有模糊：' + cue.background.filter);
    // 效果按 1280 画布换算，实际 CSS 像素随舞台宽度等比缩放；折算回 1280 应为 8px
    const perCanvas = Number(m[1]) * 1280 / stageWidth;
    assert(Math.abs(perCanvas - 8) < 0.3, '背景模糊折算 8px/1280：' + perCanvas.toFixed(2) + '（CSS ' + m[1] + 'px @' + Math.round(stageWidth) + 'px 舞台）');
    assert(!/scale\(1\.2\)/.test(restored.linyou.transform), '离开后缩放恢复：' + restored.linyou.transform);
    assert(/blur\(0px\)/.test(restored.background.filter), '离开后模糊恢复：' + restored.background.filter);
    assert.equal(cue.linyou.left, s1.linyou.left);
    assert.equal(cue.linyou.width, s1.linyou.width);
  });

  /* ---------- A5：原作一条路径 ---------- */
  await click('#play'); await sleep(250);
  const canonLog = await walk(80, null);
  await click('#stop');
  check('原作一条路径：' + canonLog.length + ' 句走到唯一结尾', () => {
    const last = pack.canon.nodes[pack.canon.nodes.length - 1];
    assert.equal(canonLog[canonLog.length - 1].text, last.text);
    assert.equal(canonLog[canonLog.length - 1].who, '第一章·节选完');
    assert(canonLog.every(x => !x.choices.length), '原作线没有分支');
    assert.equal(canonLog.length, pack.canon.nodes.length, '每一句都走过');
  });

  /* ---------- A7：保存后演出没有改动原始布局 ---------- */
  await click('#save'); await sleep(1800);
  const saveState = await run('({saved:document.querySelector("#saved").textContent,toast:document.querySelector("#toast").textContent})');
  if (/失败/.test(saveState.saved)) throw new Error('界面保存失败：' + saveState.saved + ' / ' + saveState.toast);
  const savedDisk = JSON.parse(fs.readFileSync(path.join(CANON_DIR, 'project.paper.json'), 'utf8'));
  check('保存：角色与绑定写入工程文件；所有图层几何与演出参数与原始 JSON 一致', () => {
    assert.equal(savedDisk.schema, 4);
    assert.equal(savedDisk.characters.length, 2);
    assert.equal(savedDisk.characters[0].expressions.length, 2);
    for (const orig of pack.canon.nodes) {
      const now = savedDisk.nodes.find(n => n.id === orig.id);
      assert(now, '节点仍在：' + orig.id);
      assert.equal(now.layers.length, orig.layers.length, '图层数量不变：' + orig.id);
      for (const l of orig.layers) {
        const after = now.layers.find(x => x.id === l.id);
        assert(after, '图层仍在：' + orig.id + '/' + l.id);
        for (const key of ['asset', 'x', 'y', 'w', 'h', 'fit', 'opacity', 'motion']) {
          assert.equal(after[key], l[key], orig.id + '/' + l.id + '.' + key + ' 未被改动');
        }
      }
      assert.deepEqual(now.effects.map(e => [e.layer, e.type, e.to, e.duration]),
        (orig.effects || []).map(e => [e.layer, e.type, e.to, e.duration]), '演出参数未变：' + orig.id);
    }
  });

  /* ---------- A5：测试版三条分支 ---------- */
  await importProject(path.join(PACK, 'story/wanfeng_branch_test.paper.json'), BRANCH_DIR, '测试分支线');
  const mergeText = pack.branch.nodes.find(n => n.id === 'road_26').text;
  const endText = pack.branch.nodes.find(n => n.id === 'demo_end').text;
  const results = [];
  for (const idx of [0, 1, 2]) {
    await click('#play'); await sleep(250);
    const log = await walk(60, idx);
    await click('#stop');
    results.push(log);
  }
  const optionTexts = await run(`(()=>{const b=[...document.querySelectorAll('#list .node')];return b.length})()`);
  assert.equal(optionTexts, 50);
  check('三条测试分支都汇回 road_26，并共同进入 demo_end', () => {
    assert.equal(pack.branch.nodes.filter(n => n.type === 'end').length, 1, '只有一个结局节点');
    for (const log of results) {
      assert(log.some(x => x.text === mergeText), '经过 road_26（' + mergeText + '）');
      assert.equal(log[log.length - 1].text, endText);
      assert.equal(log[log.length - 1].who, '第一章·节选完');
      const choice = log.find(x => x.choices.length);
      assert(choice && choice.choices.length === 3, '遇到三选项');
    }
    const paths = results.map(r => r.map(x => x.text).join('|'));
    assert.equal(new Set(paths).size, 3, '三条路径确实不同');
  });
  await shot('05-测试分支-汇合后结尾');

  /* ---------- A7：移动到新目录后重开 ---------- */
  fs.cpSync(CANON_DIR, MOVED_DIR, { recursive: true });
  await openDirectory(MOVED_DIR);
  const moved = await run('({nodes:document.querySelectorAll("#list .node").length,title:document.querySelector("#title").value,path:document.querySelector("#projectPath").textContent})');
  check('工程移动到新目录后仍能打开，素材按内容寻址共用', () => {
    assert.equal(moved.nodes, 45);
    assert.equal(moved.title, '晚风经过二楼走廊｜第一章节选·原作线');
    assert(moved.path.includes(path.basename(MOVED_DIR)));
    assert.equal(fs.readdirSync(path.join(MOVED_DIR, 'assets/images')).length, 7, '移动后仍是 7 张图片');
  });

  /* ---------- A7：导出离线 HTML ---------- */
  const exportPath = path.join(RESULT_DIR, 'wanfeng-canon.html');
  saveQueue.push(exportPath);
  await click('#export');
  await sleep(2500);
  const html = fs.readFileSync(exportPath, 'utf8');
  check('导出的 HTML 自包含：不引用素材包、本机绝对路径或开发服务器', () => {
    for (const bad of ['file:///', '127.0.0.1', 'localhost', 'F:/Wanfeng', 'C:\\', 'Wanfeng-Demo-Pack', 'assets/images']) {
      assert(!html.includes(bad), '导出内容不应包含 ' + bad);
    }
    assert(!/<script[^>]+src=/i.test(html));
    assert(!/<link[^>]+href=/i.test(html));
    assert(!/<img[^>]+src="(?!data:)/i.test(html));
    assert(html.includes('"characters"') && html.includes('"speakerId"'), '携带角色与表情数据');
    assert(html.length > 5 * 1024 * 1024, '图片内嵌，体积 ' + Math.round(html.length / 1024 / 1024) + 'MB');
  });

  const game = new BrowserWindow({
    width: 1200, height: 820, show: true, title: '离线播放验证',
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
  });
  await game.loadFile(exportPath);
  await sleep(900);
  const gameState = await game.webContents.executeJavaScript(`(async()=>{
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const sig=${SIG_IN_PAGE};
    const seen=[];
    for(let i=0;i<80;i++){
      const text=document.querySelector('#text').textContent;
      if(text==='林澈！')await sleep(800);
      const btns=[...document.querySelectorAll('#choices button')];
      seen.push({who:document.querySelector('#who').textContent,text,color:document.querySelector('#who').style.color,
        layers:[...document.querySelectorAll('#layers .visual-layer')].map(w=>({id:w.dataset.layer,sig:sig(w.querySelector('img').src),transform:w.style.transform,filter:w.style.filter}))});
      if(btns.length)break;
      if(document.querySelector('#hint').textContent.includes('故事结束'))break;
      document.querySelector('#scene').click();
      await sleep(30);
    }
    return {seen,title:document.querySelector('#title').textContent};
  })()`);
  check('离线 HTML 在独立窗口播放：角色名/颜色、表情切换、特写与虚化都正确', () => {
    assert.equal(gameState.title, '晚风经过二楼走廊｜第一章节选·原作线');
    assert(gameState.seen.length >= 44, '走完全程：' + gameState.seen.length + ' 句');
    const road17 = gameState.seen.find(x => x.text === '林澈！');
    assert(road17, '播放到 road_17');
    assert.equal(road17.who, '林悠');
    assert.equal(road17.color, 'rgb(63, 103, 83)', '姓名颜色随角色导出：' + road17.color);
    const you = road17.layers.find(l => l.id === 'linyou');
    assert.equal(you.sig, expect.you_annoyed, '离线播放器用的是轻恼素材');
    assert(/scale\(1\.2\)/.test(you.transform), '离线播放器播放 120% 特写：' + you.transform);
    const bg = road17.layers.find(l => l.id === 'background');
    assert(/blur\(/.test(bg.filter) && !/blur\(0px\)/.test(bg.filter), '离线播放器播放背景虚化：' + bg.filter);
    const school = gameState.seen[gameState.seen.length - 1];
    assert.equal(school.text, endText);
  });
  // 离线包再走一遍到 road_17，留一张导出成品的截图
  await game.loadFile(exportPath);
  await sleep(700);
  await game.webContents.executeJavaScript(`(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<30;i++){if(document.querySelector('#text').textContent==='林澈！')break;document.querySelector('#scene').click();await sleep(40)}await sleep(900);return true})()`);
  fs.writeFileSync(path.join(RESULT_DIR, '07-离线HTML-road_17.png'), (await game.webContents.capturePage()).toPNG());
  game.destroy();

  check('整个流程没有渲染进程报错', () => assert.equal(errors.length, 0, errors.join(' | ')));

  report.finishedAt = new Date().toISOString();
  report.demoDirs = { canon: CANON_DIR, branch: BRANCH_DIR, moved: MOVED_DIR };
  report.exported = exportPath;
  report.screenshots = fs.readdirSync(RESULT_DIR).filter(f => f.endsWith('.png')).sort();
  report.unverified = ['真人鼠标/键盘操作（脚本用队列代答原生对话框，其余为真实窗口事件流）', '第二台电脑与安装包（EXE）验收'];
  fs.writeFileSync(path.join(RESULT_DIR, '验收报告.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\nDEMO_ACCEPTANCE PASS');
  console.log('DEMO_DIRS=' + [CANON_DIR, BRANCH_DIR, MOVED_DIR].join(','));
  console.log('EXPORTED=' + exportPath);
}

main().then(() => app.exit(0)).catch(err => {
  console.error('DEMO ACCEPTANCE FAILED: ' + (err && err.stack));
  app.exit(1);
});
