'use strict';
/* V0.4.1 角色与表情：
 * 1) V0.3 工程迁移后节点、图层、演出原样保留，不按名字猜测人物；
 * 2) 切换表情只换素材关联，几何/ID/层级/透明度/效果目标不变；
 * 3) 表情按实际路径结算，某条分支的表情不会污染另一条分支；
 * 4) 改名不断开台词；删除角色/表情时引用可替换或保留占位；
 * 5) 落盘、回读、导出 HTML 都携带同一套角色数据。 */
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
const PNG2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJgg==';
const img = (id, name, kind = 'char', data = PNG) => ({ id, name, kind, width: 1024, height: 1536, data: 'data:image/png;base64,' + data });
const layer = (id, kind, asset, x, y, w, h) => ({ id, kind, asset, name: id, x, y, w, h, fit: kind === 'bg' ? 'cover' : 'contain', opacity: 100, hidden: false, locked: false, motion: 'none' });
const say = (id, text, name, next) => ({ id, type: 'say', name, text, next: next || '', sceneMode: 'inherit', layers: [], effects: [], speakerId: '', expressionId: '', cast: [], cast: [] });

/* 一份 V0.3 工程：两人同场，背景 16:9，road_17 式的特写＋虚化。 */
function v3Project() {
  const p = {
    schema: 3, id: 'wanfeng', title: '晚风经过二楼走廊', presets: [],
    assets: [img('you_neutral', '林悠·自然'), img('you_annoyed', '林悠·轻恼', 'char', PNG2),
      img('che_neutral', '林澈·平静'), img('che_smile', '林澈·微笑', 'char', PNG2),
      img('bg_school', '校园·二楼走廊', 'bg')],
    nodes: []
  };
  const n1 = say('n1', '走廊尽头，风把书页翻开。', '', 'n2');
  n1.sceneMode = 'own';
  n1.layers = [layer('background', 'bg', 'bg_school', 0, 0, 100, 100),
    layer('linyou', 'char', 'you_neutral', 10, 12, 33, 88),
    layer('linche', 'char', 'che_neutral', 56, 2, 36.75, 98)];
  const n2 = say('n2', '林澈！', '林悠', 'n3');
  n2.effects = [Object.assign(F.make('you_closeup', 'linyou', 'scale'), { to: 120, originX: 50, originY: 25, duration: .4, returnDuration: .35 }),
    Object.assign(F.make('bg_blur', 'background', 'blur'), { to: 8, duration: .4, returnDuration: .35 })];
  const n3 = say('n3', '怎么了？', '林澈', 'n4');
  const n4 = say('n4', '没什么，走吧。', '林悠', 'end');
  const end = { id: 'end', type: 'end', name: '第一章·节选完', text: '两人并肩走下楼梯。', next: '', sceneMode: 'inherit', layers: [], effects: [] };
  p.nodes = [n1, n2, n3, n4, end];
  return p;
}

/* 角色绑定：相当于作者在界面里建成「林悠/林澈 + 表情」并绑定图层。 */
function bindCast(p) {
  p.characters = [
    { id: 'ch_you', name: '林悠', color: '#3f6753', defaultExpressionId: 'ex_you_n', expressions: [
      { id: 'ex_you_n', name: '自然', assetId: 'you_neutral' },
      { id: 'ex_you_a', name: '轻恼', assetId: 'you_annoyed' }] },
    { id: 'ch_che', name: '林澈', color: '#7a5b3f', defaultExpressionId: 'ex_che_n', expressions: [
      { id: 'ex_che_n', name: '平静', assetId: 'che_neutral' },
      { id: 'ex_che_s', name: '微笑', assetId: 'che_smile' }] }
  ];
  const l1 = p.nodes[0].layers;
  l1.find(l => l.id === 'linyou').characterId = 'ch_you';
  l1.find(l => l.id === 'linyou').expressionId = 'ex_you_n';
  l1.find(l => l.id === 'linche').characterId = 'ch_che';
  l1.find(l => l.id === 'linche').expressionId = 'ex_che_n';
  const byId = id => p.nodes.find(n => n.id === id);
  byId('n2').speakerId = 'ch_you'; byId('n2').expressionId = 'ex_you_a';
  byId('n3').speakerId = 'ch_che';
  byId('n4').speakerId = 'ch_you'; byId('n4').expressionId = 'ex_you_n';
  return p;
}

/* ---------- 1. 迁移 ---------- */
const raw = v3Project();
const migrated = C.migrate(raw);
assert.equal(migrated.schema, 5);
assert.deepEqual(migrated.characters, [], '旧工程不凭空造角色');
assert.equal(migrated.nodes[2].name, '林澈', '说话人文本原样保留，没有被猜成角色');
assert.deepEqual(migrated.nodes[1].layers, raw.nodes[1].layers, '未改动的节点图层完全相等');
assert.deepEqual(migrated.nodes[2].layers, [], '继承画面仍是空的');
assert.equal(migrated.nodes[2].speakerId, '');
assert.equal(migrated.nodes[2].expressionId, '');
assert.equal(migrated.nodes[0].layers[1].characterId, '', '图层获得空的角色绑定，而不是自动绑定');
assert.deepEqual(migrated.nodes[1].effects.map(e => e.layer), ['linyou', 'background'], '演出目标没有变化');
assert.equal(migrated.nodes[1].effects[0].to, 120);
assert.equal(raw.schema, 3, '迁移不修改入参');
assert(C.validate(migrated));
/* 旧工程没有被强行绑定角色：说话人仍是自由文本，检查通过。 */
assert.deepEqual(C.analyze(migrated).errors, []);
assert.equal(C.speakerOf(migrated, migrated.nodes[2]).name, '林澈');
console.log('  ok  V0.3 工程迁移为 schema 4：图层/演出原样保留，不按名字合并人物');

/* ---------- 2. 表情切换只换素材 ---------- */
const p = bindCast(C.migrate(v3Project()));
assert(C.validate(p));
assert.deepEqual(C.analyze(p).errors, []);
const rawYou = p.nodes[0].layers.find(l => l.id === 'linyou');
const before = { ...rawYou };
const staged = C.stage(p, 'n2');
const shownYou = staged.find(l => l.id === 'linyou');
assert.equal(shownYou.asset, 'you_annoyed', '本句切到轻恼');
assert.equal(shownYou.id, before.id);
assert.deepEqual({ x: shownYou.x, y: shownYou.y, w: shownYou.w, h: shownYou.h, opacity: shownYou.opacity, motion: shownYou.motion, fit: shownYou.fit },
  { x: before.x, y: before.y, w: before.w, h: before.h, opacity: before.opacity, motion: before.motion, fit: before.fit },
  '坐标、大小、透明度、动画、适配方式全部不变');
assert.equal(p.nodes[0].layers.find(l => l.id === 'linyou').asset, 'you_neutral', '原图层素材没有被就地改写');
shownYou.x = 99;
assert.equal(p.nodes[0].layers.find(l => l.id === 'linyou').x, 10, '解析结果是副本，编辑它不会污染原图层');
assert.equal(staged.find(l => l.id === 'linche').asset, 'che_neutral', '另一个人的图层不受影响');
assert.equal(staged.length, p.nodes[0].layers.length, '不新增图层');
assert.deepEqual(p.nodes[1].effects.map(e => e.layer), ['linyou', 'background'], '效果仍绑定同一个图层 ID');
console.log('  ok  表情切换只改素材关联：不跳位、不累计缩放、不复制图层、不动另一方');

/* ---------- 3. 表情按路径结算，分支互不污染 ---------- */
const branch = bindCast(C.migrate(v3Project()));
const choice = { id: 'c1', type: 'choice', name: '', text: '要说什么？', next: '', sceneMode: 'inherit', layers: [], effects: [], speakerId: '', expressionId: '', cast: [], paragraphId: '',
  options: [{ text: '道歉', target: 'b1' }, { text: '换个话题', target: 'b2' }] };
const b1 = say('b1', '刚才是我太急了。', '林悠', 'merge');
b1.speakerId = 'ch_you'; b1.expressionId = 'ex_you_n';
const b2 = say('b2', '今天的风真好。', '林悠', 'merge');
b2.speakerId = 'ch_you';                      // 没有指定表情 → 沿用路径上的
const merge = say('merge', '两人一起下楼。', '', 'end');
branch.nodes = [branch.nodes[0], branch.nodes[1], choice, b1, b2, merge, branch.nodes[4]];
const branchPg = branch.chapters[0].paragraphs[0].id;
branch.nodes.forEach(n => { if (!n.paragraphId) n.paragraphId = branchPg; });
branch.nodes[1].next = 'c1'; b1.next = 'merge'; b2.next = 'merge'; merge.next = 'end';
assert(C.validate(branch));
const express = (id, trail) => C.stage(branch, id, trail).find(l => l.id === 'linyou').asset;
// 经过 n2（轻恼）后，没写表情的 b2 沿用轻恼
assert.equal(express('b2', ['n1', 'n2', 'c1']), 'you_annoyed', '同一条路径上表情延续');
// 没经过 n2 的分支完全不受影响
assert.equal(express('b1', ['n1', 'c1']), 'you_neutral');
assert.equal(express('b2', ['n1', 'c1']), 'you_neutral', '另一条分支不被污染');
// 同一句在两条路径上得到不同结果，靠的是路径而不是改写别人的图层
assert.equal(express('b2', ['n1', 'n2', 'c1']), 'you_annoyed');
assert.equal(express('b2', ['n1', 'c1']), 'you_neutral');
// 显式切回自然
assert.equal(express('b1', ['n1', 'n2', 'c1']), 'you_neutral', '显式选择的表情覆盖延续');
// 独立画面重置
assert.equal(C.castAlong(branch, 'n1')[ 'ch_you' ], undefined, '独立画面不继承上游表情');
console.log('  ok  表情按实际分支路径结算：延续、显式覆盖、分支隔离、独立画面重置');

/* 同场两人各自的表情：说话人是林悠，画面上的林澈也能单独微笑。 */
const duo = C.clone(branch);
const n4 = duo.nodes.find(n => n.id === 'b1');
n4.cast = [{ characterId: 'ch_che', expressionId: 'ex_che_s' }];
assert(C.validate(duo));
const duoLayers = C.stage(duo, 'b1', ['n1']);
assert.equal(duoLayers.find(l => l.id === 'linche').asset, 'che_smile', '非说话人角色也能单独换表情');
assert.equal(duoLayers.find(l => l.id === 'linyou').asset, 'you_neutral', '说话人的表情不受同场设置影响');
assert.equal(duo.nodes[0].layers.find(l => l.id === 'linche').asset, 'che_neutral', '原图层仍是平静');
assert.equal(C.stage(duo, 'merge', ['n1']).find(l => l.id === 'linche').asset, 'che_neutral', '同场表情只属于本句');
assert.deepEqual(C.expressionUsage(duo, 'ch_che', 'ex_che_s').lines, [3], '引用统计包含同场表情');
/* 两个角色同句切换：互不干扰 */
const both = C.clone(duo);
both.nodes.find(n => n.id === 'b1').speakerId = 'ch_you';
both.nodes.find(n => n.id === 'b1').expressionId = 'ex_you_a';
const bothLayers = C.stage(both, 'b1', ['n1']);
assert.equal(bothLayers.find(l => l.id === 'linyou').asset, 'you_annoyed');
assert.equal(bothLayers.find(l => l.id === 'linche').asset, 'che_smile');
assert.equal(bothLayers.filter(l => l.kind === 'char').length, 2, '两人同场仍是原来的两个角色图层');
console.log('  ok  同场两人的表情各自生效，只用原图层、不新增也不串味');

/* ---------- 4. 改名 / 删除 ---------- */
const renamed = C.clone(branch);
renamed.characters.find(c => c.id === 'ch_you').name = '林悠（改）';
assert(C.validate(renamed));
assert.equal(renamed.nodes[1].speakerId, 'ch_you', '改名不动台词绑定');
assert.equal(C.speakerOf(renamed, renamed.nodes[1]).name, '林悠（改）');
assert.equal(C.stage(renamed, 'n2').find(l => l.id === 'linyou').asset, 'you_annoyed');
assert.equal(C.speakerOf(renamed, renamed.nodes[1]).color, '#3f6753');

// 删除仍被引用的表情：保留占位必须有反馈
const loseExpr = C.clone(branch);
loseExpr.characters.find(c => c.id === 'ch_you').expressions = loseExpr.characters.find(c => c.id === 'ch_you').expressions.filter(e => e.id !== 'ex_you_a');
loseExpr.characters.find(c => c.id === 'ch_you').defaultExpressionId = 'ex_you_n';
assert(C.analyze(loseExpr).errors.some(e => e.includes('表情')), '被引用的表情丢失会报错');
assert.throws(() => C.validate(loseExpr), /表情/, '格式校验同样拒绝悬空表情');

// 替换成另一个表情后恢复有效
const replaced = C.clone(loseExpr);
replaced.characters.find(c => c.id === 'ch_you').expressions.push({ id: 'ex_you_a', name: '轻恼2', assetId: 'you_annoyed' });
assert(C.validate(replaced));

// 删除角色：解除绑定后说话人退回自由文本，文字不丢
const loseChar = C.clone(branch);
loseChar.characters = loseChar.characters.filter(c => c.id !== 'ch_you');
for (const n of loseChar.nodes) if (n.speakerId === 'ch_you') { n.speakerId = ''; n.expressionId = ''; if (!n.name) n.name = '林悠'; }
for (const n of loseChar.nodes) for (const l of n.layers) if (l.characterId === 'ch_you') { l.characterId = ''; l.expressionId = ''; }
assert(C.validate(loseChar));
assert.equal(C.speakerOf(loseChar, loseChar.nodes[1]).name, '林悠', '解除绑定后仍用原来的说话人文字');
assert.deepEqual(C.analyze(loseChar).errors, []);

// 保留占位：明确报错而不是静默变成别人
const keepPlaceholder = C.clone(branch);
keepPlaceholder.characters = keepPlaceholder.characters.filter(c => c.id !== 'ch_you');
assert(C.analyze(keepPlaceholder).errors.some(e => e.includes('角色')), '角色丢失（保留占位）会提示');
console.log('  ok  改名不断开绑定；表情/角色丢失有明确反馈，可替换或保留占位');

/* ---------- 5. 落盘 / 回读 / 导出 ---------- */
const store = createProjectStore();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-cast-'));
const root = path.join(tmp, '晚风演示');
store.createProject(root, p);
const disk = JSON.parse(fs.readFileSync(path.join(root, 'project.paper.json'), 'utf8'));
assert.equal(disk.schema, 5);
assert.equal(disk.characters.length, 2, '角色写入工程文件');
assert.equal(disk.characters[0].expressions.length, 2);
assert.equal(disk.nodes[1].speakerId, 'ch_you', '台词的角色绑定写入工程文件');
assert(!JSON.stringify(disk).includes('data:image'), '角色元数据不内嵌图片');
const reopened = store.openProject(root).project;
/* V0.7.6 起运行时素材是 paperasset:// 地址：单文件 HTML 导出前要读回 data URI。 */
const inlineRuntime = proj => {
  const toData = a => {
    if (!/^paper:\/\/app\/asset\//i.test(String(a.data || ''))) return a;
    const rel = a.file || String(a.data).replace(/^paper:\/\/app\/asset\//i, '');
    const buf = fs.readFileSync(path.join(root, ...rel.split('/')));
    return Object.assign({}, a, { data: 'data:' + (a.mime || 'image/png') + ';base64,' + buf.toString('base64') });
  };
  return Object.assign({}, proj, {
    assets: (proj.assets || []).map(toData),
    audioAssets: (proj.audioAssets || []).map(toData)
  });
};
assert.deepEqual(reopened.characters, p.characters);
assert.equal(reopened.nodes[1].speakerId, 'ch_you');
assert.equal(reopened.nodes[0].layers.find(l => l.id === 'linyou').characterId, 'ch_you');
assert.equal(C.stage(reopened, 'n2').find(l => l.id === 'linyou').asset, 'you_annoyed', '回读后表情仍然生效');

const html = buildGameHTML(inlineRuntime(p), { player: paperPlayer, coreFactory: createVNCore, effectFactory: createPaperEffects, css: paperPlayerCSS, esc });
assert(html.includes('"characters"'), '导出的 HTML 带有角色数据');
assert(html.includes('"speakerId"'));
const nodes = {};
const makeElement = tag => ({
  tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {}, textContent: '', className: '', disabled: false, onclick: null,
  appendChild(c) { this.children.push(c); return c; }, replaceChildren(...items) { this.children = [...items]; },
  getBoundingClientRect() { return { width: 1280, height: 720 }; }, setAttribute() {}, focus() {}, remove() {},
  classList: { toggle() {}, add() {}, remove() {} }
});
const document = { getElementById(id) { return nodes[id] || (nodes[id] = makeElement('div')); }, createElement(t) { return makeElement(t); }, onkeydown: null };
const sandbox = { document, console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, performance: { now: () => 1000 }, setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, matchMedia: () => ({ matches: false }) };
vm.createContext(sandbox);
vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], sandbox, { filename: 'exported-game.js' });
nodes.startGame.onclick();                                // V0.6.1：先从标题页进入
const srcOf = id => nodes.layers.children.find(c => c.dataset.layer === id).children[0].src;
assert.equal(nodes.who.textContent, '');
const initialLinyou = srcOf('linyou');
assert(initialLinyou.includes(PNG), '初始画面是自然表情');
nodes.scene.onclick();                                    // n1 → n2（林悠·轻恼）
assert.equal(nodes.who.textContent, '林悠', '导出的播放器显示角色名');
assert.equal(nodes.who.style.color, '#3f6753', '姓名颜色一并导出');
assert.notEqual(srcOf('linyou'), initialLinyou, '导出的播放器按表情切换素材');
assert(srcOf('linche').includes(PNG), '另一个角色仍是自己的素材');
assert.equal(nodes.layers.children.length, 3, '导出播放器不新增图层');
console.log('  ok  角色/表情随工程落盘、回读并原样导出到自包含 HTML');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('PASS: character model, schema-4 migration, path-scoped expressions, rename, deletion feedback, disk and export parity');
