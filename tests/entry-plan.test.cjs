'use strict';
/* 定点试玩的路径判定：
 * 1) 互斥分支分别改表情和 hold 效果，汇合后不能混用两条路线的状态；
 * 2) 路线唯一时正常还原；目标本身是独立场景时直接从该场景开始；
 * 3) 有真实试玩路径时优先用真实路径；
 * 4) 绝不以「数组顺序扫过所有前置节点」的结果冒充目标句状态。 */
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
    schema: 5, id: 'p', title: '路径测试', presets: [], chapters: [{ id: 'ch_1', title: '第一章', collapsed: false, paragraphs: [{ id: 'pg_1', title: '默认段落', collapsed: false }] }],
    assets: [img('bg_home', 'bg'), img('bg_road', 'bg'), img('you_n', 'char'), img('you_a', 'char')],
    characters: [{ id: 'ch_you', name: '林悠', color: '#3f6753', defaultExpressionId: 'ex_n', expressions: [{ id: 'ex_n', name: '自然', assetId: 'you_n' }, { id: 'ex_a', name: '轻恼', assetId: 'you_a' }] }],
    nodes: []
  };
  const s1 = N('s1', {
    sceneMode: 'own',
    layers: [L('bg', 'bg_home', 'bg'), L('you', 'you_n', 'char', { characterId: 'ch_you', expressionId: 'ex_n', x: 10, y: 12, w: 33, h: 88, fit: 'contain' })]
  });
  const c1 = N('c1', {
    type: 'choice', options: [{ text: '去天台', target: 'a1' }, { text: '去操场', target: 'b1' }],
    sceneMode: 'inherit'
  });
  /* A 路线：改成轻恼 + 背景持续虚化 */
  const a1 = N('a1', { speakerId: 'ch_you', expressionId: 'ex_a', next: 'a2' });
  a1.effects = [Object.assign(F.make('ea', 'bg', 'blur'), { to: 8, policy: 'hold' })];
  const a2 = N('a2', { next: 'm' });
  /* B 路线：保持自然 + 角色持续放大 */
  const b1 = N('b1', { speakerId: 'ch_you', expressionId: 'ex_n', next: 'b2' });
  b1.effects = [Object.assign(F.make('eb', 'you', 'scale'), { to: 120, policy: 'hold' })];
  const b2 = N('b2', { next: 'm' });
  const m = N('m', { next: 'end' });
  const end = N('end', { type: 'end' });
  p.nodes = [s1, c1, a1, a2, b1, b2, m, end];
  return p;
}

const p = fixture();
assert(C.validate(p));

/* ---------- 1. 汇合句：两条互斥路线，必须判定为有歧义 ---------- */
const plan = C.entryPlan(p, 'm');
assert.equal(plan.ambiguous, true, '汇合句前面有两条路线');
assert.equal(plan.options.length, 2, '给出两条候选路线');
const tails = plan.options.map(o => o.trail.join('>')).sort();
assert.deepEqual(tails, ['s1>c1>a1>a2', 's1>c1>b1>b2'], '候选路线各自完整、互不掺和：' + JSON.stringify(tails));
for (const o of plan.options) {
  assert(!(o.trail.includes('a1') && o.trail.includes('b1')), '没有把两条分支拼在一起');
  assert.equal(o.anchorId, 's1', '进入点是最前面的独立场景');
}

/* 数组顺序前缀 = 所有前置节点，正好是「两条分支都跑一遍」的错误做法 */
const naive = p.nodes.slice(0, p.nodes.findIndex(n => n.id === 'm')).map(n => n.id);
assert(naive.includes('a1') && naive.includes('b1'), '数组顺序前缀同时包含两条分支');
for (const o of plan.options) assert.notDeepEqual(o.trail, naive, '不使用数组顺序前缀');

/* ---------- 2. 两条路线分别还原状态，互不混用 ---------- */
const routeA = plan.options.find(o => o.trail.includes('a1'));
const routeB = plan.options.find(o => o.trail.includes('b1'));
const stageA = C.stage(p, 'm', routeA.trail);
const stageB = C.stage(p, 'm', routeB.trail);
assert.equal(stageA.find(l => l.id === 'you').asset, 'you_a', 'A 路线显示轻恼');
assert.equal(stageB.find(l => l.id === 'you').asset, 'you_n', 'B 路线显示自然');

const stateA = F.before(p, C, 'm', routeA.trail);
const stateB = F.before(p, C, 'm', routeB.trail);
assert(stateA.bg, 'A 路线有背景虚化');
assert(!stateA.you || !stateA.you.scale || stateA.you.scale === 100, 'A 路线没有 B 路线的放大');
assert(stateB.you && stateB.you.scale === 120, 'B 路线角色放大到 120');
assert(!stateB.bg || !stateB.bg.blur, 'B 路线没有 A 路线的虚化');
const naiveState = F.before(p, C, 'm', naive);
assert(naiveState.bg && naiveState.bg.blur && naiveState.you && naiveState.you.scale === 120,
  '数组顺序前缀会同时带上两条分支的状态（正因如此不能用它）');
console.log('  ok  汇合句：两条互斥路线都算得出来，各自还原表情与 hold，不混用数组顺序前缀');

/* ---------- 3. 唯一路线 / 独立场景 / 真实路径 ---------- */
const linear = fixture();
linear.nodes.splice(1, 1);                     // 去掉分支，变成 s1 → a1 → a2 → m → end
linear.nodes.find(n => n.id === 'a2').next = 'm';
linear.nodes.find(n => n.id === 's1').next = 'a1';
const lp = C.entryPlan(linear, 'm');
assert.equal(lp.ambiguous, false, '只有一个前置时是确定的');
assert.deepEqual(lp.trail, ['s1', 'a1', 'a2'], '从进入点开始还原（含进入点本身）');
assert.equal(lp.anchorId, 's1');

const scenePlan = C.entryPlan(p, 's1');
assert.equal(scenePlan.source, 'scene');
assert.deepEqual(scenePlan.trail, [], '独立场景从自身开始，不需要前置');
const ownEnd = C.entryPlan(p, 'a1');
assert.deepEqual(ownEnd.trail, ['s1', 'c1'], 'a1 不是独立场景，唯一路线时带上它之前的必要节点');
assert.equal(ownEnd.ambiguous, false);

const actual = C.entryPlan(p, 'm', ['s1', 'c1', 'b1', 'b2']);
assert.equal(actual.source, 'actual', '有实际路径时优先用实际路径');
assert.deepEqual(actual.trail, ['s1', 'c1', 'b1', 'b2']);
console.log('  ok  唯一路线直接还原、独立场景从自身开始、真实路径优先');

/* ---------- 4. 不可达时不编造状态 ---------- */
const broken = fixture();
broken.nodes.find(n => n.id === 'c1').options = [{ text: '去天台', target: 'a1' }, { text: '无效', target: '' }];
broken.nodes = broken.nodes.filter(n => n.id !== 'b1' && n.id !== 'b2');
const unreachable = C.clone(fixture());
unreachable.nodes.find(n => n.id === 'm').next = 'end';
unreachable.nodes = unreachable.nodes.filter(n => n.id !== 's1');
const noAnchor = C.entryPlan(unreachable, 'm');
assert.equal(noAnchor.ambiguous, true, '没有独立场景入口时不算确定');
console.log('  ok  找不到入口时不伪造状态，交给界面提示');

console.log('PASS: entry plan picks real route or unique path, refuses to mix exclusive branches');
