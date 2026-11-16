'use strict';
/* V0.4.2 章节与段落：
 * 1) schema 4 → 5 迁移只加分组，不动节点顺序、台词、图层与演出；
 * 2) 树由 p.nodes 的播放顺序派生，不维护第二份顺序；
 * 3) 移动节点/段落/章节时显式跳转不受影响，顺序变化先算出来给界面提示；
 * 4) 删除分组默认保留剧情（变成未分组），不删节点、不改播放顺序；
 * 5) 从指定位置试玩用现有 scene/cast/effects 解析，前置状态不串场景；
 * 6) TXT 解析与导入预览是纯计划，确认前不碰工程；
 * 7) 落盘、回读与导出都带章节数据。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const createVNCore = require('../dist/core.js');
const createPaperEffects = require('../dist/effects.js');
const createProjectStore = require('../desktop/project-store.cjs');
const { buildGameHTML } = require('../dist/export.js');
const { paperPlayer, paperPlayerCSS } = require('../dist/player.js');
const C = createVNCore();
const F = createPaperEffects();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const img = (id, kind = 'bg') => ({ id, name: id, kind, width: 1600, height: 900, data: 'data:image/png;base64,' + PNG });
const layer = (id, asset, kind) => ({ id, asset, name: id, kind, x: 0, y: 0, w: 100, h: 100, fit: 'cover', opacity: 100, hidden: false, locked: false, motion: 'none', characterId: '', expressionId: '' });

/* 一份 V0.4.1（schema 4）工程：两处场景切换，用来验证从中间试玩不串场景。 */
function v4() {
  const mk = (id, text, name, next) => ({ id, type: 'say', name, text, next: next || '', sceneMode: 'inherit', layers: [], effects: [], speakerId: '', expressionId: '', cast: [] });
  const p = {
    schema: 4, id: 'proj', title: '章节测试', presets: [],
    assets: [img('bg_home'), img('bg_road'), img('bg_school'), img('you_n', 'char'), img('you_a', 'char')],
    characters: [
      { id: 'ch_you', name: '林悠', color: '#3f6753', defaultExpressionId: 'ex_n', expressions: [
        { id: 'ex_n', name: '自然', assetId: 'you_n' },
        { id: 'ex_a', name: '轻恼', assetId: 'you_a' }] }
    ],
    nodes: []
  };
  const n1 = mk('n1', '早餐。', '旁白', 'n2');
  n1.sceneMode = 'own';
  n1.layers = [{ ...layer('bg', 'bg_home', 'bg') }, { ...layer('you', 'you_n', 'char'), characterId: 'ch_you', expressionId: 'ex_n', x: 10, y: 12, w: 33, h: 88, fit: 'contain' }];
  const n2 = mk('n2', '豆浆快凉了。', '林澈', 'n3');
  n2.effects = [Object.assign(F.make('e1', 'you', 'scale'), { to: 120 })];
  const n3 = mk('n3', '两人出门。', '旁白', 'n4');
  n3.sceneMode = 'own';
  n3.layers = [{ ...layer('bg', 'bg_road', 'bg') }, { ...layer('you', 'you_a', 'char'), characterId: 'ch_you', expressionId: 'ex_a' }];
  const n4 = mk('n4', '走廊尽头。', '旁白', 'n5');
  n4.sceneMode = 'own';
  n4.layers = [{ ...layer('bg', 'bg_school', 'bg') }, { ...layer('you', 'you_n', 'char'), characterId: 'ch_you', expressionId: 'ex_n' }];
  const n5 = mk('n5', '林澈！', '林悠', 'end');
  n5.speakerId = 'ch_you'; n5.expressionId = 'ex_a';
  const end = { id: 'end', type: 'end', name: '完', text: '结束。', next: '', sceneMode: 'inherit', layers: [], effects: [], speakerId: '', expressionId: '', cast: [] };
  p.nodes = [n1, n2, n3, n4, n5, end];
  return p;
}

/* ---------- 1. 迁移 ---------- */
const raw = v4();
const p = C.migrate(raw);
assert.equal(p.schema, 5);
assert.equal(p.chapters.length, 1, '旧工程得到一个默认章节');
assert.equal(p.chapters[0].paragraphs.length, 1, '旧工程得到一个默认段落');
assert.equal(p.chapters[0].title, '第一章');
const defaultPg = p.chapters[0].paragraphs[0].id;
assert(p.nodes.every(n => n.paragraphId === defaultPg), '所有节点进入默认段落');
assert.deepEqual(p.nodes.map(n => n.id), raw.nodes.map(n => n.id), '节点顺序没有被迁移改变');
assert.deepEqual(p.nodes.map(n => n.text), raw.nodes.map(n => n.text), '台词不变');
assert.deepEqual(p.nodes.map(n => n.effects), raw.nodes.map(n => n.effects), '演出不变');
assert.deepEqual(p.characters, raw.characters, '角色不变');
assert.equal(raw.schema, 4, '迁移不修改入参');
assert(C.validate(p));
assert.deepEqual(C.analyze(p).errors, []);
console.log('  ok  schema 4 → 5：默认章节/段落，节点顺序、台词、演出、角色都不变');

/* ---------- 2. 树由播放顺序派生 ---------- */
const q = C.clone(p);
const ch1 = q.chapters[0];
const pgBreak = { id: 'pg_break', title: '早餐', collapsed: false };
const pgRoad = { id: 'pg_road', title: '上学路', collapsed: false };
ch1.paragraphs = [pgBreak, pgRoad];
const ch2 = { id: 'ch_2', title: '第二章', collapsed: false, paragraphs: [{ id: 'pg_school', title: '学校走廊', collapsed: false }] };
q.chapters.push(ch2);
q.nodes[0].paragraphId = pgBreak.id; q.nodes[1].paragraphId = pgBreak.id;
q.nodes[2].paragraphId = pgRoad.id;
q.nodes[3].paragraphId = 'pg_school'; q.nodes[4].paragraphId = 'pg_school'; q.nodes[5].paragraphId = 'pg_school';
const tree = C.tree(q);
assert.deepEqual(tree.chapters.map(c => c.title), ['第一章', '第二章']);
assert.deepEqual(tree.chapters[0].paragraphs.map(g => g.nodes.length), [2, 1], '段落计数来自播放顺序');
assert.deepEqual(tree.chapters[1].paragraphs[0].nodes, ['n4', 'n5', 'end']);
assert.equal(tree.ungrouped.length, 0);
assert(C.validate(q));
console.log('  ok  树按 p.nodes 派生：章节/段落计数正确，没有第二份节点顺序');

/* ---------- 3. 移动：显式跳转不变、顺序影响可预判 ---------- */
/* n2 不写 next，靠「按顺序继续」：把它移走就会改变去向，界面必须先算出来 */
const moved = C.clone(q);
moved.nodes[1].next = '';
const impact = C.moveImpact(moved, 'n2', pgRoad.id, null);
assert(impact.diffs.length > 0, '依赖顺序的句子移动后，后继变化要被算出来');
assert(impact.diffs.some(d => d.nodeId === 'n2' && d.before === 'n3' && d.after === 'n4'), '原来到 n3，移动后改到 n4：' + JSON.stringify(impact.diffs));
C.moveNodeToParagraph(moved, 'n2', pgRoad.id, null);
assert(C.validate(moved));
assert.equal(moved.nodes.find(n => n.id === 'n2').paragraphId, pgRoad.id);
assert.deepEqual(C.tree(moved).chapters[0].paragraphs[1].nodes, ['n3', 'n2'], '落到目标段落最后一句之后');
assert.equal(C.analyze(moved).errors.length, 0, '显式跳转仍然有效');
/* 插到指定句子之前 */
const inserted = C.clone(q);
C.moveNodeToParagraph(inserted, 'n4', pgBreak.id, 'n1');
assert.deepEqual(C.tree(inserted).chapters[0].paragraphs[0].nodes, ['n4', 'n1', 'n2']);
assert.equal(C.analyze(inserted).errors.length, 0);
/* 显式 next 不因移动而改写 */
const explicit = C.clone(q);
explicit.nodes[0].next = 'n3';
const beforeNext = explicit.nodes[0].next;
C.moveNodeToParagraph(explicit, 'n3', pgBreak.id, 'n1');
assert.equal(explicit.nodes.find(n => n.id === 'n1').next, beforeNext, '显式 next 不被静默重写');
assert.equal(C.orderSuccessor(explicit, explicit.nodes.find(n => n.id === 'n1')), 'n3');
console.log('  ok  移动节点：归属与位置更新，显式跳转不改写，顺序影响先算后提示');

/* ---------- 4. 段落 / 章节移动与删除 ---------- */
const pmoved = C.clone(q);
const pres = C.moveParagraph(pmoved, 'pg_school', pmoved.chapters[0].id, null);
assert(pres, '段落可以移动到另一个章节');
assert.equal(C.paragraphMap(pmoved).get('pg_school').chapter.id, pmoved.chapters[0].id);
assert(C.validate(pmoved));
/* 段落整体移动后，段内相对顺序不变，节点没有丢 */
const schoolIds = C.tree(pmoved).chapters[0].paragraphs.find(g => g.id === 'pg_school').nodes;
assert.deepEqual(schoolIds, ['n4', 'n5', 'end']);
const removed = C.clone(q);
const delRes = C.removeParagraph(removed, 'pg_break');
assert.deepEqual(delRes.keptNodeIds, ['n1', 'n2'], '删除段落保留剧情');
assert(C.validate(removed));
assert.equal(removed.nodes.length, q.nodes.length, '没有删除任何剧情节点');
assert.deepEqual(C.tree(removed).ungrouped, ['n1', 'n2'], '被删段落的句子进入未分组');
assert.deepEqual(removed.nodes.map(n => n.id), q.nodes.map(n => n.id), '播放顺序不变');
const removedCh = C.clone(q);
const delCh = C.removeChapter(removedCh, 'ch_2');
assert.deepEqual(delCh.keptNodeIds, ['n4', 'n5', 'end']);
assert(C.validate(removedCh));
assert.equal(removedCh.nodes.length, q.nodes.length);
console.log('  ok  段落/章节移动与删除：段内顺序保持，删除默认保留剧情并进入未分组');

/* ---------- 5. 从指定位置试玩 ---------- */
const own = C.entryPath(q, 'n5');
assert.equal(own.anchorId, 'n4', '入口取最近的独立场景');
assert.deepEqual(own.trail, ['n4'], '进入点是最近的独立场景，之前的句子不再参与还原');
assert.equal(own.uncertain, false, '线性前置没有分支时是确定的');
const school = C.stage(q, 'n5', own.trail);
assert.equal(school.find(l => l.id === 'bg').asset, 'bg_school', '从学校段试玩不会沿用上学路的背景');
assert.equal(school.find(l => l.id === 'you').asset, 'you_a', '表情按本句与路径结算');
/* 前置有分支时明确标记不确定 */
const branched = C.clone(q);
branched.nodes[1].type = 'choice';
branched.nodes[1].options = [{ text: 'A', target: 'n3' }, { text: 'B', target: 'n4' }];
branched.nodes[1].next = '';
const bpath = C.entryPath(branched, 'n5');
/* n4 是独立场景且就在本句前一句：它会重置图层、表情与持续效果，
   所以前面出现过选项也不影响这一句的状态，仍算确定。 */
assert.equal(bpath.uncertain, false, '有独立场景兜底时不算不确定');
assert.deepEqual(bpath.trail, ['n4']);
const near = C.entryPlan(branched, 'n2');
assert.equal(near.ambiguous, false, '紧跟在独立场景后面的句子只有一条入口');
assert.deepEqual(near.trail, ['n1']);
/* 持续效果按路径还原：n2 之后进入 n3 的独立场景会重置 */
const beforeN3 = F.before(branched, C, 'n3', C.entryPath(branched, 'n3').trail);
assert.equal(Object.keys(beforeN3).length, 0, '独立场景重置此前的持续效果');
console.log('  ok  从本句试玩：最近独立场景为入口，背景/表情正确');

/* ---------- 6. 排序一致性：删除分组与跨段移动 ---------- */
const orderBefore = q.nodes.map(n => n.id);
const delOne = C.clone(q);
C.removeParagraph(delOne, 'pg_break');
assert.deepEqual(delOne.nodes.map(n => n.id), orderBefore, '删除段落不改播放顺序');
assert.deepEqual(C.tree(delOne).ungrouped.sort(), ['n1', 'n2'], '被删段落的句子进入未分组');
/* 之后若整理章节/段落，未分组的句子也必须留在原位，不能被搬到末尾 */
C.moveParagraph(delOne, 'pg_school', delOne.chapters[0].id, null);
assert.deepEqual(delOne.nodes.slice(0, 2).map(n => n.id), ['n1', 'n2'], '整理顺序后未分组句子仍在原位');
assert.deepEqual(delOne.nodes.map(n => n.id).sort(), orderBefore.slice().sort(), '没有节点丢失或重复');
assert.equal(C.analyze(delOne).errors.length, 0, '删除后显式跳转仍有效');
assert(C.analyze(delOne).warnings.some(w => w.includes('未分组')), '检查里能看到未分组提示');
/* 跨段移动后：树顺序 == 播放顺序，显式引用仍指向同一个节点 */
const crossMove = C.clone(q);
crossMove.nodes[1].next = '';
C.moveNodeToParagraph(crossMove, 'n2', pgRoad.id, null);
assert.deepEqual(C.flattenOrder(crossMove), crossMove.nodes.map(n => n.id), '没有未分组时，树的展开顺序就是播放顺序');
assert.equal(C.analyze(crossMove).errors.length, 0);
assert.equal(C.orderSuccessor(crossMove, crossMove.nodes.find(n => n.id === 'n2')), 'n4', '没有显式 next 的句子跟着新顺序继续');
assert.equal(C.orderSuccessor(crossMove, crossMove.nodes.find(n => n.id === 'n1')), 'n2', '显式 next 仍然指向原节点');
const jumpTarget = crossMove.nodes.find(n => n.id === 'n4');
assert.equal(jumpTarget.next, 'n5', '显式 next 没有被移动改写');
console.log('  ok  排序一致性：删除分组与跨段移动后播放顺序可解释，显式跳转仍有效');

/* ---------- 7. TXT 解析与导入计划 ---------- */
const script = [
  '# 第一章',
  '## 早餐',
  '林悠：豆浆快凉了。',
  '林澈：来了。',
  '两人低头吃饭。',
  '## 上学路',
  '阿澈：走快点。',
  '### 这不是段落',
  '：空说话人'
].join('\n');
const plan = C.parseScript(script, q.characters.concat([{ id: 'ch_che', name: '林澈', expressions: [] }, { id: 'ch_dup1', name: '路人', expressions: [] }, { id: 'ch_dup2', name: '路人', expressions: [] }]));
assert.equal(plan.stats.chapters, 1);
assert.equal(plan.stats.paragraphs, 2, '## 才产生段落');
assert.equal(plan.stats.nodes, 4);
assert.equal(plan.stats.bound, 2, '唯一匹配的角色名自动绑定');
assert.equal(plan.stats.free, 1, '未登记的名字保留自由文本');
assert.equal(plan.stats.narration, 1);
assert.equal(plan.unrecognized.length, 2, '格式不对的标题与空台词被报告');
assert(plan.chapters[0].paragraphs[0].nodes[0].speakerId === 'ch_you');
assert.equal(plan.chapters[0].paragraphs[1].nodes[0].name, '阿澈');
assert.equal(plan.chapters[0].paragraphs[1].nodes[0].speakerId, '', '未登记的名字保留自由文本');
const dupNode = C.parseScript('路人：你好。', [{ id: 'a', name: '路人' }, { id: 'b', name: '路人' }]).chapters[0].paragraphs[0].nodes[0];
assert.equal(dupNode.speakerId, '', '重名时不擅自绑定');
assert.equal(dupNode.name, '路人');
/* 计划本身不改工程 */
const target = C.clone(q);
const targetBefore = JSON.stringify(target);
const created = C.applyScriptPlan(target, plan, { mode: 'chapters' });
assert.notEqual(JSON.stringify(target), targetBefore, '确认后才写入');
assert.equal(target.nodes.length, q.nodes.length + 4);
assert.equal(target.chapters.length, q.chapters.length + 1);
assert.equal(target.nodes[0].text, q.nodes[0].text, '旧节点没有被导入影响');
assert.equal(target.nodes[0].paragraphId, q.nodes[0].paragraphId);
assert.equal(created.nodes.length, 4);
assert(C.validate(target));
/* 导入到当前段落 */
const target2 = C.clone(q);
const pgId = C.tree(target2).chapters[0].paragraphs[0].id;
C.applyScriptPlan(target2, plan, { mode: 'paragraph', paragraphId: pgId });
assert.equal(target2.nodes.filter(n => n.paragraphId === pgId).length, 2 + 4, '全部进入指定段落');
assert.equal(target2.chapters.length, q.chapters.length, '没有新建章节');
console.log('  ok  TXT 解析：章节/段落/说话人识别、重名与无法识别的行都有反馈，应用前不动工程');

/* ---------- 8. 落盘回读与导出 ---------- */
const store = createProjectStore();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-chapters-'));
const root = path.join(tmp, '章节工程');
store.createProject(root, q);
const disk = JSON.parse(fs.readFileSync(path.join(root, 'project.paper.json'), 'utf8'));
assert.equal(disk.schema, 5);
assert.equal(disk.chapters.length, 2);
assert.equal(disk.chapters[0].paragraphs[1].title, '上学路');
assert.equal(disk.nodes[3].paragraphId, 'pg_school');
const reopened = store.openProject(root).project;
assert.deepEqual(reopened.chapters, q.chapters);
assert.deepEqual(reopened.nodes.map(n => n.id), q.nodes.map(n => n.id), '重开后播放顺序一致');
assert.deepEqual(C.tree(reopened).chapters[1].paragraphs[0].nodes, ['n4', 'n5', 'end']);

const html = buildGameHTML(q, { player: paperPlayer, coreFactory: createVNCore, effectFactory: createPaperEffects, css: paperPlayerCSS, esc });
assert(html.includes('"chapters"'), '导出携带章节数据');
assert(html.includes('"paragraphId"'));
const nodes = {};
const makeElement = tag => ({
  tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {}, textContent: '', className: '', disabled: false, onclick: null,
  appendChild(c) { this.children.push(c); return c; }, replaceChildren(...items) { this.children = [...items]; },
  getBoundingClientRect() { return { width: 1280, height: 720 }; }, setAttribute() {}, focus() {}, remove() {}
});
const document = { getElementById(id) { return nodes[id] || (nodes[id] = makeElement('div')); }, createElement(t) { return makeElement(t); }, onkeydown: null };
const sandbox = { document, console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, performance: { now: () => 1000 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, matchMedia: () => ({ matches: false }) };
vm.createContext(sandbox);
vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], sandbox, { filename: 'exported.js' });
assert.equal(nodes.text.textContent, q.nodes[0].text, '导出播放器从第一句开始');
nodes.scene.onclick();
assert.equal(nodes.text.textContent, q.nodes[1].text, '章节不影响播放顺序');
console.log('  ok  落盘、回读与导出都带章节数据，播放顺序与编辑器一致');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('PASS: chapter tree, schema-5 migration, move impact, group deletion, entry path, TXT plan, disk and export parity');
