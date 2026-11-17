'use strict';
/* V0.4.3 批量编辑：
 * 1) 字段隔离：只改勾选的字段，未勾选保持原样；旁白/自由文本/旧表情处理正确；
 * 2) 在场角色表情只改本句绑定，不动图层几何与其他角色；缺角色/多图层/路线不明时跳过并给原因；
 * 3) 场景粘贴只替换布局，不碰台词、跳转、选项、段落与演出；有冲突的目标不写入；
 * 4) 演出粘贴按图层 ID / 唯一角色匹配，缺失或不唯一时跳过，追加冲突可识别；
 * 5) 计划与应用：无变化不产生记录；应用后节点之间、与源句之间互不共享对象；
 * 6) entryPlan 达到枚举预算时停下来并报告「不唯一」，不假报唯一。 */
const assert = require('node:assert/strict');
const createVNCore = require('../dist/core.js');
const createPaperEffects = require('../dist/effects.js');
const C = createVNCore();
const F = createPaperEffects();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const img = (id, kind) => ({ id, name: id, kind, width: 1600, height: 900, data: 'data:image/png;base64,' + PNG });
const L = (id, asset, kind, extra) => Object.assign({ id, asset, name: id, kind, x: 0, y: 0, w: 100, h: 100, fit: 'cover', opacity: 100, hidden: false, locked: false, motion: 'none', characterId: '', expressionId: '' }, extra || {});
const N = (id, o) => Object.assign({ id, type: 'say', name: '', text: id, next: '', sceneMode: 'inherit', layers: [], effects: [], speakerId: '', expressionId: '', cast: [], paragraphId: 'pg_1' }, o || {});

function fixture() {
  const p = {
    schema: 5, id: 'b', title: '批量测试', presets: [],
    chapters: [{ id: 'ch_1', title: '第一章', collapsed: false, paragraphs: [{ id: 'pg_1', title: '默认段落', collapsed: false }] }],
    assets: [img('bg_home', 'bg'), img('bg_school', 'bg'), img('you_n', 'char'), img('you_a', 'char'), img('che_n', 'char'), img('che_s', 'char')],
    characters: [
      { id: 'ch_you', name: '林悠', color: '#3f6753', defaultExpressionId: 'ex_you_n', expressions: [{ id: 'ex_you_n', name: '自然', assetId: 'you_n' }, { id: 'ex_you_a', name: '轻恼', assetId: 'you_a' }] },
      { id: 'ch_che', name: '林澈', color: '#7a5b3f', defaultExpressionId: 'ex_che_n', expressions: [{ id: 'ex_che_n', name: '平静', assetId: 'che_n' }, { id: 'ex_che_s', name: '微笑', assetId: 'che_s' }] }
    ],
    nodes: []
  };
  const n1 = N('n1', {
    sceneMode: 'own',
    layers: [L('bg', 'bg_home', 'bg'), L('you', 'you_n', 'char', { characterId: 'ch_you', expressionId: 'ex_you_n', x: 10, y: 12, w: 33, h: 88, fit: 'contain' }), L('che', 'che_n', 'char', { characterId: 'ch_che', expressionId: 'ex_che_n', x: 56, y: 2, w: 36.75, h: 98, fit: 'contain' })]
  });
  const n2 = N('n2', { speakerId: 'ch_you', expressionId: 'ex_you_a', name: '林悠', next: 'n3' });
  n2.effects = [Object.assign(F.make('e1', 'you', 'scale'), { to: 120 })];
  const n3 = N('n3', { name: '', next: 'n4' });                                      // 旁白
  const n4 = N('n4', { speakerId: 'ch_che', expressionId: 'ex_che_n', name: '林澈', next: 'n5' });
  const n5 = N('n5', { type: 'choice', next: '', options: [{ text: '继续', target: 'n6' }, { text: '结束', target: 'n6' }] });
  const n6 = N('n6', { type: 'end', text: '完' });
  p.nodes = [n1, n2, n3, n4, n5, n6];
  return p;
}

/* ---------- 1. 字段隔离与说话角色 ---------- */
const p = fixture();
assert(C.validate(p));
let plan = C.planBatch(p, ['n2', 'n3', 'n4'], { speaker: { characterId: 'ch_che' } });
assert.equal(plan.total, 3);
assert.equal(plan.changes.length, 2, 'n2 与旁白 n3 需要改；n4 本来就是林澈');
assert.equal(plan.skipped.length, 1);
assert(plan.skipped[0].reason.includes('目标状态'));
const n2change = plan.changes.find(c => c.nodeId === 'n2');
assert.equal(n2change.after.speakerId, 'ch_che');
assert.equal(n2change.after.expressionId, 'ex_che_n', '旧表情不属于新角色，改为新角色默认表情');
assert(n2change.notes.some(x => x.includes('默认表情')), '预览里说明表情被替换：' + JSON.stringify(n2change.notes));
assert.deepEqual(n2change.after.cast, [], '没有动在场角色绑定');
const n3change = plan.changes.find(c => c.nodeId === 'n3');
assert.equal(n3change.after.speakerId, 'ch_che', '旁白也可以指定说话角色');
assert.equal(n3change.after.name, '林澈');
C.applyBatch(p, plan);
assert.equal(p.nodes.find(n => n.id === 'n2').speakerId, 'ch_che');
assert.equal(p.nodes.find(n => n.id === 'n2').expressionId, 'ex_che_n');
console.log('  ok  批量改说话角色：旁白可指定，旧角色表情改为新角色默认表情并写进预览说明');

/* 未勾选字段保持原样 */
const q = fixture();
const onlyExpr = C.planBatch(q, ['n2'], { speakerExpression: { expressionId: 'ex_you_n' } });
assert.equal(onlyExpr.changes.length, 1);
assert.equal(onlyExpr.changes[0].after.speakerId, 'ch_you', '没勾选说话角色，角色不变');
assert.equal(onlyExpr.changes[0].after.name, '林悠');
assert.equal(onlyExpr.changes[0].after.expressionId, 'ex_you_n');
const noSpeaker = C.planBatch(q, ['n3'], { speakerExpression: { expressionId: 'ex_you_n' } });
assert.equal(noSpeaker.changes.length, 0);
assert(noSpeaker.skipped[0].reason.includes('没有说话角色'));
const choiceSkip = C.planBatch(q, ['n5', 'n6'], { speaker: { characterId: 'ch_you' } });
assert.equal(choiceSkip.changes.length, 0);
assert.equal(choiceSkip.skipped.length, 2);
assert(choiceSkip.skipped.every(s => s.reason.includes('不参与批量修改')));
console.log('  ok  未勾选字段不动；选项/结局节点跳过并说明原因');

/* ---------- 2. 在场角色表情 ---------- */
const r = fixture();
const beforeLayers = JSON.stringify(r.nodes[0].layers);
const castPlan = C.planBatch(r, ['n2', 'n3'], { cast: { characterId: 'ch_che', expressionId: 'ex_che_s' } });
assert.equal(castPlan.changes.length, 2, '两句都能改在场角色表情');
assert.deepEqual(castPlan.changes[0].after.cast, [{ characterId: 'ch_che', expressionId: 'ex_che_s' }]);
assert.equal(castPlan.changes[0].after.speakerId, 'ch_you', '说话人没被改');
C.applyBatch(r, castPlan);
assert.equal(JSON.stringify(r.nodes[0].layers), beforeLayers, '图层几何一点没动');
assert.equal(C.stage(r, 'n2').find(l => l.id === 'che').asset, 'che_s', '林澈在本句显示微笑');
assert.equal(C.stage(r, 'n2').find(l => l.id === 'you').asset, 'you_a', '林悠仍是本句的轻恼');
/* 角色存在但画面里没有它的图层 -> 跳过并说明 */
const absent = fixture();
absent.characters.push({ id: 'ch_x', name: '林夏', color: '', defaultExpressionId: '', expressions: [{ id: 'ex_x', name: '默认', assetId: 'you_n' }] });
const missing = C.planBatch(absent, ['n2'], { cast: { characterId: 'ch_x', expressionId: 'ex_x' } });
assert.equal(missing.changes.length, 0);
assert(missing.skipped[0].reason.includes('没有这个角色'), missing.skipped[0].reason);
/* 同一角色既设说话表情又设在场表情 -> 冲突，不写入 */
const clash = C.planBatch(fixture(), ['n2'], { speakerExpression: { expressionId: 'ex_you_n' }, cast: { characterId: 'ch_you', expressionId: 'ex_you_a' } });
assert.equal(clash.changes.length, 0);
assert(clash.conflicts[0].reason.includes('只能保留一个'));
console.log('  ok  在场角色表情只改本句绑定，图层几何与其他角色不变；同角色冲突不写入');

/* 角色不存在 -> 冲突 */
const gone = fixture();
gone.characters = gone.characters.filter(c => c.id !== 'ch_che');
const gonePlan = C.planBatch(gone, ['n2'], { cast: { characterId: 'ch_che', expressionId: 'ex_che_s' } });
assert.equal(gonePlan.changes.length, 0);
assert(gonePlan.conflicts.length + gonePlan.skipped.length === 1);
console.log('  ok  角色被删除时给出冲突/跳过，不静默写坏引用');

/* 路径不明时跳过（不用某条路线的画面猜图层） */
const amb = fixture();
const s1 = N('s1', { sceneMode: 'own', layers: [L('bg', 'bg_home', 'bg'), L('you', 'you_n', 'char', { characterId: 'ch_you' })] });
const a1 = N('a1', { next: 'm' });
a1.sceneMode = 'own'; a1.layers = [L('bg', 'bg_home', 'bg'), L('you', 'you_a', 'char', { characterId: 'ch_you' })];
const b1 = N('b1', { next: 'm' });
b1.sceneMode = 'own'; b1.layers = [L('bg', 'bg_school', 'bg')];
const c1 = N('c1', { type: 'choice', options: [{ text: 'A', target: 'a1' }, { text: 'B', target: 'b1' }] });
const m = N('m', { next: 'end' });
const end = N('end', { type: 'end' });
amb.nodes = [s1, c1, a1, b1, m, end];
const ambPlan = C.planBatch(amb, ['m'], { cast: { characterId: 'ch_you', expressionId: 'ex_you_a' } });
assert.equal(ambPlan.changes.length, 0);
assert(ambPlan.skipped[0].reason.includes('路线不唯一'), ambPlan.skipped[0].reason);
console.log('  ok  分支汇合句画面不唯一时跳过，不按某条路线猜图层');

/* ---------- 3. 场景复制粘贴 ---------- */
const sc = fixture();
const src = C.clone(sc.nodes[0]);
const paste = C.planPasteScene(sc, 'n1', ['n3', 'n4']);
assert(paste.ok);
assert.equal(paste.targets.filter(t => t.ok).length, 2);
C.applyPasteScene(sc, paste, true);
const n3after = sc.nodes.find(n => n.id === 'n3');
assert.equal(n3after.sceneMode, 'own', '目标变成独立场景');
assert.deepEqual(n3after.layers.map(l => l.id), src.layers.map(l => l.id), '保留图层 ID 以支持演出绑定');
assert.equal(n3after.layers[1].characterId, 'ch_you', '角色绑定一起复制');
assert.equal(n3after.next, 'n4', '跳转没被改');
assert.equal(n3after.text, 'n3', '台词没被改');
assert.deepEqual(n3after.effects, [], '演出没有被一起复制');
const inherited = C.planPasteScene(sc, 'n2', ['n4']);
assert.equal(inherited.ok, false);
assert(inherited.reason.includes('独立场景'));
/* 目标原有演出指向的图层在粘贴后不存在 -> 该目标不写入 */
const conflicted = fixture();
conflicted.nodes.find(n => n.id === 'n3').effects = [Object.assign(F.make('ex', 'ghost', 'blur'), {})];
const cp = C.planPasteScene(conflicted, 'n1', ['n3']);
assert.equal(cp.targets[0].ok, false);
assert(cp.targets[0].issues.join('').includes('不存在'));
C.applyPasteScene(conflicted, cp, true);
assert.notEqual(conflicted.nodes.find(n => n.id === 'n3').sceneMode, 'own', '有冲突的目标没有被写入');
console.log('  ok  场景粘贴只换布局：保留图层 ID 与角色绑定，不动台词/跳转/演出；有冲突的目标不写');

/* ---------- 4. 演出复制粘贴 ---------- */
const fx = fixture();
const fxSource = fx.nodes.find(n => n.id === 'n2');
const replacePlan = C.planPasteEffects(fx, 'n2', ['n4'], 'replace');
assert.equal(replacePlan.ok, true);
assert.equal(replacePlan.targets[0].ok, true, JSON.stringify(replacePlan.targets[0].issues));
assert.notEqual(replacePlan.targets[0].effects[0].id, fxSource.effects[0].id, '复制出新的演出 ID');
assert.equal(replacePlan.targets[0].effects[0].layer, 'you', '同图层 ID 自动匹配');
C.applyPasteEffects(fx, replacePlan, true);
const n4fx = fx.nodes.find(n => n.id === 'n4');
assert.equal(n4fx.effects.length, 1);
assert.equal(n4fx.effects[0].to, 120);
assert.equal(n4fx.effects[0].policy, 'sentence');
/* 追加同图层同类型 -> 冲突 */
const appendPlan = C.planPasteEffects(fx, 'n2', ['n4'], 'append');
assert.equal(appendPlan.targets[0].ok, false);
assert(appendPlan.targets[0].issues.join('').includes('已经有同类演出'));
/* 目标画面没有该图层 -> 跳过 */
const bare = fixture();
bare.nodes.push(N('n7', { sceneMode: 'own', layers: [L('bg', 'bg_school', 'bg')] }));
const missingLayer = C.planPasteEffects(bare, 'n2', ['n7'], 'replace');
assert.equal(missingLayer.targets[0].ok, false);
assert(missingLayer.targets[0].issues.join('').includes('没有'), JSON.stringify(missingLayer.targets[0].issues));
console.log('  ok  演出粘贴：新 ID、同图层匹配、追加冲突与缺失图层都能识别');

/* ---------- 5. 无变化与应用独立性 ---------- */
const same = fixture();
const noop = C.planBatch(same, ['n2'], { speaker: { characterId: 'ch_you' } });
assert.equal(noop.changes.length, 0, '已经是目标状态时不产生变更');
assert.equal(noop.skipped[0].reason.includes('目标状态'), true);
const copyPlan = C.planBatch(same, ['n2', 'n3'], { cast: { characterId: 'ch_che', expressionId: 'ex_che_s' } });
C.applyBatch(same, copyPlan);
const a = same.nodes.find(n => n.id === 'n2'), b = same.nodes.find(n => n.id === 'n3');
assert.notEqual(a.cast, b.cast, '两个节点不共享 cast 数组');
a.cast[0].expressionId = 'ex_che_n';
assert.equal(b.cast[0].expressionId, 'ex_che_s', '改一个节点不影响另一个');
assert.notEqual(a.cast, same.nodes.find(n => n.id === 'n1').cast);
console.log('  ok  无变化不产生记录；应用后各节点互不共享对象');

/* ---------- 6. entryPlan 预算 ---------- */
const budget = { schema: 5, id: 'x', title: 't', presets: [], chapters: [{ id: 'ch', title: 'c', collapsed: false, paragraphs: [{ id: 'pg_1', title: 'p', collapsed: false }] }], assets: [], characters: [], nodes: [] };
const entry = N('s0', { sceneMode: 'own' });
const first = N('c0', { type: 'choice', options: [] });
budget.nodes = [entry, first];
for (let i = 0; i < 6; i++) {
  const mid = N('m' + i, { type: 'choice', options: [] });
  for (let j = 0; j < 6; j++) {
    const leaf = N('l' + i + '_' + j, { next: 'target' });
    mid.options.push({ text: 'x', target: leaf.id });
    budget.nodes.push(leaf);
  }
  first.options.push({ text: 'y', target: mid.id });
  budget.nodes.push(mid);
}
const target = N('target', { next: 'end' });
const end2 = N('end', { type: 'end' });
budget.nodes.push(target, end2);
const entry0 = C.entryPlan(budget, 'target');
assert.equal(entry0.ambiguous, true, '路线超出预算时必须报告不唯一');
assert(entry0.truncated === true || entry0.options.length > 1, '截断标记或候选多于一条');
console.log('  ok  entryPlan 超过枚举预算时停止并报告不唯一，不假报唯一');

console.log('PASS: batch plan isolation, scene/effect paste rules, deep-copy independence, entry budget');
