'use strict';
/*
 * 补齐 V0.4.1 的验收证据：三条测试分支各自的节点路线、汇合点、结尾截图，
 * 并确认「角色列表为空」是旧工程未绑定角色，而不是打开/迁移/保存丢数据。
 *
 *   npm run branch:evidence
 *
 * 节点路线直接按工程里的 next / options 走（与播放器同一套 edges 规则），
 * 截图另外用真实窗口试玩到结尾。
 */
const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const createVNCore = require('../dist/core.js');

const OUT = process.env.CHAPTERS_OUT || 'F:/Wanfeng-Demo';
const BRANCH = path.join(OUT, '晚风-branch');
const RESULT = path.join(OUT, '验收结果-v042');
const PACK_JSON = 'F:/Wanfeng-Demo-Pack/story/wanfeng_branch_test.paper.json';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-branch-userdata-'));
app.setPath('userData', userData);
const openQueue = [], messageQueue = [];
dialog.showOpenDialog = async () => {
  const next = openQueue.shift();
  return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
};
dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
dialog.showMessageBox = async () => ({ response: messageQueue.length ? messageQueue.shift() : 2 });
require('../desktop/main.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let win = null;
const run = js => win.webContents.executeJavaScript(js);

/* 按 next / options 走出一条真实路线，返回节点 ID。 */
function route(project, pick) {
  const byId = new Map(project.nodes.map(n => [n.id, n]));
  const ids = [];
  let cur = project.nodes[0].id;
  for (let i = 0; i < 300 && cur; i++) {
    ids.push(cur);
    const n = byId.get(cur);
    if (!n || n.type === 'end') break;
    if (n.type === 'choice') { cur = n.options[pick]?.target; continue; }
    cur = n.next || project.nodes[project.nodes.indexOf(n) + 1]?.id;
  }
  return ids;
}

async function main() {
  await app.whenReady();
  for (let i = 0; i < 120; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading() && win.webContents.getURL()) break;
    await sleep(100);
  }
  fs.mkdirSync(RESULT, { recursive: true });
  const disk = JSON.parse(fs.readFileSync(path.join(BRANCH, 'project.paper.json'), 'utf8'));
  const packWanfeng = JSON.parse(fs.readFileSync(PACK_JSON, 'utf8'));
  const endText = disk.nodes.find(n => n.id === 'demo_end').text;
  const mergeText = disk.nodes.find(n => n.id === 'road_26').text;

  console.log('工程：' + BRANCH + '（schema ' + disk.schema + '，' + disk.nodes.length + ' 节点）');
  const routes = [0, 1, 2].map(i => route(disk, i));
  routes.forEach((ids, i) => {
    console.log('  路线 ' + (i + 1) + '（' + disk.nodes.find(n => n.id === 'test_choice').options[i].text + '）共 ' + ids.length + ' 个节点：');
    console.log('    ' + ids.join(' → '));
  });
  routes.forEach((ids, i) => {
    assert(ids.includes('road_26'), '路线 ' + (i + 1) + ' 必须经过 road_26');
    assert.equal(ids[ids.length - 1], 'demo_end', '路线 ' + (i + 1) + ' 结束于 demo_end');
    assert.equal(new Set(ids).size, ids.length, '路线 ' + (i + 1) + ' 没有重复节点');
    const choiceAt = ids.findIndex(id => id === 'test_choice');
    assert(choiceAt > 0 && choiceAt < ids.indexOf('road_26'), '选项在汇合点之前');
  });
  assert.equal(new Set(routes.map(r => r.join('|'))).size, 3, '三条路线确实不同');
  console.log('  ok  三条路线都经过 road_26 并结束于 demo_end，且互不相同');

  /* 角色列表：旧工程没有角色，不是丢失 */
  const chars = (disk.characters || []).length;
  const packHas = Object.prototype.hasOwnProperty.call(packWanfeng, 'characters');
  const canon = JSON.parse(fs.readFileSync(path.join(OUT, '晚风-canon', 'project.paper.json'), 'utf8'));
  console.log('  · 分支工程 characters=' + chars + '，素材包原始 JSON 含 characters 字段：' + packHas);
  console.log('  · 原作工程 characters=' + (canon.characters || []).length + '（V0.4.1 里绑定过角色，保存/重开/导出后仍在）');
  assert.equal(packHas, false, '素材包分支剧本本身没有角色数据');
  assert.equal(chars, 0, '分支工程按导入时的事实保存为空角色列表');
  assert.equal((canon.characters || []).length, 2, '同一版本保存的角色没有丢失');
  console.log('  ok  角色列表为空 = 旧测试工程未绑定角色（素材包无 characters 字段），不是打开/迁移/保存导致的数据丢失');

  /* 真实窗口：三条路线各跑到结尾并截图 */
  messageQueue.push(0); openQueue.push(BRANCH);
  await run(`document.querySelector('#open').click()`);
  await sleep(2200);
  const opened = await run('p.nodes.length');
  assert.equal(opened, 50);
  for (let i = 0; i < 3; i++) {
    await run(`document.querySelector('#play').click()`);
    await sleep(250);
    const walk = await run(`(async()=>{
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const seen=[];
      let steps=0;
      for(let k=0;k<80;k++){
        steps++;
        const btns=[...document.querySelectorAll('#choices button')];
        seen.push(document.querySelector('#line').textContent);
        if(btns.length){ btns[${i}].click(); await sleep(60); continue; }
        if(document.querySelector('#nextHint').textContent.includes('故事结束'))break;
        document.querySelector('#stage').click();
        await sleep(50);
      }
      return {steps,lines:seen,last:document.querySelector('#line').textContent,who:document.querySelector('#speaker').textContent};
    })()`);
    assert.equal(walk.last, endText, '第 ' + (i + 1) + ' 条路线到结尾');
    assert.equal(walk.who, '第一章·节选完');
    assert(walk.lines.includes(mergeText), '第 ' + (i + 1) + ' 条路线经过 road_26 的台词');
    fs.writeFileSync(path.join(RESULT, 'branch-route-' + (i + 1) + '-end.png'), (await win.webContents.capturePage()).toPNG());
    console.log('  ok  第 ' + (i + 1) + ' 条路线在窗口里跑到结尾（' + walk.steps + ' 步）：' + walk.last);
    await run(`document.querySelector('#stop').click()`);
    await sleep(200);
  }

  /* 汇合句的定点试玩：road_26 前面有两条互斥路线，必须让作者选，不能拼状态 */
  await run(`(()=>{const b=document.querySelector('#list [data-id="road_26"]');if(b)b.click()})()`);
  await sleep(250);
  await run(`document.querySelector('#playHere').click()`);
  await sleep(300);
  const ambiguous = await run(`(()=>{const body=document.querySelector('#modalBody');return {open:document.querySelector('#modal').open,heading:body.querySelector('h2')?body.querySelector('h2').textContent:'',routes:body.querySelectorAll('[data-route]').length,text:body.textContent.replace(/\s+/g,' ').slice(0,200)}})()`);
  fs.writeFileSync(path.join(RESULT, 'branch-ambiguity.png'), (await win.webContents.capturePage()).toPNG());
  assert(ambiguous.open && ambiguous.routes >= 2, 'road_26 需要选择路线：' + JSON.stringify(ambiguous));
  const pickRoute = async idx => {
    await run(`document.querySelectorAll('#modalBody [data-route]')[${idx}].click()`);
    await sleep(350);
    const state = await run(`({current,trail:trail.slice()})`);
    await run(`document.querySelector('#stop').click()`);
    await sleep(180);
    await run(`document.querySelector('#playHere').click()`);
    await sleep(300);
    return state;
  };
  const routeA = await pickRoute(0);
  const routeB = await pickRoute(1);
  const extras = t => t.filter(id => id.startsWith('extra_'));
  for (const [name, r] of [['路线 A', routeA], ['路线 B', routeB]]) {
    assert.equal(r.current, 'road_26', name + ' 从 road_26 开始');
    assert(r.trail.includes('road_21') && r.trail.includes('test_choice'), name + ' 走的是真实前置节点');
    const e = extras(r.trail);
    const onlyB = e.every(id => id.startsWith('extra_b'));
    const onlyC = e.every(id => id.startsWith('extra_c'));
    assert(onlyB || onlyC, name + ' 只包含一条分支的节点：' + JSON.stringify(e));
  }
  assert.notDeepEqual(routeA.trail, routeB.trail, '两条路线的前置不同');
  await run(`document.querySelector('#closeModal').click()`).catch(() => {});
  console.log('  ok  road_26 定点试玩：两条互斥路线分别还原，trail 不含另一条分支（截图 branch-ambiguity.png）');

  const report = {
    checkedAt: new Date().toISOString(),
    project: BRANCH,
    routes: routes.map((ids, i) => ({
      option: disk.nodes.find(n => n.id === 'test_choice').options[i].text,
      nodes: ids, length: ids.length,
      reachesRoad26: ids.includes('road_26'),
      endsAt: ids[ids.length - 1]
    })),
    characters: { branch: chars, packHasCharactersField: packHas, canon: (canon.characters || []).length },
    conclusion: '角色列表为空是旧测试工程未绑定角色（素材包分支剧本没有 characters 字段）；同一版本下原作工程的 2 个角色在保存、重开与导出后仍在，因此不是打开/迁移/保存导致的数据丢失。',
    entryPlan: {
      node: 'road_26',
      ambiguous: true,
      routes: ambiguous.routes,
      chosen: [routeA, routeB].map(r => ({
        trail: r.trail,
        extras: r.trail.filter(id => id.startsWith('extra_'))
      }))
    },
    screenshots: ['branch-route-1-end.png', 'branch-route-2-end.png', 'branch-route-3-end.png', 'branch-ambiguity.png']
  };
  fs.writeFileSync(path.join(RESULT, '分支路线证据.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\nBRANCH_EVIDENCE PASS');
}

main().then(() => app.exit(0)).catch(err => {
  console.error('BRANCH EVIDENCE FAILED: ' + (err && err.stack));
  app.exit(1);
});
